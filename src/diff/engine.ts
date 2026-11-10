import { diffWordsWithSpace } from "diff";

/**
 * Deterministic diff engine: reviewed baseline ↔ current file content.
 *
 * Pending changes are always recomputed from the two document states alone,
 * never from the sequence of writes that produced the current content.
 *
 * Pipeline:
 *
 *     word diff → atomic changes → change grouper → change groups
 *
 * The grouper adaptively promotes clusters of atomic edits to phrase,
 * sentence, or paragraph granularity so the UI can expose the smallest
 * *useful* unit of interaction instead of raw diff operations.
 */

export interface FinePart {
  kind: "equal" | "insert" | "delete";
  text: string;
}

/** What kind of edit this change represents (drives the UI colour). */
export type ChangeKind = "replacement" | "insertion" | "deletion";

/** The unit of interaction a change is exposed at. */
export type Granularity = "word" | "phrase" | "sentence" | "paragraph";

export interface LogicalChange {
  id: string;
  /** Range in the reviewed baseline. */
  baseFrom: number;
  baseTo: number;
  /** Range in the current content. */
  currentFrom: number;
  currentTo: number;
  baseText: string;
  currentText: string;
  /** Word-level diff within this logical change. */
  fine: FinePart[];
  kind: ChangeKind;
  granularity: Granularity;
}

/** How eagerly the grouper promotes clusters of edits to a larger unit. */
export type GroupingLevel = "off" | "balanced" | "eager";

export interface GroupingOptions {
  sentence: GroupingLevel;
  paragraph: GroupingLevel;
}

export const DEFAULT_GROUPING: GroupingOptions = {
  sentence: "balanced",
  paragraph: "balanced",
};

/**
 * Fraction of a unit that must be rewritten before the unit itself becomes
 * the review target. `off` disables the pass entirely.
 */
const SENTENCE_FRACTION: Record<GroupingLevel, number> = {
  off: Infinity,
  balanced: 0.6,
  eager: 0.4,
};
const PARAGRAPH_FRACTION: Record<GroupingLevel, number> = {
  off: Infinity,
  balanced: 0.75,
  eager: 0.5,
};

/** Tuning for the adaptive grouper. */
const MERGE_GAP = 15;
/** Units shorter than these are never promoted — there is nothing to simplify. */
const MIN_SENTENCE_LEN = 16;
const MIN_PARAGRAPH_LEN = 50;

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function fineDiff(baseText: string, currentText: string): FinePart[] {
  if (!baseText) return currentText ? [{ kind: "insert", text: currentText }] : [];
  if (!currentText) return [{ kind: "delete", text: baseText }];
  return coalesce(
    diffWordsWithSpace(baseText, currentText).map((p) => ({
      kind: p.added ? "insert" : p.removed ? "delete" : "equal",
      text: p.value,
    }))
  );
}

/**
 * Join edits separated only by spaces into one delete + insert pair, so a
 * rewrite reads "~~Nobody has finished~~ Several members found" instead of
 * alternating word by word. Blank lines still separate runs.
 */
function coalesce(parts: FinePart[]): FinePart[] {
  const out: FinePart[] = [];
  let del = "";
  let ins = "";
  let gap: string | null = null;
  const flush = () => {
    if (del) out.push({ kind: "delete", text: del });
    if (ins) out.push({ kind: "insert", text: ins });
    del = ins = "";
    if (gap !== null) out.push({ kind: "equal", text: gap });
    gap = null;
  };
  for (const p of parts) {
    if (p.kind === "equal") {
      const joinable = (del || ins) && gap === null && !p.text.trim() && !/\n\s*\n/.test(p.text);
      if (joinable) gap = p.text;
      else {
        flush();
        out.push(p);
      }
      continue;
    }
    if (gap !== null) {
      // Join only a run that ends up with both a deletion and an insertion;
      // the unchanged spacing then belongs to both sides.
      const hasDel = !!del || p.kind === "delete";
      const hasIns = !!ins || p.kind === "insert";
      if (hasDel && hasIns) {
        del += gap;
        ins += gap;
        gap = null;
      } else flush();
    }
    if (p.kind === "delete") del += p.text;
    else ins += p.text;
  }
  flush();
  return out;
}

