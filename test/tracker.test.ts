import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, pendingSummary, settle } from "./harness";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const NOTE = "Hello world. This is a note.\n\nSecond paragraph here.\n";

describe("startup", () => {
  it("adopts every note silently on first run", async () => {
    const h = await createHarness({ "a.md": NOTE, "b.md": "B" });
    expect(h.tracker.pending()).toEqual([]);
    expect(h.externalEvents).toEqual([]);
  });

  it("detects changes made while Obsidian was closed", async () => {
    const h = await createHarness({ "a.md": NOTE });
    h.vault.external.writeSilently("a.md", NOTE.replace("world", "brave world"));
    const h2 = await h.restart();
    expect(pendingSummary(h2.tracker)).toEqual(["a.md: modified"]);
    expect(h2.tracker.changesFor("a.md").map((c) => c.currentText)).toEqual(["brave "]);
  });

  it("keeps pending changes across a restart", async () => {
    const h = await createHarness({ "a.md": NOTE });
    h.vault.external.write("a.md", NOTE.replace("world", "planet"));
    await settle();
    const h2 = await h.restart();
    expect(pendingSummary(h2.tracker)).toEqual(["a.md: modified"]);
  });

  it("skips excluded paths and notes outside the size limit", async () => {
    const h = await createHarness(
      { "a.md": NOTE },
      { settings: { excluded: ["private/"], maxFileSizeKB: 1 } }
    );
    h.vault.external.write("private/x.md", "secret");
    h.vault.external.write("big.md", "x".repeat(2048));
    await settle();
    expect(h.tracker.pending()).toEqual([]);
  });
});

describe("closed notes", () => {
  it("reports an external write as pending, and accept makes it clean", async () => {
    const h = await createHarness({ "a.md": NOTE });
    h.vault.external.write("a.md", NOTE.replace("world", "planet"));
    await settle();
    expect(pendingSummary(h.tracker)).toEqual(["a.md: modified"]);
    expect(h.externalEvents).toEqual(["a.md"]);

    const [change] = h.tracker.changesFor("a.md");
    expect(change).toMatchObject({ kind: "replacement", baseText: "world", currentText: "planet" });
    h.tracker.accept("a.md", change);
    await settle();
    expect(h.tracker.pending()).toEqual([]);
    expect(h.vault.content("a.md")).toContain("planet");

    // The accepted text is the new baseline, also after a restart.
    const h2 = await h.restart();
    expect(h2.tracker.pending()).toEqual([]);
  });

  it("reject writes the baseline text back to the file", async () => {
    const h = await createHarness({ "a.md": NOTE });
    h.vault.external.write("a.md", NOTE.replace("world", "planet"));
    await settle();
    h.tracker.reject("a.md", h.tracker.changesFor("a.md")[0]);
    await settle();
    expect(h.vault.content("a.md")).toBe(NOTE);
    expect(h.tracker.pending()).toEqual([]);
  });

  it("accepting one of two changes leaves the other pending", async () => {
    const h = await createHarness({ "a.md": NOTE });
    h.vault.external.write("a.md", NOTE.replace("world", "planet").replace("Second", "Third"));
    await settle();
    const changes = h.tracker.changesFor("a.md");
    expect(changes).toHaveLength(2);
    h.tracker.accept("a.md", changes[0]);
    await settle();
    expect(h.tracker.changesFor("a.md").map((c) => c.currentText)).toEqual(["Third"]);
  });

  it("several writes before review show as one combined diff", async () => {
    const h = await createHarness({ "a.md": NOTE });
    h.vault.external.write("a.md", NOTE.replace("world", "planet"));
    await settle();
    h.vault.external.write("a.md", NOTE.replace("world", "moon"));
    await settle();
    expect(h.tracker.changesFor("a.md").map((c) => c.currentText)).toEqual(["moon"]);
    h.vault.external.write("a.md", NOTE);
    await settle();
    expect(h.tracker.pending()).toEqual([]);
  });
});

describe("other plugins' writes", () => {
  it("count as agent changes by default", async () => {
    const h = await createHarness({ "a.md": NOTE });
    const file = h.vault.getMarkdownFiles()[0];
    await h.vault.modify(file, NOTE + "More.\n");
    await settle();
    expect(pendingSummary(h.tracker)).toEqual(["a.md: modified"]);
  });

  it("are treated as own edits when the setting is off", async () => {
    const h = await createHarness({ "a.md": NOTE }, { settings: { pluginWritesAreAgent: false } });
    const file = h.vault.getMarkdownFiles()[0];
    await h.vault.modify(file, NOTE + "More.\n");
    await h.vault.process(file, (d) => d + "Even more.\n");
    await settle();
    expect(h.tracker.pending()).toEqual([]);
  });
});

