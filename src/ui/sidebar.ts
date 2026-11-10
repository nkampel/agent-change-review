import { App, ItemView, Modal, WorkspaceLeaf, setIcon } from "obsidian";
import { ChangeTracker, PendingInfo } from "../core/tracker";
import { askChoice } from "./confirm";

export const SIDEBAR_VIEW = "agent-change-review-sidebar";

export interface SidebarHost {
  tracker: ChangeTracker;
  /** Open a note and jump to its first pending change. */
  openFirstChange(path: string): Promise<void>;
}

/** Right-sidebar list of every file with unreviewed changes (docs/DESIGN.md §8). */
export class PendingChangesView extends ItemView {
  private renderTimer: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private host: SidebarHost
  ) {
    super(leaf);
  }

  getViewType(): string {
    return SIDEBAR_VIEW;
  }

  getDisplayText(): string {
    return "Agent changes";
  }

  getIcon(): string {
    return "git-compare";
  }

  async onOpen(): Promise<void> {
    this.registerEvent(this.host.tracker.on("changed", () => this.scheduleRender()));
    this.render();
  }

  async onClose(): Promise<void> {
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
  }

  private scheduleRender(): void {
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 100);
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("acr-sidebar");
    const items = this.host.tracker.pending();

    const header = root.createDiv({ cls: "acr-sidebar-header" });
    header.createDiv({
      cls: "acr-sidebar-title",
      text: items.length === 0 ? "No pending changes" : `${items.length} file${items.length === 1 ? "" : "s"} changed`,
    });
    if (items.length > 0) {
      const actions = header.createDiv({ cls: "acr-sidebar-actions" });
      this.iconButton(actions, "check-check", "Accept everything", () => this.everything("accept"));
      this.iconButton(actions, "undo-2", "Reject everything", () => this.everything("reject"));
    }

    if (items.length === 0) {
      root.createDiv({
        cls: "acr-sidebar-empty",
        text: "When an agent or another tool edits notes in this vault, the changes show up here and inline in the note.",
      });
      return;
    }

    const list = root.createDiv({ cls: "acr-sidebar-list" });
    for (const item of items) this.renderItem(list, item);
  }

  private renderItem(list: HTMLElement, item: PendingInfo): void {
    const row = list.createDiv({ cls: `acr-item acr-item-${item.status}` });
    const main = row.createDiv({ cls: "acr-item-main" });
    const slash = item.path.lastIndexOf("/");
    const name = item.path.slice(slash + 1).replace(/\.md$/, "");
    const folder = slash >= 0 ? item.path.slice(0, slash) : "";

    const title = main.createDiv({ cls: "acr-item-title" });
    title.createSpan({ cls: "acr-item-name", text: name });
    const badge = statusBadge(item);
    if (badge) title.createSpan({ cls: `acr-badge acr-badge-${badge.kind}`, text: badge.text });

    const meta = main.createDiv({ cls: "acr-item-meta" });
    if (folder) meta.createSpan({ cls: "acr-item-folder", text: folder });
    if (item.renamedFrom) meta.createSpan({ cls: "acr-item-renamed", text: `from ${item.renamedFrom}` });

    if (item.status !== "deleted") {
      const counts = main.createDiv({ cls: "acr-counts" });
      const { changed, added, removed } = item.counts;
      if (changed) counts.createSpan({ cls: "acr-count acr-count-changed", text: `~${changed}` });
      if (added) counts.createSpan({ cls: "acr-count acr-count-added", text: `+${added}` });
      if (removed) counts.createSpan({ cls: "acr-count acr-count-removed", text: `−${removed}` });
      if (item.lastExternal) {
        counts.createSpan({ cls: "acr-item-time", text: relativeTime(item.lastExternal) });
      }
    }

    main.addEventListener("click", () => {
      if (item.status === "deleted") this.previewDeleted(item.path);
      else void this.host.openFirstChange(item.path);
    });

    const actions = row.createDiv({ cls: "acr-item-actions" });
    const tracker = this.host.tracker;
    const labels = actionLabels(item);
    this.iconButton(actions, "check", labels.accept, () => void tracker.acceptAll(item.path));
    this.iconButton(actions, "undo-2", labels.reject, () => void tracker.rejectAll(item.path));
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
    const btn = parent.createDiv({ cls: "clickable-icon acr-icon-btn", attr: { "aria-label": label } });
    setIcon(btn, icon);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
  }

  private async everything(action: "accept" | "reject"): Promise<void> {
    const items = this.host.tracker.pending();
    const verb = action === "accept" ? "Accept" : "Reject";
    const choice = await askChoice(
      this.app,
      `${verb} everything?`,
      action === "accept"
        ? `Mark all changes in ${items.length} file(s) as reviewed.`
        : `Revert all changes in ${items.length} file(s): edits are undone, new files go to the trash, deleted files are restored.`,
      [{ label: verb, warning: action === "reject" }, { label: "Cancel" }]
    );
    if (choice !== verb) return;
    for (const item of items) {
      if (action === "accept") await this.host.tracker.acceptAll(item.path);
      else await this.host.tracker.rejectAll(item.path);
    }
  }

  private previewDeleted(path: string): void {
    const content = this.host.tracker.deletedContent(path);
    if (content === null) return;
    new DeletedPreview(this.app, path, content, this.host.tracker).open();
  }
}

class DeletedPreview extends Modal {
  constructor(
    app: App,
    private path: string,
    private content: string,
    private tracker: ChangeTracker
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("acr-deleted-modal");
    this.titleEl.setText(`Deleted: ${this.path}`);
    this.contentEl.createEl("pre", { cls: "acr-deleted-content", text: this.content || "(empty file)" });
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    const restore = row.createEl("button", { cls: "mod-cta", text: "Restore file" });
    restore.addEventListener("click", () => {
      this.close();
      void this.tracker.rejectAll(this.path);
    });
    const accept = row.createEl("button", { text: "Accept deletion" });
    accept.addEventListener("click", () => {
      this.close();
      void this.tracker.acceptAll(this.path);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function statusBadge(item: PendingInfo): { kind: string; text: string } | null {
  if (item.status === "created") return { kind: "created", text: "new" };
  if (item.status === "deleted") return { kind: "deleted", text: "deleted" };
  if (item.renamedFrom) return { kind: "renamed", text: "moved" };
  return null;
}

function actionLabels(item: PendingInfo): { accept: string; reject: string } {
  if (item.status === "created") return { accept: "Keep new file", reject: "Delete new file" };
  if (item.status === "deleted") return { accept: "Accept deletion", reject: "Restore file" };
  return { accept: "Accept all changes", reject: "Reject all changes" };
}

function relativeTime(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}
