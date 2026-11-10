import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { EditorView } from "@codemirror/view";
import { LogicalChange, changeAtCurrentPos } from "./diff/engine";
import { OwnMarks } from "./core/ownmarks";
import { SnapshotStore } from "./core/store";
import { ChangeTracker } from "./core/tracker";
import { DisplayOptions, ReviewHost, ReviewSink, reviewExtension } from "./editor/extension";
import { AgentChangeReviewSettingTab, AgentChangeReviewSettings, DEFAULT_SETTINGS } from "./settings";
import { ChangeBubble } from "./ui/bubble";
import { PendingChangesView, SIDEBAR_VIEW } from "./ui/sidebar";

const NOTICE_BURST = 1200;

export default class AgentChangeReviewPlugin extends Plugin implements ReviewHost {
  settings!: AgentChangeReviewSettings;
  tracker!: ChangeTracker;
  private marks!: OwnMarks;
  private bubble = new ChangeBubble();
  private sinkPlugin!: ReturnType<typeof reviewExtension>["plugin"];
  private statusEl!: HTMLElement;
  private noticePaths = new Set<string>();
  private noticeTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.marks = new OwnMarks(this.app, () => this.settings.pluginWritesAreAgent);
    this.marks.install();
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    this.tracker = new ChangeTracker(
      this.app,
      new SnapshotStore(this.app.vault.adapter, dir),
      this.marks,
      () => this.settings
    );
    await this.tracker.load();

    const { extension, plugin } = reviewExtension(this);
    this.sinkPlugin = plugin;
    this.registerEditorExtension(extension);

    this.registerView(
      SIDEBAR_VIEW,
      (leaf) =>
        new PendingChangesView(leaf, {
          tracker: this.tracker,
          openFirstChange: (path) => this.openFirstChange(path),
        })
    );
    this.addRibbonIcon("git-compare", "Agent changes", () => void this.openSidebar());

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("acr-status", "mod-clickable");
    this.statusEl.addEventListener("click", () => void this.openSidebar());
    this.registerEvent(this.tracker.on("changed", () => this.updateStatus()));
    this.registerEvent(this.tracker.on("external", (path) => this.queueNotice(path as string)));
    this.updateStatus();

