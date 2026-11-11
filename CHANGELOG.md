# Changelog

All notable changes to this project are documented here. Versions follow
[semantic versioning](https://semver.org).

## [1.0.1] — 2026-11-11

### Changed
- Requires Obsidian 1.8.7 or newer (was 1.6.6).
- Release assets carry GitHub build provenance attestations.

### Fixed
- Hovering changes in a pop-out window could fail to open the bubble.
- Code cleanups for the Obsidian community plugin review.

## [1.0.0] — 2026-11-10

First public release.

### Features
- Inline review of changes that agents and other tools make to your notes, in
  Live Preview and Source mode: blue for changed text, green for added, red
  for removed, with optional change bars beside changed lines.
- Changes made while Obsidian was closed are detected at the next start.
- A hover popup per change: a plain-language summary, link and embed changes
  called out, word-level detail for rewritten sentences and paragraphs, and
  Accept / Revert. Reverting can be undone.
- Your own edits are never highlighted; editing inside a pending change keeps
  it pending with your version.
- The *Agent changes* panel lists modified, new, deleted and moved notes, with
  accept/revert per note or for everything, and a preview of deleted notes.
- Status bar counter, notices for new changes, and commands for navigating and
  accepting/rejecting changes.
- Keyboard review: after *Go to next change*, press A to accept, R to revert
  (each moves on to the next change), F to skip, Esc to close.
- Settings: removed-text display, change bars, notices, how eagerly edits are
  grouped into sentences and paragraphs, excluded paths, maximum file size,
  whether other plugins' writes count as agent changes, and resetting all
  baselines.
