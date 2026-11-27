import { Button, h_flex } from "gpui-base";
import {
  type AsyncContext,
  type Context,
  div,
  type Element,
  type FocusHandle,
  type KeyEvent,
  type ScrollWheelEvent,
} from "gpui-kit";
import { exec, pickFolder } from "herdr";
import type { Repository } from "../git/repository.ts";
import { type GitAt, inspectProject, inspectWorktree, projectRoot, type WorktreeStatus } from "../git/workspaces.ts";
import type { RepositoryLocation } from "../runtime/context.ts";
import { showResult } from "./commands/result.ts";
import { ICON_CELLS } from "./icons.ts";
import type { Services } from "./shell.ts";
import { DIALOG, GLYPH, type Look, rows as rowsPx } from "./theme.ts";
import {
  box,
  type CellSpan,
  displayWidth,
  isChord,
  padToWidth,
  sectionLabel,
  spanElements,
  spansWidth,
  spinner,
  truncateToWidth,
} from "./widgets.ts";
import { openWorkspacePicker } from "./workspaces/picker.ts";
import { ProjectRegistry } from "./workspaces/projects.ts";
import {
  buildRows,
  currentRow,
  type ProjectResult,
  pathLabel,
  type RepositoryRow,
  rowHeight,
  rowKey,
  worktreeLabel,
} from "./workspaces/rows.ts";

const CURRENT_TOP = 1.4;
const SEPARATOR = 5.3;
const PROJECTS_HEADER = 6;
const PROJECTS_TOP = 8.4;
const CARD_PAD = 0.5;
const ITEM_GAP = 0.3;
const GROUP_GAP = 0.55;
const ADD_WIDE = 34;
const DEFAULT_WIDTH = 40;
const BUSY = "Wait for the current Git operation.";

interface Placed {
  index: number;
  top: number;
  height: number;
}

interface Inspection {
  cwd: string | null;
  on: string | null;
  current: WorktreeStatus | null;
  statuses: Map<string, ProjectResult>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gitAt(on: string | null): GitAt {
  return (cwd) => (args) => exec("git", args, { cwd, on });
}

function line(look: Look, spans: CellSpan[]): Element {
  return h_flex()
    .flex_none()
    .h(look.row)
    .min_w(0)
    .whitespace_nowrap()
    .overflow_hidden()
    .children(spanElements(look, spans));
}

function fitted(width: number, prefix: number, suffix: number): number {
  return Math.max(1, Math.min(Math.max(1, width - prefix - suffix), Math.max(1, width - prefix)));
}

export class WorkspacesBox {
  private readonly registry = new ProjectRegistry();
  private current: RepositoryRow = currentRow(null, null);
  private currentStatus: WorktreeStatus | null = null;
  private currentCwd: string | null = null;
  private currentOn: string | null = null;
  private statuses = new Map<string, ProjectResult>();
  private rows: RepositoryRow[] = [this.current];
  private readonly expanded = new Set<string>();
  private selected = 0;
  private scroll = 0;
  private height = 0;
  private width = DEFAULT_WIDTH;
  private page = 1;
  private wheel = 0;
  private hovered: number | null = null;
  private switching: string | null = null;
  private refreshing = false;
  private queued = false;
  private queuedRepository: Extract<Repository, { state: "ready" }> | undefined;
  private announced = false;
  private loaded = false;
  private adding = false;
  private request = 0;
  private alive = true;
  private readonly handle: FocusHandle;

  constructor(
    private readonly services: Services,
    cx: AsyncContext,
  ) {
    this.handle = cx.focus_handle();
  }

  release(): void {
    this.alive = false;
    this.request++;
    this.handle.release();
  }

  focus(): void {
    this.handle.focus();
  }

  isFocused(): boolean {
    return this.handle.is_focused();
  }

  progress(): string | null {
    return this.adding ? "Choosing Project" : null;
  }

  syncProjects(cx: AsyncContext): void {
    if (!this.registry.changed()) return;
    this.rebuild();
    this.refresh(cx);
  }

