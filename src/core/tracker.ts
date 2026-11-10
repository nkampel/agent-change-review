import { App, Events, Notice, TAbstractFile, TFile, normalizePath } from "obsidian";
import {
  GroupingOptions,
  LogicalChange,
  acceptedBaseline,
  computeChanges,
  rejectionEdit,
} from "../diff/engine";
import { EditorEdit, EditorRegistry, EditorSink } from "./editors";
import { FileState, FileStates, isPending } from "./filestate";
import { hashText } from "./hash";
import {
  ChangeCounts,
  TextEdit,
  applyEdits,
  countChanges,
  editsBetween,
  findChange,
  mirrorOwnEdits,
} from "./model";
import { OwnMarks } from "./ownmarks";
import { RenamePairing } from "./pairing";
import { PathFilter } from "./paths";
import { FileStatus, SnapshotStore } from "./store";
import { KeyedQueue, KeyedTimers, sleep } from "./timing";

/**
 * ChangeTracker: the authority on reviewed baselines and pending changes.
 *
 * Invariant (docs/DESIGN.md §2): pending changes are always
 * `computeChanges(baseline, current)`. The baseline only moves through own
 * edits (mirrored per §3.4), accepts, and resets; everything else that
 * touches a file only changes `current`.
 *
 * Where `current` comes from: for a note open in an editor the editor buffer
 * is authoritative (disk lags behind autosave, and Obsidian reloads external
 * writes into the editor as a `userEvent: "set"` transaction); for a closed
 * note it is the file on disk.
 *
 * The tracker knows Obsidian's vault but not CodeMirror: editors talk to it
 * through the `EditorSink` interface (editors.ts).
 *
 * Helpers: per-file state and baseline persistence live in filestate.ts,
 * delete + create pairing into renames in pairing.ts.
 */

export interface TrackerSettings {
  excluded: string[];
  maxFileSizeKB: number;
  grouping: GroupingOptions;
}

export interface PendingInfo {
  path: string;
  status: FileStatus;
  renamedFrom?: string;
  lastExternal: number;
  counts: ChangeCounts;
}

const OWN_EDIT_DEBOUNCE = 150;

export type { EditorEdit, EditorSink };

export class ChangeTracker extends Events {
  private states: FileStates;
  private editors = new EditorRegistry();
  private pairing: RenamePairing;
  private queue = new KeyedQueue<string>((e) => console.error("[agent-change-review]", e));
  private pushTimers = new KeyedTimers<string>();
  private filter: PathFilter;
  private started = false;

  constructor(
    private app: App,
    private store: SnapshotStore,
    private marks: OwnMarks,
    private settings: () => TrackerSettings
  ) {
    super();
    this.states = new FileStates(store);
    this.pairing = new RenamePairing(
      (path) => void this.enqueue(path, () => this.resolveCreate(path)),
      (st) => void this.enqueue(st.path, () => this.resolveDelete(st))
    );
    this.filter = new PathFilter(settings().excluded);
  }

  // ------------------------------------------------------------- lifecycle

  /** Restore persisted state. Pending files get their baselines loaded. */
  async load(): Promise<void> {
    await this.store.load();
    for (const [path, entry] of this.store.entries) {
      const st: FileState = { path, entry, changes: [] };
      this.states.put(st);
      if (!isPending(st)) continue;
      const base = entry.status === "created" ? "" : await this.store.read(entry);
      if (base === null) {
        // Unreadable snapshot: nothing to diff against. The scan re-adopts it.
        if (entry.status === "deleted") this.forget(st);
        else {
          entry.status = "clean";
          entry.hash = "";
          delete entry.renamedFrom;
        }
        continue;
      }
      st.baseline = base;
    }
  }

  /** Begin watching. Call once the workspace layout is ready. */
  start(): void {
    this.started = true;
    void this.scan(this.store.isNew);
  }

  async shutdown(): Promise<void> {
    this.states.flushAll();
    this.pushTimers.clearAll();
    this.pairing.dispose();
    await this.store.flush();
  }

  /** Re-read exclusions/limits/grouping from settings. */
  settingsChanged(): void {
    this.filter = new PathFilter(this.settings().excluded);
    for (const st of this.states.all()) {
      st.computedFor = undefined;
      if (isPending(st) || this.editors.isOpen(st.path)) this.recompute(st);
    }
    if (this.started) void this.scan(true);
  }

