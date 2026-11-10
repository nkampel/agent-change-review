# Design — Agent Change Review

**Plugin id:** `agent-change-review` · **Name:** Agent Change Review
**Target platform:** Obsidian desktop plugin
**Editor foundation:** Obsidian's CodeMirror 6 (Live Preview + Source mode)
**Architecture principle:** The plugin never generates content. It watches the vault, keeps a reviewed baseline per note, and renders `baseline ↔ current` as inline change tints that you accept or reject.

---

# 1. Product vision

Coding/writing agents (Claude Code, scripts, sync tools) edit Markdown files on disk. Today you find out what changed with a red/green split diff, which is hard to read for prose.

Agent Change Review shows those changes **inside the note itself**, as you normally read and edit it:

- **blue** = changed (replacement)
- **green** = added
- **red** = removed

Hovering a change opens a bubble that says exactly what changed (before → after, word-level detail, a short summary) and lets you **accept** or **reject** it.

Colours encode the *kind* of change, never a judgement.

---

# 2. Core concepts

| Term | Meaning |
|---|---|
| **Baseline** | The last reviewed content of a file, stored as a snapshot. |
| **Current** | The file's content now (editor buffer if open, else disk). |
| **Pending change** | A logical change in `diff(baseline, current)`. |
| **External change** | Any modification not made by typing in an Obsidian editor (agent, git, script, sync, other plugins writing to disk). |
| **Own edit** | A user edit made in an Obsidian editor. Own edits are never tinted. |

**The fundamental invariant:** pending changes are always recomputed from `baseline` and `current`. They are never derived from the sequence of events that produced them. With no pending changes, `baseline == current`.

---

# 3. Change detection

## 3.1 Tracking scope
- All `.md` files in the vault are tracked. Settings may exclude folders/globs.
- On first install, every tracked file is snapshotted silently (nothing is pending).
- Files above a size limit (setting, default 1 MB) are skipped and listed as untracked.

## 3.2 While Obsidian is running
- A `vault.on("modify")` event with content ≠ the plugin's `lastSeen[path]` is an **external change**. `lastSeen` is updated from the open editors' own saves, so Obsidian's autosave of your typing never counts as external.
- When an open file is reloaded from disk, the CM6 transaction that brings in the new content must be classified as external, not as an own edit (see §3.4). **Verified** (Obsidian 1.13 `app.js`): `TextFileView.onModify → loadFileInternal → MarkdownView.setViewData → editMode.set(data, false)` dispatches a minimal line-diff with `userEvent: "set"`. Panes showing the same note sync the same way (`onExternalDataChange`), so a `"set"` whose result equals the known current text is a pane sync, not a disk change.
- For a note open in an editor, the editor buffer is authoritative and `modify` events for it are ignored (disk lags autosave). For closed notes, disk is authoritative.
- Several external writes before review accumulate: you always see one **cumulative** diff, baseline ↔ current. Intermediate states are not kept.

## 3.3 At startup (offline changes)
- On load, compare each tracked file's content hash with its stored baseline hash. A mismatch marks the file as pending. The agent may have run while Obsidian was closed.
- A tracked baseline whose file no longer exists → **deleted** (§3.5).
- A `.md` file with no snapshot that appeared since the last session → **created** (§3.5).
- Startup scanning is incremental (mtime/size first, hash only on mismatch) and must not block the UI.

## 3.4 Own edits ("own edits are never tinted")
Rule for every own-edit transaction in an editor whose file has pending changes:

1. **Edit entirely inside an unchanged region:** mirror it into the baseline. Map the position current → baseline; in equal regions the mapping is exact. The edit does not appear as a change.
2. **Edit touching or inside a pending change** (including its boundaries): apply it to current only. The change stays pending and its *after* text now shows your edited version. Reject still restores the baseline.

Files without pending changes need no special handling: the baseline simply follows the file (`baseline := current` on each own save).

