import { h_flex, v_flex } from "gpui-base";
import { type AsyncContext, type Context, div, type Element, type KeyEvent, type ScrollWheelEvent } from "gpui-kit";
import { type DiffDocument, readComparison, readDiff } from "../../git/diff.ts";
import { type ChangedPath, type Commit, readCommitChanges, statusLetter } from "../../git/history.ts";
import type { FileChange, RunGit } from "../../git/repository.ts";
import { SplitDiff } from "../code-view.ts";
import type { Services } from "../shell.ts";
import { type Look, type Palette, statusColor } from "../theme.ts";
import { box, type CellSpan, countedTitle, spanElements, spinner, truncateToWidth } from "../widgets.ts";

const DETAILS_CACHE_CAP = 64;
const PREVIEW_CACHE_CAP = 8;
const PREVIEW_TITLE_RESERVE = 6;

export type InspectFocus = "details" | "preview";

export interface WorkingChange {
  side: "staged" | "unstaged";
  status: string;
  path: string;
  file: FileChange;
}

interface DetailLine {
  spans: CellSpan[];
  change?: number;
}

interface PreviewTarget {
  key: string;
  path: string;
  read: (git: RunGit) => Promise<DiffDocument>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "unknown error").trim() || "unknown error";
}

export function workingChanges(files: readonly FileChange[]): WorkingChange[] {
  const staged = files.flatMap((file) =>
    file.staged ? [{ side: "staged" as const, status: statusLetter(file.staged), path: file.path, file }] : [],
  );
  const unstaged = files.flatMap((file) =>
    file.unstaged ? [{ side: "unstaged" as const, status: statusLetter(file.unstaged), path: file.path, file }] : [],
  );
  return [...staged, ...unstaged];
}

function changeLine(status: string, path: string, index: number, t: Palette): DetailLine {
  return {
    change: index,
    spans: [
      { text: status.charAt(0) || status, color: statusColor(t, status), bold: true },
      { text: " " },
      { text: " ", icon: "file", color: t.hint },
      { text: path },
    ],
  };
}

function field(label: string, value: string, t: Palette): DetailLine {
  return { spans: [{ text: `${label}: `, color: t.hint }, { text: value }] };
}

function commitLines(commit: Commit, changes: readonly ChangedPath[], t: Palette): DetailLine[] {
  const lines: DetailLine[] = [
    { spans: [{ text: commit.subject, bold: true }] },
    { spans: [] },
    field("Author", `${commit.authorName} <${commit.authorEmail}>`, t),
    field("Date", commit.authorTime, t),
    field("SHA", commit.sha, t),
    field("Parents", commit.parents.length ? commit.parents.join(" ") : "(root)", t),
    field("Refs", commit.refs.length ? commit.refs.map((reference) => reference.name).join(", ") : "—", t),
    { spans: [] },
  ];
  for (const line of commit.body ? commit.body.split("\n") : []) lines.push({ spans: [{ text: line }] });
  if (commit.body) lines.push({ spans: [] });
  return [
    ...lines,
    ...changeSection(
      changes.map((change) => [change.status, change.path] as const),
      t,
    ),
  ];
}

function changeSection(changes: readonly (readonly [string, string])[], t: Palette): DetailLine[] {
  const lines: DetailLine[] = [
    { spans: [{ text: countedTitle("Changes", changes.length), color: t.accent, bold: true }] },
  ];
  if (!changes.length) lines.push({ spans: [{ text: "(none)" }] });
  changes.forEach(([status, path], index) => {
    lines.push(changeLine(status, path, index, t));
  });
  return lines;
}

function workingLines(changes: readonly WorkingChange[], t: Palette): DetailLine[] {
  return [
    { spans: [{ text: "Uncommitted", bold: true }] },
    { spans: [] },
    ...changeSection(
      changes.map((change) => [change.status, change.path] as const),
      t,
    ),
  ];
}

export class Inspect {
  focus: InspectFocus | null = null;
  private commit: Commit | null = null;
  private working: WorkingChange[] | null = null;
  private changes: ChangedPath[] | null = null;
  private shown: { commit: Commit; changes: ChangedPath[] } | null = null;
  private cache = new Map<string, ChangedPath[]>();
  private pending = false;
  private error: string | null = null;
  private request = 0;
  private selected = 0;
  private scroll = 0;
  private follow = true;
  private height = 0;
  private wheel = 0;
  private previewPath: string | null = null;
  private loadedPath: string | null = null;
  private previewKey: string | null = null;
  private previewPending = false;
  private previewError: string | null = null;
  private previewRequest = 0;
  private previewCache = new Map<string, DiffDocument>();
  private preview: DiffDocument | null = null;
  private diff = new SplitDiff("git-commit-preview");