// ------------------------------------------------------------- text bounds

/** Sentence bounds containing [from, to) — falls back to line/paragraph edges. */
function sentenceBounds(text: string, from: number, to: number): [number, number] {
  const boundary = /[.!?](?=[\s”"')\]]|$)|\n/g;
  let start = 0;
  let end = text.length;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(text)) !== null) {
    const idx = m.index + m[0].length;
    if (idx <= from) start = idx;
    // `idx >= to` (not `m.index >= to`): a terminator ending exactly at the
    // range end closes this sentence rather than pulling in the next one.
    else if (idx >= to) {
      end = idx;
      break;
    }
  }
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return [start, end];
}

/** Blank-line-separated block containing [from, to). */
function paragraphBounds(text: string, from: number, to: number): [number, number] {
  const sep = /\n[ \t]*\n/g;
  let start = 0;
  let end = text.length;
  let m: RegExpExecArray | null;
  while ((m = sep.exec(text)) !== null) {
    const idx = m.index + m[0].length;
    if (idx <= from) start = idx;
    else if (m.index >= to) {
      end = m.index;
      break;
    }
  }
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return [start, end];
}

// --------------------------------------------------------- atomic changes

interface Span {
  oFrom: number;
  oTo: number;
  pFrom: number;
  pTo: number;
  /** Set once the grouper promotes the span to a larger unit. */
  promoted?: Granularity;
}

/** Contiguous runs of added/removed tokens, with no gap merging. */
function atomicSpans(base: string, current: string): Span[] {
  const parts = diffWordsWithSpace(base, current);
  const spans: Span[] = [];
  let o = 0;
  let p = 0;
  let cur: Span | null = null;
  for (const part of parts) {
    const changed = !!part.added || !!part.removed;
    if (changed) {
      if (!cur) cur = { oFrom: o, oTo: o, pFrom: p, pTo: p };
      if (!part.added) cur.oTo = o + part.value.length;
      if (!part.removed) cur.pTo = p + part.value.length;
    } else if (cur) {
      spans.push(cur);
      cur = null;
    }
    if (!part.added) o += part.value.length;
    if (!part.removed) p += part.value.length;
  }
  if (cur) spans.push(cur);
  return spans;
}

/**
 * A pure insertion or deletion can often slide through the unchanged text
 * around it without changing the result ("a\n|b\n|" vs "|a\n|b\n").
 * The word diff picks an arbitrary position; slide each one to where it
 * covers whole lines (or at least whole words). A whitespace-only span that
 * can slide up against its neighbour is merged into it, so deleting a line
 * is one change rather than the line plus a stray "Removed line break".
 */
