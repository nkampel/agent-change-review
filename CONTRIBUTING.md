# Contributing

Thanks for helping out. Bug reports with steps to reproduce are just as
welcome as code.

## Setup

```sh
git clone https://github.com/nkampel/agent-change-review.git
cd agent-change-review
npm install          # .npmrc enables legacy-peer-deps (the obsidian package pins CodeMirror versions)
npm run build        # writes main.js to the repo root
```

For a dev vault, create `test_vault/` in the repo (it is git-ignored). Every
build is then also installed into `test_vault/.obsidian/plugins/agent-change-review/`.
With `npm run dev` (watch mode) and the
[Hot Reload](https://github.com/pjeby/hot-reload) plugin installed in that
vault, Obsidian reloads the plugin after each change.

## Checks

```sh
npm run typecheck    # tsc over src/ and test/, including unused symbols
npm test             # Vitest
npm run build
```

CI runs all three on every push and pull request.

Tests run without Obsidian: `obsidian` is replaced by a small stub
(`test/stubs/obsidian.ts`), and `test/harness.ts` provides an in-memory vault
that fires vault events like Obsidian does, plus fake editors. The editor
extension is tested against a real CodeMirror `EditorView` in jsdom. Visual
details still need a look in a real vault.

## Where things are

- `docs/DESIGN.md`: the design, including the Obsidian behaviour it relies on.
  Read §2–§3 before changing how changes are detected.
- `src/core/`: change tracking (no CodeMirror here). `tracker.ts` is the single
  authority on baselines and pending changes.
- `src/diff/engine.ts`: the diff and the grouping of edits into reviewable
  changes.
- `src/editor/extension.ts`: highlights and transaction classification in the
  editor.
- `src/ui/`: the popup, the panel, and dialogs.

`CLAUDE.md` summarizes the rules the code depends on (for example, that
pending changes are always computed from the baseline and the current text,
never from the sequence of events). They apply to human contributors too.

## Screenshots

The README images are generated from a demo vault; see
[scripts/demo/README.md](scripts/demo/README.md).

## Releasing

1. Update `CHANGELOG.md`.
2. `npm version 1.2.3` bumps `package.json`, `manifest.json` and
   `versions.json`, commits, and creates the tag `1.2.3` (no `v`: Obsidian
   requires the tag to equal the manifest version).
3. `git push --follow-tags`. The release workflow checks the tag, runs the
   checks, and publishes a GitHub release with `main.js`, `manifest.json` and
   `styles.css`.
