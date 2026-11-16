import { h_flex, InputState, v_flex } from "gpui-base";
import {
  type AsyncContext,
  type Context,
  div,
  type Element,
  type FocusHandle,
  type KeyEvent,
  type ScrollWheelEvent,
} from "gpui-kit";
import {
  type Commit,
  filteredCommitIndices,
  HISTORY_PAGE_SIZE,
  type HistoryCursor,
  type HistoryPage,
  isHead,
  readHistoryPage,
  readRefsFingerprint,
} from "../git/history.ts";
import { prepareHistory } from "../git/history-maintenance.ts";
import type { RunGit } from "../git/repository.ts";
import { showResult } from "./commands/result.ts";
import { Inspect, workingChanges } from "./graph/inspect.ts";
import { curveLanes, glyphLanes, type LaneViewport } from "./graph/lanes.ts";
import { buildLayout, type LayoutRow, layoutWidth, ROW_HEIGHT } from "./graph/layout.ts";
import { commitDetail, commitTitle, graphViewWidth } from "./graph/rows.ts";
import {
  type BodySize,
  type GraphAction,
  type RefreshScope,
  type Services,
  shortCommit,
  type TabStatus,
  type TabView,
} from "./shell.ts";
import { cols, DIALOG, type Look, rows } from "./theme.ts";
import { type ActionCell, box, filterBar, isChord, scrollbar, spinner } from "./widgets.ts";
import type { WorkspacesBox } from "./workspaces.ts";

const GRAPH_ACTIONS: readonly { id: GraphAction; label: string; shortcut: string; icon: string }[] = [
  { id: "checkout", label: "Checkout", shortcut: "x", icon: "\uf417" },
  { id: "rebase", label: "Rebase", shortcut: "r", icon: "\uf47f" },
  { id: "cherry-pick", label: "Cherry-pick", shortcut: "y", icon: "⎇" },
  { id: "revert", label: "Revert", shortcut: "v", icon: "↩" },
  { id: "reset", label: "Reset", shortcut: "t", icon: "\uf464" },
  { id: "copy-sha", label: "Copy SHA", shortcut: "h", icon: "\uf0c5" },
];

const REVEAL_LIMIT = 10_000;
const SPLIT_SCALE = 1_000;
const DEFAULT_SPLITS = [200, 600] as const;
const MIN_FILES_WIDTH = 20;
const MIN_DIFF_WIDTH = 24;
const WIDE_LOWER = 90;

interface GraphState {
  commits: Commit[];
  visible: number[];
  uncommitted: Commit | null;
  layout: LayoutRow[];
  loaded: boolean;
  hasMore: boolean;
  cursor: HistoryCursor | null;
  selected: number;
  scroll: number;
  graphScroll: number;
  query: string;
  anchor: string | null;
  stashed: GraphState | null;
}

interface PendingHistory {
  id: number;
  replace: boolean;
  offset: number;
}

interface Preparation {
  pending: boolean;
  warning: string | null;
  done: Promise<void>;
}

function emptyState(): GraphState {
  return {
    commits: [],
    visible: [],
    uncommitted: null,
    layout: [],
    loaded: false,
    hasMore: false,
    cursor: null,
    selected: 0,
    scroll: 0,
    graphScroll: 0,
    query: "",
    anchor: null,
    stashed: null,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function paneWidths(total: number): [number, number, number] {
  if (total < MIN_FILES_WIDTH + MIN_DIFF_WIDTH * 2) {
    const files = Math.floor(total / 5);
    const before = Math.floor((total * 2) / 5);
    return [files, before, total - files - before];
  }
  const scaled = (split: number) => Math.floor((total * split) / SPLIT_SCALE);
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));
  const first = clamp(scaled(DEFAULT_SPLITS[0]), MIN_FILES_WIDTH, total - MIN_DIFF_WIDTH * 2);
  const second = clamp(scaled(DEFAULT_SPLITS[1]), first + MIN_DIFF_WIDTH, total - MIN_DIFF_WIDTH);
  return [first, second - first, total - second];
}

