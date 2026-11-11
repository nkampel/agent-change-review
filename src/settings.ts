import { App, PluginSettingTab, Setting } from "obsidian";
import type AgentChangeReviewPlugin from "./main";
import { DEFAULT_GROUPING, GroupingLevel, GroupingOptions } from "./diff/engine";
import { askChoice } from "./ui/confirm";

export interface AgentChangeReviewSettings {
  /** Exclusion patterns, one per entry (see PathFilter). */
  excluded: string[];
  maxFileSizeKB: number;
  deletionDisplay: "marker" | "inline";
  changeBars: boolean;
  grouping: GroupingOptions;
  notify: boolean;
  /** Writes by other Obsidian plugins (vault.modify/process) count as agent changes. */
  pluginWritesAreAgent: boolean;
}

export const DEFAULT_SETTINGS: AgentChangeReviewSettings = {
  excluded: [],
  maxFileSizeKB: 1024,
  deletionDisplay: "marker",
  changeBars: true,
  grouping: { ...DEFAULT_GROUPING },
  notify: true,
  pluginWritesAreAgent: true,
};

export class AgentChangeReviewSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: AgentChangeReviewPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    // ----- display

    new Setting(containerEl)
      .setName("Removed text")
      .setDesc("How deletions appear in the note. Hovering always shows the removed text.")
      .addDropdown((d) => {
        d.addOption("marker", "Slim red marker");
        d.addOption("inline", "Struck-through text");
        d.setValue(s.deletionDisplay);
        d.onChange(async (v) => {
          s.deletionDisplay = v as AgentChangeReviewSettings["deletionDisplay"];
          await this.plugin.saveSettings(true);
        });
      });

    new Setting(containerEl)
      .setName("Change bars")
      .setDesc(
        "A thin coloured bar beside every changed line, so changes stay visible where Live Preview hides the text (embeds, tables, folded sections)."
      )
      .addToggle((t) =>
        t.setValue(s.changeBars).onChange(async (v) => {
          s.changeBars = v;
          await this.plugin.saveSettings(true);
        })
      );

    new Setting(containerEl)
      .setName("Notify on new changes")
      .setDesc("Show a notice when files change outside Obsidian.")
      .addToggle((t) =>
        t.setValue(s.notify).onChange(async (v) => {
          s.notify = v;
          await this.plugin.saveSettings();
        })
      );

    // ----- review detail

    new Setting(containerEl).setName("Review detail").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "How edits are grouped into reviewable changes. Lower detail bundles nearby edits into whole " +
        "sentences or paragraphs; higher detail keeps them separate.",
    });

    new Setting(containerEl)
      .setName("Group into sentences")
      .setDesc(
        "When most of a sentence is rewritten, review the whole sentence instead of its individual edits."
      )
      .addDropdown((d) => {
        d.addOption("off", "Off — keep word and phrase edits");
        d.addOption("balanced", "Balanced (recommended)");
        d.addOption("eager", "Eager — group sooner");
        d.setValue(s.grouping.sentence);
        d.onChange(async (v) => {
          s.grouping.sentence = v as GroupingLevel;
          await this.plugin.saveSettings(true);
        });
      });

    new Setting(containerEl)
      .setName("Group into paragraphs")
      .setDesc(
        "When several sentences in a paragraph are rewritten, review the paragraph as one change. Only ever combines two or more separate changes."
      )
      .addDropdown((d) => {
        d.addOption("off", "Off — never group whole paragraphs");
        d.addOption("balanced", "Balanced (recommended)");
        d.addOption("eager", "Eager — group sooner");
        d.setValue(s.grouping.paragraph);
        d.onChange(async (v) => {
          s.grouping.paragraph = v as GroupingLevel;
          await this.plugin.saveSettings(true);
        });
      });

    // ----- tracking

    new Setting(containerEl).setName("Tracking").setHeading();

    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc(
        "One per line. A folder (Templates/), a file (Inbox/log.md), or a glob (**/drafts/*). Lines starting with # are ignored."
      )
      .addTextArea((t) => {
        t.setPlaceholder("Templates/\nDaily/*.md");
        t.setValue(s.excluded.join("\n"));
        t.inputEl.rows = 4;
        t.inputEl.addEventListener("blur", () => {
          const next = t
            .getValue()
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          if (next.join("\n") === s.excluded.join("\n")) return;
          s.excluded = next;
          void this.plugin.saveSettings(true);
        });
      });

    new Setting(containerEl)
      .setName("Maximum file size (KB)")
      .setDesc("Larger notes are not tracked.")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(s.maxFileSizeKB));
        t.onChange(async (v) => {
          const n = Number(v);
          if (!Number.isFinite(n) || n <= 0) return;
          s.maxFileSizeKB = n;
          await this.plugin.saveSettings(true);
        });
      });

    new Setting(containerEl)
      .setName("Count other plugins' writes as agent changes")
      .setDesc(
        "When on, notes written by other Obsidian plugins are reviewed like external edits. Obsidian's own link updates after a rename and property edits are never counted."
      )
      .addToggle((t) =>
        t.setValue(s.pluginWritesAreAgent).onChange(async (v) => {
          s.pluginWritesAreAgent = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Reset all baselines")
      .setDesc(
        "Treat the current content of every note as reviewed. Clears all pending changes, including new and deleted files."
      )
      .addButton((b) =>
        b
          .setButtonText("Reset")
          .setWarning()
          .onClick(async () => {
            const choice = await askChoice(
              this.app,
              "Reset all baselines?",
              "Every pending change in the vault will be marked as reviewed. This cannot be undone.",
              [{ label: "Reset", warning: true }, { label: "Cancel" }]
            );
            if (choice === "Reset") await this.plugin.tracker.resetAll();
          })
      );
  }
}