function slidePureSpans(spans: Span[], base: string, current: string): Span[] {
  const out: Span[] = [];
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const isDeletion = span.pFrom === span.pTo && span.oTo > span.oFrom;
    const isInsertion = span.oFrom === span.oTo && span.pTo > span.pFrom;
    if (!isDeletion && !isInsertion) {
      out.push(span);
      continue;
    }
    // Slide within the document that holds the text; the other side's empty
    // range moves by the same amount, since the text around it is unchanged.
    const doc = isDeletion ? base : current;
    const from = isDeletion ? span.oFrom : span.pFrom;
    const to = isDeletion ? span.oTo : span.pTo;
    const prev = out[out.length - 1];
    const next = spans[i + 1];
    const lo = prev ? (isDeletion ? prev.oTo : prev.pTo) : 0;
    const hi = next ? (isDeletion ? next.oFrom : next.pFrom) : doc.length;

    let min = 0;
    while (from + min - 1 >= lo && doc[from + min - 1] === doc[to + min - 1]) min--;
    let max = 0;
    while (to + max < hi && doc[from + max] === doc[to + max]) max++;

    const blank = !doc.slice(from, to).trim();
    let shift = 0;
    if (blank && prev && from + min === lo) shift = min;
    else if (blank && next && to + max === hi) shift = max;
    else {
      let best = alignScore(doc, from, to);
      for (let k = min; k <= max; k++) {
        const score = alignScore(doc, from + k, to + k);
        if (score > best || (score === best && Math.abs(k) < Math.abs(shift))) {
          best = score;
          shift = k;
        }
      }
    }
    const moved: Span = {
      oFrom: span.oFrom + shift,
      oTo: span.oTo + shift,
      pFrom: span.pFrom + shift,
      pTo: span.pTo + shift,
    };
    if (prev && prev.oTo === moved.oFrom && prev.pTo === moved.pFrom) {
      out[out.length - 1] = mergeSpans(prev, moved);
    } else if (next && moved.oTo === next.oFrom && moved.pTo === next.pFrom) {
      spans[i + 1] = mergeSpans(moved, next);
    } else {
      out.push(moved);
    }
  }
  return out;
}

/** How well [from, to) of `doc` lines up with line and word boundaries. */
function alignScore(doc: string, from: number, to: number): number {
  const lineStart = from === 0 || doc[from - 1] === "\n";
  const lineEnd = doc[to - 1] === "\n";
  const space = (i: number) => i < 0 || i >= doc.length || /\s/.test(doc[i]);
  let score = 0;
  if (lineStart) score += 4;
  if (lineEnd) score += 4;
  if (space(from - 1) || space(from)) score += 1;
  if (space(to) || space(to - 1)) score += 1;
  return score;
}

// ---------------------------------------------------------- change grouper

/**
 * Merge two adjacent spans into one. The text between them is unchanged, so
 * it is identical in both documents and both ranges simply extend to cover it.
 */
function mergeSpans(a: Span, b: Span): Span {
  return {
    oFrom: Math.min(a.oFrom, b.oFrom),
    oTo: Math.max(a.oTo, b.oTo),
    pFrom: Math.min(a.pFrom, b.pFrom),
    pTo: Math.max(a.pTo, b.pTo),
    promoted: b.promoted ?? a.promoted,
  };
}

/**
 * Merge spans separated only by a short unchanged gap that crosses no
 * structural boundary. Sentence and line breaks are left to the promotion
 * passes, so a phrase group never straddles two sentences.
 */
function mergeNearby(spans: Span[], current: string): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    const prev = out[out.length - 1];
    if (prev) {
      const gap = current.slice(prev.pTo, span.pFrom);
      const crossesBoundary = /[\n]/.test(gap) || /[.!?]\s/.test(gap);
      if (gap.length <= MERGE_GAP && !crossesBoundary) {
        out[out.length - 1] = mergeSpans(prev, span);
        continue;
      }
    }
    out.push({ ...span });
  }
  return out;
}

/** Change magnitude in characters — the larger of the two sides. */
function magnitude(s: Span): number {
  return Math.max(s.pTo - s.pFrom, s.oTo - s.oFrom);
}

/**
 * Expand a span to a wider current range. The added text on either side is
 * unchanged, so the base range grows by exactly the same amounts.
 */
function expandTo(span: Span, pFrom: number, pTo: number, level: Granularity): Span {
  return {
    oFrom: span.oFrom - (span.pFrom - pFrom),
    oTo: span.oTo + (pTo - span.pTo),
    pFrom,
    pTo,
    promoted: level,
  };
}

/**
 * Promote clusters of changes to whole sentences (and then paragraphs) when
 * they rewrite enough of the unit that reviewing the pieces separately is
 * noise. Spans falling inside a promoted unit are absorbed into it.
 */