  canRemoveProject(): boolean {
    return this.rows[this.selected]?.kind.type === "project";
  }

  refresh(cx: AsyncContext, repository?: Extract<Repository, { state: "ready" }>): void {
    if (!this.alive) return;
    const request = ++this.request;
    if (this.refreshing) {
      this.queued = true;
      this.queuedRepository = repository;
      return;
    }
    const location = this.services.source.followed();
    const context = this.services.context();
    const roots = [...this.registry.roots()];
    this.refreshing = true;
    cx.spawn(async (cx) => {
      try {
        const inspection = await this.inspect(location, roots, repository);
        if (
          this.alive &&
          request === this.request &&
          context === this.services.context() &&
          JSON.stringify(location) === JSON.stringify(this.services.source.followed())
        )
          this.apply(inspection);
      } finally {
        if (this.alive) {
          this.refreshing = false;
          if (this.queued) {
            const next = this.queuedRepository;
            this.queued = false;
            this.queuedRepository = undefined;
            this.refresh(cx, next === this.services.repository() ? next : undefined);
          } else {
            this.announced = false;
          }
          cx.notify();
        }
      }
    });
  }

  private async inspect(
    location: RepositoryLocation | null,
    roots: string[],
    repository?: Extract<Repository, { state: "ready" }>,
  ): Promise<Inspection> {
    const cwd = location?.cwd ?? null;
    const on = location?.on ?? null;
    const activeLocation = this.services.location();
    const activeOn = activeLocation?.on ?? null;
    const activeGit = repository === this.services.repository() ? this.services.git() : null;
    const at =
      (machine: string | null): GitAt =>
      (path) =>
        activeGit && machine === activeOn && path === repository?.root ? activeGit : gitAt(machine)(path);
    const supplied =
      activeGit && activeOn === on && (cwd === activeLocation?.cwd || cwd === repository?.root)
        ? repository
        : undefined;
    const previousCurrent = cwd === this.currentCwd && on === this.currentOn ? this.currentStatus : null;
    const currentRead = cwd
      ? inspectWorktree(at(on), supplied?.root ?? cwd, previousCurrent, !supplied, supplied).catch(() => null)
      : Promise.resolve(null);
    const previous = [...this.statuses.values()].flatMap((result) =>
      result.ok ? [result.status.primary, ...result.status.worktrees] : [],
    );
    const [current, results] = await Promise.all([
      currentRead,
      Promise.all(
        roots.map(async (root) =>
          inspectProject(
            at(null),
            root,
            previous,
            on === null ? await currentRead : null,
            activeOn === null && activeGit ? repository : undefined,
          ).then(
            (status): ProjectResult => ({ ok: true, status }),
            (error: unknown): ProjectResult => ({ ok: false, error: message(error) }),
          ),
        ),
      ),
    ]);
    return {
      cwd,
      on,
      current,
      statuses: new Map(roots.map((root, index) => [root, results[index] ?? { ok: false, error: "" }])),
    };
  }

  private apply(inspection: Inspection): void {
    this.currentCwd = inspection.cwd;
    this.currentOn = inspection.on;
    this.currentStatus = inspection.current;
    this.current = currentRow(inspection.cwd, inspection.current);
    this.statuses = inspection.statuses;
    this.loaded = true;
    this.rebuild();
  }

  private allRows(): RepositoryRow[] {
    return buildRows(this.current, this.registry.roots(), this.statuses, () => true);
  }

  private rebuild(): void {
    const selected = this.rows[this.selected];
    const key = selected ? rowKey(selected) : null;
    this.rows = buildRows(this.current, this.registry.roots(), this.statuses, (root) => this.expanded.has(root));
    const index = this.rows.findIndex((row) => rowKey(row) === key);
    this.selected = index >= 0 ? index : Math.min(this.selected, this.rows.length - 1);
  }

