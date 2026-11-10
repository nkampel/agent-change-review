/**
 * The CM6 layer against a real EditorView (jsdom) and real undo history:
 * transaction classification, decorations, and undo/redo of a reject.
 */
import { history, redo, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewHost, reviewExtension } from "../src/editor/extension";
import { createHarness, settle } from "./harness";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.empty?.();
});

const NOTE = "Hello world. This is a note.\n";

async function setup() {
  const h = await createHarness({ "a.md": NOTE });
  const host: ReviewHost = {
    tracker: h.tracker,
    display: () => ({ deletionDisplay: "marker", changeBars: true }),
    hover: () => undefined,
    unhover: () => undefined,
    scrolled: () => undefined,
  };
  const { extension } = reviewExtension(host);
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: NOTE,
      extensions: [editorInfoField.init(() => ({ file: { path: "a.md" } }) as never), history(), extension],
    }),
  });
  /** Obsidian reloads a changed file into the editor with userEvent "set". */
  const reload = (text: string) =>
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "set" });
  return { h, view, reload };
}

const tinted = (view: EditorView) =>
  Array.from(view.contentDOM.querySelectorAll(".acr-ch")).map((el) => el.className.split(" ")[1] ?? "");

it("renders an external change and removes the tint on reject", async () => {
  const { h, view, reload } = await setup();
  reload(NOTE.replace("world", "planet"));
  await settle();
  expect(tinted(view)).toEqual(["acr-ch-replacement"]);
  expect(view.contentDOM.querySelector(".acr-line-replacement")).not.toBeNull();

  h.tracker.reject("a.md", h.tracker.changesFor("a.md")[0]);
  await settle();
  expect(view.state.doc.toString()).toBe(NOTE);
  expect(tinted(view)).toEqual([]);
});

it("undoing a reject brings the change back as pending; redo rejects it again", async () => {
  const { h, view, reload } = await setup();
  reload(NOTE.replace("world", "planet"));
  await settle();
  h.tracker.reject("a.md", h.tracker.changesFor("a.md")[0]);
  await settle();
  expect(h.tracker.pending()).toEqual([]);

  undo(view);
  await settle();
  expect(view.state.doc.toString()).toContain("planet");
  expect(h.tracker.changesFor("a.md").map((c) => c.currentText)).toEqual(["planet"]);

  redo(view);
  await settle();
  expect(view.state.doc.toString()).toBe(NOTE);
  expect(h.tracker.pending()).toEqual([]);
});

it("own typing is not tinted", async () => {
  const { h, view } = await setup();
  view.dispatch({ changes: { from: 0, insert: "Oh. " }, userEvent: "input.type" });
  await settle();
  expect(h.tracker.pending()).toEqual([]);
  expect(tinted(view)).toEqual([]);
});
