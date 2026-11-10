import { describe, expect, it } from "vitest";
import { applyEdits, editsBetween, mirrorOwnEdits } from "../src/core/model";
import { PathFilter } from "../src/core/paths";
import { acceptedBaseline, computeChanges, rejectionEdit } from "../src/diff/engine";
import { describeChange } from "../src/ui/describe";

const brief = (base: string, current: string) =>
  computeChanges(base, current).map((c) => ({
    kind: c.kind,
    granularity: c.granularity,
    base: c.baseText,
    current: c.currentText,
  }));

describe("computeChanges", () => {
  it("returns nothing for identical texts", () => {
    expect(computeChanges("same", "same")).toEqual([]);
  });

  it("classifies insertions, deletions and replacements", () => {
    expect(brief("A cat sat.", "A black cat sat.")).toEqual([
      { kind: "insertion", granularity: "word", base: "", current: "black " },
    ]);
    expect(brief("A black cat sat.", "A cat sat.")).toEqual([
      { kind: "deletion", granularity: "word", base: "black ", current: "" },
    ]);
    expect(brief("A cat sat.", "A dog sat.")).toEqual([
      { kind: "replacement", granularity: "word", base: "cat", current: "dog" },
    ]);
  });

  it("promotes a mostly rewritten sentence to a sentence change", () => {
    const base = "The results were good. We measured twelve samples in total.";
    const current = "The results were good. Overall, twenty samples were analysed by us.";
    const changes = computeChanges(base, current);
    expect(changes).toHaveLength(1);
    expect(changes[0].granularity).toBe("sentence");
  });

  it("keeps a single edit in a long paragraph at word level", () => {
    const para =
      "This paragraph is fairly long and contains several sentences. Only one word changes. The rest stays the same.";
    const changes = computeChanges(para, para.replace("one word", "a single word"));
    expect(changes.length).toBe(1);
    expect(["word", "phrase"]).toContain(changes[0].granularity);
  });

  it("reviews a changed link as a whole link", () => {
    expect(brief("See [[Alpha]] here.", "See [[Beta]] here.")).toEqual([
      { kind: "replacement", granularity: "word", base: "[[Alpha]]", current: "[[Beta]]" },
    ]);
    // Two separate edits inside one long link become one change with exact offsets.
    const base = "Go to [[Projects/Alpha release planning notes|the alpha notes]] today.";
    const current = "Go to [[Projects/Beta release planning notes|the beta notes]] today.";
    const changes = computeChanges(base, current);
    expect(changes).toHaveLength(1);
    expect(changes[0].baseText).toBe("[[Projects/Alpha release planning notes|the alpha notes]]");
    expect(changes[0].currentText).toBe("[[Projects/Beta release planning notes|the beta notes]]");
    expect(applyEdits(current, [rejectionEdit(changes[0])])).toBe(base);
    expect(acceptedBaseline(base, changes[0])).toBe(current);
  });

  it("leaves edits next to (not inside) a link alone", () => {
    expect(brief("See [[Alpha]] here.", "See [[Alpha]] there.")).toEqual([
      { kind: "replacement", granularity: "word", base: "here", current: "there" },
    ]);
  });

  it("deletes a whole line as one change", () => {
    const base = "- Lecture notes.\n- The list.\n- Office hours on Tuesday.\n\n## Open\n";
    const current = "- Lecture notes.\n- The list.\n\n## Open\n";
    expect(brief(base, current)).toEqual([
      { kind: "deletion", granularity: "phrase", base: "- Office hours on Tuesday.\n", current: "" },
    ]);
    expect(brief("Line one.\nLine two.\nLine three.\n", "Line one.\nLine three.\n")).toEqual([
      { kind: "deletion", granularity: "phrase", base: "Line two.\n", current: "" },
    ]);
  });

  it("inserts a whole line as one change", () => {
    expect(brief("Line one.\nLine three.\n", "Line one.\nLine two.\nLine three.\n")).toEqual([
      { kind: "insertion", granularity: "sentence", base: "", current: "Line two.\n" },
    ]);
  });

  it("groups word detail into runs instead of alternating word by word", () => {
    const base = "Should we switch? Nobody has finished the first chapter yet, and the talk was thin.";
    const current = "Should we switch? Several members found the first chapter dense, so a lighter text could help.";
    const [c] = computeChanges(base, current);
    expect(c.granularity).toBe("sentence");
    expect(c.fine.map((p) => (p.kind === "equal" ? p.text : `${p.kind === "delete" ? "-" : "+"}[${p.text}]`)).join("")).toBe(
      "-[Nobody has finished]+[Several members found] the first chapter -[yet]+[dense], -[and the talk was thin]+[so a lighter text could help]."
    );
  });

  it("word detail reconstructs both texts exactly", () => {
    const cases: [string, string][] = [
      [". ", " d"],
      [" ", "[ ["],
      ["Some words.\n- item one old\n- item two", "Some words.\n- item one\nnew - item two"],
      ["Nobody has finished the\nfirst chapter yet.", "Several members found\nthe first chapter dense."],
      ["a b c d e f", "a x c y e z"],
    ];
    for (const [base, current] of cases) {
      for (const c of computeChanges(base, current)) {
        const side = (k: string) => c.fine.filter((p) => p.kind === "equal" || p.kind === k).map((p) => p.text).join("");
        expect(side("delete")).toBe(c.baseText);
        expect(side("insert")).toBe(c.currentText);
      }
    }
  });

  it("is deterministic", () => {
    const base = "Alpha beta gamma.\n\nDelta epsilon.";
    const current = "Alpha gamma beta.\n\nDelta zeta epsilon!";
    expect(computeChanges(base, current)).toEqual(computeChanges(base, current));
  });

  it("accept and reject round-trip every change kind", () => {
    const base = "One two three.\n\nFour five six.\n";
    const current = "One 2 three.\n\nFour five six. Seven.\n";
    for (const c of computeChanges(base, current)) {
      const rejected = applyEdits(current, [rejectionEdit(c)]);
      expect(computeChanges(base, rejected)).toHaveLength(computeChanges(base, current).length - 1);
      const accepted = acceptedBaseline(base, c);
      expect(computeChanges(accepted, current)).toHaveLength(computeChanges(base, current).length - 1);
    }
  });
});