  private active(row: RepositoryRow): boolean {
    const repository = this.services.repository();
    const on = row.kind.type === "current" ? this.currentOn : null;
    return (
      repository?.state === "ready" && repository.root === row.path && on === (this.services.location()?.on ?? null)
    );
  }

  private settleSwitch(): void {
    if (this.switching === null || this.services.loading()) return;
    if (this.services.repository() !== null || this.services.repositoryError() !== null) this.switching = null;
  }

  private switchRow(index: number, cx: AsyncContext): void {
    const row = this.rows[index];
    if (!row) return;
    this.selected = index;
    this.handle.focus();
    if (this.services.busy()) {
      this.services.reportError(BUSY);
      return;
    }
    if (row.kind.type === "current" && row.overview === null) {
      this.switching = null;
      this.services.source.select(null);
      this.services.refresh("repository", cx);
      this.services.reportError("Current is not a Git repository");
      return;
    }
    if (this.active(row)) return;
    this.switching = rowKey(row);
    this.services.source.select(row.kind.type === "current" ? null : { cwd: row.path, on: null });
    this.services.refresh("repository", cx);
  }

  private toggleSelectedProject(): void {
    const row = this.rows[this.selected];
    if (row?.kind.type !== "project") return;
    if (!this.expanded.delete(row.kind.root)) this.expanded.add(row.kind.root);
    this.rebuild();
  }

