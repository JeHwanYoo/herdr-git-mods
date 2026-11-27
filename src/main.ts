import { v_flex } from "gpui-base";
import { type AsyncContext, type Context, div, type Element, type FocusHandle, View } from "gpui-kit";
import { exec, nextCommand, watchFolder } from "herdr";
import { shareSummaryReads } from "./git/read-sharing.ts";
import { type Repository, type RunGit, readRepository } from "./git/repository.ts";
import { RepositoryContext } from "./runtime/context.ts";
import { GitPlacement } from "./runtime/pane.ts";
import { ChangesTab } from "./ui/changes.ts";
import { Commands } from "./ui/commands.ts";
import { FilesTab } from "./ui/explorer.ts";
import { GraphTab } from "./ui/graph.ts";
import { Overlay } from "./ui/overlay.ts";
import { SettingsTab } from "./ui/settings.ts";
import {
  type AppShortcut,
  type BodySize,
  type RefreshScope,
  type RepositoryFacts,
  type Services,
  Shell,
  type TabId,
  type TabView,
} from "./ui/shell.ts";
import { look, WIDE_COLUMNS } from "./ui/theme.ts";
import { WorkspacesBox } from "./ui/workspaces.ts";

const REFRESH_MS = 10000;

const EMPTY_FACTS: RepositoryFacts = { head: null, identity: null, github: false, remotes: [], stash: false };

