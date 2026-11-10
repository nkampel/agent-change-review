import { DataAdapter } from "obsidian";
import { hashText } from "./hash";

/**
 * Persistent baselines (docs/DESIGN.md §9).
 *
 * Every tracked note has a snapshot file holding its last reviewed content,
 * plus an entry in `index.json`. Snapshots are keyed by a random id rather
 * than by path, so a rename only touches the index.
 *
 * Writes are not atomic. Instead every snapshot is verified against the hash
 * recorded in the index when read: a torn or missing snapshot reads as
 * `null`, and the tracker then adopts the current content as baseline rather
 * than reporting a bogus diff.
 */

export type FileStatus = "clean" | "modified" | "created" | "deleted";

export interface IndexEntry {
  /** Snapshot file id. */
  id: string;
  /** Hash of the baseline content stored in the snapshot. */
  hash: string;
  status: FileStatus;
  /** Set when an external rename moved the file here and it is not yet reviewed. */
  renamedFrom?: string;
  /** Time of the most recent unreviewed external change (ms). */
  lastExternal?: number;
  /** Disk stat when the file was last confirmed to equal the baseline. */
  mtime?: number;
  size?: number;
}

interface IndexFile {
  version: 1;
  entries: Record<string, IndexEntry>;
}

export class SnapshotStore {
  readonly entries = new Map<string, IndexEntry>();
  /** True when no index existed yet: the first scan snapshots silently. */
  isNew = false;

  private saveTimer: number | null = null;
  private writeChains = new Map<string, Promise<void>>();

  constructor(
    private adapter: DataAdapter,
    private dir: string
  ) {}

  private get indexPath(): string {
    return `${this.dir}/index.json`;
  }

  private snapshotPath(id: string): string {
    return `${this.dir}/snapshots/${id}.md`;
  }

  async load(): Promise<void> {
    if (!(await this.adapter.exists(`${this.dir}/snapshots`))) {
      await this.adapter.mkdir(`${this.dir}/snapshots`);
    }
    let raw: string | null = null;
    if (await this.adapter.exists(this.indexPath)) raw = await this.adapter.read(this.indexPath);
    else if (await this.adapter.exists(this.indexPath + ".tmp")) {
      // Crashed between writing the temp file and swapping it in.
      raw = await this.adapter.read(this.indexPath + ".tmp");
    }
    if (raw === null) {
      this.isNew = true;
      return;
    }
    try {
      const parsed = JSON.parse(raw) as IndexFile;
      for (const [path, entry] of Object.entries(parsed.entries ?? {})) {
        this.entries.set(path, entry);
      }
    } catch (e) {
      console.error("[agent-change-review] index.json unreadable, starting fresh", e);
      this.isNew = true;
    }
  }

  newId(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** Read a snapshot; `null` when missing or not matching the recorded hash. */
  async read(entry: IndexEntry): Promise<string | null> {
    await this.writeChains.get(entry.id);
    const p = this.snapshotPath(entry.id);
    if (!(await this.adapter.exists(p))) return entry.hash === hashText("") ? "" : null;
    const text = await this.adapter.read(p);
    return hashText(text) === entry.hash ? text : null;
  }

  /** Write a snapshot; writes per id are serialized in call order. */
  write(entry: IndexEntry, text: string): Promise<void> {
    entry.hash = hashText(text);
    this.scheduleSave();
    const id = entry.id;
    const prev = this.writeChains.get(id) ?? Promise.resolve();
    const next = prev
      .then(() => this.adapter.write(this.snapshotPath(id), text))
      .catch((e) => console.error("[agent-change-review] snapshot write failed", e));
    this.writeChains.set(id, next);
    void next.then(() => {
      if (this.writeChains.get(id) === next) this.writeChains.delete(id);
    });
    return next;
  }

  async remove(entry: IndexEntry): Promise<void> {
    await this.writeChains.get(entry.id);
    const p = this.snapshotPath(entry.id);
    try {
      if (await this.adapter.exists(p)) await this.adapter.remove(p);
    } catch (e) {
      console.error("[agent-change-review] snapshot remove failed", e);
    }
  }

  /** Remove snapshot files no index entry refers to. */
  async pruneOrphans(): Promise<void> {
    const live = new Set(Array.from(this.entries.values(), (e) => e.id));
    const listing = await this.adapter.list(`${this.dir}/snapshots`);
    for (const file of listing.files) {
      const id = file.split("/").pop()?.replace(/\.md$/, "");
      if (id && !live.has(id)) await this.adapter.remove(file);
    }
  }

  scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveIndex();
    }, 1000);
  }

  async saveIndex(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const data: IndexFile = { version: 1, entries: Object.fromEntries(this.entries) };
    const json = JSON.stringify(data);
    const tmp = this.indexPath + ".tmp";
    try {
      await this.adapter.write(tmp, json);
      if (await this.adapter.exists(this.indexPath)) await this.adapter.remove(this.indexPath);
      await this.adapter.rename(tmp, this.indexPath);
    } catch (e) {
      console.error("[agent-change-review] index save failed", e);
    }
  }

  /** Wait for all queued snapshot writes, then persist the index. */
  async flush(): Promise<void> {
    await Promise.all(this.writeChains.values());
    await this.saveIndex();
  }
}
