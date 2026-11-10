import { LogicalChange } from "../diff/engine";
import { TextEdit } from "./model";

/** An open editor showing a note, as the tracker sees it. */
export interface EditorSink {
  /** Vault path of the note this editor shows (follows renames). */
  path(): string | null;
  text(): string;
  /** Deliver changes computed for `text`; ignored if the editor moved on. */
  setChanges(changes: LogicalChange[], text: string): void;
  /** Apply edits (in current-text coordinates) as one undoable transaction. */
  applyEdits(edits: TextEdit[]): void;
}

/**
 * One editor transaction, classified by the editor extension:
 * - `own`: typing, paste, commands — the user's own edit;
 * - `reload`: Obsidian replaced the buffer from disk (an external write,
 *   or another pane of the same note syncing);
 * - `plugin`: this plugin's own reject edit, or undoing one.
 */
export interface EditorEdit {
  kind: "own" | "reload" | "plugin";
  startText: string;
  endText: string;
  /** Edits in `startText` coordinates. */
  edits: TextEdit[];
}

/** The set of attached editors. Several panes may show the same note. */
export class EditorRegistry {
  private sinks = new Set<EditorSink>();

  add(sink: EditorSink): void {
    this.sinks.add(sink);
  }

  remove(sink: EditorSink): void {
    this.sinks.delete(sink);
  }

  /** Any editor showing `path` (its buffer is the note's current text). */
  for(path: string): EditorSink | null {
    for (const s of this.sinks) if (s.path() === path) return s;
    return null;
  }

  isOpen(path: string): boolean {
    return this.for(path) !== null;
  }

  /** Deliver `changes` to every editor showing `path`. */
  push(path: string, changes: LogicalChange[], current: string | undefined): void {
    for (const sink of this.sinks) {
      if (sink.path() === path) this.pushTo(sink, changes, current ?? sink.text());
    }
  }

  /** Never dispatch into an editor synchronously: we may be inside its update. */
  pushTo(sink: EditorSink, changes: LogicalChange[], text: string): void {
    window.setTimeout(() => {
      if (this.sinks.has(sink)) sink.setChanges(changes, text);
    }, 0);
  }
}