  // ------------------------------------------------------------- queries

  isTracked(file: TFile): boolean {
    if (file.extension !== "md") return false;
    if (file.path.startsWith(this.app.vault.configDir + "/")) return false;
    if (file.stat.size > this.settings().maxFileSizeKB * 1024) return false;
    return !this.filter.excludes(file.path);
  }

  /** Is the note at `path` tracked (worth reporting editor changes for)? */
  wants(path: string | null): boolean {
    const file = path ? this.fileAt(path) : null;
    return !!file && this.isTracked(file);
  }

  pending(): PendingInfo[] {
    const out: PendingInfo[] = [];
    for (const st of this.states.all()) {
      if (!isPending(st)) continue;
      out.push({
        path: st.path,
        status: st.entry.status,
        renamedFrom: st.entry.renamedFrom,
        lastExternal: st.entry.lastExternal ?? 0,
        counts: countChanges(st.changes),
      });
    }
    return out.sort((a, b) => b.lastExternal - a.lastExternal);
  }

  changesFor(path: string): LogicalChange[] {
    const st = this.states.get(path);
    if (!st) return [];
    this.syncFromSink(st);
    if (st.baseline === undefined || st.current === undefined) return [];
    return this.freshChanges(st, st.current);
  }

  /** Baseline of a deleted file (for the preview). */
  deletedContent(path: string): string | null {
    const st = this.states.get(path);
    return st?.entry.status === "deleted" ? (st.baseline ?? null) : null;
  }

  // ------------------------------------------------------------- editors

  attach(sink: EditorSink): void {
    this.editors.add(sink);
    const path = sink.path();
    const file = path ? this.fileAt(path) : null;
    if (!path || !file || !this.isTracked(file)) {
      this.editors.pushTo(sink, [], sink.text());
      return;
    }
    const text = sink.text();
    const st = this.states.get(path);
    if (!st) {
      if (!this.pairing.holdsCreate(path)) this.createState(path, text, "clean", text);
      return;
    }
    if (isPending(st)) {
      if (st.entry.status === "deleted") st.entry.status = "modified";
      st.current = text;
      this.recompute(st);
      return;
    }
    st.current = text;
    if (hashText(text) !== this.states.baselineHash(st)) this.verify(st, file);
    else this.pushSoon(st);
  }

  detach(sink: EditorSink): void {
    this.editors.remove(sink);
    const path = sink.path();
    const st = path ? this.states.get(path) : undefined;
    if (!st || this.editors.isOpen(st.path)) return;
    this.states.flushPersist(st);
    if (!isPending(st)) {
      st.current = undefined;
      st.baseline = undefined;
      st.changes = [];
      st.computedFor = undefined;
    }
  }

  /** Called synchronously from the editor for every document change. */
  onEditorEdit(sink: EditorSink, e: EditorEdit): void {
    const path = sink.path();
    const file = path ? this.fileAt(path) : null;
    if (!path || !file || !this.isTracked(file)) return;
    let st = this.states.get(path);
    if (!st) {
      if (this.pairing.holdsCreate(path)) return;
      st = this.createState(path, e.startText, "clean", e.startText);
    }
    if (st.verifying) {
      if (e.kind === "own") st.deferred?.push({ startText: e.startText, edits: e.edits });
      st.current = e.endText;
      return;
    }
    let kind = e.kind;
    if (kind === "reload") {
      // Another pane of the same note syncing, not a disk change.
      if (e.endText === st.current) return;
      if (this.marks.takeContent(path, e.endText)) kind = "own";
    }

    if (!isPending(st)) {
      if (kind === "own") {
        st.current = e.endText;
        this.states.persist(st, e.endText);
        return;
      }
      // A clean buffer equals the baseline, so the pre-change text is it.
      st.baseline = e.startText;
      st.current = e.endText;
      st.entry.status = "modified";
      if (kind === "reload") this.noteExternal(st);
      this.schedule(st, 0);
      return;
    }

    if (kind === "own" && st.baseline !== undefined) {
      const changes = this.freshChanges(st, e.startText);
      const next = mirrorOwnEdits(st.baseline, changes, e.edits);
      if (next !== st.baseline) {
        st.baseline = next;
        this.states.persist(st, next);
      }
    }
    st.current = e.endText;
    if (kind === "reload") this.noteExternal(st);
    this.schedule(st, kind === "own" ? OWN_EDIT_DEBOUNCE : 0);
  }

