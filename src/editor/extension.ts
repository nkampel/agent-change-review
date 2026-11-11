import {
  Annotation,
  ChangeSet,
  EditorState,
  Extension,
  Range,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import {
  Decoration,
  DecorationSet,
  EditorView,
  PluginValue,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { ChangeKind, LogicalChange } from "../diff/engine";
import { TextEdit } from "../core/model";
import { EditorEdit, EditorSink } from "../core/editors";
import { ChangeTracker } from "../core/tracker";

/**
 * Inline review layer for Obsidian's Markdown editor (Source + Live Preview).
 *
 * The extension only renders what the tracker computed and reports document
 * changes back; it holds no review state of its own besides the inverse of
 * recent rejects, needed to recognise "undo reject" (§7).
 */

export interface DisplayOptions {
  deletionDisplay: "marker" | "inline";
  changeBars: boolean;
}

export interface ReviewHost {
  tracker: ChangeTracker;
  display(): DisplayOptions;
  /** Hover entered a change's highlight. */
  hover(sink: ReviewSink, change: LogicalChange, anchor: DOMRect): void;
  /** Pointer left a highlight (the bubble decides whether to close). */
  unhover(): void;
  /** The editor scrolled; floating UI anchored to it is now misplaced. */
  scrolled(): void;
}

/** Marks this plugin's own reject transactions. */
export const reviewEdit = Annotation.define<"reject">();

interface PendingDecorations {
  changes: LogicalChange[];
  decorations: DecorationSet;
}

const setPending = StateEffect.define<{
  changes: LogicalChange[];
  decorations: DecorationSet;
}>();

const pendingField = StateField.define<PendingDecorations>({
  create: () => ({ changes: [], decorations: Decoration.none }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPending)) return e.value;
    if (!tr.docChanged) return value;
    return { changes: value.changes, decorations: value.decorations.map(tr.changes) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

/**
 * Recent reject transactions, kept mapped to the current doc, so undo/redo of
 * a reject can be recognised (§7). Undoing a reject restores agent text and
 * must not be mirrored into the baseline like an own edit.
 *
 * `inverses` undo a reject; `forwards` redo one that was undone.
 */
interface RejectHistory {
  inverses: ChangeSet[];
  forwards: ChangeSet[];
}

export const rejectInverses = StateField.define<RejectHistory>({
  create: () => ({ inverses: [], forwards: [] }),
  update(value, tr) {
    if (!tr.docChanged) return value;
    let { inverses, forwards } = value;
    let addInverse = false;
    let addForward = false;
    if (tr.isUserEvent("undo") && inverses.some((c) => sameChanges(c, tr.changes))) {
      inverses = inverses.filter((c) => !sameChanges(c, tr.changes));
      addForward = true;
    } else if (tr.isUserEvent("redo") && forwards.some((c) => sameChanges(c, tr.changes))) {
      forwards = forwards.filter((c) => !sameChanges(c, tr.changes));
      addInverse = true;
    } else if (tr.annotation(reviewEdit) === "reject") {
      addInverse = true;
    }
    // Existing entries apply to the old doc and are mapped forward; the new
    // one is this transaction's inverse, which already applies to the new doc.
    const map = (list: ChangeSet[]) => list.slice(-30).map((c) => c.map(tr.changes));
    inverses = map(inverses);
    forwards = map(forwards);
    const inverted = tr.changes.invert(tr.startState.doc);
    if (addInverse) inverses.push(inverted);
    if (addForward) forwards.push(inverted);
    return { inverses, forwards };
  },
});

function sameChanges(a: ChangeSet, b: ChangeSet): boolean {
  return JSON.stringify(a.toJSON()) === JSON.stringify(b.toJSON());
}

export function classify(tr: Transaction): EditorEdit["kind"] {
  if (tr.annotation(reviewEdit)) return "plugin";
  // Obsidian dispatches disk reloads (and pane syncs) with userEvent "set".
  if (tr.isUserEvent("set")) return "reload";
  if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) {
    const history = tr.startState.field(rejectInverses, false);
    const list = tr.isUserEvent("undo") ? history?.inverses : history?.forwards;
    if (list?.some((c) => sameChanges(c, tr.changes))) return "plugin";
  }
  return "own";
}

function editsOf(tr: Transaction): TextEdit[] {
  const edits: TextEdit[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    edits.push({ from: fromA, to: toA, insert: inserted.toString() });
  });
  return edits;
}

// ------------------------------------------------------------- decorations

class DeletionMarker extends WidgetType {
  constructor(
    readonly id: string,
    readonly text: string,
    readonly inline: boolean
  ) {
    super();
  }

  eq(other: DeletionMarker): boolean {
    return other.id === this.id && other.inline === this.inline;
  }

  toDOM(): HTMLElement {
    if (this.inline) {
      return createSpan({ cls: "acr-ch acr-del-inline", text: this.text, attr: { "data-acr-id": this.id } });
    }
    return createSpan({
      cls: "acr-ch acr-del-marker",
      attr: { "data-acr-id": this.id, "aria-label": "Removed text" },
    });
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function buildDecorations(
  state: EditorState,
  changes: LogicalChange[],
  display: DisplayOptions
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const lineKinds = new Map<number, ChangeKind>();
  const doc = state.doc;
  for (const c of changes) {
    if (c.currentTo > doc.length) continue;
    if (c.kind === "deletion") {
      ranges.push(
        Decoration.widget({
          widget: new DeletionMarker(c.id, c.baseText, display.deletionDisplay === "inline"),
          side: 1,
        }).range(c.currentFrom)
      );
    } else {
      ranges.push(
        Decoration.mark({
          class: `acr-ch acr-ch-${c.kind} acr-gran-${c.granularity}`,
          attributes: { "data-acr-id": c.id },
        }).range(c.currentFrom, c.currentTo)
      );
    }
    if (display.changeBars) {
      // Text added after a line break does not change the line before it.
      let start = c.currentFrom;
      while (start < c.currentTo && doc.sliceString(start, start + 1) === "\n") start++;
      const first = doc.lineAt(start).number;
      const last = doc.lineAt(Math.max(start, c.currentTo - 1)).number;
      for (let n = first; n <= last; n++) {
        const from = doc.line(n).from;
        const prev = lineKinds.get(from);
        // Mixed kinds on one line read as "changed".
        lineKinds.set(from, prev && prev !== c.kind ? "replacement" : c.kind);
      }
    }
  }
  for (const [from, kind] of lineKinds) {
    ranges.push(Decoration.line({ class: `acr-line acr-line-${kind}` }).range(from));
  }
  return Decoration.set(ranges, true);
}

// ------------------------------------------------------------- view plugin

export class ReviewSink implements EditorSink, PluginValue {
  private onOver = (e: MouseEvent) => this.handleOver(e);
  private onOut = (e: MouseEvent) => this.handleOut(e);
  private onScroll = () => this.host.scrolled();

  constructor(
    readonly view: EditorView,
    private host: ReviewHost
  ) {
    view.contentDOM.addEventListener("mouseover", this.onOver);
    view.contentDOM.addEventListener("mouseout", this.onOut);
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    host.tracker.attach(this);
  }

  path(): string | null {
    const info = this.view.state.field(editorInfoField, false);
    return info?.file?.path ?? null;
  }

  text(): string {
    return this.view.state.doc.toString();
  }

  /** Changes as last delivered (positions mapped through later edits). */
  get changes(): LogicalChange[] {
    return this.view.state.field(pendingField).changes;
  }

  setChanges(changes: LogicalChange[], text: string): void {
    const state = this.view.state;
    if (state.doc.length !== text.length || state.doc.toString() !== text) return;
    this.view.dispatch({
      effects: setPending.of({
        changes,
        decorations: buildDecorations(state, changes, this.host.display()),
      }),
    });
  }

  applyEdits(edits: TextEdit[]): void {
    this.view.dispatch({
      changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })),
      annotations: [
        reviewEdit.of("reject"),
        isolateHistory.of("full"),
        Transaction.userEvent.of("acr.reject"),
      ],
    });
  }

  update(u: ViewUpdate): void {
    if (!u.docChanged || !this.host.tracker.wants(this.path())) return;
    for (const tr of u.transactions) {
      if (!tr.docChanged) continue;
      this.host.tracker.onEditorEdit(this, {
        kind: classify(tr),
        startText: tr.startState.doc.toString(),
        endText: tr.newDoc.toString(),
        edits: editsOf(tr),
      });
    }
  }

  destroy(): void {
    this.view.contentDOM.removeEventListener("mouseover", this.onOver);
    this.view.contentDOM.removeEventListener("mouseout", this.onOut);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.host.tracker.detach(this);
  }

  /** Select a change, scroll it into view, and return where it sits on screen. */
  reveal(change: LogicalChange): void {
    this.view.dispatch({
      selection: { anchor: change.currentFrom, head: change.currentTo },
      effects: EditorView.scrollIntoView(change.currentFrom, { y: "center" }),
    });
    this.view.focus();
  }

  /** Screen rect of a change, once the view has laid it out. */
  rectOf(change: LogicalChange): Promise<DOMRect | null> {
    return new Promise((resolve) => {
      this.view.requestMeasure({
        read: (view) => {
          const start = view.coordsAtPos(change.currentFrom, 1);
          const end = view.coordsAtPos(Math.max(change.currentFrom, change.currentTo), -1);
          if (!start) return null;
          const bottom = end && end.top === start.top ? end.bottom : start.bottom;
          const right = end && end.top === start.top ? end.right : start.right + 2;
          return new DOMRect(start.left, start.top, Math.max(2, right - start.left), bottom - start.top);
        },
        write: (rect) => resolve(rect),
      });
    });
  }

  private changeFor(el: HTMLElement): LogicalChange | null {
    const id = el.getAttribute("data-acr-id");
    return this.changes.find((c) => c.id === id) ?? null;
  }

  private handleOver(e: MouseEvent): void {
    const target = (e.target as HTMLElement | null)?.closest?.("[data-acr-id]");
    if (!target?.instanceOf(HTMLElement)) return;
    const change = this.changeFor(target);
    if (change) this.host.hover(this, change, target.getBoundingClientRect());
  }

  private handleOut(e: MouseEvent): void {
    const from = (e.target as HTMLElement | null)?.closest?.("[data-acr-id]");
    if (!from) return;
    const to = (e.relatedTarget as HTMLElement | null)?.closest?.("[data-acr-id]");
    if (to && to.getAttribute("data-acr-id") === from.getAttribute("data-acr-id")) return;
    this.host.unhover();
  }
}

export function reviewExtension(host: ReviewHost): {
  extension: Extension;
  plugin: ViewPlugin<ReviewSink>;
} {
  const plugin = ViewPlugin.define((view) => new ReviewSink(view, host));
  return { extension: [pendingField, rejectInverses, plugin], plugin };
}