async function readPages(
  git: RunGit,
  request: { start: string | null; offset: number; count: number },
  cursor: HistoryCursor | null,
  followHead: boolean,
): Promise<HistoryPage> {
  let page = await readHistoryPage(git, request, cursor);
  const commits = [...page.commits];
  let found = commits.some(isHead);
  while (followHead && !found && page.hasMore) {
    page = await readHistoryPage(
      git,
      { start: request.start, offset: request.offset + commits.length, count: HISTORY_PAGE_SIZE },
      page.cursor,
    );
    commits.push(...page.commits);
    found = page.commits.some(isHead);
  }
  return { ...page, commits, offset: request.offset };
}

export class GraphTab implements TabView {
  readonly id = "graph";
  private state = emptyState();
  private inspect: Inspect;
  private filter: InputState;
  private handle: FocusHandle;
  private active = false;
  private filtering = false;
  private context: string | null = null;
  private request = 0;
  private pending: PendingHistory | null = null;
  private historyError: string | null = null;
  private preparations = new Map<string, Preparation>();
  private lastLoad: number | null = null;
  private fingerprint: string | null = null;
  private fingerprintRequest = 0;
  private reveal_: string | null = null;
  private followHead_ = false;
  private height = 0;
  private width = 0;
  private graphWidth = 0;
  private graphVisible = 0;
  private wheel = 0;

  constructor(
    private readonly services: Services,
    cx: AsyncContext,
    private readonly showGraph: () => boolean,
    private readonly workspaces: WorkspacesBox,
  ) {
    this.inspect = new Inspect(services);
    this.handle = cx.focus_handle();
    this.filter = InputState.new({});
    this.filter.on("change", (_, cx) => {
      if (this.filter.value() === this.state.query) return;
      this.state.query = this.filter.value();
      this.applyFilter(cx);
      cx.notify();
    });
    this.filter.on("focus", (_, cx) => {
      this.filtering = true;
      cx.notify();
    });
    this.filter.on("blur", (_, cx) => {
      this.filtering = false;
      cx.notify();
    });
    this.filter.on("submit", (_, cx) => {
      this.handle.focus();
      cx.notify();
    });
  }

  activate(cx: AsyncContext): void {
    this.active = true;
    this.syncContext();
    this.syncUncommitted(cx);
    if (!this.state.loaded && !this.pending) this.requestHistory(cx);
    this.handle.focus();
  }

  deactivate(): void {
    this.active = false;
    this.reveal_ = null;
  }

  focus(): void {
    this.handle.focus();
  }

  release(): void {
    this.request++;
    this.inspect.release();
    this.filter.release();
    this.handle.release();
  }

  selectedCommit(): string | null {
    return this.context === this.services.context() ? (this.selected()?.sha ?? null) : null;
  }

  selectedCommitInfo(): { sha: string; subject: string; parents: string[] } | null {
    const commit = this.context === this.services.context() ? this.selected() : null;
    return commit ? { sha: commit.sha, subject: commit.subject, parents: [...commit.parents] } : null;
  }

  followHead(): void {
    this.followHead_ = true;
  }

  reveal(sha: string, cx: AsyncContext): void {
    this.reveal_ = sha;
    if (!this.state.loaded && !this.pending) this.requestHistory(cx);
    this.revealPending(cx);
    cx.notify();
  }

  copySha(cx: Context): void {
    const commit = this.selected();
    if (!commit) return;
    const short = shortCommit(commit.sha);
    this.services.overlay.open({
      kind: "confirm",
      title: "Copy commit SHA",
      width: DIALOG.medium,
      lines: ["Copy this commit SHA?", "", { text: commit.sha, tone: "accent", bold: true }, commit.subject],
      hint: `${short} selected`,
      primary: "[Enter] Copy",
      secondary: "[Esc] Cancel",
      onConfirm: (cx) => {
        cx.write_to_clipboard(commit.sha);
        showResult(this.services.overlay, "Copy SHA", true, `${short} copied to the clipboard.`, undefined, cx);
      },
    });
    cx.notify();
  }