## 3.5 File-level events
| Event | Shown as | Accept | Reject |
|---|---|---|---|
| File created externally | Whole file tinted green; list entry "new" | Snapshot becomes baseline | Move file to trash |
| File deleted externally | List entry "deleted" (with preview of the old content) | Drop snapshot | Restore file from snapshot |
| File renamed/moved | List entry "renamed from …"; the snapshot moves with it | Clear the rename marker | Move back to the old path |

- Obsidian reports an external `mv` as delete + create. External creates wait 1.5 s and external deletes 3 s, and a delete and a create with identical content are paired into one rename. Renames done in Obsidian (`vault.on("rename")`) carry the snapshot over silently.
- **Own vs external file operations** (`src/core/ownmarks.ts`): the plugin wraps Obsidian's in-app entry points and marks what they are about to do. `vault.create`/`copy` are own creates, and `vault.delete`/`trash` and `fileManager.trashFile` are own deletes. Content written during `fileManager.renameFile` (link updates) or `processFrontMatter` is own. Other plugins' `vault.modify`/`process` writes are own only when "Count other plugins' writes as agent changes" is off. Marks expire after 5 s. An own content write to a pending file is mirrored into the baseline like an own edit.

---

# 4. Diff model

Reuse the existing engine `src/diff/engine.ts` unchanged in spirit: `word diff → atomic spans → change grouper → logical changes`.

- Granularity word / phrase / sentence / paragraph, with the promotion rules and their load-bearing guards (density from pre-promotion spans; paragraph promotion needs ≥2 changes).
- User-tunable "Review detail" (`off` / `balanced` / `eager` per pass) stays.
- `LogicalChange.fine` provides the word-level breakdown used by the hover.
- `changeSignature` keeps UI state (hover pin, focus) stable across recomputes.
- Kind mapping: `replacement` → blue, `insertion` → green, `deletion` → red.
- Diff is computed against the **raw Markdown**, not the rendered output.
- Recompute is debounced (≈150 ms) after edits and runs immediately after an external change.

The core model (`ChangeTracker`, `Snapshot`, `LogicalChange`) must not know about CodeMirror or Obsidian views. The editor extension only consumes `{changes, baseline, current}`.

---

# 5. Inline rendering (Live Preview + Source)

Implemented as a CM6 extension (`registerEditorExtension`): a StateField of pending changes and a ViewPlugin for decorations. Reading view is **out of scope** for v1.

- **Replacement / insertion:** mark decorations on the current text, using the existing tint style (light background + 1px underline, stronger on hover). Sentence/paragraph groups get the left inset accent so they read as blocks.
- **Deletion**, per setting `deletionDisplay`:
  - `marker` (default): a slim red bar widget at the deletion point; the hover reveals the removed text.
  - `inline`: a non-editable widget showing the removed text struck through in red.
- **Change bars:** a line decoration (`.acr-line`, drawn with `::before` in the left margin) on every line a change touches, so changes stay visible even where Live Preview hides the text (embeds, tables, folded callouts). Leading line breaks of an insertion don't mark the line before it. The bar doubles as the fallback for marks hidden inside Live Preview widgets.
- **Theming:** reuse the current `styles.css` tint/bubble section, renamed from the `awe-` to the `acr-` prefix. Colours come only from Obsidian theme variables (`--color-blue-rgb`, `--color-green-rgb`, `--color-red-rgb`, `--background-*`, `--text-*`), so light/dark/community themes work without extra CSS.

---

# 6. Change Bubble (hover)

Adapted from `src/ui/bubble.ts`: hover intent with a grace delay, and the bubble pins once an action is clicked.

Content:
1. **Header:** kind chip (Changed / Added / Removed) and granularity.
2. **Summary line:** kind + size, e.g. "Replaced 3 words", "Added paragraph (42 words)", "Removed sentence (18 words)". If links/embeds changed, say so explicitly: "Removed link `[[Note]]`", "Changed embed target". Reuse `src/markdown/links.ts` to detect these.
3. **Before → after:** old text struck through in red, new text in its kind colour, truncated with "Show all".
4. **Word-level detail** (sentence/paragraph changes): the fine diff from `change.fine`, with the deleted/inserted words marked inside the unit.
5. **Actions:** `Accept` · `Reject` (label by kind: Reject change / Remove addition / Restore deletion).