const NEXT_COMMANDS: Record<string, AppShortcut> = {
  changes: "changes",
  history: "graph",
  graph: "graph",
  files: "files",
  settings: "settings",
  commands: "commands",
  workspaces: "workspace",
  "files-search": "files-search",
  fetch: "fetch",
  pull: "pull",
  commit: "commit",
  push: "push",
  branches: "branch",
  stash: "stash",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readFacts(git: RunGit): Promise<RepositoryFacts> {
  const [head, name, email, origin, remotes, stash] = await Promise.all([
    git(["rev-parse", "--verify", "--quiet", "HEAD"]),
    git(["config", "user.name"]),
    git(["config", "user.email"]),
    git(["remote", "get-url", "origin"]),
    git(["remote"]),
    git(["rev-parse", "--verify", "--quiet", "refs/stash"]),
  ]);
  const user = name.stdout.trim();
  const mail = email.stdout.trim();
  return {
    head: head.code === 0 ? head.stdout.trim() || null : null,
    identity: user && mail ? { name: user, email: mail } : null,
    github: origin.code === 0 && origin.stdout.includes("github.com"),
    remotes: remotes.stdout.split("\n").filter(Boolean),
    stash: stash.code === 0,
  };
}

class Session {
  readonly services: Services;
  readonly overlay: Overlay;
  readonly shell: Shell;
  readonly root: FocusHandle;
  private readonly workspaces: WorkspacesBox;
  private readonly settings: SettingsTab;
  private readonly tabs: Record<TabId, TabView>;
  private readonly graph: GraphTab;
  private readonly changes: ChangesTab;
  private readonly commands: Commands;
  private tab: TabId = "changes";
  private repository: Repository | null = null;
  private readGit: RunGit | null = null;
  private facts: RepositoryFacts = EMPTY_FACTS;
  private repositoryError: string | null = null;
  private error: string | null = null;
  private context: string | null = null;
  private on: string | null = null;
  private loading = false;
  private watched: string | null = null;
  private statusRequest = 0;
  private operation: string | null = null;
  private body: BodySize = { width: 0, height: 0, cols: 0, rows: 0, wide: true };
  private active = true;

  constructor(
    private readonly source: RepositoryContext,
    private readonly placement: GitPlacement,
    cx: AsyncContext,
  ) {
    this.root = cx.focus_handle();
    this.overlay = new Overlay(cx, () => this.tabs[this.tab].focus());
    this.services = {
      source,
      overlay: this.overlay,
      context: () => JSON.stringify(this.source.current()),
      location: () => this.source.current(),
      repository: () => this.repository,
      repositoryError: () => this.repositoryError,
      loading: () => this.loading,
      facts: () => this.facts,
      git: () => this.readGit,
      historyGit: () => {
        const repository = this.repository;
        if (repository?.state !== "ready") return null;
        const on = this.on;
        return (args) => exec("git", args, { cwd: repository.root, on, timeout: 300000 });
      },
      mutate: (context, label, action, cx) => this.mutate(context, label, action, cx),
      busy: () => this.operation,
      refresh: (scope, cx) => this.refresh(scope, cx),
      activeTab: () => this.tab,
      setTab: (tab, cx) => this.setTab(tab, cx),
      selectedCommit: () => this.graph.selectedCommit(),
      revealCommit: (sha, cx) => {
        this.setTab("graph", cx);
        this.graph.reveal(sha, cx);
      },
      openCommitDiff: (sha, cx) => {
        this.changes.showCommit(sha, cx);
        this.setTab("changes", cx);
      },
      reportError: (message) => {
        this.error = message;
      },
      commands: () => this.commands,
    };
    this.workspaces = new WorkspacesBox(this.services, cx);
    this.settings = new SettingsTab(
      cx,
      (cx) => this.commands.dispatch("update", cx),
      () => this.commands.update.status(),
    );
    const changes = new ChangesTab(this.services, this.workspaces, cx);
    this.changes = changes;
    this.graph = new GraphTab(this.services, cx, () => this.settings.graph, this.workspaces);
    const files = new FilesTab(this.services, this.workspaces, cx);
    this.tabs = { changes, graph: this.graph, files, settings: this.settings };
    this.commands = new Commands(this.services, { changes, graph: this.graph, files, workspaces: this.workspaces });
    this.shell = new Shell({
      active: () => this.tabs[this.tab],
      setTab: (tab, cx) => this.setTab(tab, cx),
      commands: () => this.commands,
      overlayOpen: () => this.overlay.isOpen(),
    });
    changes.activate(cx);
    this.listenCommands(cx);
    this.commands.update.watch(cx);
    this.refresh("repository", cx);
    cx.timer.every(REFRESH_MS, (cx) => {
      if (this.settings.autoRefresh) this.refresh("changes", cx);
    });
  }

  close(): void {
    this.active = false;
    this.statusRequest++;
    this.watched = null;
    this.overlay.release();
    this.commands.release();
    for (const tab of Object.values(this.tabs)) tab.release();
    this.workspaces.release();
    this.root.release();
  }

  private listenCommands(cx: AsyncContext): void {
    cx.spawn(async (cx) => {
      while (this.active) {
        const command = await nextCommand();
        if (!this.active) return;
        this.command(command, cx);
        cx.notify();
      }
    });
  }

  private command(command: string, cx: AsyncContext): void {
    const shortcut = NEXT_COMMANDS[command];
    if (command === "focus") this.tabs[this.tab].focus();
    else if (command === "close") this.placement.close();
    else if (command === "refresh") this.refresh("repository", cx);
    else if (shortcut && !this.overlay.isOpen()) this.shell.dispatch(shortcut, cx);
  }

  private setTab(tab: TabId, cx: AsyncContext): void {
    if (tab === this.tab) return;
    this.tabs[this.tab].deactivate(cx);
    this.tab = tab;
    const next = this.tabs[tab];
    next.activate(cx);
    next.focus();
  }

  private broadcast(scope: RefreshScope, cx: AsyncContext): void {
    for (const tab of Object.values(this.tabs)) tab.refresh?.(scope, cx);
  }

  refresh(scope: RefreshScope, cx: AsyncContext): void {
    if (scope === "workspaces") this.workspaces.refresh(cx);
    if (scope === "workspaces" || scope === "history") {
      this.broadcast(scope, cx);
      return;
    }
    const where = this.source.current();
    const context = JSON.stringify(where);
    if (context !== this.context) {
      this.context = context;
      this.on = where?.on ?? null;
      this.statusRequest++;
      this.repository = null;
      this.readGit = null;
      this.facts = EMPTY_FACTS;
      this.repositoryError = null;
      this.error = null;
      this.watched = null;
      this.loading = false;
      this.broadcast("repository", cx);
    }
    if (!where?.cwd || this.loading || !this.active || this.operation) return;
    this.loading = true;
    const request = ++this.statusRequest;
    const current = () =>
      this.active && request === this.statusRequest && context === JSON.stringify(this.source.current());
    const cwd = where.cwd;
    cx.spawn(async (cx) => {
      try {
        const git: RunGit = (args) => exec("git", args, { cwd, on: where.on });
        const repository = await readRepository(git);
        const facts = repository.state === "ready" ? await readFacts(git) : EMPTY_FACTS;
        if (!current()) return;
        this.applyRepository(repository, facts, cx);
        this.broadcast(scope, cx);
        if (repository.state === "ready" && !this.on) this.watch(repository.root, context, cx);
      } catch (error) {
        if (current()) this.repositoryError = errorMessage(error);
      } finally {
        if (current()) {
          this.loading = false;
          cx.notify();
        }
      }
    });
  }

  private applyRepository(repository: Repository, facts: RepositoryFacts, cx: AsyncContext): void {
    const on = this.on;
    this.repository = repository;
    this.readGit =
      repository.state === "ready"
        ? shareSummaryReads((args) => exec("git", args, { cwd: repository.root, on }))
        : null;
    this.facts = facts;
    this.repositoryError = null;
    this.loading = false;
    this.workspaces.refresh(cx, repository.state === "ready" ? repository : undefined);
  }

  private watch(root: string, context: string, cx: AsyncContext): void {
    if (this.watched === root) return;
    this.watched = root;
    const watching = () => this.active && this.context === context && this.watched === root;
    cx.spawn(async (cx) => {
      try {
        while (watching()) {
          await watchFolder(root);
          if (watching() && this.settings.autoRefresh) this.refresh("changes", cx);
        }
      } catch {
        if (this.context === context && this.watched === root) this.watched = null;
      }
    });
  }

  private mutate(
    context: string,
    label: string,
    action: (git: RunGit, cx: AsyncContext) => Promise<void>,
    cx: AsyncContext,
  ): void {
    const repository = this.repository;
    if (repository?.state !== "ready" || this.operation) return;
    if (context !== this.context || context !== JSON.stringify(this.source.current())) {
      this.error = "Repository changed; review the current repository before retrying";
      return;
    }
    const on = this.on;
    const current = () => this.active && context === JSON.stringify(this.source.current());
    this.operation = label;
    this.error = null;
    this.statusRequest++;
    this.loading = false;
    cx.spawn(async (cx) => {
      try {
        const git: RunGit = (args) => exec("git", args, { cwd: repository.root, on });
        const latest = await readRepository(git);
        if (!current()) return;
        if (latest.state !== "ready" || latest.root !== repository.root)
          throw new Error("Repository changed; refresh before retrying");
        await action(git, cx);
      } catch (error) {
        if (this.active)
          this.error = `${label} failed in ${repository.root}: ${errorMessage(error)}. Inspect the repository before retrying.`;
      } finally {
        if (this.active) {
          this.operation = null;
          this.refresh("repository", cx);
          cx.notify();
        }
      }
    });
  }

  render(cx: Context): Element {
    if (JSON.stringify(this.source.current()) !== this.context) this.refresh("repository", cx);
    this.workspaces.syncProjects(cx);
    const view = look();
    const tab = this.tabs[this.tab];
    const repository = this.repository;
    const path = repository?.state === "ready" ? repository.root : (this.source.current()?.cwd ?? "");
    const root = v_flex()
      .id("git")
      .relative()
      .size_full()
      .min_h(0)
      .bg(view.t.background)
      .text_color(view.t.text)
      .font_family(view.font)
      .text_size(view.size)
      .line_height(`${view.row}px`)
      .child(this.shell.header(view))
      .child(
        v_flex()
          .id("git-body")
          .flex_1()
          .min_h(0)
          .min_w(0)
          .p(6)
          .overflow_hidden()
          .on_size_change((size, cx) => {
            const cols = Math.floor(size.width / view.screenCell);
            const rows = Math.floor(size.height / view.screenRow);
            if (cols === this.body.cols && rows === this.body.rows) return;
            this.body = { ...size, cols, rows, wide: cols >= WIDE_COLUMNS };
            cx.notify();
          })
          .child(tab.render(view, this.body, cx)),
      )
      .child(
        this.shell.statusBar(view, {
          repository,
          facts: this.facts,
          path,
          status: tab.status?.() ?? {},
          graph: this.tab === "graph",
          progress: this.operation ?? this.workspaces.progress() ?? (this.loading ? "Refreshing repository" : null),
          error: this.error ?? this.repositoryError,
        }),
      )
      .on_modifiers_changed((event, cx) => this.shell.modifiersChanged(event.modifiers.alt, cx))
      .on_key_down((event, cx) => this.shell.keyDown(event, cx))
      .track_focus(this.root);
    const dialog = this.overlay.render(view);
    return dialog ? root.child(dialog) : root;
  }
}

export default class Git extends View {
  private session: Session | null = null;
  private placement: GitPlacement | null = null;

  override init(_props: unknown, cx: AsyncContext): void {
    const source = new RepositoryContext();
    this.placement = new GitPlacement(source, cx);
    if (this.placement.launcher) return;
    this.session = new Session(source, this.placement, cx);
  }

  override async close(): Promise<void> {
    this.session?.close();
    this.session = null;
  }

  override render(cx: Context): Element {
    return this.session?.render(cx) ?? div();
  }
}
