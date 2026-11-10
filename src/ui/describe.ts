import { LogicalChange } from "../diff/engine";
import { compareLinkTargets, isOnlyLinks } from "../markdown/links";

/**
 * Plain-language description of a change for the bubble header:
 * "Replaced 1 word with 2 words", "Added paragraph (42 words)",
 * "Changed link [[A]] → [[B]]", "Formatting only".
 */

export interface ChangeDescription {
  summary: string;
  /** Link/embed target changes, called out separately. */
  links: string[];
}

function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

function words(n: number): string {
  return `${n} word${n === 1 ? "" : "s"}`;
}

function formatTarget(t: string): string {
  const i = t.indexOf(":");
  const kind = t.slice(0, i);
  const target = t.slice(i + 1);
  if (kind === "embed") return `![[${target}]]`;
  if (kind === "wiki") return `[[${target}]]`;
  return target;
}

function linkLabel(t: string): string {
  return t.startsWith("embed:") ? "embed" : "link";
}

const MARKUP = /[*_`~=#>[\]()!|-]/g;

export function describeChange(c: LogicalChange): ChangeDescription {
  const links: string[] = [];
  const check = compareLinkTargets(c.baseText, c.currentText);
  if (check.missing.length === 1 && check.added.length === 1) {
    const [a, b] = [check.missing[0], check.added[0]];
    links.push(`Changed ${linkLabel(a)} ${formatTarget(a)} → ${formatTarget(b)}`);
  } else {
    for (const t of check.missing) links.push(`Removed ${linkLabel(t)} ${formatTarget(t)}`);
    for (const t of check.added) links.push(`Added ${linkLabel(t)} ${formatTarget(t)}`);
  }

  // The change is just a link: the link line says it all.
  const linkOnly = (t: string) => !t.trim() || isOnlyLinks(t);
  if (links.length === 1 && linkOnly(c.baseText) && linkOnly(c.currentText)) {
    return { summary: links[0], links: [] };
  }
  return { summary: summarize(c), links };
}

function summarize(c: LogicalChange): string {
  const unit = c.granularity === "sentence" || c.granularity === "paragraph" ? c.granularity : null;
  if (c.kind === "insertion" || c.kind === "deletion") {
    const verb = c.kind === "insertion" ? "Added" : "Removed";
    const text = c.kind === "insertion" ? c.currentText : c.baseText;
    if (!text.trim()) return `${verb} ${/\n/.test(text) ? "line break" : "whitespace"}`;
    const n = wordCount(text);
    if (!/[\p{L}\p{N}]/u.test(text)) return `${verb} punctuation`;
    return unit ? `${verb} ${unit} (${words(n)})` : `${verb} ${words(n)}`;
  }

  if (c.baseText.replace(/\s+/g, " ").trim() === c.currentText.replace(/\s+/g, " ").trim()) {
    return "Whitespace only";
  }
  if (c.baseText.replace(MARKUP, "") === c.currentText.replace(MARKUP, "")) {
    return "Formatting only";
  }
  if (c.baseText.toLowerCase() === c.currentText.toLowerCase()) return "Capitalization only";
  if (!/[\p{L}\p{N}]/u.test(c.baseText + c.currentText)) return "Changed punctuation";

  if (unit) {
    let changed = 0;
    for (const p of c.fine) if (p.kind === "insert") changed += wordCount(p.text);
    const total = wordCount(c.currentText);
    return `Rewrote ${unit} · ${changed} of ${words(total)} new`;
  }
  return `Replaced ${words(wordCount(c.baseText))} with ${words(wordCount(c.currentText))}`;
}