  toolbar(): ActionCell[] {
    const enabled = this.services.repository()?.state === "ready" && !!this.selectedCommit();
    return GRAPH_ACTIONS.map((action) => ({
      id: `git-graph-${action.id}`,
      label: action.label,
      shortcut: action.shortcut,
      icon: action.icon,
      enabled,
      onClick: (cx: Context) => this.services.commands().shortcut(action.id, cx),
    }));
  }

  status(): TabStatus {
    return {
      selected: this.selectedCommit(),
      progress: this.progress(),
      error: this.historyError ?? this.preparations.get(this.services.context())?.warning ?? null,
    };
  }

  private progress(): string | null {
    const pending = this.pending;
    if (!pending) return null;
    if (this.preparations.get(this.services.context())?.pending) return "Preparing history";
    if (!pending.replace && this.reveal_) return "Finding the commit in Graph";
    if (!pending.replace) return "Loading more commits";
    return this.state.loaded ? "Refreshing commits" : "Loading Graph";
  }

  escape(cx: Context): boolean {
    if (this.workspaces.isFocused()) {
      this.handle.focus();
      return true;
    }
    if (this.inspect.escape()) {
      this.handle.focus();
      return true;
    }
    return this.leaveAnchor(cx);
  }

  refresh(scope: RefreshScope, cx: AsyncContext): void {
    this.syncContext();
    if (scope === "workspaces") return;
    this.syncUncommitted(cx);
    if (scope === "changes") {
      if (this.state.loaded) this.checkRefs(cx);
      return;
    }
    if (this.state.loaded || this.active) this.requestHistory(cx);
  }

  private syncContext(): void {
    const context = this.services.context();
    if (context === this.context) return;
    this.context = context;
    this.state = emptyState();
    this.request++;
    this.pending = null;
    this.historyError = null;
    this.lastLoad = null;
    this.fingerprint = null;
    this.reveal_ = null;
    this.inspect.reset();
    this.inspect.clearCaches();
    this.filter.set_value("");
  }

  private checkRefs(cx: AsyncContext): void {
    const git = this.services.git();
    if (!git || this.pending) return;
    const context = this.services.context();
    const request = ++this.fingerprintRequest;
    cx.spawn(async (cx) => {
      try {
        const fingerprint = await readRefsFingerprint(git);
        if (request !== this.fingerprintRequest || context !== this.services.context()) return;
        if (this.fingerprint !== null && fingerprint !== this.fingerprint) {
          this.requestHistory(cx);
          cx.notify();
        }
      } catch {
        return;
      }
    });
  }

  private displayOffset(): number {
    const commit = this.state.uncommitted;
    return commit?.subject.toLowerCase().includes(this.state.query.toLowerCase()) ? 1 : 0;
  }

  private displayLen(): number {
    return this.state.visible.length + this.displayOffset();
  }

  private uncommittedSelected(): boolean {
    return this.displayOffset() === 1 && this.state.selected === 0;
  }

  private rowCommit(row: number): Commit | null {
    const offset = this.displayOffset();
    if (offset === 1 && row === 0) return this.state.uncommitted;
    const index = this.state.visible[row - offset];
    return index === undefined ? null : (this.state.commits[index] ?? null);
  }

  private selected(): Commit | null {
    const commit = this.rowCommit(this.state.selected);
    return commit?.sha ? commit : null;
  }

  private pageRows(): number {
    return Math.max(this.height > 0 ? 1 : 0, Math.floor(this.height / ROW_HEIGHT));
  }

  private rebuildLayout(): void {
    const filtered = this.state.query !== "";
    const nodes = [
      ...(this.displayOffset() && this.state.uncommitted ? [this.state.uncommitted] : []),
      ...this.state.visible.flatMap((index) => this.state.commits[index] ?? []),
    ].map((commit) => ({ sha: commit.sha, parents: filtered ? [] : commit.parents }));
    this.state.layout = buildLayout(nodes);
  }

