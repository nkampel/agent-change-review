import { App, Modal } from "obsidian";

/** Minimal confirmation dialog; resolves the chosen button label or null. */
class ChoiceModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private title: string,
    private message: string,
    private choices: { label: string; warning?: boolean }[],
    private resolve: (choice: string | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createEl("p", { text: this.message });
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    for (const c of this.choices) {
      const btn = row.createEl("button", { text: c.label });
      if (c.warning) btn.addClass("mod-warning");
      btn.addEventListener("click", () => {
        this.resolved = true;
        this.close();
        this.resolve(c.label);
      });
    }
  }

  onClose(): void {
    if (!this.resolved) this.resolve(null);
    this.contentEl.empty();
  }
}

export function askChoice(
  app: App,
  title: string,
  message: string,
  choices: { label: string; warning?: boolean }[]
): Promise<string | null> {
  return new Promise((resolve) => {
    new ChoiceModal(app, title, message, choices, resolve).open();
  });
}
