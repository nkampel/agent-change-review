// Demo vault for screenshots: sample notes "before" and the edits an agent
// makes "after". Neutral content only.
//
//   node scripts/demo/vault.mjs create <dir>   write the vault + install the plugin
//   node scripts/demo/vault.mjs agent <dir>    apply the agent's edits on disk

import fs from "fs";
import path from "path";

const STUDY = `# Study plan

The goal for this term is to finish the statistics course and start the
reading group on research methods. Most of the work happens on weekday
mornings, when it is quiet.

## Schedule

Statistics lectures are on Monday and Wednesday. The reading group meets
every second Thursday, and each meeting covers one chapter of the book.
Exercises are due on Fridays.

## Resources

- Lecture notes are linked from [[Statistics course]].
- The reading list lives in [[Reading list]].
- Office hours are on Tuesday afternoons.

## Open questions

Should the reading group switch to a shorter book? Nobody has finished the
first chapter yet, and the discussion was thin last time.
`;

const STUDY_AFTER = `# Study plan

The goal for this term is to finish the statistics course and start the
reading group on research methods. Most of the work happens on weekday
mornings, when the library is quiet and there are no meetings.

## Schedule

Statistics lectures are on Monday and Wednesday. The reading group meets
every second Thursday, and each meeting covers one chapter of the book.
Exercises are due on Fridays.

Before each reading group, write three questions about the chapter and
share them in the group chat the evening before.

## Resources

- Lecture notes are linked from [[Statistics course]].
- The reading list lives in [[Reading list 2026]].

## Open questions

Should the reading group switch to a shorter book? Several members found
the first chapter dense, so a lighter text could keep the discussion going.
`;

const FILES = {
  "Study plan.md": STUDY,
  "Statistics course.md": "# Statistics course\n\nWeek 1: descriptive statistics.\nWeek 2: probability.\n",
  "Inbox/Reading list.md": "# Reading list\n\n- How to Read a Book\n- The Craft of Research\n",
  "Old ideas.md": "# Old ideas\n\n- A podcast about study habits\n- Flashcards for every lecture\n",
  "Weekly review.md": "# Weekly review\n\nWhat went well, what to change next week.\n",
};

function write(dir, rel, text) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function create(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(FILES)) write(dir, rel, text);

  const plugin = path.join(dir, ".obsidian/plugins/agent-change-review");
  fs.mkdirSync(plugin, { recursive: true });
  for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(f, path.join(plugin, f));
  write(dir, ".obsidian/community-plugins.json", JSON.stringify(["agent-change-review"]));
  write(dir, ".obsidian/app.json", JSON.stringify({ livePreview: true, showLineNumber: false }));
}

function agent(dir) {
  write(dir, "Study plan.md", STUDY_AFTER);
  write(dir, "Weekly review.md", "# Weekly review\n\nWhat went well, what to change next week, and one thing to drop.\n");
  write(dir, "Meeting notes.md", "# Meeting notes\n\nAgreed to read chapter two by next Thursday.\n");
  fs.rmSync(path.join(dir, "Old ideas.md"));
  fs.mkdirSync(path.join(dir, "Reading"), { recursive: true });
  fs.renameSync(path.join(dir, "Inbox/Reading list.md"), path.join(dir, "Reading/Reading list.md"));
}

const [cmd, dir] = process.argv.slice(2);
if (!dir || !["create", "agent"].includes(cmd)) {
  console.error("usage: node scripts/demo/vault.mjs create|agent <dir>");
  process.exit(1);
}
(cmd === "create" ? create : agent)(path.resolve(dir));