  private clampSelection(): void {
    this.state.selected = Math.max(0, Math.min(this.state.selected, this.displayLen() - 1));
  }

  private selectVisible(position: number): void {
    this.state.selected = this.displayOffset() + Math.max(0, position);
    this.clampSelection();
  }

  private selectSha(sha: string | null): void {
    const position = sha ? this.state.visible.findIndex((index) => this.state.commits[index]?.sha === sha) : -1;
    this.selectVisible(Math.max(0, position));
  }

  private ensureVisible(): void {
    const viewport = this.pageRows();
    const length = this.displayLen();
    if (viewport === 0 || length === 0) {
      this.state.scroll = 0;
      return;
    }
    if (this.state.selected < this.state.scroll) this.state.scroll = this.state.selected;
    else if (this.state.selected >= this.state.scroll + viewport)
      this.state.scroll = this.state.selected + 1 - viewport;
    this.state.scroll = Math.max(0, Math.min(this.state.scroll, length - viewport));
  }

  private syncInspect(cx: AsyncContext): void {
    if (this.uncommittedSelected()) {
      const repository = this.services.repository();
      this.inspect.showWorking(workingChanges(repository?.state === "ready" ? repository.files : []));
    } else this.inspect.showCommit(this.selected(), cx);
  }

  private applyFilter(cx: AsyncContext): void {
    const onUncommitted = this.uncommittedSelected();
    const sha = this.selected()?.sha ?? null;
    this.state.visible = filteredCommitIndices(this.state.commits, this.state.query);
    this.rebuildLayout();
    if (onUncommitted && this.displayOffset()) this.state.selected = 0;
    else this.selectSha(sha);
    this.ensureVisible();
    this.syncInspect(cx);
  }

  private select(index: number, cx: AsyncContext): void {
    this.reveal_ = null;
    const length = this.displayLen();
    if (length === 0) return;
    const selected = Math.max(0, Math.min(index, length - 1));
    if (selected !== this.state.selected) {
      this.state.selected = selected;
      this.syncInspect(cx);
    }
    this.ensureVisible();
  }

  private moveSelection(delta: number, cx: AsyncContext): void {
    if (this.displayLen() === 0) return;
    this.select(this.state.selected + delta, cx);
    if (delta > 0) this.requestMore(false, cx);
  }

  private refreshUncommitted(): void {
    const repository = this.services.repository();
    const dirty = repository?.state === "ready" && repository.files.length > 0;
    const show = !this.state.anchor && this.state.loaded && (this.state.commits.length === 0 || dirty);
    const parent = this.state.commits.find(isHead) ?? this.state.commits[0];
    this.state.uncommitted = show
      ? {
          sha: "",
          parents: parent ? [parent.sha] : [],
          authorName: "",
          authorEmail: "",
          authorTime: "",
          refs: [],
          subject: "Uncommitted",
          body: "",
        }
      : null;
    this.rebuildLayout();
    this.clampSelection();
  }

  private syncUncommitted(cx: AsyncContext): void {
    const onUncommitted = this.uncommittedSelected();
    const position = onUncommitted ? null : this.state.selected - this.displayOffset();
    this.refreshUncommitted();
    if (onUncommitted && this.displayOffset()) this.state.selected = 0;
    else this.selectVisible(position ?? 0);
    this.ensureVisible();
    if (this.state.loaded) this.syncInspect(cx);
  }

  private requestHistory(cx: AsyncContext): void {
    this.load(true, 0, Math.max(this.state.commits.length, HISTORY_PAGE_SIZE), cx);
  }

  private requestMore(explicit: boolean, cx: AsyncContext): void {
    if (!this.active || !this.state.hasMore || !this.state.loaded) return;
    const near = this.state.scroll + 2 * this.pageRows() >= this.displayLen();
    if (!explicit && (this.state.query !== "" || !near)) return;
    this.load(false, this.state.commits.length, HISTORY_PAGE_SIZE, cx);
  }

