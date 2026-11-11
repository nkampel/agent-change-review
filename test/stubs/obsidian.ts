/**
 * Minimal runtime stand-in for the `obsidian` module (which only exists
 * inside the app). Vitest aliases `obsidian` to this file; types still come
 * from the real package.
 */
import { StateField } from "@codemirror/state";

type Callback = (...args: unknown[]) => unknown;

export interface EventRef {
  name: string;
  cb: Callback;
}

export class Events {
  private handlers = new Map<string, Set<Callback>>();

  on(name: string, cb: Callback): EventRef {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(cb);
    return { name, cb };
  }

  offref(ref: EventRef): void {
    this.handlers.get(ref.name)?.delete(ref.cb);
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(name) ?? []) cb(...args);
  }
}

export class Notice {
  static messages: string[] = [];
  containerEl = document.createElement("div");
  messageEl = document.createElement("div");
  constructor(message: string) {
    Notice.messages.push(message);
  }
  hide(): void {}
}

export class TAbstractFile {
  path = "";
  name = "";
}

export class TFile extends TAbstractFile {
  basename = "";
  extension = "";
  stat = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

/** In Obsidian this field is provided by the app's editor. */
export const editorInfoField = StateField.define<{ file: { path: string } | null }>({
  create: () => ({ file: null }),
  update: (v) => v,
});
