import { LogicalChange } from "../diff/engine";
import { hashText } from "./hash";
import { TextEdit } from "./model";
import { FileStatus, IndexEntry, SnapshotStore } from "./store";

/**
 * In-memory state of every tracked note, kept in step with the snapshot
 * store's index. Owns baseline persistence: snapshot writes are debounced,
 * and anything reading a baseline must go through `readBaseline` /
 * `baselineHash`, where a not-yet-written snapshot wins over the file.
 */

export interface FileState {
  path: string;
  entry: IndexEntry;
  /** Reviewed content. Always loaded while the file is pending. */
  baseline?: string;
  /** Last known current content (pending files, and clean files open in an editor). */
  current?: string;
  changes: LogicalChange[];
  computedFor?: string;
  computedBase?: string;
  /** Debounced snapshot write. */
  persistTimer?: number;
  persistText?: string;
  /** A clean open file whose buffer differs from its snapshot is being checked. */
  verifying?: boolean;
  deferred?: { startText: string; edits: TextEdit[] }[];
}

/** Pending: has something to review (content, or only an unreviewed move). */
export function isPending(st: FileState): boolean {
  return st.entry.status !== "clean" || !!st.entry.renamedFrom;
}

const PERSIST_DEBOUNCE = 1500;

export class FileStates {
  private states = new Map<string, FileState>();

  constructor(readonly store: SnapshotStore) {}

  get(path: string): FileState | undefined {
    return this.states.get(path);
  }

  has(path: string): boolean {
    return this.states.has(path);
  }

  /** Is `st` still the live state for its path (not replaced or forgotten)? */
  isLive(st: FileState): boolean {
    return this.states.get(st.path) === st;
  }

  all(): FileState[] {
    return Array.from(this.states.values());
  }

  /** Track a state object (e.g. one restored from the index or a pending delete). */
  put(st: FileState): void {
    this.states.set(st.path, st);
  }

  /** Stop tracking `path` in memory; its index entry and snapshot stay. */
  take(path: string): FileState | undefined {
    const st = this.states.get(path);
    this.states.delete(path);
    return st;
  }

  /** New index entry + state; writes `baseline` as its snapshot. */
  create(path: string, baseline: string, status: FileStatus, current?: string): FileState {
    const entry: IndexEntry = { id: this.store.newId(), hash: "", status };
    this.store.entries.set(path, entry);
    const st: FileState = { path, entry, changes: [] };
    if (status !== "clean") st.baseline = baseline;
    if (current !== undefined) st.current = current;
    this.states.set(path, st);
    void this.store.write(entry, baseline);
    return st;
  }

  /** Drop a file entirely: state, index entry, and snapshot. */
  forget(st: FileState): void {
    if (st.persistTimer !== undefined) window.clearTimeout(st.persistTimer);
    st.persistTimer = undefined;
    st.persistText = undefined;
    if (this.states.get(st.path) === st) this.states.delete(st.path);
    if (this.store.entries.get(st.path) === st.entry) this.store.entries.delete(st.path);
    void this.store.remove(st.entry);
    st.changes = [];
    this.store.scheduleSave();
  }

  /** Re-key a state to a new path (rename). Replaces any stale state there. */
  move(st: FileState, to: string): void {
    const from = st.path;
    if (this.states.get(from) === st) this.states.delete(from);
    if (this.store.entries.get(from) === st.entry) this.store.entries.delete(from);
    const stale = this.states.get(to);
    if (stale && stale !== st) void this.store.remove(stale.entry);
    st.path = to;
    this.states.set(to, st);
    this.store.entries.set(to, st.entry);
    this.store.scheduleSave();
  }

  /** Store `text` as the baseline snapshot, debounced unless `immediate`. */
  persist(st: FileState, text: string, immediate = false): void {
    st.persistText = text;
    if (st.persistTimer !== undefined) window.clearTimeout(st.persistTimer);
    st.persistTimer = undefined;
    if (immediate) this.flushPersist(st);
    else st.persistTimer = window.setTimeout(() => this.flushPersist(st), PERSIST_DEBOUNCE);
  }

  flushPersist(st: FileState): void {
    if (st.persistTimer !== undefined) window.clearTimeout(st.persistTimer);
    st.persistTimer = undefined;
    if (st.persistText === undefined) return;
    const text = st.persistText;
    st.persistText = undefined;
    if (this.store.entries.get(st.path) !== st.entry) return;
    void this.store.write(st.entry, text);
  }

  flushAll(): void {
    for (const st of this.states.values()) this.flushPersist(st);
  }

  /** Baseline text: a not-yet-written snapshot wins over the one on disk. */
  readBaseline(st: FileState): Promise<string | null> {
    if (st.persistText !== undefined) return Promise.resolve(st.persistText);
    return this.store.read(st.entry);
  }

  baselineHash(st: FileState): string {
    return st.persistText !== undefined ? hashText(st.persistText) : st.entry.hash;
  }

  /** Record the disk stat at which the file was confirmed to equal its baseline. */
  setStat(st: FileState, stat: { mtime: number; size: number }): void {
    st.entry.mtime = stat.mtime;
    st.entry.size = stat.size;
    this.store.scheduleSave();
  }
}