  // ------------------------------------------------------------- actions

  accept(path: string, ref: LogicalChange): void {
    const st = this.states.get(path);
    const c = st && this.locate(st, ref);
    if (!st || !c || st.baseline === undefined) return;
    st.baseline = acceptedBaseline(st.baseline, c);
    this.states.persist(st, st.baseline);
    if (st.entry.status === "created" && st.baseline === st.current) st.entry.status = "clean";
    this.recompute(st);
  }

  reject(path: string, ref: LogicalChange): void {
    const st = this.states.get(path);
    const c = st && this.locate(st, ref);
    if (!st || !c) return;
    void this.editCurrent(st, [rejectionEdit(c)]);
  }

  async acceptAll(path: string): Promise<void> {
    const st = this.states.get(path);
    if (!st) return;
    if (st.entry.status === "deleted") {
      this.forget(st);
      return;
    }
    this.syncFromSink(st);
    if (st.current === undefined) {
      const file = this.fileAt(path);
      if (file) st.current = await this.app.vault.read(file);
    }
    if (st.current !== undefined) {
      st.baseline = st.current;
      this.states.persist(st, st.current, true);
    }
    st.entry.status = "clean";
    delete st.entry.renamedFrom;
    delete st.entry.lastExternal;
    this.recompute(st);
  }

  async rejectAll(path: string): Promise<void> {
    const st = this.states.get(path);
    if (!st) return;
    const vault = this.app.vault;
    const file = this.fileAt(path);

    if (st.entry.status === "created") {
      if (!file) return this.forget(st);
      this.marks.expectDelete(path);
      await this.app.fileManager.trashFile(file);
      return;
    }
    if (st.entry.status === "deleted") {
      if (this.app.vault.getAbstractFileByPath(path)) {
        new Notice(`Cannot restore ${path}: a file already exists there.`);
        return;
      }
      await this.ensureFolder(path);
      this.marks.expectCreate(path);
      await vault.create(path, st.baseline ?? "");
      return;
    }
    const changes = this.changesFor(path);
    if (changes.length > 0) await this.editCurrent(st, changes.map(rejectionEdit));

    const from = st.entry.renamedFrom;
    if (from && file) {
      if (vault.getAbstractFileByPath(from)) {
        new Notice(`Cannot move back to ${from}: a file already exists there.`);
        return;
      }
      await this.ensureFolder(from);
      await this.app.fileManager.renameFile(file, from);
    }
  }

  /** Accept the rename only, leaving content changes pending. */
  acceptRename(path: string): void {
    const st = this.states.get(path);
    if (!st?.entry.renamedFrom) return;
    delete st.entry.renamedFrom;
    if (st.entry.status === "modified" && st.changes.length === 0) st.entry.status = "clean";
    this.store.scheduleSave();
    this.recompute(st);
  }

  /** Make every file's current content its baseline. */
  async resetAll(): Promise<void> {
    for (const st of this.states.all()) {
      if (isPending(st)) await this.acceptAll(st.path);
    }
    await this.scan(true, true);
  }

  // ------------------------------------------------------------- vault events

