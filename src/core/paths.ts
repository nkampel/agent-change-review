/**
 * Exclusion patterns from settings, one per line:
 *   `Folder/`        everything under Folder
 *   `Folder/Note.md` exactly that file (or, without `.md`, that folder)
 *   `**\/drafts/*`   glob: `*` matches within a path segment, `**` across segments
 */
export class PathFilter {
  private matchers: ((path: string) => boolean)[];

  constructor(patterns: string[]) {
    this.matchers = patterns
      .map((p) => p.trim().replace(/^\/+/, ""))
      .filter((p) => p && !p.startsWith("#"))
      .map(compile);
  }

  excludes(path: string): boolean {
    return this.matchers.some((m) => m(path));
  }
}

function compile(pattern: string): (path: string) => boolean {
  if (/[*?]/.test(pattern)) {
    let re = "";
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (pattern.startsWith("**/", i)) {
        re += "(?:.*/)?";
        i += 2;
      } else if (pattern.startsWith("**", i)) {
        re += ".*";
        i += 1;
      } else if (ch === "*") re += "[^/]*";
      else if (ch === "?") re += "[^/]";
      else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    const compiled = new RegExp(`^${re}(?:/.*)?$`);
    return (path) => compiled.test(path);
  }
  const folder = pattern.replace(/\/+$/, "");
  return (path) => path === folder || path.startsWith(folder + "/");
}