    this.addCommands();
    this.addSettingTab(new AgentChangeReviewSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      const vault = this.app.vault;
      this.registerEvent(vault.on("modify", (f) => this.tracker.onModify(f)));
      this.registerEvent(vault.on("create", (f) => this.tracker.onCreate(f)));
      this.registerEvent(vault.on("delete", (f) => this.tracker.onDelete(f)));
      this.registerEvent(vault.on("rename", (f, old) => this.tracker.onRename(f, old)));
      this.tracker.start();
    });
  }

  async onunload(): Promise<void> {
    this.bubble.destroy();
    this.marks.uninstall();
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    await this.tracker.shutdown();
  }

  async loadSettings(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<AgentChangeReviewSettings>;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      grouping: { ...DEFAULT_SETTINGS.grouping, ...(data.grouping ?? {}) },
    };
  }

  /** `retrack`: settings that affect tracking or rendering changed. */
  async saveSettings(retrack = false): Promise<void> {
    await this.saveData(this.settings);
    if (retrack) this.tracker.settingsChanged();
  }

  // ------------------------------------------------------------- ReviewHost

  display(): DisplayOptions {
    return { deletionDisplay: this.settings.deletionDisplay, changeBars: this.settings.changeBars };
  }

  hover(sink: ReviewSink, change: LogicalChange, anchor: DOMRect): void {
    this.showBubble(sink, change, anchor, false);
  }

  unhover(): void {
    this.bubble.scheduleHide();
  }

  scrolled(): void {
    this.bubble.scrolled();
  }

  private showBubble(sink: ReviewSink, change: LogicalChange, anchor: DOMRect, pin: boolean): void {
    const path = sink.path();
    if (!path) return;
    // Opened from the keyboard: keep reviewing after accept/reject.
    const thenNext = () => {
      if (pin) this.focusAfter(sink, path, change, true);
    };
    this.bubble.show(
      change,
      anchor,
      {
        accept: () => {
          this.tracker.accept(path, change);
          thenNext();
        },
        reject: () => {
          this.tracker.reject(path, change);
          thenNext();
        },
        next: () => this.focusAfter(sink, path, change, false),
      },
      sink.view.dom.ownerDocument,
      pin
    );
  }

  // ------------------------------------------------------------- commands

  private activeSink(): ReviewSink | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    // `editor.cm` is Obsidian's underlying CodeMirror 6 view.
    const cm = (view?.editor as unknown as { cm?: EditorView } | undefined)?.cm;
    return cm?.plugin(this.sinkPlugin) ?? null;
  }

  private withSink(fn: (sink: ReviewSink, path: string, changes: LogicalChange[]) => void) {
    return (checking: boolean): boolean => {
      const sink = this.activeSink();
      const path = sink?.path();
      if (!sink || !path) return false;
      const changes = this.tracker.changesFor(path);
      if (changes.length === 0) return false;
      if (!checking) fn(sink, path, changes);
      return true;
    };
  }

  private addCommands(): void {
    this.addCommand({
      id: "open-sidebar",
      name: "Show pending changes",
      callback: () => void this.openSidebar(),
    });
    this.addCommand({
      id: "next-change",
      name: "Go to next change",
      checkCallback: this.withSink((sink, _path, changes) => {
        const head = sink.view.state.selection.main.head;
        const next = changes.find((c) => c.currentFrom > head) ?? changes[0];
        void this.focusChange(sink, next);
      }),
    });
    this.addCommand({
      id: "previous-change",
      name: "Go to previous change",
      checkCallback: this.withSink((sink, _path, changes) => {
        const from = sink.view.state.selection.main.from;
        const before = changes.filter((c) => c.currentFrom < from);
        void this.focusChange(sink, before[before.length - 1] ?? changes[changes.length - 1]);
      }),
    });
    this.addCommand({
      id: "accept-change",
      name: "Accept change at cursor",
      checkCallback: this.withSink((sink, path, changes) => {
        const c = changeAtCurrentPos(changes, sink.view.state.selection.main.head);
        if (c) {
          this.bubble.destroy();
          this.tracker.accept(path, c);
        } else new Notice("No change at the cursor.");
      }),
    });
    this.addCommand({
      id: "reject-change",
      name: "Reject change at cursor",
      checkCallback: this.withSink((sink, path, changes) => {
        const c = changeAtCurrentPos(changes, sink.view.state.selection.main.head);
        if (c) {
          this.bubble.destroy();
          this.tracker.reject(path, c);
        } else new Notice("No change at the cursor.");
      }),
    });
    this.addCommand({
      id: "accept-all-file",
      name: "Accept all changes in this note",
      checkCallback: this.withFile((path) => void this.tracker.acceptAll(path)),
    });
    this.addCommand({
      id: "reject-all-file",
      name: "Reject all changes in this note",
      checkCallback: this.withFile((path) => void this.tracker.rejectAll(path)),
    });
  }

  private withFile(fn: (path: string) => void) {
    return (checking: boolean): boolean => {
      const file = this.app.workspace.getActiveFile();
      if (!file || !this.tracker.pending().some((p) => p.path === file.path)) return false;
      if (!checking) fn(file.path);
      return true;
    };
  }

  /**
   * Keyboard review: open the change after `change`. After an accept or
   * reject that change is gone, so the next one starts at its position.
   */
  private focusAfter(sink: ReviewSink, path: string, change: LogicalChange, inclusive: boolean): void {
    // Let the editor apply a reject and the tracker recompute first.
    window.setTimeout(() => {
      const changes = this.tracker.changesFor(path);
      if (changes.length === 0) return;
      const next =
        changes.find((c) => (inclusive ? c.currentFrom >= change.currentFrom : c.currentFrom > change.currentFrom)) ??
        changes[0];
      void this.focusChange(sink, next);
    }, 50);
  }

  private async focusChange(sink: ReviewSink, change: LogicalChange): Promise<void> {
    sink.reveal(change);
    const rect = await sink.rectOf(change);
    if (rect) this.showBubble(sink, change, rect, true);
  }

  // ------------------------------------------------------------- sidebar, status, notices

  async openSidebar(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(SIDEBAR_VIEW)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: SIDEBAR_VIEW, active: true });
    }
    void workspace.revealLeaf(leaf);
  }

  private async openFirstChange(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType("markdown").find((l) => (l.view as MarkdownView).file?.path === path);
    if (leaf) workspace.setActiveLeaf(leaf, { focus: true });
    else {
      leaf = workspace.getLeaf(false);
      await leaf.openFile(file);
    }
    const view = leaf.view;
    if (view instanceof MarkdownView && view.getMode() !== "source") {
      await leaf.setViewState({ ...leaf.getViewState(), state: { ...leaf.getViewState().state, mode: "source" } });
    }
    // Changes arrive asynchronously after the editor attaches.
    window.setTimeout(() => {
      const sink = this.activeSink();
      const changes = this.tracker.changesFor(path);
      if (sink && changes.length > 0) void this.focusChange(sink, changes[0]);
    }, 120);
  }

  private updateStatus(): void {
    const n = this.tracker.pending().length;
    this.statusEl.toggle(n > 0);
    this.statusEl.setText(n === 1 ? "1 file changed" : `${n} files changed`);
    this.statusEl.setAttr("aria-label", "Review agent changes");
  }

  private queueNotice(path: string): void {
    if (!this.settings.notify) return;
    this.noticePaths.add(path);
    if (this.noticeTimer !== null) return;
    this.noticeTimer = window.setTimeout(() => {
      this.noticeTimer = null;
      const n = this.noticePaths.size;
      const only = n === 1 ? Array.from(this.noticePaths)[0] : null;
      this.noticePaths.clear();
      const text = only
        ? `Changed outside Obsidian: ${only.replace(/\.md$/, "")} — click to review`
        : `${n} files changed outside Obsidian — click to review`;
      const notice = new Notice(text, 8000);
      notice.noticeEl.addClass("acr-notice");
      notice.noticeEl.addEventListener("click", () => {
        if (only && this.app.vault.getAbstractFileByPath(only)) void this.openFirstChange(only);
        else void this.openSidebar();
      });
    }, NOTICE_BURST);
  }
}
