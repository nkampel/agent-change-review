# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

**Agent Change Review** (`agent-change-review`): an Obsidian desktop plugin that renders changes made to vault notes by agents and other external tools *inline in the note*. Blue = changed, green = added, red = removed. A hover bubble explains each change and offers accept/reject. There is no LLM integration.

- [docs/DESIGN.md](docs/DESIGN.md) is the authoritative spec, including the verified Obsidian internals the design relies on.
- `test_vault/` is an untracked dev vault; when it exists, the build also installs into `test_vault/.obsidian/plugins/agent-change-review/`.

## Commands

- `npm run build`: bundle to `main.js` in the repo root, and install into `test_vault/` when it exists (esbuild, cjs; obsidian/electron/`@codemirror/*` external)
- `npm run dev`: watch mode (the dev vault gets a `.hotreload` marker for the Hot Reload plugin)
- `npm run typecheck`: `tsc --noEmit` over `src/` and `test/`, with unused-symbol checks (keep this clean; there is no separate lint)
- `npm test` / `npm run test:watch`: Vitest
- `npm install`: `.npmrc` sets `legacy-peer-deps`, because the `obsidian` package pins exact `@codemirror/*` peer versions
- Release: `npm version x.y.z` (bumps `manifest.json` + `versions.json`, tags without a `v`), then push the tag; `.github/workflows/release.yml` builds and publishes the GitHub release. Obsidian requires the tag to equal the manifest version.

## Tests

Vitest with jsdom (`vitest.config.ts`). `obsidian` is aliased to `test/stubs/obsidian.ts` (`Events`, `Notice`, `TFile`, `editorInfoField` as a plain `StateField`). `test/harness.ts` has a fake in-memory vault/adapter that fires vault events like Obsidian, a fake file manager, and `FakeEditor` sinks; timers are faked and `settle()` advances them. `test/extension.test.ts` uses a real `EditorView` with real `@codemirror/commands` history; `editorInfoField` must be added to its extensions explicitly, because Obsidian normally provides it. UI look and feel is checked manually in `test_vault`.

## Source map

- `src/main.ts`: plugin wiring. It implements `ReviewHost` for the editor extension and owns the bubble, commands, sidebar/status bar/notices, and vault event registration (after layout ready).
- `src/core/tracker.ts`: `ChangeTracker`, the single authority on baselines and pending state. It handles vault events, editor edits, accept/reject, and the startup scan.
- `src/core/filestate.ts`: `FileState`/`FileStates`: per-file state kept in step with the index, plus debounced baseline persistence (`persist`, `readBaseline`, `baselineHash`).
- `src/core/editors.ts`: the `EditorSink`/`EditorEdit` contract and `EditorRegistry` (attached editors, deferred pushes).
- `src/core/pairing.ts`: `RenamePairing`, which holds external deletes/creates briefly to pair them into renames.
- `src/core/timing.ts`: `KeyedTimers`, `KeyedQueue` (per-path serialization).
- `src/core/model.ts`: pure helpers: `mirrorOwnEdits` (§3.4), `editsBetween`, `findChange`, counts.
- `src/core/store.ts`: `SnapshotStore`: `index.json` plus hash-verified snapshot files under the plugin dir.
- `src/core/ownmarks.ts`: wraps Obsidian's in-app create/delete/rename/frontmatter/modify APIs to tell own file operations from external ones.
- `src/core/paths.ts`: exclusion patterns. `src/core/hash.ts`: cyrb53.
- `src/editor/extension.ts`: the CM6 layer: decorations StateField, the reject-history StateField, and the `ReviewSink` ViewPlugin (an `EditorSink`).
- `src/diff/engine.ts`: deterministic grouped word diff (base ↔ current).
- `src/ui/`: `bubble.ts`, `describe.ts` (change summaries), `sidebar.ts` (pending list + deleted-file preview), `confirm.ts`.
- `src/markdown/links.ts`: link/embed target extraction, used for "Changed link" summaries.

## Core model (non-negotiable)

1. **Pending changes are always `computeChanges(baseline, current)`**, never derived from the event sequence. The baseline only moves through own edits (mirrored), accept, and reset.
2. **Where `current` comes from:** an open editor's buffer is authoritative. `modify` events for open notes are ignored, because external writes reach the editor as Obsidian's reload transaction. Closed notes use disk.
3. **Transaction classification** (`classify` in the extension):
   - `userEvent: "set"` is a disk reload or a pane sync, i.e. external. If its result equals the tracker's known current text, it is a pane sync and a no-op.
   - The plugin's own reject transactions, and undo/redo that matches a recorded reject inverse/forward, are `plugin`: they change current, never the baseline.
   - Everything else is `own`.
4. **Own edits are never tinted.** An own edit in unchanged text is mirrored into the baseline. An edit touching a pending change (boundaries count) changes only current, so the change stays pending.
5. **Clean files hold no baseline in memory** (it equals current). A pending file always has its baseline loaded. The clean → pending transition on a reload takes the transaction's start text as baseline.
6. **Never dispatch into an editor synchronously from the tracker.** Pushes go through `setTimeout(0)`, because the tracker is often called from inside a CM update.
7. Snapshot writes are debounced. Any read of the baseline must go through `readBaseline`/`baselineHash` (the in-memory pending text wins over the file), or a quick external write after a settle diffs against a stale snapshot.
8. The core (`src/core/*`, `engine`) must not import CodeMirror. Editors talk to the tracker only via `EditorSink`.

## Diff engine notes

`word diff → atomic spans → change grouper → change groups`. The grouper merges spans separated by short gaps that cross no sentence/line boundary, then promotes clusters to whole sentences and paragraphs (`SENTENCE_FRACTION`/`PARAGRAPH_FRACTION`, `MIN_*_LEN` guards). Granularity is derived from what the final span covers. Two rules are load-bearing; loosening either makes everything collapse into one paragraph change:
1. density is measured from **pre-promotion** spans;
2. paragraph promotion requires **≥2 separate changes**.

User-tunable via `settings.grouping` ("Review detail"). `rejectionEdit` works for every kind (an insertion has empty `baseText`, a deletion has empty `currentText`). `acceptedBaseline` folds a change into the baseline.

## Known limitations / deliberate choices

- Reading view has no tints (v1). Changes inside Live Preview widgets are visible only via the change bar and the sidebar.
- Accept is not undoable. Reject is.
- Writes that bypass the vault API (sync clients, `adapter.write`) always count as external.