  private prepare(context: string, git: RunGit): Preparation {
    const existing = this.preparations.get(context);
    if (existing) return existing;
    const preparation: Preparation = { pending: true, warning: null, done: Promise.resolve() };
    preparation.done = prepareHistory(git).then(
      () => {
        preparation.pending = false;
      },
      (error: unknown) => {
        preparation.pending = false;
        preparation.warning = `History acceleration unavailable: ${message(error)}. History remains available.`;
      },
    );
    this.preparations.set(context, preparation);
    return preparation;
  }

  private load(replace: boolean, offset: number, count: number, cx: AsyncContext): void {
    const git = this.services.git();
    const maintenanceGit = this.services.historyGit();
    if (!git || !maintenanceGit) return;
    if (replace) {
      this.request++;
      this.pending = null;
      this.historyError = null;
    }
    if (this.pending || this.historyError) return;
    const id = ++this.request;
    const context = this.services.context();
    const start = this.state.anchor;
    const cursor = replace ? null : this.state.cursor;
    const follow = this.followHead_ && !start;
    this.pending = { id, replace, offset };
    const current = () => id === this.request && context === this.services.context();
    cx.spawn(async (cx) => {
      const preparation = this.prepare(context, maintenanceGit);
      cx.notify();
      await preparation.done;
      if (!current()) return;
      cx.notify();
      try {
        const began = Date.now();
        const [page, fingerprint] = await Promise.all([
          readPages(git, { start, offset, count }, cursor, follow),
          replace ? readRefsFingerprint(git) : Promise.resolve(null),
        ]);
        if (!current()) return;
        this.pending = null;
        this.applyPage(page, replace, follow, fingerprint, began, cx);
      } catch (error) {
        if (!current()) return;
        this.pending = null;
        this.historyError = `${message(error)}. Refresh to retry`;
      } finally {
        cx.notify();
      }
    });
  }

  private applyPage(
    page: HistoryPage,
    replace: boolean,
    follow: boolean,
    fingerprint: string | null,
    began: number,
    cx: AsyncContext,
  ): void {
    if (!replace && page.offset !== this.state.commits.length) return;
    this.lastLoad = (Date.now() - began) / 1000;
    this.fingerprint = fingerprint ?? this.fingerprint;
    const state = this.state;
    const selected = this.selected()?.sha ?? null;
    const onUncommitted = this.uncommittedSelected();
    state.hasMore = page.hasMore;
    state.loaded = true;
    state.cursor = page.cursor;
    if (replace) {
      state.commits = page.commits;
      state.visible = filteredCommitIndices(state.commits, state.query);
    } else {
      const offset = state.commits.length;
      state.visible.push(...filteredCommitIndices(page.commits, state.query).map((index) => offset + index));
      state.commits.push(...page.commits);
    }
    const head = state.commits.findIndex(isHead);
    if (follow) this.followHeadRow(head);
    this.refreshUncommitted();
    if (follow) this.selectVisible(Math.max(0, state.visible.indexOf(head)));
    else if (onUncommitted && this.displayOffset()) state.selected = 0;
    else this.selectSha(selected);
    this.ensureVisible();
    this.syncInspect(cx);
    this.revealPending(cx);
  }

  private followHeadRow(head: number): void {
    if (head >= 0 && !this.state.visible.includes(head)) {
      this.state.query = "";
      this.filter.set_value("");
      this.state.visible = this.state.commits.map((_, index) => index);
    }
    this.followHead_ = false;
  }

  private revealPending(cx: AsyncContext): boolean {
    const sha = this.reveal_;
    if (!sha) return false;
    if (!this.active) {
      this.reveal_ = null;
      return false;
    }
    for (let row = 0; row < this.displayLen(); row++)
      if (this.rowCommit(row)?.sha === sha) {
        this.reveal_ = null;
        this.inspect.focus = null;
        this.handle.focus();
        this.select(row, cx);
        return true;
      }
    if (this.pending || !this.state.loaded) return false;
    this.revealMissing(sha, cx);
    return true;
  }

