/**
 * Fakes for driving the ChangeTracker without Obsidian: an in-memory vault
 * that fires vault events the way Obsidian does, a file manager, and editors
 * that report transactions the way the CM6 extension classifies them.
 */
import type { App } from "obsidian";
import { TFile, TFolder } from "obsidian";
import { vi } from "vitest";
import { TextEdit, applyEdits } from "../src/core/model";
import { OwnMarks } from "../src/core/ownmarks";
import { SnapshotStore } from "../src/core/store";
import { EditorEdit, EditorSink } from "../src/core/editors";
import { ChangeTracker, TrackerSettings } from "../src/core/tracker";
import { DEFAULT_GROUPING, LogicalChange } from "../src/diff/engine";

const PLUGIN_DIR = ".obsidian/plugins/agent-change-review";

/** Disk: plain files keyed by path. Survives "restarts". */
export class FakeAdapter {
  files = new Map<string, string>();
  dirs = new Set<string>();

  async exists(p: string): Promise<boolean> {
    return this.files.has(p) || this.dirs.has(p);
  }
  async mkdir(p: string): Promise<void> {
    this.dirs.add(p);
  }
  async read(p: string): Promise<string> {
    const data = this.files.get(p);
    if (data === undefined) throw new Error(`ENOENT ${p}`);
    return data;
  }
  async write(p: string, data: string): Promise<void> {
    this.files.set(p, data);
  }
  async remove(p: string): Promise<void> {
    this.files.delete(p);
  }
  async rename(from: string, to: string): Promise<void> {
    const data = await this.read(from);
    this.files.delete(from);
    this.files.set(to, data);
  }
  async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
    const files = Array.from(this.files.keys()).filter(
      (k) => k.startsWith(dir + "/") && !k.slice(dir.length + 1).includes("/")
    );
    return { files, folders: [] };
  }
}

type VaultEvent = "modify" | "create" | "delete" | "rename";
type Listener = (file: TFile, oldPath?: string) => void;

/** Notes live under the vault root in `adapter.files` too (Obsidian's view of the disk). */
export class FakeVault {
  configDir = ".obsidian";
  private notes = new Map<string, TFile>();
  private folders = new Set<string>();
  private listeners = new Map<VaultEvent, Listener[]>();
  private clock = 1_000;

  constructor(readonly adapter: FakeAdapter) {}

  on(name: VaultEvent, cb: Listener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), cb]);
  }
  private emit(name: VaultEvent, file: TFile, oldPath?: string): void {
    for (const cb of this.listeners.get(name) ?? []) cb(file, oldPath);
  }

  // ---- reads

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    if (this.notes.has(path)) return this.notes.get(path)!;
    if (this.folders.has(path)) return Object.assign(new TFolder(), { path, name: path });
    return null;
  }
  getMarkdownFiles(): TFile[] {
    return Array.from(this.notes.values()).filter((f) => f.extension === "md");
  }
  async read(file: TFile): Promise<string> {
    return this.adapter.read(file.path);
  }
  async cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }
  content(path: string): string | undefined {
    return this.notes.has(path) ? this.adapter.files.get(path) : undefined;
  }

  // ---- in-app writes (what OwnMarks wraps)

  async create(path: string, data: string): Promise<TFile> {
    if (this.notes.has(path)) throw new Error(`exists: ${path}`);
    const file = this.put(path, data);
    this.emit("create", file);
    return file;
  }
  async modify(file: TFile, data: string): Promise<void> {
    this.put(file.path, data);
    this.emit("modify", file);
  }
  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const out = fn(this.adapter.files.get(file.path) ?? "");
    await this.modify(file, out);
    return out;
  }
  async delete(file: TFile): Promise<void> {
    this.drop(file.path);
    this.emit("delete", file);
  }
  async trash(file: TFile): Promise<void> {
    await this.delete(file);
  }
  async createFolder(path: string): Promise<void> {
    this.folders.add(path);
  }
  async renameInApp(file: TFile, to: string): Promise<void> {
    const from = file.path;
    const data = this.adapter.files.get(from) ?? "";
    this.notes.delete(from);
    this.adapter.files.delete(from);
    this.setPath(file, to);
    this.notes.set(to, file);
    this.adapter.files.set(to, data);
    this.emit("rename", file, from);
  }

  // ---- outside Obsidian (an agent writing to disk), as Obsidian reports it

  external = {
    write: (path: string, data: string): void => {
      const existing = this.notes.get(path);
      const file = this.put(path, data);
      this.emit(existing ? "modify" : "create", file);
    },
    remove: (path: string): void => {
      const file = this.notes.get(path)!;
      this.drop(path);
      this.emit("delete", file);
    },
    /** An external `mv` arrives as delete + create. */
    move: (from: string, to: string): void => {
      const data = this.adapter.files.get(from)!;
      this.external.remove(from);
      this.external.write(to, data);
    },
    /** Changed while Obsidian was closed: no event. */
    writeSilently: (path: string, data: string): void => {
      this.put(path, data);
    },
  };

  private put(path: string, data: string): TFile {
    let file = this.notes.get(path);
    if (!file) {
      file = new TFile();
      this.setPath(file, path);
      this.notes.set(path, file);
    }
    file.stat = { ctime: file.stat.ctime || this.clock, mtime: ++this.clock, size: data.length };
    this.adapter.files.set(path, data);
    return file;
  }
  private drop(path: string): void {
    this.notes.delete(path);
    this.adapter.files.delete(path);
  }
  private setPath(file: TFile, path: string): void {
    file.path = path;
    file.name = path.split("/").pop()!;
    file.extension = file.name.includes(".") ? file.name.split(".").pop()! : "";
    file.basename = file.name.replace(/\.[^.]*$/, "");
  }
}