  private move(delta: number): void {
    if (this.rows.length === 0) return;
    this.handle.focus();
    this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta));
  }

  manage(cx: Context | AsyncContext): void {
    const rows = this.allRows();
    const selected = this.rows[this.selected];
    const key = selected ? rowKey(selected) : null;
    let index = rows.findIndex((row) => rowKey(row) === key);
    if (index < 0) index = rows.findIndex((row) => this.active(row));
    openWorkspacePicker(this.services.overlay, {
      rows: () => this.allRows(),
      selected: Math.max(0, index),
      choose: (row, cx) => this.chooseWorkspace(row, cx),
    });
    cx.notify();
  }

  private chooseWorkspace(row: RepositoryRow, cx: AsyncContext): void {
    if (row.kind.type === "worktree") {
      this.expanded.add(row.kind.project);
      this.rebuild();
    }
    const index = this.rows.findIndex((candidate) => rowKey(candidate) === rowKey(row));
    if (index >= 0) this.switchRow(index, cx);
  }

  add(cx: AsyncContext): void {
    if (this.services.busy() || this.adding) {
      this.services.reportError(BUSY);
      return;
    }
    this.adding = true;
    const overlay = this.services.overlay;
    cx.spawn(async (cx) => {
      try {
        const folder = await pickFolder({ prompt: "Add Project" });
        if (!folder || !this.alive) return;
        const root = await projectRoot(gitAt(null)(folder));
        if (!this.alive) return;
        if (!this.registry.add(root)) {
          showResult(overlay, "Git operation", false, "Project is already registered");
          return;
        }
        showResult(overlay, "Add Project", true, "Project added", undefined, cx);
        this.announced = true;
        this.refresh(cx);
      } catch (error) {
        if (this.alive) showResult(overlay, "Git operation", false, message(error));
      } finally {
        this.adding = false;
        cx.notify();
      }
    });
  }

  removeProject(cx: Context | AsyncContext): void {
    if (this.services.busy() || this.adding) {
      this.services.reportError(BUSY);
      return;
    }
    const row = this.rows[this.selected];
    if (row?.kind.type !== "project") {
      this.services.reportError("Select a registered Project");
      return;
    }
    const root = row.kind.root;
    this.services.overlay.open({
      kind: "confirm",
      title: "Remove Project",
      width: DIALOG.medium,
      lines: ["Remove this Project from Workspaces?", root, "", "Files and worktrees stay on disk."],
      primary: "[Enter] Remove",
      secondary: "[Esc] Cancel",
      onConfirm: (cx) => this.remove(root, cx),
    });
    cx.notify();
  }

  private remove(root: string, cx: AsyncContext): void {
    const overlay = this.services.overlay;
    try {
      if (!this.registry.remove(root)) {
        showResult(overlay, "Git operation", false, "Project is not registered");
        return;
      }
    } catch (error) {
      showResult(overlay, "Git operation", false, message(error));
      return;
    }
    this.expanded.delete(root);
    this.statuses.delete(root);
    this.rebuild();
    showResult(overlay, "Remove Project", true, "Project removed", undefined, cx);
    this.announced = true;
    this.refresh(cx);
  }

  private key(event: KeyEvent, cx: Context): void {
    if (isChord(event)) return;
    const moves: Record<string, number> = {
      down: 1,
      j: 1,
      up: -1,
      k: -1,
      pagedown: this.page,
      pageup: -this.page,
      home: -this.rows.length,
      end: this.rows.length,
    };
    const delta = moves[event.keystroke];
    if (delta !== undefined) this.move(delta);
    else if (event.keystroke === "enter") this.switchRow(this.selected, cx);
    else if (event.keystroke === "space") this.toggleSelectedProject();
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  private scrollWheel(event: ScrollWheelEvent, look: Look, cx: Context): void {
    this.wheel += event.delta_lines ? event.delta_lines.y * look.row : event.delta.y;
    const steps = Math.trunc(this.wheel / look.row);
    if (steps === 0) return;
    this.wheel -= steps * look.row;
    cx.stop_propagation();
    this.move(-steps);
    cx.notify();
  }

  private click(index: number, cx: Context): void {
    const project = this.rows[index]?.kind.type === "project";
    this.switchRow(index, cx);
    if (project) this.toggleSelectedProject();
  }

  private layout(): { placed: Placed[]; content: number } {
    const placed: Placed[] = [];
    const [first] = this.rows;
    if (first) placed.push({ index: 0, top: CURRENT_TOP, height: rowHeight(first) + CARD_PAD });
    let next = PROJECTS_TOP;
    let grouped = false;
    for (const [index, row] of this.rows.entries()) {
      if (index === 0) continue;
      if (row.kind.type === "project") {
        if (grouped) next += GROUP_GAP;
        grouped = true;
      } else {
        next += ITEM_GAP;
      }
      const height = rowHeight(row) + CARD_PAD;
      placed.push({ index, top: next, height });
      next += height;
    }
    return { placed, content: Math.max(next, PROJECTS_TOP) };
  }

  private scrollTo(placed: Placed[], content: number): void {
    const height = this.height || content;
    const selected = placed.find((entry) => entry.index === this.selected);
    if (this.selected === 0) this.scroll = 0;
    else if (selected && selected.top < this.scroll) this.scroll = selected.top;
    else if (selected && selected.top + selected.height > this.scroll + height)
      this.scroll = selected.top + selected.height - height;
    this.scroll = Math.max(0, Math.min(this.scroll, content - height));
  }

  private title(look: Look): string | Element {
    if (!this.refreshing || (this.loaded && !this.announced)) return "Workspaces";
    return h_flex()
      .child(spinner(look))
      .child(this.loaded ? " Refreshing Workspaces" : " Loading Workspaces");
  }

  private nameSpans(row: RepositoryRow, look: Look, spans: CellSpan[], reserved: number): CellSpan[] {
    const { t } = look;
    const name = pathLabel(row.path);
    if (row.kind.type === "worktree") spans.push({ text: `  ${worktreeLabel(row.path, row.kind.project)}` });
    else spans.push({ text: name });
    if (row.kind.type === "project") {
      const count = ` · ${row.worktrees} ${row.worktrees === 1 ? "worktree" : "worktrees"}`;
      if (this.width >= spansWidth(spans) + displayWidth(count) + reserved) spans.push({ text: count, color: t.hint });
    }
    return spans;
  }

  private nameLine(look: Look, row: RepositoryRow, focusedRow: boolean, index: number): Element {
    const { t } = look;
    const switching = this.switching === rowKey(row);
    const icon = row.kind.type === "worktree" ? "worktree" : "repository";
    const marker: CellSpan[] = switching
      ? []
      : this.active(row)
        ? [{ text: padToWidth(GLYPH.marker, ICON_CELLS + 1), color: t.accent }]
        : [{ text: " ", icon, color: t.hint }];
    const spans = this.nameSpans(row, look, marker, switching ? ICON_CELLS + 1 : 0);
    const content = line(look, spans).flex_1();
    const result = h_flex().flex_none().h(look.row).min_w(0);
    if (switching)
      result.child(
        h_flex()
          .flex_none()
          .w((ICON_CELLS + 1) * look.cell)
          .child(spinner(look)),
      );
    result.child(content);
    const actions = row.kind.type === "project" && (focusedRow || this.hovered === index) && this.width > 3;
    if (actions)
      result.child(
        Button.new(`git-workspace-remove-${index}`)
          .accessibility_label("Remove Project")
          .flex_none()
          .h(look.row)
          .text_color(t.error)
          .hover((style) => style.bg(t.hover))
          .child("[-]")
          .on_click((_, cx) => {
            cx.stop_propagation();
            this.selected = index;
            this.removeProject(cx);
          }),
      );
    return result;
  }

  private summaryLine(look: Look, row: RepositoryRow): Element {
    const { t } = look;
    if (this.switching === rowKey(row)) return line(look, [{ text: "Loading repository", color: t.accent }]);
    if (row.error) return line(look, [{ text: row.error, color: row.kind.type === "current" ? t.warning : t.error }]);
    if (!row.branch) return line(look, []);
    const overview = row.overview;
    const working: CellSpan[] = [];
    if (overview && overview.changedPaths > 0) {
      working.push({ text: "● ", color: t.warning }, { text: `${overview.changedPaths}f`, color: t.hint });
      if (overview.additions > 0) working.push({ text: ` +${overview.additions}`, color: t.success });
      if (overview.deletions > 0) working.push({ text: ` -${overview.deletions}`, color: t.error });
    }
    const prefix: CellSpan = { text: " ", icon: "branch", color: t.accent };
    const suffix = working.length ? 3 + spansWidth(working) : 0;
    const branch = truncateToWidth(row.branch.checkedOut, fitted(this.width, spansWidth([prefix]), suffix));
    const spans: CellSpan[] = [prefix, { text: branch, color: t.accent }];
    if (working.length) spans.push({ text: GLYPH.separator }, ...working);
    return line(look, spans);
  }

  private upstreamLine(look: Look, row: RepositoryRow): Element | null {
    const { t } = look;
    const branch = row.branch;
    if (!branch?.upstream) return null;
    if (this.switching === rowKey(row)) return line(look, []);
    const sync: CellSpan[] = [];
    if (branch.ahead === 0 && branch.behind === 0) sync.push({ text: "✓", color: t.success });
    if (branch.ahead > 0) sync.push({ text: `↑${branch.ahead}`, color: t.success });
    if (branch.ahead > 0 && branch.behind > 0) sync.push({ text: " " });
    if (branch.behind > 0) sync.push({ text: `↓${branch.behind}`, color: t.warning });
    const prefix: CellSpan = { text: " ", icon: "remote", color: t.accent };
    const upstream = truncateToWidth(branch.upstream, fitted(this.width, spansWidth([prefix]), 3 + spansWidth(sync)));
    return line(look, [prefix, { text: upstream, color: t.hint }, { text: GLYPH.separator }, ...sync]);
  }

  private rowElement(look: Look, entry: Placed, focused: boolean): Element {
    const { t } = look;
    const row = this.rows[entry.index];
    if (!row) return div();
    const focusedRow = focused && entry.index === this.selected;
    const index = entry.index;
    const element = div()
      .id(`git-workspace-row-${index}`)
      .absolute()
      .left(0)
      .right(0)
      .top(rowsPx(look, entry.top - this.scroll))
      .h(rowsPx(look, entry.height))
      .flex()
      .flex_col()
      .justify_center()
      .overflow_hidden()
      .px(8)
      .bg(focusedRow ? t.accentSoft : t.background)
      .border(1)
      .border_color(focusedRow ? t.accentEdge : t.rule)
      .when(focusedRow, (el) => el.font_weight(600))
      .when(!focusedRow, (el) => el.hover((style) => style.bg(t.hover)))
      .on_hover((hovered, cx) => {
        if (hovered) this.hovered = index;
        else if (this.hovered === index) this.hovered = null;
        cx.notify();
      })
      .on_click((_, cx) => {
        cx.stop_propagation();
        this.click(index, cx);
        cx.notify();
      })
      .child(this.nameLine(look, row, focusedRow, index))
      .child(this.summaryLine(look, row));
    const upstream = this.upstreamLine(look, row);
    if (upstream) element.child(upstream);
    if (focusedRow) element.child(div().absolute().bottom(0).left(0).right(0).h(2).bg(t.accent));
    return element;
  }

  private header(look: Look, top: number, child: Element): Element {
    return div()
      .absolute()
      .left(0)
      .right(0)
      .top(rowsPx(look, top - this.scroll))
      .h(look.row)
      .flex()
      .items_center()
      .child(child);
  }

  private addButton(look: Look): Element {
    const { t } = look;
    const wide = this.width >= ADD_WIDE;
    return Button.new("git-workspace-add")
      .accessibility_label("Add Project")
      .flex_none()
      .h(look.row)
      .px(6)
      .items_center()
      .border(1)
      .border_color(t.lineStrong)
      .rounded(2)
      .text_size(Math.max(10, look.size - 2))
      .text_color(t.accentText)
      .font_weight(600)
      .hover((style) => style.bg(t.accentSoft).border_color(t.accent))
      .child(wide ? "+ ADD PROJECT" : "+")
      .on_click((_, cx) => {
        cx.stop_propagation();
        this.add(cx);
        cx.notify();
      });
  }

  private sections(look: Look): Element[] {
    const { t } = look;
    const wide = this.width >= ADD_WIDE;
    const projects = h_flex()
      .w_full()
      .items_center()
      .gap(6)
      .child(sectionLabel(look, "Projects", { rule: true }));
    if (wide) projects.child(this.addButton(look));
    const children = [
      this.header(look, 0, sectionLabel(look, "Current", { rule: true })),
      this.header(look, SEPARATOR, div().w_full().h(1).bg(t.rule)),
      this.header(look, PROJECTS_HEADER, projects),
    ];
    if (!wide)
      children.push(
        this.header(look, PROJECTS_HEADER + 1, h_flex().w_full().justify_end().child(this.addButton(look))),
      );
    return children;
  }

  render(look: Look): Element {
    this.settleSwitch();
    const focused = this.isFocused();
    const { placed, content } = this.layout();
    this.scrollTo(placed, content);
    const height = this.height || content;
    const visible = placed.filter(
      (entry) => entry.top + entry.height > this.scroll && entry.top < this.scroll + height,
    );
    this.page = Math.max(1, visible.length);
    const body = div()
      .id("git-workspaces-list")
      .relative()
      .flex_1()
      .min_h(0)
      .min_w(0)
      .overflow_hidden()
      .on_size_change((size, cx) => {
        const rows = Math.max(1, Math.floor(size.height / look.screenRow));
        const width = Math.max(1, Math.floor((size.width - 18) / look.screenCell));
        if (rows === this.height && width === this.width) return;
        this.height = rows;
        this.width = width;
        cx.notify();
      })
      .on_scroll_wheel((event, cx) => this.scrollWheel(event, look, cx))
      .children(this.sections(look))
      .children(visible.map((entry) => this.rowElement(look, entry, focused)));
    const frame = box(look, { id: "git-workspaces", title: this.title(look), focused }, body);
    const handle = this.handle;
    return frame
      .track_focus(handle)
      .on_mouse_down("left", () => handle.focus())
      .on_key_down((event, cx) => this.key(event, cx));
  }
}