  private revealMissing(sha: string, cx: AsyncContext): void {
    const short = sha.slice(0, 7);
    if (this.state.commits.some((commit) => commit.sha === sha)) {
      this.reveal_ = null;
      this.services.reportError(`Clear the Graph filter to see ${short}.`);
    } else if (this.state.hasMore && this.state.commits.length < REVEAL_LIMIT) {
      this.requestMore(true, cx);
    } else if (this.state.hasMore && !this.state.anchor) {
      this.openAnchor(sha, cx);
    } else {
      this.reveal_ = null;
      this.services.reportError(`${short} is not within the newest ${this.state.commits.length} commits in Graph.`);
    }
  }

  private resetHistory(): void {
    this.request++;
    this.pending = null;
    this.historyError = null;
    this.lastLoad = null;
  }

  private openAnchor(sha: string, cx: AsyncContext): void {
    const saved = this.state;
    const stashed = saved.anchor ? saved.stashed : saved;
    this.state = { ...emptyState(), stashed, anchor: sha };
    this.reveal_ = sha;
    this.filter.set_value("");
    this.resetHistory();
    this.inspect.reset();
    this.handle.focus();
    this.requestHistory(cx);
  }

  private leaveAnchor(cx: AsyncContext): boolean {
    const saved = this.state.stashed;
    if (!saved) return false;
    this.state = saved;
    this.filter.set_value(saved.query);
    this.resetHistory();
    this.inspect.reset();
    this.handle.focus();
    this.syncInspect(cx);
    this.requestHistory(cx);
    return true;
  }

  private scrollGraph(delta: number): void {
    const max = Math.max(0, this.graphWidth - this.graphVisible);
    this.state.graphScroll = Math.max(0, Math.min(this.state.graphScroll + delta, max));
  }

  private openFilter(): void {
    this.filter.focus();
    this.filtering = true;
  }

  private filterKey(event: KeyEvent, cx: Context): boolean {
    if (event.keystroke === "escape") {
      this.filter.set_value("");
      this.state.query = "";
      this.applyFilter(cx);
      this.handle.focus();
    } else if (event.keystroke === "enter") this.handle.focus();
    else if (event.keystroke === "pagedown") this.requestMore(true, cx);
    else return false;
    return true;
  }

  private commitsKey(event: KeyEvent, cx: Context): boolean {
    const page = Math.max(1, this.pageRows());
    const moves: Record<string, number> = { down: 1, j: 1, up: -1, k: -1, pageup: -page };
    const move = moves[event.keystroke];
    if (move !== undefined) this.moveSelection(move, cx);
    else if (event.keystroke === "h") this.scrollGraph(-2);
    else if (event.keystroke === "l") this.scrollGraph(2);
    else if (event.keystroke === "enter") this.openCommitDiff(cx);
    else if (event.keystroke === "right") this.inspect.focusChanges();
    else if (event.keystroke === "pagedown") {
      this.moveSelection(page, cx);
      this.requestMore(this.state.query !== "" || this.state.visible.length === 0, cx);
    } else if (event.keystroke === "home") this.select(0, cx);
    else if (event.keystroke === "end") {
      this.select(this.displayLen() - 1, cx);
      this.requestMore(false, cx);
    } else return false;
    return true;
  }

  private openCommitDiff(cx: AsyncContext): void {
    const commit = this.selected();
    if (commit) this.services.openCommitDiff(commit.sha, cx);
  }

  private key(event: KeyEvent, cx: Context): void {
    if (isChord(event) || this.workspaces.isFocused()) return;
    let handled: boolean;
    if (this.filtering) handled = this.filterKey(event, cx);
    else if (event.key_char === "/" || event.keystroke === "/") {
      this.openFilter();
      handled = true;
    } else if (this.inspect.focus) handled = this.inspect.key(event, cx);
    else handled = this.commitsKey(event, cx);
    if (!handled) return;
    cx.stop_propagation();
    cx.notify();
  }