describe("model helpers", () => {
  it("editsBetween + applyEdits reproduce the target text", () => {
    const from = "The quick brown fox.";
    const to = "The slow brown cat!";
    expect(applyEdits(from, editsBetween(from, to))).toBe(to);
  });

  it("mirrorOwnEdits copies edits in unchanged text into the baseline only", () => {
    const base = "Hello world. Bye.";
    const current = "Hello planet. Bye.";
    const changes = computeChanges(base, current);
    // Typing in unchanged text ("Bye." -> "Bye now.") is mirrored.
    const at = current.indexOf("Bye.") + 3;
    expect(mirrorOwnEdits(base, changes, [{ from: at, to: at, insert: " now" }])).toBe("Hello world. Bye now.");
    // Typing inside the pending change is not.
    const inChange = current.indexOf("planet") + 2;
    expect(mirrorOwnEdits(base, changes, [{ from: inChange, to: inChange, insert: "x" }])).toBe(base);
  });
});

describe("PathFilter", () => {
  const filter = new PathFilter(["Templates/", "Inbox/log.md", "**/drafts/*", "# a comment", ""]);
  it.each([
    ["Templates/Daily.md", true],
    ["Templates", true],
    ["TemplatesX/a.md", false],
    ["Inbox/log.md", true],
    ["Inbox/other.md", false],
    ["drafts/a.md", true],
    ["deep/nested/drafts/a.md", true],
    ["notes/a.md", false],
  ])("%s excluded: %s", (path, excluded) => {
    expect(filter.excludes(path)).toBe(excluded);
  });
});

describe("describeChange", () => {
  const one = (base: string, current: string) => describeChange(computeChanges(base, current)[0]);

  it("summarises word edits", () => {
    expect(one("A cat sat.", "A dog sat.").summary).toBe("Replaced 1 word with 1 word");
    expect(one("A cat sat.", "A black cat sat.").summary).toBe("Added 1 word");
  });

  it("calls out link changes", () => {
    expect(one("See [[Alpha]] here.", "See [[Beta]] here.")).toEqual({
      summary: "Changed link [[Alpha]] → [[Beta]]",
      links: [],
    });
    expect(one("See [[Alpha]] here.", "See [[Beta]] there now.").links).toEqual([
      "Changed link [[Alpha]] → [[Beta]]",
    ]);
    expect(one("A ![[img.png]] b", "A ![[pic.png]] b").summary).toBe("Changed embed ![[img.png]] → ![[pic.png]]");
    expect(one("See [docs](a.md) now.", "See [docs](b.md) now.").summary).toBe("Changed link a.md → b.md");
  });

  it("recognises formatting-only changes", () => {
    expect(one("A cat sat.", "A **cat** sat.").summary).toBe("Formatting only");
  });
});