function promote(
  spans: Span[],
  bounds: (from: number, to: number) => [number, number],
  fraction: number,
  minUnitLen: number,
  /** Promotion needs at least this many separate changes in the unit. */
  minCount: number,
  level: Granularity,
  /**
   * Spans used to measure how much of the unit actually changed. Later passes
   * must pass the pre-promotion spans: an already-promoted span covers a whole
   * sentence, so measuring it would report near-total coverage for a paragraph
   * whose sentences were only lightly edited.
   */
  densitySpans?: Span[]
): Span[] {
  if (!isFinite(fraction)) return spans;
  const out: Span[] = [];
  let i = 0;
  while (i < spans.length) {
    const [uFrom, uTo] = bounds(spans[i].pFrom, spans[i].pTo);
    const unitLen = Math.max(uTo - uFrom, 1);
    // Collect every span inside this unit.
    let j = i;
    let changed = 0;
    while (j < spans.length && spans[j].pFrom >= uFrom && spans[j].pTo <= uTo) {
      if (!densitySpans) changed += magnitude(spans[j]);
      j++;
    }
    const count = j - i;
    if (densitySpans) {
      for (const s of densitySpans) {
        if (s.pFrom >= uFrom && s.pFrom <= uTo) changed += magnitude(s);
      }
    }
    if (count === 0) {
      out.push(spans[i]);
      i++;
      continue;
    }
    const covers = changed / unitLen;
    // A single span already spanning the whole unit needs no promotion here.
    const spansWholeUnit = count === 1 && spans[i].pFrom <= uFrom && spans[i].pTo >= uTo;
    if (covers >= fraction && !spansWholeUnit && unitLen >= minUnitLen && count >= minCount) {
      let merged = spans[i];
      for (let k = i + 1; k < j; k++) merged = mergeSpans(merged, spans[k]);
      out.push(expandTo(merged, uFrom, uTo, level));
    } else {
      for (let k = i; k < j; k++) out.push(spans[k]);
    }
    i = j;
  }
  return out;
}

/** Wiki-links, embeds, and Markdown links/images, each on one line. */
const LINK_RE = /!?\[\[[^\]\n]+\]\]|!?\[[^\]\n]*\]\([^)\n]*\)/g;

/**
 * Widen every span that touches a link to cover the whole link, so a changed
 * target reads as "[[Alpha]] → [[Beta]]" rather than "Alpha → Beta" (and the
 * bubble can call it out as a link change). Spans that end up overlapping
 * are merged.
 */
function snapToLinks(spans: Span[], current: string): Span[] {
  const links: [number, number][] = [];
  for (const m of current.matchAll(LINK_RE)) links.push([m.index, m.index + m[0].length]);
  if (links.length === 0) return spans;

  /** Current range widened to the links it touches (links never overlap). */
  const widen = (from: number, to: number): [number, number] => {
    for (const [lf, lt] of links) {
      const touches = from === to ? lf < from && from < lt : from < lt && to > lf;
      if (touches) {
        from = Math.min(from, lf);
        to = Math.max(to, lt);
      }
    }
    return [from, to];
  };

  const out: Span[] = [];
  let i = 0;
  while (i < spans.length) {
    let span = spans[i];
    let [from, to] = widen(span.pFrom, span.pTo);
    // Absorb later spans inside the widened range first: merging keeps both
    // coordinate systems exact because the text between spans is unchanged.
    let j = i + 1;
    while (j < spans.length && spans[j].pFrom < to) {
      span = mergeSpans(span, spans[j]);
      [from, to] = widen(Math.min(from, span.pFrom), Math.max(to, span.pTo));
      j++;
    }
    if (from !== span.pFrom || to !== span.pTo) {
      span = { ...expandTo(span, from, to, "word"), promoted: span.promoted };
    }
    out.push(span);
    i = j;
  }
  return out;
}

function classify(baseText: string, currentText: string): ChangeKind {
  if (!baseText) return "insertion";
  if (!currentText) return "deletion";
  return "replacement";
}

/**
 * Granularity is derived from what the final span actually covers, not from
 * which pass produced it: a run of merges can end up spanning a whole
 * paragraph without any promotion step having run.
 */
