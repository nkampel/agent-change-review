import { diffWordsWithSpace } from "diff";
import { LogicalChange } from "../diff/engine";

/**
 * Pure helpers of the change model. Nothing here knows about Obsidian or
 * CodeMirror: the tracker feeds plain strings and edit lists in.
 */

/** A replacement of `[from, to)` with `insert`, in the coordinates of one text. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/** Does an edit of `[from, to]` touch a pending change (boundaries count as touching)? */
function touches(edit: TextEdit, c: LogicalChange): boolean {
  return edit.from <= c.currentTo && edit.to >= c.currentFrom;
}

/**
 * Own edits are never tinted (docs/DESIGN.md §3.4). Given the pending
 * changes for `(baseline, oldCurrent)` and the user's edits to `oldCurrent`:
 *
 * - an edit entirely inside unchanged text is mirrored into the baseline, so
 *   it never shows up as a change;
 * - an edit touching a pending change only alters the current text: the
 *   change stays pending and now shows the edited version.
 *
 * Unchanged text is identical in both documents, so a position in it maps to
 * the baseline by the accumulated length difference of the changes before it.
 */
export function mirrorOwnEdits(
  baseline: string,
  changes: LogicalChange[],
  edits: TextEdit[]
): string {
  const mirrored: TextEdit[] = [];
  for (const edit of edits) {
    if (changes.some((c) => touches(edit, c))) continue;
    let delta = 0;
    for (const c of changes) {
      if (c.currentTo >= edit.from) break;
      delta += c.baseTo - c.baseFrom - (c.currentTo - c.currentFrom);
    }
    mirrored.push({ from: edit.from + delta, to: edit.to + delta, insert: edit.insert });
  }
  return applyEdits(baseline, mirrored);
}

/** Apply non-overlapping edits (in `text` coordinates, any order). */
export function applyEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.from - a.from);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}

/** Edits turning `from` into `to`, in `from` coordinates (word-level). */
export function editsBetween(from: string, to: string): TextEdit[] {
  const edits: TextEdit[] = [];
  let pos = 0;
  let cur: TextEdit | null = null;
  for (const part of diffWordsWithSpace(from, to)) {
    if (part.added || part.removed) {
      if (!cur) cur = { from: pos, to: pos, insert: "" };
      if (part.removed) cur.to += part.value.length;
      else cur.insert += part.value;
    } else if (cur) {
      edits.push(cur);
      cur = null;
    }
    if (!part.added) pos += part.value.length;
  }
  if (cur) edits.push(cur);
  return edits;
}

export interface ChangeCounts {
  changed: number;
  added: number;
  removed: number;
}

export function countChanges(changes: LogicalChange[]): ChangeCounts {
  const counts: ChangeCounts = { changed: 0, added: 0, removed: 0 };
  for (const c of changes) {
    if (c.kind === "insertion") counts.added++;
    else if (c.kind === "deletion") counts.removed++;
    else counts.changed++;
  }
  return counts;
}

/**
 * Re-find a change after a recompute. Ids embed baseline offsets, which shift
 * when own edits are mirrored into the baseline, so fall back to matching
 * the texts and picking the nearest position.
 */
export function findChange(changes: LogicalChange[], ref: LogicalChange): LogicalChange | null {
  const byId = changes.find((c) => c.id === ref.id);
  if (byId) return byId;
  let best: LogicalChange | null = null;
  for (const c of changes) {
    if (c.baseText !== ref.baseText || c.currentText !== ref.currentText) continue;
    if (!best || Math.abs(c.currentFrom - ref.currentFrom) < Math.abs(best.currentFrom - ref.currentFrom))
      best = c;
  }
  return best;
}