  private listWheel(event: ScrollWheelEvent, look: Look, cx: Context): void {
    const lines = event.delta_lines;
    const horizontal = lines ? lines.x : event.delta.x / look.cell;
    if (Math.abs(horizontal) >= 1 || event.modifiers.shift) {
      const amount = Math.abs(horizontal) >= 1 ? -horizontal : -(lines ? lines.y : event.delta.y / look.row);
      if (Math.abs(amount) >= 1) this.scrollGraph(amount > 0 ? 2 : -2);
      cx.stop_propagation();
      cx.notify();
      return;
    }
    this.wheel += lines ? lines.y * look.row : event.delta.y;
    const steps = Math.trunc(this.wheel / look.row);
    if (steps === 0) return;
    this.wheel -= steps * look.row;
    this.inspect.focus = null;
    this.moveSelection(-steps, cx);
    cx.stop_propagation();
    cx.notify();
  }

  private commitsTitle(look: Look): Element | string {
    if (this.pending) {
      return h_flex().child(spinner(look)).child(` ${this.progress()}`);
    }
    const anchor = this.state.anchor;
    if (anchor)
      return h_flex()
        .child(`Commits from ${shortCommit(anchor)} · `)
        .child(
          div()
            .id("git-graph-back")
            .text_color(look.t.accent)
            .font_weight(700)
            .child("[Esc] Back to HEAD")
            .on_click((_, cx) => {
              cx.stop_propagation();
              this.leaveAnchor(cx);
              cx.notify();
            }),
        );
    let title = "Commits";
    if (this.state.query) title += ` · ${this.displayLen()} matches`;
    if (this.lastLoad !== null) title += ` · Loaded in ${this.lastLoad.toFixed(2)} s`;
    return title;
  }

  private footer(look: Look): Element | null {
    const text = this.historyError ? "Refresh to retry" : this.state.hasMore ? "[PgDn] Load more" : "";
    if (!text) return null;
    return div()
      .id("git-graph-load-more")
      .absolute()
      .bottom(0)
      .left(look.cell)
      .h(look.row)
      .bg(look.t.background)
      .text_color(look.t.hint)
      .whitespace_nowrap()
      .child(text)
      .on_click((_, cx) => {
        cx.stop_propagation();
        if (this.historyError) return;
        this.requestMore(true, cx);
        cx.notify();
      });
  }

  private lanes(look: Look, row: LayoutRow | undefined, view: LaneViewport): Element {
    if (!row || view.width <= 0) return div().flex_none().w(cols(look, view.width));
    return this.showGraph() ? curveLanes(look, row, view) : glyphLanes(look, row, view);
  }

  private commitRow(look: Look, row: number, first: boolean): Element {
    const { t } = look;
    const commit = this.rowCommit(row);
    const selected = row === this.state.selected;
    const text = {
      width: this.width,
      gutter: Math.min(this.graphVisible + 1, this.width),
      nowSeconds: Date.now() / 1000,
      bold: selected,
    };
    const view: LaneViewport = {
      width: this.graphVisible,
      scroll: this.state.graphScroll,
      total: this.graphWidth,
      first,
      selected,
      background: selected ? t.selection : t.background,
    };
    const element = h_flex()
      .id(`git-commit-row-${row}`)
      .flex_none()
      .h(rows(look, ROW_HEIGHT))
      .min_w(0)
      .overflow_hidden()
      .when(selected, (el) => el.bg(t.selection))
      .when(!selected, (el) => el.hover((style) => style.bg(t.hover)))
      .on_click((_, cx) => {
        cx.stop_propagation();
        this.clickRow(row, cx);
      })
      .on_mouse_down("right", (_, cx) => {
        cx.stop_propagation();
        this.clickRow(row, cx);
        if (this.selected()) this.services.commands().shortcut("actions", cx);
      })
      .child(this.lanes(look, this.state.layout[row], view))
      .child(div().flex_none().w(look.cell));
    if (!commit) return element;
    return element.child(
      v_flex()
        .flex_1()
        .min_w(0)
        .child(commitTitle(look, commit, text))
        .child(commitDetail(look, commit, text)),
    );
  }