Keyboard: commands for next/previous change, accept/reject the change at the cursor, and accept/reject all in the file.

---

# 7. Accept / reject semantics

- **Accept** a change: apply that change to the **baseline**. The current text is untouched; the tint disappears.
- **Reject** a change: apply `rejectionEdit(change)` to **current**. This edits the open editor as one undoable CM transaction, or the file via `vault.process` if it is closed. The tint disappears because current now equals the baseline there.
- Undoing a reject (Ctrl+Z) brings the text back, and it reappears as pending, because the baseline was never changed. Reject transactions are isolated in history, and the editor keeps their inverses mapped to the current doc. An undo whose changes equal one of them is classified as a plugin edit, not an own edit, so it is not mirrored into the baseline. Redo of an undone reject is tracked the same way. Undoing an accept is not supported in v1 (baseline changes aren't in editor history); see §11.
- **Accept all / Reject all** per file (bubble menu, sidebar, commands).
- Undecided changes simply stay pending, with no expiry.
- Writes made by reject must not be detected as external changes (the plugin updates `lastSeen` before writing).

---

# 8. Pending-changes sidebar

A right-sidebar view, "Agent changes":

- Lists every file with pending state: path, status (modified / new / deleted / renamed), and counts `~n +n −n`.
- Sorted by most recent external change. Clicking an entry opens the file and scrolls to the first change.
- Per-entry actions: Accept all, Reject all.
- Header: "Accept everything" (with confirmation).
- The ribbon icon and a status-bar counter ("3 files changed") open the sidebar.
- When new external changes are detected, a short **Notice** appears ("Agent changed 2 files"), throttled to one notice per burst; clicking it opens the sidebar. It can be disabled in settings.

---

# 9. Persistence

- Snapshots are stored under `.obsidian/plugins/agent-change-review/snapshots/<random id>.md`, one file per tracked note, holding the baseline content. Random ids (not path hashes) mean a rename only touches the index.
- `index.json`: `{ path → { id, hash, status, renamedFrom?, lastExternal?, mtime, size } }`. It is written as a temp file and then swapped in.
- Snapshot writes are debounced (1.5 s) and verified rather than atomic: a read is checked against the hash in the index, and a torn or missing snapshot reads as "unknown", so the current content is adopted rather than showing a bogus diff. Until a debounced write lands, the in-memory text wins over the file.
- Only files whose content differs from the baseline need their snapshot kept. The cache could therefore be pruned to hashes only for unchanged files. However, startup diffing (§3.3) needs a full baseline to *show* offline changes, so **v1 keeps full snapshots for every tracked file.** Size estimate: roughly the vault's Markdown size.
- The settings tab offers "Reset all baselines to current" (clears all pending state).

---

# 10. Settings

| Setting | Default |
|---|---|
| Excluded folders/globs | `.trash/`, templates folder |
| Max tracked file size | 1 MB |
| Deletion display | `marker` / `inline` |
| Review detail (sentence / paragraph grouping) | `balanced` / `balanced` |
| Notice on external change | on |
| Gutter markers | on |

---

# 11. Open questions / known limitations

1. ~~Own vs external create/delete.~~ Resolved by wrapping Obsidian's in-app APIs (§3.5) instead of guessing from focus.
2. **Other plugins writing to disk** count as external by default; a setting flips that for writes through the vault API. Tools that bypass the vault API (sync clients, plugins using `adapter.write`) always look external. Mitigation: excluded paths.
3. **Undo of accept** is not supported in v1.
4. **Reading view** tints are out of scope for v1.
5. **Very large rewrites** (whole file replaced): the engine may produce one paragraph-sized change per paragraph. That is acceptable, but the bubble should cap its preview length.
