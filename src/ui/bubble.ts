import { LogicalChange, kindLabel } from "../diff/engine";
import { describeChange } from "./describe";

/**
 * Change Bubble: a compact panel explaining one pending change, opened by
 * hovering its highlight (docs/DESIGN.md §6).
 *
 * It stays open while the pointer travels from the highlight into the bubble
 * (hover intent), and pins itself once you interact with it or when opened
 * from a keyboard command. A pinned bubble closes on Escape, an outside
 * click, or when the editor scrolls.
 *
 * A pinned bubble also takes single-key review shortcuts: A accepts, R
 * reverts, F skips forward. A bubble opened by hovering ignores them, so
 * typing in the note is never affected.
 */

const HIDE_DELAY = 220;
const PREVIEW_CHARS = 600;

export interface BubbleActions {
  accept: () => void;
  reject: () => void;
  /** Move on to the next change without acting on this one. */
  next: () => void;
}

function rejectLabel(change: LogicalChange): string {
  if (change.kind === "insertion") return "Remove addition";
  if (change.kind === "deletion") return "Restore text";
  return "Revert change";
}

/**
 * A single line break inside prose is a soft wrap in Markdown: show it as a
 * space in the word detail so rewritten runs read as one line. Blank lines
 * and whitespace-only parts stay as they are.
 */
function softWrap(text: string): string {
  if (!text.trim()) return text;
  return text.replace(/(^|[^\n])\n(?!\n)/g, "$1 ");
}

export class ChangeBubble {
  private el: HTMLElement | null = null;
  private hideTimer: number | null = null;
  private pinned = false;
  private shownAt = 0;
  /** The document the bubble lives in (the editor's window, which may be a pop-out). */
  private doc: Document = activeDocument;
  private current: LogicalChange | null = null;

  private actions: BubbleActions | null = null;

