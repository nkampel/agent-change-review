import { App, TAbstractFile } from "obsidian";
import { around } from "monkey-around";
import { hashText } from "./hash";

/**
 * Tells Obsidian's own file operations apart from external ones.
 *
 * Obsidian fires the same vault events whether a note was created, deleted or
 * written from inside the app or by an agent on disk. The plugin wraps the
 * in-app entry points and records what they are about to do; the tracker then
 * asks these marks when the matching event arrives.
 *
 * - creates (`vault.create`, `vault.copy`) and deletes (`vault.delete`,
 *   `vault.trash`, `fileManager.trashFile`) are always own;
 * - content writes made while Obsidian updates links after a rename, or
 *   through `processFrontMatter`, are own;
 * - other plugins' `vault.modify` / `vault.process` writes are own only when
 *   the "count plugin writes as agent changes" setting is off.
 *
 * Marks expire after a few seconds so a stale mark never hides a later
 * external change.
 */

const MARK_TTL = 5000;

type Restore = () => void;
type Method = (this: unknown, ...args: unknown[]) => unknown;

export class OwnMarks {
  private creates = new Map<string, number>();
  private deletes = new Map<string, number>();
  private contents = new Map<string, { hash: string; until: number }[]>();
  /** >0 while a rename's link update or a frontmatter write is running. */
  private ownWriteDepth = 0;
  private restores: Restore[] = [];

  constructor(
    private app: App,
    private pluginWritesAreAgent: () => boolean
  ) {}

  install(): void {
    const vault = this.app.vault;
    const fm = this.app.fileManager;
    // Arrow helpers keep the plugin instance reachable from the wrappers below,
    // whose own `this` must stay the wrapped object (vault / file manager).
    const markCreate = (path: string) => this.mark(this.creates, path);
    const markDelete = (path: string) => this.mark(this.deletes, path);
    const writesAreOwn = () => this.writesAreOwn();
    const markContent = (path: string, text: string) => this.markContent(path, text);
    const enterOwnWrite = () => this.ownWriteDepth++;
    const leaveOwnWrite = () => this.ownWriteDepth--;

    this.wrap(vault, "create", (orig) =>
      function (this: unknown, ...args: unknown[]) {
        markCreate(args[0] as string);
        return orig.apply(this, args);
      }
    );
    this.wrap(vault, "copy", (orig) =>
      function (this: unknown, ...args: unknown[]) {
        markCreate(args[1] as string);
        return orig.apply(this, args);
      }
    );
    for (const name of ["delete", "trash"]) {
      this.wrap(vault, name, (orig) =>
        function (this: unknown, ...args: unknown[]) {
          markDelete((args[0] as TAbstractFile).path);
          return orig.apply(this, args);
        }
      );
    }
    this.wrap(fm, "trashFile", (orig) =>
      function (this: unknown, ...args: unknown[]) {
        markDelete((args[0] as TAbstractFile).path);
        return orig.apply(this, args);
      }
    );
    // Link updates after a rename run inside renameFile's promise.
    for (const name of ["renameFile", "processFrontMatter"]) {
      this.wrap(fm, name, (orig) =>
        async function (this: unknown, ...args: unknown[]) {
          enterOwnWrite();
          try {
            return await orig.apply(this, args);
          } finally {
            // Content marks are taken at write time, so the window only
            // needs to span the call; the events may arrive later.
            leaveOwnWrite();
          }
        }
      );
    }
    this.wrap(vault, "modify", (orig) =>
      function (this: unknown, ...args: unknown[]) {
        if (writesAreOwn()) markContent((args[0] as { path: string }).path, args[1] as string);
        return orig.apply(this, args);
      }
    );
    this.wrap(vault, "process", (orig) =>
      function (this: unknown, ...args: unknown[]) {
        if (!writesAreOwn()) return orig.apply(this, args);
        const [file, fn, ...rest] = args as [{ path: string }, (data: string) => string, ...unknown[]];
        const capture = (data: string): string => {
          const out = fn(data);
          markContent(file.path, out);
          return out;
        };
        return orig.call(this, file, capture, ...rest);
      }
    );
  }

  uninstall(): void {
    for (const r of this.restores.reverse()) r();
    this.restores = [];
  }

  private writesAreOwn(): boolean {
    return this.ownWriteDepth > 0 || !this.pluginWritesAreAgent();
  }

  /**
   * Wrap `target[name]` via monkey-around, so uninstalling is safe even when
   * another plugin wrapped the same method after us.
   */
  private wrap(target: object, name: string, make: (orig: Method) => Method): void {
    const host = target as Record<string, Method>;
    if (typeof host[name] !== "function") return;
    this.restores.push(around(host, { [name]: make }));
  }

  private mark(map: Map<string, number>, path: string): void {
    map.set(path, Date.now() + MARK_TTL);
  }

  /** Is `path` (or a folder containing it) marked in `map`? */
  private hasMark(map: Map<string, number>, path: string): boolean {
    const now = Date.now();
    for (const [p, until] of map) {
      if (until < now) {
        map.delete(p);
        continue;
      }
      if (p === path || path.startsWith(p + "/")) return true;
    }
    return false;
  }

  isOwnCreate(path: string): boolean {
    return this.hasMark(this.creates, path);
  }

  isOwnDelete(path: string): boolean {
    return this.hasMark(this.deletes, path);
  }

  /** The plugin is about to create or delete a file itself. */
  expectCreate(path: string): void {
    this.mark(this.creates, path);
  }

  expectDelete(path: string): void {
    this.mark(this.deletes, path);
  }

  markContent(path: string, text: string): void {
    const now = Date.now();
    const list = (this.contents.get(path) ?? []).filter((m) => m.until >= now);
    list.push({ hash: hashText(text), until: now + MARK_TTL });
    this.contents.set(path, list);
  }

  /** Was `text` written to `path` by Obsidian itself? Consumes the mark. */
  takeContent(path: string, text: string): boolean {
    const list = this.contents.get(path);
    if (!list) return false;
    const now = Date.now();
    const h = hashText(text);
    const idx = list.findIndex((m) => m.hash === h && m.until >= now);
    if (idx < 0) return false;
    list.splice(idx, 1);
    if (list.length === 0) this.contents.delete(path);
    return true;
  }
}
