/**
 * Link targets inside a Markdown fragment: Obsidian wiki-links, embeds, and
 * Markdown link/image URLs. Used to call out link changes explicitly in the
 * change bubble ("Removed link [[Note]]"), since a changed target matters more
 * than the surrounding prose.
 */

const EMBED_RE = /!\[\[([^\]]+)\]\]/g;
const WIKILINK_RE = /(?<!!)\[\[([^\]]+)\]\]/g;
// Markdown links/images: capture the URL part only; display text may be rewritten.
const MDLINK_RE = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)[^)]*\)/g;

/** Extract the multiset of link targets from a markdown fragment. */
function extractLinkTargets(md: string): string[] {
  const targets: string[] = [];
  for (const m of md.matchAll(EMBED_RE)) {
    targets.push("embed:" + m[1].split("|")[0].trim());
  }
  for (const m of md.matchAll(WIKILINK_RE)) {
    targets.push("wiki:" + m[1].split("|")[0].trim());
  }
  for (const m of md.matchAll(MDLINK_RE)) {
    targets.push("url:" + m[1].replace(/^<|>$/g, "").trim());
  }
  return targets.sort();
}

interface LinkTargetDiff {
  ok: boolean;
  missing: string[];
  added: string[];
}

/** Compare the link targets of two fragments as multisets. */
export function compareLinkTargets(source: string, result: string): LinkTargetDiff {
  const before = extractLinkTargets(source);
  const after = extractLinkTargets(result);
  const count = (arr: string[]) => {
    const m = new Map<string, number>();
    for (const t of arr) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  };
  const b = count(before);
  const a = count(after);
  const missing: string[] = [];
  const added: string[] = [];
  for (const [t, n] of b) if ((a.get(t) ?? 0) < n) missing.push(t);
  for (const [t, n] of a) if ((b.get(t) ?? 0) < n) added.push(t);
  return { ok: missing.length === 0 && added.length === 0, missing, added };
}

/** Is `md` nothing but links/embeds (and whitespace)? */
export function isOnlyLinks(md: string): boolean {
  const rest = md.replace(EMBED_RE, "").replace(WIKILINK_RE, "").replace(MDLINK_RE, "");
  return rest.trim() === "" && md.trim() !== "";
}