  onModify(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const path = file.path;
    void this.enqueue(path, async () => {
      const st = this.states.get(path);
      if (!this.isTracked(file)) {
        if (st) this.forget(st);
        return;
      }
      const data = await this.app.vault.read(file);
      if (!st) {
        if (!this.pairing.holdsCreate(path)) this.createState(path, data, "clean");
        return;
      }
      // An open editor is authoritative; external writes arrive as reloads.
      if (this.editors.isOpen(path)) {
        if (!isPending(st) && hashText(data) === this.states.baselineHash(st)) this.setStat(st, file);
        return;
      }
      if (!isPending(st)) {
        if (hashText(data) === this.states.baselineHash(st)) return this.setStat(st, file);
        if (this.marks.takeContent(path, data)) {
          this.states.persist(st, data, true);
          return this.setStat(st, file);
        }
        const base = await this.states.readBaseline(st);
        if (base === null || base === data) {
          this.states.persist(st, data, true);
          return this.setStat(st, file);
        }
        st.baseline = base;
        st.current = data;
        st.entry.status = "modified";
        this.noteExternal(st);
        this.recompute(st);
        return;
      }
      if (st.entry.status === "deleted" || data === st.current) return;
      if (
        this.marks.takeContent(path, data) &&
        st.baseline !== undefined &&
        st.current !== undefined
      ) {
        const changes = this.freshChanges(st, st.current);
        st.baseline = mirrorOwnEdits(st.baseline, changes, editsBetween(st.current, data));
        this.states.persist(st, st.baseline);
      } else {
        this.noteExternal(st);
      }
      st.current = data;
      this.recompute(st);
    });
  }

  onCreate(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const path = file.path;
    if (this.marks.isOwnCreate(path)) {
      void this.enqueue(path, async () => {
        const st = this.states.get(path);
        if (st?.entry.status === "deleted") {
          // Restored by "Reject deletion".
          const data = await this.app.vault.read(file);
          st.baseline = data;
          st.current = this.editors.isOpen(path) ? st.current ?? data : data;
          st.entry.status = "clean";
          delete st.entry.lastExternal;
          this.states.persist(st, data, true);
          this.recompute(st);
        } else if (!st && this.isTracked(file)) {
          this.createState(path, await this.app.vault.read(file), "clean");
        }
      });
      return;
    }
    if (!this.isTracked(file)) return;
    this.pairing.holdCreate(path);
  }

  onDelete(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    const path = file.path;
    this.pairing.dropCreate(path);
    const st = this.states.get(path);
    if (!st) return;
    if (this.marks.isOwnDelete(path)) {
      this.forget(st);
      return;
    }
    // Wait: an external `mv` shows up as delete + create of the same content.
    const known = st.current ?? st.persistText;
    const hash = known !== undefined ? hashText(known) : st.entry.hash;
    this.states.take(path);
    this.pairing.holdDelete(st, hash);
  }

  /** In-app renames (external ones arrive as delete + create). */
  onRename(file: TAbstractFile, oldPath: string): void {
    if (!(file instanceof TFile)) return;
    const st = this.states.get(oldPath);
    if (!st) {
      if (file.extension === "md" && this.isTracked(file)) {
        void this.enqueue(file.path, async () => {
          if (!this.states.has(file.path))
            this.createState(file.path, await this.app.vault.read(file), "clean");
        });
      }
      return;
    }
    if (file.extension !== "md" || !this.isTracked(file)) {
      this.forget(st);
      return;
    }
    this.states.move(st, file.path);
    if (st.entry.renamedFrom === file.path) {
      delete st.entry.renamedFrom;
      if (st.entry.status === "modified" && st.changes.length === 0) st.entry.status = "clean";
    }
    this.recompute(st);
  }

  // ------------------------------------------------------------- internals

  private async resolveCreate(path: string): Promise<void> {
    const file = this.fileAt(path);
    if (!file) return;
    const data = await this.app.vault.read(file);
    const existing = this.states.get(path);
    if (existing) {
      if (existing.entry.status === "deleted") {
        existing.entry.status = "modified";
        existing.current = data;
        this.noteExternal(existing);
        this.recompute(existing);
      }
      return;
    }
    const claimed = this.pairing.claimDelete(hashText(data));
    if (claimed) {
      const { oldPath, st } = claimed;
      this.states.put(st);
      this.states.move(st, path);
      if (st.entry.status !== "created") {
        st.entry.renamedFrom = st.entry.renamedFrom ?? oldPath;
        if (st.entry.renamedFrom === path) delete st.entry.renamedFrom;
        if (st.entry.status === "clean" && st.entry.renamedFrom) {
          // Keep the baseline in memory: a pending file always has it.
          st.baseline = st.baseline ?? (await this.states.readBaseline(st)) ?? data;
          st.current = data;
        }
      }
      this.noteExternal(st);
      this.recompute(st);
      return;
    }
    const st = this.createState(path, "", "created");
    st.current = this.editors.for(path)?.text() ?? data;
    this.noteExternal(st);
    this.recompute(st);
  }