  constructor(private readonly services: Services) {}

  release(): void {
    this.diff.release();
  }

  clearCaches(): void {
    this.shown = null;
    this.cache.clear();
    this.previewCache.clear();
  }

  previewOpen(): boolean {
    return this.previewPath !== null;
  }

  loading(): boolean {
    return this.pending;
  }

  showCommit(commit: Commit | null, cx: AsyncContext): void {
    const same = commit && this.commit?.sha === commit.sha && !this.working;
    this.commit = commit;
    this.working = null;
    if (same && commit) return;
    this.reset();
    if (!commit) {
      this.changes = null;
      return;
    }
    const cached = this.cache.get(commit.sha);
    if (cached) {
      this.changes = cached;
      this.shown = { commit, changes: cached };
      return;
    }
    this.changes = null;
    this.load(commit, cx);
  }

  showWorking(changes: WorkingChange[]): void {
    const was = this.working !== null;
    this.commit = null;
    this.changes = null;
    this.working = changes;
    if (!was) this.reset();
    this.selected = Math.min(this.selected, Math.max(0, changes.length - 1));
  }

  reset(): void {
    this.request++;
    this.pending = false;
    this.closePreview();
    if (this.focus) this.focus = null;
    this.scroll = 0;
    this.follow = true;
    this.error = null;
    this.selected = 0;
  }

