import { FileState } from "./filestate";
import { KeyedTimers } from "./timing";

/**
 * An external `mv` reaches Obsidian as a delete followed by a create of the
 * same content. Both events are held back briefly so they can be paired into
 * a rename; unpaired ones resolve as a plain delete or create.
 */

/** Window for pairing an external delete + create into a rename. */
const PAIR_WINDOW = 1500;

interface HeldDelete {
  st: FileState;
  /** Hash of the deleted file's last known content. */
  hash: string;
  timer: number;
}

export class RenamePairing {
  private creates = new KeyedTimers<string>();
  private deletes = new Map<string, HeldDelete>();

  constructor(
    private resolveCreate: (path: string) => void,
    private resolveDelete: (st: FileState) => void
  ) {}

  /** A create at `path` is still waiting for a possible matching delete. */
  holdsCreate(path: string): boolean {
    return this.creates.has(path);
  }

  holdsDelete(path: string): boolean {
    return this.deletes.has(path);
  }

  holdCreate(path: string): void {
    this.creates.set(path, PAIR_WINDOW, () => this.resolveCreate(path));
  }

  /** The created file went away again before resolving. */
  dropCreate(path: string): void {
    this.creates.clear(path);
  }

  holdDelete(st: FileState, hash: string): void {
    const path = st.path;
    // Each held delete resolves on its own, even if the path is deleted again
    // meanwhile. Longer than the create window, so a create can always claim it.
    const held: HeldDelete = {
      st,
      hash,
      timer: window.setTimeout(() => {
        if (this.deletes.get(path) === held) this.deletes.delete(path);
        this.resolveDelete(st);
      }, PAIR_WINDOW * 2),
    };
    this.deletes.set(path, held);
  }

  /** Claim a held delete whose content matches `hash` (the rename source). */
  claimDelete(hash: string): { oldPath: string; st: FileState } | null {
    for (const [oldPath, d] of this.deletes) {
      if (d.hash !== hash) continue;
      window.clearTimeout(d.timer);
      this.deletes.delete(oldPath);
      return { oldPath, st: d.st };
    }
    return null;
  }

  dispose(): void {
    this.creates.clearAll();
    for (const d of this.deletes.values()) window.clearTimeout(d.timer);
    this.deletes.clear();
  }
}