  private async resolveDelete(st: FileState): Promise<void> {
    if (this.states.has(st.path) || this.fileAt(st.path)) {
      // Something else lives here now; drop the old record.
      void this.store.remove(st.entry);
      return;
    }
    if (st.entry.status === "created") {
      this.store.entries.delete(st.path);
      void this.store.remove(st.entry);
      this.emitChanged();
      return;
    }
    this.states.flushPersist(st);
    if (st.baseline === undefined) st.baseline = (await this.states.readBaseline(st)) ?? undefined;
    if (st.baseline === undefined) {
      this.store.entries.delete(st.path);
      void this.store.remove(st.entry);
      this.emitChanged();
      return;
    }
    st.entry.status = "deleted";
    st.current = undefined;
    st.changes = [];
    this.states.put(st);
    this.noteExternal(st);
    this.store.scheduleSave();
    this.emitChanged();
  }

  /**
   * A clean note opened with a buffer that differs from its snapshot: the
   * file changed while nobody was watching. Own edits made while the
   * snapshot loads are replayed onto it afterwards.
   */
  private verify(st: FileState, file: TFile): void {
    st.verifying = true;
    st.deferred = [];
    void this.enqueue(st.path, async () => {
      const base = await this.states.readBaseline(st);
      const deferred = st.deferred ?? [];
      st.verifying = false;
      st.deferred = undefined;
      if (st.current === undefined) return;
      if (base === null) {
        this.states.persist(st, st.current, true);
        return;
      }
      let baseline = base;
      for (const d of deferred) {
        baseline = mirrorOwnEdits(baseline, this.compute(baseline, d.startText), d.edits);
      }
      if (baseline === st.current) {
        this.states.persist(st, baseline, true);
        this.pushSoon(st);
        return;
      }
      st.baseline = baseline;
      st.entry.status = "modified";
      this.noteExternal(st, file.stat.mtime);
      this.recompute(st);
    });
  }