  private clickRow(row: number, cx: Context): void {
    this.inspect.focus = null;
    this.handle.focus();
    this.select(row, cx);
    cx.notify();
  }

  private measureLayout(): void {
    const length = this.displayLen();
    const overflow = this.width > 1 && length * ROW_HEIGHT > this.height;
    const width = this.width - (overflow ? 1 : 0);
    const visibleRows = Math.min(Math.ceil(this.height / ROW_HEIGHT), Math.max(0, length - this.state.scroll));
    this.graphWidth = layoutWidth(this.state.layout, this.state.scroll, visibleRows);
    this.graphVisible = Math.min(graphViewWidth(width), this.graphWidth);
    this.state.graphScroll = Math.min(this.state.graphScroll, Math.max(0, this.graphWidth - this.graphVisible));
  }

  private commitList(look: Look): Element {
    this.ensureVisible();
    this.measureLayout();
    const length = this.displayLen();
    const end = Math.min(length, this.state.scroll + Math.max(1, Math.ceil(this.height / ROW_HEIGHT)));
    const list = v_flex().flex_1().min_w(0).min_h(0).overflow_hidden();
    for (let row = this.state.scroll; row < end; row++)
      list.child(this.commitRow(look, row, row === this.state.scroll));
    const bar = scrollbar(look, {
      axis: "vertical",
      total: length,
      visible: this.pageRows(),
      offset: this.state.scroll,
    });
    return h_flex()
      .id("git-commits")
      .flex_1()
      .min_h(0)
      .min_w(0)
      .items_stretch()
      .on_size_change((size, cx) => {
        const height = Math.max(0, Math.floor(size.height / look.row));
        const width = Math.max(0, Math.floor(size.width / look.cell));
        if (height === this.height && width === this.width) return;
        this.height = height;
        this.width = width;
        cx.notify();
      })
      .on_scroll_wheel((event, cx) => this.listWheel(event, look, cx))
      .child(list)
      .when(!!bar, (el) => el.child(bar ?? div()));
  }

  private commitsBox(look: Look): Element {
    const focused = !this.inspect.focus && !this.filtering && !this.workspaces.isFocused();
    const element = box(
      look,
      { id: "git-commits-box", title: this.commitsTitle(look), focused },
      this.commitList(look),
    );
    const footer = this.footer(look);
    return footer ? element.child(footer) : element;
  }

  private lower(look: Look, size: { cols: number; rows: number }): Element {
    const preview = this.inspect.previewOpen();
    const onFocus = () => this.handle.focus();
    const height = size.rows;
    if (size.cols < WIDE_LOWER) {
      const pane = preview
        ? this.inspect.renderPreview(look, size, onFocus)
        : this.inspect.renderDetails(look, onFocus);
      return h_flex().h(rows(look, height)).flex_none().items_stretch().child(pane.flex_1());
    }
    const [first, second, third] = paneWidths(size.cols);
    const row = h_flex()
      .h(rows(look, height))
      .flex_none()
      .child(this.workspaces.render(look).w(cols(look, first)).flex_none().h_full());
    if (!preview) return row.child(this.inspect.renderDetails(look, onFocus).flex_1().h_full());
    return row
      .child(this.inspect.renderDetails(look, onFocus).w(cols(look, second)).flex_none().h_full())
      .child(this.inspect.renderPreview(look, { cols: third, rows: height }, onFocus).flex_1().h_full());
  }

  render(look: Look, size: BodySize): Element {
    const available = Math.max(0, size.rows - 3);
    const listRows = Math.round((available * 58) / 100);
    return v_flex()
      .id("git-graph")
      .size_full()
      .min_h(0)
      .min_w(0)
      .track_focus(this.handle)
      .on_key_down((event, cx) => this.key(event, cx))
      .child(filterBar(look, { id: "git-graph-filter", input: this.filter, active: this.filtering }))
      .child(this.commitsBox(look).h(rows(look, listRows)).flex_none())
      .child(this.lower(look, { cols: size.cols, rows: available - listRows }));
  }
}