class FakeFileManager {
  constructor(private vault: FakeVault) {}
  async trashFile(file: TFile): Promise<void> {
    await this.vault.trash(file);
  }
  async renameFile(file: TFile, to: string): Promise<void> {
    await this.vault.renameInApp(file, to);
  }
  async processFrontMatter(): Promise<void> {}
}

/**
 * An open editor. Transactions are classified as the CM6 extension would:
 * typing is `own`, a disk reload is `reload`, and the tracker's reject edits
 * are `plugin`.
 */
export class FakeEditor implements EditorSink {
  changes: LogicalChange[] = [];

  constructor(
    private tracker: ChangeTracker,
    private notePath: string,
    public doc: string
  ) {}

  path(): string | null {
    return this.notePath;
  }
  text(): string {
    return this.doc;
  }
  setChanges(changes: LogicalChange[], text: string): void {
    if (text === this.doc) this.changes = changes;
  }
  applyEdits(edits: TextEdit[]): void {
    this.transact(edits, "plugin");
  }

  type(from: number, to: number, insert: string): void {
    this.transact([{ from, to, insert }], "own");
  }
  /** Obsidian reloading the buffer after the file changed on disk. */
  reload(text: string): void {
    this.transact([{ from: 0, to: this.doc.length, insert: text }], "reload");
  }

  private transact(edits: TextEdit[], kind: EditorEdit["kind"]): void {
    const startText = this.doc;
    this.doc = applyEdits(startText, edits);
    if (this.tracker.wants(this.notePath)) {
      this.tracker.onEditorEdit(this, { kind, startText, endText: this.doc, edits });
    }
  }
}

export interface Harness {
  vault: FakeVault;
  adapter: FakeAdapter;
  tracker: ChangeTracker;
  settings: TrackerSettings & { pluginWritesAreAgent: boolean };
  marks: OwnMarks;
  externalEvents: string[];
  /** Open a note in an editor (attached like the ViewPlugin does). */
  open(path: string): FakeEditor;
  close(editor: FakeEditor): void;
  /** External write to a note that is open: disk event plus the editor reload. */
  writeOpen(editor: FakeEditor, path: string, data: string): void;
  /** Simulate quitting Obsidian and starting it again on the same disk. */
  restart(): Promise<Harness>;
}

/** Let debounces, rename pairing windows, and queued async work finish. */
export async function settle(ms = 10_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

export async function createHarness(
  files: Record<string, string> = {},
  opts: { adapter?: FakeAdapter; vault?: FakeVault; settings?: Partial<Harness["settings"]> } = {}
): Promise<Harness> {
  const adapter = opts.adapter ?? new FakeAdapter();
  const vault = opts.vault ?? new FakeVault(adapter);
  for (const [path, data] of Object.entries(files)) vault.external.writeSilently(path, data);

  const settings = {
    excluded: [],
    maxFileSizeKB: 1024,
    grouping: { ...DEFAULT_GROUPING },
    pluginWritesAreAgent: true,
    ...opts.settings,
  };
  const app = { vault, fileManager: new FakeFileManager(vault) } as unknown as App;
  const marks = new OwnMarks(app, () => settings.pluginWritesAreAgent);
  marks.install();
  const tracker = new ChangeTracker(app, new SnapshotStore(adapter as never, PLUGIN_DIR), marks, () => settings);
  await tracker.load();

  const externalEvents: string[] = [];
  tracker.on("external", (p) => externalEvents.push(p as string));
  vault.on("modify", (f) => tracker.onModify(f));
  vault.on("create", (f) => tracker.onCreate(f));
  vault.on("delete", (f) => tracker.onDelete(f));
  vault.on("rename", (f, old) => tracker.onRename(f, old!));
  tracker.start();
  await settle();

  const h: Harness = {
    vault,
    adapter,
    tracker,
    settings,
    marks,
    externalEvents,
    open(path) {
      const editor = new FakeEditor(tracker, path, vault.content(path) ?? "");
      tracker.attach(editor);
      return editor;
    },
    close(editor) {
      tracker.detach(editor);
    },
    writeOpen(editor, path, data) {
      vault.external.write(path, data);
      editor.reload(data);
    },
    async restart() {
      await tracker.shutdown();
      marks.uninstall();
      return createHarness({}, { adapter, vault: new FakeVaultFrom(vault, adapter), settings });
    },
  };
  return h;
}

/** A fresh vault object (no listeners) over the same notes, as after a restart. */
class FakeVaultFrom extends FakeVault {
  constructor(old: FakeVault, adapter: FakeAdapter) {
    super(adapter);
    for (const f of old.getMarkdownFiles()) {
      this.external.writeSilently(f.path, adapter.files.get(f.path)!);
    }
  }
}

/** Pending files as `path: status` strings, for compact assertions. */
export function pendingSummary(tracker: ChangeTracker): string[] {
  return tracker.pending().map((p) => `${p.path}: ${p.status}${p.renamedFrom ? ` from ${p.renamedFrom}` : ""}`);
}