  private onKey = (e: KeyboardEvent) => {
    if (!this.el) return;
    if (e.key === "Escape") {
      this.destroy();
      e.preventDefault();
      return;
    }
    if (!this.pinned || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const actions = this.actions;
    const act =
      e.key === "a" || e.key === "A"
        ? actions?.accept
        : e.key === "r" || e.key === "R"
          ? actions?.reject
          : e.key === "f" || e.key === "F"
            ? actions?.next
            : undefined;
    if (!act) return;
    // Handled here, so the letter is not typed into the note.
    e.preventDefault();
    e.stopPropagation();
    this.destroy();
    act();
  };
  private onDocDown = (e: MouseEvent) => {
    if (this.el && !this.el.contains(e.target as Node)) this.destroy();
  };

  show(
    change: LogicalChange,
    anchor: DOMRect,
    actions: BubbleActions,
    doc: Document,
    pin = false
  ): void {
    if (this.current?.id === change.id && this.el && this.doc === doc) {
      this.cancelHide();
      if (pin) this.pin();
      return;
    }
    this.destroy();
    this.current = change;
    this.actions = actions;
    this.shownAt = Date.now();
    this.doc = doc;

    const el = doc.body.createDiv({ cls: "acr-bubble acr-bubble-measuring" });
    this.el = el;
    el.addEventListener("mouseenter", () => this.cancelHide());
    el.addEventListener("mouseleave", () => this.scheduleHide());
    el.addEventListener("mousedown", () => this.pin());
    this.render(el, change, actions);
    this.position(anchor);
    doc.addEventListener("keydown", this.onKey, true);
    doc.addEventListener("mousedown", this.onDocDown, true);
    if (pin) this.pin();
  }

  pin(): void {
    this.pinned = true;
    this.cancelHide();
    this.el?.addClass("acr-bubble-pinned");
  }

  /** The editor scrolled: the bubble no longer sits next to its change. */
  scrolled(): void {
    // Ignore the scroll that revealing a change (keyboard navigation) causes.
    if (Date.now() - this.shownAt > 400) this.destroy();
  }

  private position(anchor: DOMRect): void {
    const el = this.el;
    if (!el) return;
    const win = this.doc.defaultView ?? window;
    win.requestAnimationFrame(() => {
      if (this.el !== el) return;
      const own = el.getBoundingClientRect();
      let left = anchor.left;
      let top = anchor.bottom + 6;
      if (left + own.width > win.innerWidth - 12) {
        left = Math.max(8, win.innerWidth - own.width - 12);
      }
      // Flip above the anchor when there is no room below.
      if (top + own.height > win.innerHeight - 12) {
        top = Math.max(8, anchor.top - own.height - 6);
      }
      el.setCssStyles({ left: `${Math.max(8, left)}px`, top: `${top}px` });
      el.removeClass("acr-bubble-measuring");
    });
  }

  private render(el: HTMLElement, change: LogicalChange, actions: BubbleActions): void {
    const { summary, links } = describeChange(change);

    const header = el.createDiv({ cls: "acr-bubble-header" });
    header.createSpan({
      cls: `acr-bubble-kind acr-bubble-kind-${change.kind}`,
      text: kindLabel(change.kind),
    });
    header.createSpan({ cls: "acr-bubble-gran", text: change.granularity });

    el.createDiv({ cls: "acr-bubble-summary", text: summary });
    for (const line of links) el.createDiv({ cls: "acr-bubble-link", text: line });

    const body = el.createDiv({ cls: "acr-bubble-body" });
    const big = change.granularity === "sentence" || change.granularity === "paragraph";
    if (change.kind === "replacement" && big) {
      // Word-level detail: what changed inside the rewritten unit.
      const detail = body.createDiv({ cls: "acr-bubble-detail" });
      for (const part of change.fine) {
        const cls =
          part.kind === "insert" ? "acr-fine-ins" : part.kind === "delete" ? "acr-fine-del" : "acr-fine-eq";
        detail.createSpan({ cls, text: softWrap(part.text) });
      }
      const toggle = el.createEl("a", { cls: "acr-bubble-toggle", text: "Show before / after" });
      const stacked = body.createDiv({ cls: "acr-bubble-stacked" });
      stacked.hide();
      this.textBlock(stacked, "acr-bubble-old", change.baseText);
      stacked.createDiv({ cls: "acr-bubble-arrow-down", text: "↓" });
      this.textBlock(stacked, "acr-bubble-new", change.currentText);
      toggle.addEventListener("click", () => {
        const showStacked = !stacked.isShown();
        stacked.toggle(showStacked);
        detail.toggle(!showStacked);
        toggle.setText(showStacked ? "Show word detail" : "Show before / after");
      });
      body.after(toggle);
    } else if (change.kind === "replacement") {
      const row = body.createDiv({ cls: "acr-bubble-inline" });
      this.textBlock(row, "acr-bubble-old", change.baseText, "span");
      row.createSpan({ cls: "acr-bubble-arrow", text: "→" });
      this.textBlock(row, "acr-bubble-new", change.currentText, "span");
    } else if (change.kind === "insertion") {
      this.textBlock(body, "acr-bubble-added", change.currentText);
    } else {
      this.textBlock(body, "acr-bubble-removed", change.baseText);
    }

    const row = el.createDiv({ cls: "acr-bubble-actions" });
    const accept = row.createEl("button", { cls: "acr-bubble-btn mod-cta", text: "Accept" });
    accept.addEventListener("click", () => {
      this.destroy();
      actions.accept();
    });
    const reject = row.createEl("button", { cls: "acr-bubble-btn", text: rejectLabel(change) });
    reject.addEventListener("click", () => {
      this.destroy();
      actions.reject();
    });
    // Shown only while pinned, when the keys are active.
    const keys = el.createDiv({ cls: "acr-bubble-keys" });
    for (const [key, label] of [
      ["A", "accept"],
      ["R", "revert"],
      ["F", "next"],
      ["Esc", "close"],
    ]) {
      const item = keys.createSpan({ cls: "acr-bubble-key" });
      item.createEl("kbd", { text: key });
      item.appendText(` ${label}`);
    }
  }

  /** Text preview, truncated with a "Show all" expander. Whitespace stays visible. */
  private textBlock(
    parent: HTMLElement,
    cls: string,
    text: string,
    tag: "div" | "span" = "div"
  ): void {
    const shown = text.trim() ? text : text.replace(/\n/g, "↵").replace(/ /g, "·");
    const el = parent.createEl(tag, { cls });
    if (shown.length <= PREVIEW_CHARS) {
      el.setText(shown);
      return;
    }
    el.setText(shown.slice(0, PREVIEW_CHARS) + "…");
    const more = parent.createEl("a", { cls: "acr-bubble-toggle", text: "Show all" });
    more.addEventListener("click", () => {
      el.setText(shown);
      more.remove();
    });
  }

  scheduleHide(): void {
    if (this.pinned) return;
    this.cancelHide();
    this.hideTimer = window.setTimeout(() => this.destroy(), HIDE_DELAY);
  }

  cancelHide(): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  destroy(): void {
    this.cancelHide();
    this.el?.remove();
    this.el = null;
    this.current = null;
    this.actions = null;
    this.pinned = false;
    this.doc.removeEventListener("keydown", this.onKey, true);
    this.doc.removeEventListener("mousedown", this.onDocDown, true);
  }
}