function granularityOf(
  span: Span,
  current: string,
  baseText: string,
  currentText: string
): Granularity {
  const covers = (from: number, to: number): boolean =>
    to > from && span.pFrom <= from && span.pTo >= to;

  const [paraFrom, paraTo] = paragraphBounds(current, span.pFrom, span.pTo);
  if (covers(paraFrom, paraTo)) {
    const body = current.slice(paraFrom, paraTo);
    // A single-sentence paragraph is better described as a sentence.
    if (/[.!?]\s+\S/.test(body) || body.includes("\n")) return "paragraph";
    return "sentence";
  }
  const [sentFrom, sentTo] = sentenceBounds(current, span.pFrom, span.pTo);
  if (covers(sentFrom, sentTo)) return "sentence";

  const longest = currentText.length >= baseText.length ? currentText : baseText;
  return /\s/.test(longest.trim()) ? "phrase" : "word";
}

/**
 * Compute grouped logical changes between base and current.
 * Ranges are non-overlapping and ordered; the unchanged text between them is
 * identical in both documents.
 */
export function computeChanges(
  base: string,
  current: string,
  grouping: GroupingOptions = DEFAULT_GROUPING
): LogicalChange[] {
  if (base === current) return [];

  let spans = slidePureSpans(atomicSpans(base, current), base, current);
  spans = mergeNearby(spans, current);
  // Real edit density, measured before any promotion inflates span sizes.
  const density = spans;
  // A single edit expanded to its sentence is still a useful review unit…
  spans = promote(
    spans,
    (f, t) => sentenceBounds(current, f, t),
    SENTENCE_FRACTION[grouping.sentence],
    MIN_SENTENCE_LEN,
    1,
    "sentence"
  );
  // …but promoting to a paragraph is only worth it when it actually combines
  // separate changes; otherwise it just swallows untouched text.
  spans = promote(
    spans,
    (f, t) => paragraphBounds(current, f, t),
    PARAGRAPH_FRACTION[grouping.paragraph],
    MIN_PARAGRAPH_LEN,
    2,
    "paragraph",
    density
  );
  spans = snapToLinks(spans, current);

  return spans.map((span) => {
    const baseText = base.slice(span.oFrom, span.oTo);
    const currentText = current.slice(span.pFrom, span.pTo);
    return {
      id: `${span.oFrom}-${hash(baseText)}-${hash(currentText)}`,
      baseFrom: span.oFrom,
      baseTo: span.oTo,
      currentFrom: span.pFrom,
      currentTo: span.pTo,
      baseText,
      currentText,
      fine: fineDiff(baseText, currentText),
      kind: classify(baseText, currentText),
      granularity: granularityOf(span, current, baseText, currentText),
    };
  });
}

/**
 * Edit to the current content that rejects a change: the current range is
 * replaced with the baseline text. For an insertion `baseText` is empty (so
 * reject deletes it); for a deletion `currentText` is empty (so reject
 * restores it).
 */
export function rejectionEdit(c: LogicalChange): {
  from: number;
  to: number;
  insert: string;
} {
  return { from: c.currentFrom, to: c.currentTo, insert: c.baseText };
}

/** Find the change containing (or, for deletions, sitting at) a position. */
export function changeAtCurrentPos(
  changes: LogicalChange[],
  pos: number
): LogicalChange | null {
  for (const c of changes) if (pos >= c.currentFrom && pos <= c.currentTo) return c;
  return null;
}

/** Baseline text after accepting one change: its current text is folded in. */
export function acceptedBaseline(base: string, c: LogicalChange): string {
  return base.slice(0, c.baseFrom) + c.currentText + base.slice(c.baseTo);
}

/** Human label for a change kind, used in the change bubble. */
export function kindLabel(kind: ChangeKind): string {
  return kind === "insertion" ? "Added" : kind === "deletion" ? "Removed" : "Changed";
}