describe("file events", () => {
  it("an external new file is pending as created; reject trashes it", async () => {
    const h = await createHarness({ "a.md": NOTE });
    h.vault.external.write("new.md", "Fresh note.");
    await settle();
    expect(pendingSummary(h.tracker)).toEqual(["new.md: created"]);
    await h.tracker.rejectAll("new.md");
    await settle();
    expect(h.vault.content("new.md")).toBeUndefined();
    expect(h.tracker.pending()).toEqual([]);
  });

  it("accepting a created file keeps it", async () => {
    const h = await createHarness({});
    h.vault.external.write("new.md", "Fresh note.");
    await settle();
    await h.tracker.acceptAll("new.md");
    await settle();
    expect(h.tracker.pending()).toEqual([]);
    expect(h.vault.content("new.md")).toBe("Fresh note.");
  });

  it("an external delete is pending as deleted; reject restores the file", async () => {
    const h = await createHarness({ "a.md": NOTE });
    h.vault.external.remove("a.md");
    await settle();
    expect(pendingSummary(h.tracker)).toEqual(["a.md: deleted"]);
    expect(h.tracker.deletedContent("a.md")).toBe(NOTE);
    await h.tracker.rejectAll("a.md");
    await settle();
    expect(h.vault.content("a.md")).toBe(NOTE);
    expect(h.tracker.pending()).toEqual([]);
  });

  it("an external move (delete + create) is paired into a rename; reject moves it back", async () => {
    const h = await createHarness({ "a.md": NOTE });
    h.vault.external.move("a.md", "dir/b.md");
    await settle();
    expect(pendingSummary(h.tracker)).toEqual(["dir/b.md: clean from a.md"]);
    expect(h.tracker.changesFor("dir/b.md")).toEqual([]);
    await h.tracker.rejectAll("dir/b.md");
    await settle();
    expect(h.vault.content("a.md")).toBe(NOTE);
    expect(h.vault.content("dir/b.md")).toBeUndefined();
    expect(h.tracker.pending()).toEqual([]);
  });

  it("a delete held for pairing still resolves when the path is deleted again", async () => {
    const h = await createHarness({ "a.md": NOTE });
    h.vault.external.remove("a.md");
    h.vault.external.write("a.md", "Different content.");
    await settle(1600);
    h.vault.external.remove("a.md");
    await settle();
    expect(pendingSummary(h.tracker)).toEqual(["a.md: deleted"]);
    expect(h.tracker.deletedContent("a.md")).toBe(NOTE);
  });

  it("in-app renames and deletes are never pending", async () => {
    const h = await createHarness({ "a.md": NOTE, "b.md": "B" });
    const [a, b] = h.vault.getMarkdownFiles();
    await h.vault.renameInApp(a, "renamed.md");
    await h.vault.trash(b);
    await settle();
    expect(h.tracker.pending()).toEqual([]);
  });
});

describe("open notes", () => {
  it("an external write reaches the editor as a reload and is tinted", async () => {
    const h = await createHarness({ "a.md": NOTE });
    const ed = h.open("a.md");
    await settle();
    h.writeOpen(ed, "a.md", NOTE.replace("world", "planet"));
    await settle();
    expect(pendingSummary(h.tracker)).toEqual(["a.md: modified"]);
    expect(ed.changes.map((c) => c.currentText)).toEqual(["planet"]);
  });

  it("own typing is never tinted", async () => {
    const h = await createHarness({ "a.md": NOTE });
    const ed = h.open("a.md");
    ed.type(0, 0, "Oh. ");
    await settle();
    expect(h.tracker.pending()).toEqual([]);

    h.writeOpen(ed, "a.md", ed.doc.replace("world", "planet"));
    await settle();
    // Typing in unchanged text is mirrored into the baseline.
    ed.type(ed.doc.length, ed.doc.length, "My addition.\n");
    await settle();
    expect(ed.changes.map((c) => c.currentText)).toEqual(["planet"]);
  });

  it("editing inside a pending change keeps it pending with the edited text", async () => {
    const h = await createHarness({ "a.md": NOTE });
    const ed = h.open("a.md");
    h.writeOpen(ed, "a.md", NOTE.replace("world", "planet"));
    await settle();
    const at = ed.doc.indexOf("planet");
    ed.type(at, at + "planet".length, "globe");
    await settle();
    expect(ed.changes).toHaveLength(1);
    expect(ed.changes[0]).toMatchObject({ baseText: "world", currentText: "globe" });
  });

  it("reject goes through the editor and does not move the baseline", async () => {
    const h = await createHarness({ "a.md": NOTE });
    const ed = h.open("a.md");
    h.writeOpen(ed, "a.md", NOTE.replace("world", "planet"));
    await settle();
    h.tracker.reject("a.md", ed.changes[0]);
    await settle();
    expect(ed.doc).toBe(NOTE);
    expect(h.tracker.pending()).toEqual([]);
    expect(ed.changes).toEqual([]);
  });

  it("a reload with the text the editor already has is a pane sync, not a change", async () => {
    const h = await createHarness({ "a.md": NOTE });
    const ed = h.open("a.md");
    ed.type(0, 0, "X");
    await settle();
    ed.reload(ed.doc);
    await settle();
    expect(h.tracker.pending()).toEqual([]);
    expect(h.externalEvents).toEqual([]);
  });

  it("the disk modify event for an open note is ignored in favour of the buffer", async () => {
    const h = await createHarness({ "a.md": NOTE });
    const ed = h.open("a.md");
    // Disk changes but Obsidian has not reloaded the editor (yet).
    h.vault.external.write("a.md", NOTE.replace("world", "planet"));
    await settle();
    expect(h.tracker.pending()).toEqual([]);
    ed.reload(NOTE.replace("world", "planet"));
    await settle();
    expect(pendingSummary(h.tracker)).toEqual(["a.md: modified"]);
  });

  it("opening a note that changed unseen marks it pending", async () => {
    const h = await createHarness({ "a.md": NOTE });
    h.vault.external.writeSilently("a.md", NOTE.replace("world", "planet"));
    const ed = h.open("a.md");
    await settle();
    expect(pendingSummary(h.tracker)).toEqual(["a.md: modified"]);
    expect(ed.changes.map((c) => c.currentText)).toEqual(["planet"]);
  });
});

describe("reset", () => {
  it("resetAll marks everything as reviewed", async () => {
    const h = await createHarness({ "a.md": NOTE, "b.md": "B" });
    h.vault.external.write("a.md", "changed");
    h.vault.external.write("c.md", "new");
    h.vault.external.remove("b.md");
    await settle();
    expect(h.tracker.pending()).toHaveLength(3);
    await h.tracker.resetAll();
    await settle();
    expect(h.tracker.pending()).toEqual([]);
  });
});