  private load(commit: Commit, cx: AsyncContext): void {
    const git = this.services.git();
    if (!git) return;
    const context = this.services.context();
    const request = ++this.request;
    this.pending = true;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        const changes = await readCommitChanges(git, commit.sha);
        if (request !== this.request || context !== this.services.context()) return;
        if (this.cache.size >= DETAILS_CACHE_CAP) this.cache.delete(this.cache.keys().next().value ?? "");
        this.cache.set(commit.sha, changes);
        this.changes = changes;
        this.shown = { commit, changes };
        this.selected = 0;
        this.scroll = 0;
        this.follow = true;
      } catch (error) {
        if (request === this.request && context === this.services.context()) this.error = message(error);
      } finally {
        if (request === this.request) {
          this.pending = false;
          cx.notify();
        }
      }
    });
  }

  private count(): number | null {
    if (this.working) return this.working.length;
    return this.changes?.length ?? null;
  }

  private pathAt(index: number): string | null {
    if (this.pending) return null;
    if (this.working) return this.working[index]?.path ?? null;
    return this.changes?.[index]?.path ?? null;
  }

  private target(index: number): PreviewTarget | null {
    const working = this.working?.[index];
    if (working)
      return {
        key: `${working.side}\0${working.path}`,
        path: working.path,
        read: (git) => readDiff(git, working.file, working.side),
      };
    const commit = this.commit;
    const change = this.changes?.[index];
    if (!commit || !change) return null;
    const parent = commit.parents[0] ?? null;
    return {
      key: `${commit.sha}\0${change.path}`,
      path: change.path,
      read: (git) => readComparison(git, parent, commit.sha, { path: change.path, from: change.from }),
    };
  }

  focusChanges(): boolean {
    const count = this.count();
    if (this.pending || !count) return false;
    this.focus = "details";
    this.selected = Math.min(this.selected, count - 1);
    this.follow = true;
    return true;
  }

  private select(index: number): void {
    const count = this.count();
    if (this.pending || !count) return;
    this.selected = Math.max(0, Math.min(index, count - 1));
    this.follow = true;
  }

  toggle(index: number, cx: AsyncContext): void {
    const path = this.pathAt(index);
    if (path === null) return;
    this.selected = index;
    this.follow = true;
    this.focus = "details";
    if (this.previewPath === path) this.closePreview();
    else this.openPreview(index, cx);
  }

  private activate(index: number, cx: AsyncContext): void {
    const path = this.pathAt(index);
    if (path === null) return;
    if (this.previewPath === path) this.focus = "preview";
    else this.openPreview(index, cx);
  }

  private openPreview(index: number, cx: AsyncContext): void {
    const target = this.target(index);
    if (!target) return;
    this.selected = index;
    this.follow = true;
    this.focus = "details";
    this.previewPath = target.path;
    this.previewError = null;
    const cached = this.previewCache.get(target.key);
    this.previewRequest++;
    if (cached) {
      this.show(target, cached);
      return;
    }
    this.readPreview(target, cx);
  }

  private readPreview(target: PreviewTarget, cx: AsyncContext): void {
    const git = this.services.git();
    if (!git) return;
    const context = this.services.context();
    const request = this.previewRequest;
    this.previewPending = true;
    cx.spawn(async (cx) => {
      try {
        const document = await target.read(git);
        if (request !== this.previewRequest || context !== this.services.context()) return;
        this.show(target, document);
      } catch (error) {
        if (request === this.previewRequest && context === this.services.context()) this.previewError = message(error);
      } finally {
        if (request === this.previewRequest) {
          this.previewPending = false;
          cx.notify();
        }
      }
    });
  }

  private show(target: PreviewTarget, document: DiffDocument): void {
    this.stash();
    this.previewKey = target.key;
    this.preview = document;
    this.loadedPath = target.path;
    this.previewError = null;
    this.diff.set(document.text, target.path);
  }

  private stash(): void {
    if (!this.previewKey || !this.preview) return;
    this.previewCache.delete(this.previewKey);
    if (this.previewCache.size >= PREVIEW_CACHE_CAP)
      this.previewCache.delete(this.previewCache.keys().next().value ?? "");
    this.previewCache.set(this.previewKey, this.preview);
  }

  closePreview(): void {
    this.previewRequest++;
    this.previewPending = false;
    this.stash();
    this.previewKey = null;
    this.preview = null;
    this.previewPath = null;
    this.loadedPath = null;
    this.previewError = null;
    if (this.focus === "preview") this.focus = "details";
  }

  escape(): boolean {
    if (this.focus === "preview") this.focus = "details";
    else if (this.focus === "details") this.focus = null;
    else return false;
    return true;
  }

  key(event: KeyEvent, cx: Context): boolean {
    if (this.focus === "preview") return this.previewKeyDown(event, cx);
    if (this.focus === "details") return this.detailsKey(event.keystroke, cx);
    return false;
  }

  private detailsKey(key: string, cx: AsyncContext): boolean {
    const page = Math.max(1, this.height - 1);
    const moves: Record<string, number> = { down: 1, j: 1, up: -1, k: -1, pagedown: page, pageup: -page };
    const move = moves[key];
    if (move !== undefined) this.select(this.selected + move);
    else if (key === "home") this.select(0);
    else if (key === "end") this.select(Number.MAX_SAFE_INTEGER);
    else if (key === "enter") this.activate(this.selected, cx);
    else if (key === "space") this.toggle(this.selected, cx);
    else if (key === "right" && this.previewPath) this.focus = "preview";
    else if (key === "left") this.focus = null;
    else return false;
    return true;
  }

  private previewKeyDown(event: KeyEvent, cx: Context): boolean {
    const handled = this.diff.key(event, cx);
    if (handled || event.keystroke !== "left") return handled;
    this.focus = "details";
    return true;
  }

  private lines(t: Palette): DetailLine[] {
    if (this.working) return workingLines(this.working, t);
    if (this.commit && this.changes) return commitLines(this.commit, this.changes, t);
    if (this.commit && this.shown) return commitLines(this.shown.commit, this.shown.changes, t);
    return [{ spans: [{ text: "No commits" }] }];
  }

  private title(look: Look): Element | string {
    if (this.pending) return h_flex().child(spinner(look)).child(" Commit details");
    if (this.working) return "Uncommitted";
    if (this.error)
      return div()
        .text_color(look.t.error)
        .font_weight(700)
        .child(`Commit details failed · ${firstLine(this.error)} · move selection to retry`);
    return "Commit details";
  }

  private followSelection(lines: DetailLine[]): void {
    if (this.focus !== "details" || !this.follow) return;
    const row = lines.findIndex((line) => line.change === this.selected);
    if (row >= 0 && row < this.scroll) this.scroll = row;
    else if (row >= 0 && row >= this.scroll + this.height) this.scroll = row + 1 - this.height;
    this.follow = false;
  }

  private wheelDetails(event: ScrollWheelEvent, look: Look, cx: Context): void {
    this.wheel += event.delta_lines ? event.delta_lines.y * look.row : event.delta.y;
    const steps = Math.trunc(this.wheel / look.row);
    if (steps === 0) return;
    this.wheel -= steps * look.row;
    this.follow = false;
    this.scroll = Math.max(0, this.scroll - steps);
    cx.stop_propagation();
    cx.notify();
  }

  renderDetails(look: Look, onFocus: (cx: Context) => void): Element {
    const { t } = look;
    const lines = this.lines(t);
    this.scroll = Math.max(0, Math.min(this.scroll, lines.length - this.height));
    this.followSelection(lines);
    const body = v_flex().flex_1().min_h(0).min_w(0).overflow_hidden();
    for (const [offset, line] of lines.slice(this.scroll, this.scroll + Math.max(1, this.height)).entries())
      body.child(this.detailRow(look, line, this.scroll + offset, onFocus));
    return box(
      look,
      { id: "git-commit-details", title: this.title(look), focused: this.focus === "details" },
      h_flex()
        .id("git-commit-details-body")
        .flex_1()
        .min_h(0)
        .min_w(0)
        .items_stretch()
        .on_size_change((size, cx) => {
          const height = Math.max(1, Math.floor(size.height / look.screenRow));
          if (height === this.height) return;
          this.height = height;
          cx.notify();
        })
        .on_scroll_wheel((event, cx) => this.wheelDetails(event, look, cx))
        .child(body),
    );
  }

  private detailRow(look: Look, line: DetailLine, index: number, onFocus: (cx: Context) => void): Element {
    const row = h_flex()
      .id(`git-commit-detail-${index}`)
      .flex_none()
      .h(look.row)
      .min_w(0)
      .overflow_hidden()
      .whitespace_nowrap()
      .children(spanElements(look, line.spans));
    const change = line.change;
    if (change === undefined) return row;
    return row
      .when(this.focus === "details" && this.selected === change, (el) => el.bg(look.t.focus).font_weight(700))
      .hover((style) => style.bg(look.t.hover))
      .on_click((_, cx) => {
        cx.stop_propagation();
        this.toggle(change, cx);
        onFocus(cx);
        cx.notify();
      });
  }

  private previewTitle(look: Look, width: number): Element | string {
    const titleWidth = Math.max(0, width - PREVIEW_TITLE_RESERVE);
    if (this.previewError)
      return div()
        .text_color(look.t.error)
        .font_weight(700)
        .child(
          truncateToWidth(`Preview failed · ${firstLine(this.previewError)} · close and reopen to retry`, titleWidth),
        );
    const shown = this.loadedPath ?? this.previewPath ?? "File";
    const language = this.preview ? this.diff.language() : "";
    const label = language ? `Preview · ${shown} · ${language}` : `Preview · ${shown}`;
    if (this.previewPending)
      return h_flex()
        .child(spinner(look))
        .child(` ${truncateToWidth(label, Math.max(0, titleWidth - 2))}`);
    return truncateToWidth(label, titleWidth);
  }

  private previewBody(look: Look, width: number, height: number): Element {
    const { t } = look;
    const vertical = !(width - 2 >= 72 || height - 2 < 8);
    const panes = this.diff.render(look, { focused: this.focus === "preview" });
    const pane = (id: string, title: string, inner: Element) =>
      box(look, { id, title }, inner).flex_1().min_h(0).min_w(0);
    const binary = this.preview?.binary;
    if (binary) return div().flex_1().text_color(t.muted).child("Binary file — no text diff");
    return (vertical ? v_flex() : h_flex())
      .flex_1()
      .min_h(0)
      .min_w(0)
      .items_stretch()
      .child(pane("git-commit-preview-before", "Before", panes.before))
      .child(pane("git-commit-preview-after", "After", panes.after));
  }

  renderPreview(look: Look, size: { cols: number; rows: number }, onFocus: (cx: Context) => void): Element {
    const close = h_flex()
      .id("git-commit-preview-close")
      .absolute()
      .top(0)
      .right(look.cell * 1)
      .h(look.row)
      .text_color(look.t.hint)
      .hover((style) => style.bg(look.t.hover))
      .child("[×]")
      .on_click((_, cx) => {
        cx.stop_propagation();
        this.closePreview();
        cx.notify();
      });
    return box(
      look,
      { id: "git-commit-preview", title: this.previewTitle(look, size.cols), focused: this.focus === "preview" },
      v_flex()
        .flex_1()
        .min_h(0)
        .min_w(0)
        .on_mouse_down("left", (_, cx) => {
          this.focus = "preview";
          onFocus(cx);
          cx.notify();
        })
        .child(this.previewBody(look, size.cols, size.rows)),
    ).child(close);
  }
}