  async scan(adoptNew: boolean, adoptChanged = false): Promise<void> {
    const vault = this.app.vault;
    const seen = new Set<string>();
    const files = vault.getMarkdownFiles();
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const path = file.path;
      seen.add(path);
      if (!this.isTracked(file)) {
        // Newly excluded (or grown past the size limit): stop tracking it.
        const st = this.states.get(path);
        if (st) this.forget(st);
        continue;
      }
      await this.enqueue(path, async () => {
        const st = this.states.get(path);
        if (!st) {
          if (this.pairing.holdsCreate(path) || this.pairing.holdsDelete(path)) return;
          const data = await vault.read(file);
          if (adoptNew) this.createState(path, data, "clean");
          else {
            const created = this.createState(path, "", "created");
            created.current = data;
            this.noteExternal(created, file.stat.mtime);
            this.recompute(created);
          }
          return;
        }
        if (isPending(st)) {
          if (st.entry.status === "deleted") st.entry.status = "modified";
          if (!this.editors.isOpen(path)) st.current = await vault.read(file);
          this.recompute(st);
          return;
        }
        if (this.editors.isOpen(path)) return;
        if (st.entry.mtime === file.stat.mtime && st.entry.size === file.stat.size && st.entry.hash)
          return;
        const data = await vault.read(file);
        if (hashText(data) === this.states.baselineHash(st)) return this.setStat(st, file);
        const base = adoptChanged ? null : await this.states.readBaseline(st);
        if (base === null) {
          this.states.persist(st, data, true);
          return this.setStat(st, file);
        }
        st.baseline = base;
        st.current = data;
        st.entry.status = "modified";
        this.noteExternal(st, file.stat.mtime);
        this.recompute(st);
      });
      if (i % 50 === 49) await sleep(0);
    }
    for (const st of this.states.all()) {
      if (seen.has(st.path) || st.entry.status === "deleted") continue;
      if (this.fileAt(st.path)) continue;
      if (adoptChanged || st.entry.status === "created") {
        this.forget(st);
        continue;
      }
      if (st.baseline === undefined) st.baseline = (await this.states.readBaseline(st)) ?? undefined;
      if (st.baseline === undefined) {
        this.forget(st);
        continue;
      }
      st.entry.status = "deleted";
      st.current = undefined;
      st.changes = [];
      this.noteExternal(st);
    }
    this.store.isNew = false;
    this.store.scheduleSave();
    this.emitChanged();
    void this.store.pruneOrphans().catch(() => undefined);
  }

  /** Apply edits to the current content: through an open editor, or the file. */
  private async editCurrent(st: FileState, edits: TextEdit[]): Promise<void> {
    const sink = this.editors.for(st.path);
    if (sink) {
      sink.applyEdits(edits);
      return;
    }
    const file = this.fileAt(st.path);
    if (!file || st.current === undefined) return;
    const before = st.current;
    const next = applyEdits(before, edits);
    st.current = next;
    this.recompute(st);
    await this.app.vault.process(file, (data) => (data === before ? next : data));
  }

  private locate(st: FileState, ref: LogicalChange): LogicalChange | null {
    const c = findChange(this.changesFor(st.path), ref);
    if (!c) new Notice("That change has moved. Hover it again to review.");
    return c;
  }

  /** Pull the buffer of an open editor into `current`. */
  private syncFromSink(st: FileState): void {
    const sink = this.editors.for(st.path);
    if (sink) st.current = sink.text();
  }

  private compute(base: string, current: string): LogicalChange[] {
    return computeChanges(base, current, this.settings().grouping);
  }

  private freshChanges(st: FileState, current: string): LogicalChange[] {
    if (st.baseline === undefined) return [];
    if (st.computedFor !== current || st.computedBase !== st.baseline) {
      st.changes = this.compute(st.baseline, current);
      st.computedFor = current;
      st.computedBase = st.baseline;
    }
    return st.changes;
  }

  private schedule(st: FileState, delay: number): void {
    this.pushTimers.set(st.path, delay, () => {
      if (this.states.isLive(st)) this.recompute(st);
    });
  }

  /** Recompute pending changes, settle files that became clean, notify. */
  private recompute(st: FileState): void {
    // Clean files hold no baseline in memory: it equals the current text.
    if (isPending(st) && st.baseline !== undefined && st.current !== undefined)
      this.freshChanges(st, st.current);
    else st.changes = [];
    // A file pending only for its rename can pick up content changes later.
    if (st.entry.status === "clean" && st.changes.length > 0) st.entry.status = "modified";
    if (
      st.entry.status === "modified" &&
      st.changes.length === 0 &&
      st.baseline !== undefined &&
      st.baseline === st.current
    ) {
      st.entry.status = "clean";
      delete st.entry.lastExternal;
      this.states.persist(st, st.baseline);
      if (!st.entry.renamedFrom) {
        st.baseline = undefined;
        st.computedFor = undefined;
        if (!this.editors.isOpen(st.path)) st.current = undefined;
      }
    }
    this.store.scheduleSave();
    this.pushSoon(st);
    this.emitChanged();
  }

  private pushSoon(st: FileState): void {
    this.editors.push(st.path, isPending(st) ? st.changes : [], st.current);
  }

  private setStat(st: FileState, file: TFile): void {
    this.states.setStat(st, file.stat);
  }

  private createState(
    path: string,
    baseline: string,
    status: FileStatus,
    current?: string
  ): FileState {
    const st = this.states.create(path, baseline, status, current);
    const file = this.fileAt(path);
    if (file && status === "clean") this.setStat(st, file);
    return st;
  }

  private forget(st: FileState): void {
    this.states.forget(st);
    this.pushSoon(st);
    this.emitChanged();
  }

  private noteExternal(st: FileState, when = Date.now()): void {
    st.entry.lastExternal = when;
    this.trigger("external", st.path);
  }

  private emitChanged(): void {
    this.trigger("changed");
  }

  private fileAt(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  private async ensureFolder(path: string): Promise<void> {
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir && !this.app.vault.getAbstractFileByPath(normalizePath(dir))) {
      await this.app.vault.createFolder(dir);
    }
  }

  /** Serialize async work per path so reads and writes never interleave. */
  private enqueue(path: string, fn: () => Promise<void> | void): Promise<void> {
    return this.queue.run(path, fn);
  }
}

