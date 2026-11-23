import { h_flex, v_flex } from "gpui-base";
import {
  type Context,
  div,
  type Element,
  type FocusHandle,
  type KeyEvent,
  type MouseButtonEvent,
  type ScrollWheelEvent,
} from "gpui-kit";
import type { ChangeSection, DiffSummary, WorkingChange } from "../../git/comparison.ts";
import type { StagingOperation } from "../../git/staging.ts";
import { type Color, cols, GLYPH, type Look, type Palette, statusColor } from "../theme.ts";
import { box, countedTitle, displayWidth, isChord, scrollbar, spinner, viewportOffset } from "../widgets.ts";
import { type TreeRow, treeRows } from "./tree.ts";

export interface FilesHost {
  changes(): readonly WorkingChange[];
  summaries(): Partial<Record<ChangeSection, DiffSummary>>;
  select(change: number, cx: Context): void;
  activate(change: number, cx: Context): void;
  focus(): void;
  stage(operation: StagingOperation, owner: string, cx: Context): void;
  discard(paths: string[], cx: Context): void;
  error(message: string): void;
  clearDiffSelection(): void;
}

interface Span {
  text: string;
  color: Color;
  bold?: boolean;
}

const OVERLAY = 3;

function changeKey(change: WorkingChange): string {
  return `${change.section}\0${change.path}`;
}

function rowKey(row: TreeRow, changes: readonly WorkingChange[]): string {
  if (row.kind === "directory") return row.key;
  const change = changes[row.change];
  return change ? changeKey(change) : "";
}

function stagingOperation(row: TreeRow, changes: readonly WorkingChange[]): StagingOperation | null {
  if (row.kind === "directory") {
    if (row.section === "staged") return { kind: "unstage-all" };
    if (row.section === "unstaged" || row.section === "working") return { kind: "stage-all" };
    return null;
  }
  const change = changes[row.change];
  if (!change || change.section === "commit") return null;
  return change.section === "staged"
    ? { kind: "unstage", paths: [change.path] }
    : { kind: "stage", paths: [change.path] };
}

function discardPaths(row: TreeRow, changes: readonly WorkingChange[]): string[] | null {
  if (row.kind === "directory") {
    if (row.section !== "unstaged") return null;
    const paths = changes
      .filter((change) => change.section === "unstaged" && change.status !== "??")
      .map((change) => change.path);
    return paths.length ? paths : null;
  }
  const change = changes[row.change];
  if (change?.section !== "unstaged" || change.status === "??") return null;
  return [change.path];
}

function summarySpans(t: Palette, files: number, summary: DiffSummary | undefined): Span[] {
  const spans: Span[] = [{ text: ` ${files}f`, color: t.hint }];
  if (summary?.additions) spans.push({ text: ` +${summary.additions}`, color: t.success });
  if (summary?.deletions) spans.push({ text: ` -${summary.deletions}`, color: t.error });
  return spans;
}

function sliceSpans(spans: Span[], offset: number, width: number): Span[] {
  const output: Span[] = [];
  let skipped = 0;
  let used = 0;
  for (const span of spans) {
    let text = "";
    for (const character of span.text) {
      const size = displayWidth(character);
      if (skipped < offset) {
        skipped += size;
        continue;
      }
      if (used + size > width) break;
      text += character;
      used += size;
    }
    if (text) output.push({ ...span, text });
  }
  return output;
}

export class FilesPane {
  rows: TreeRow[] = [];
  selected = 0;
  private scroll = 0;
  private horizontal = 0;
  private collapsed = new Set<string>();
  private selection = new Set<string>();
  private anchor: number | null = null;
  private keyboard = false;
  private dragAnchor: number | null = null;
  private dragging = false;
  private pressed = false;
  private hovered: number | null = null;
  private height = 0;
  private width = 0;
  private wheelX = 0;
  private wheelY = 0;

  constructor(
    private readonly host: FilesHost,
    readonly handle: FocusHandle,
  ) {}

  reset(): void {
    this.collapsed.clear();
    this.clearSelection();
    this.selected = 0;
    this.scroll = 0;
    this.horizontal = 0;
  }

  rebuild(selectedChange: number | null): void {
    const changes = this.host.changes();
    this.rows = treeRows(changes, this.collapsed);
    const index =
      selectedChange === null ? -1 : this.rows.findIndex((row) => row.kind === "file" && row.change === selectedChange);
    this.selected = index >= 0 ? index : Math.min(this.selected, Math.max(0, this.rows.length - 1));
    const available = new Set(changes.map(changeKey));
    for (const key of this.selection) if (!available.has(key)) this.selection.delete(key);
    if (this.anchor !== null && this.rows[this.anchor]?.kind !== "file") {
      this.anchor = null;
      this.keyboard = false;
      this.dragging = false;
    }
  }

  replaced(): void {
    this.collapsed.clear();
    this.clearSelection();
  }

  private fileKey(index: number): string | null {
    const row = this.rows[index];
    if (row?.kind !== "file") return null;
    const change = this.host.changes()[row.change];
    return change ? changeKey(change) : null;
  }

  private view(): Set<string> {
    const keys = new Set(this.selection);
    if (this.anchor === null) return keys;
    for (let index = Math.min(this.anchor, this.selected); index <= Math.max(this.anchor, this.selected); index++) {
      const key = this.fileKey(index);
      if (key) keys.add(key);
    }
    return keys;
  }

  selecting(): boolean {
    return this.anchor !== null || this.keyboard || this.dragAnchor !== null || this.dragging;
  }

  private begin(index: number, keyboard: boolean): void {
    if (!this.fileKey(index)) {
      this.host.error("Focus a file before starting selection.");
      return;
    }
    this.host.focus();
    this.selected = index;
    this.anchor = index;
    this.keyboard = keyboard;
    this.dragging = !keyboard;
  }

  private finish(): void {
    this.selection = this.view();
    this.anchor = null;
    this.keyboard = false;
    this.dragging = false;
    this.dragAnchor = null;
  }

  clearSelection(): void {
    this.selection.clear();
    this.anchor = null;
    this.keyboard = false;
    this.dragging = false;
    this.dragAnchor = null;
  }

  escape(): boolean {
    if (this.keyboard) this.finish();
    else if (this.selection.size > 0) this.clearSelection();
    else return false;
    return true;
  }

  private choose(index: number, cx: Context): void {
    if (this.rows.length === 0) return;
    this.selected = Math.max(0, Math.min(index, this.rows.length - 1));
    const row = this.rows[this.selected];
    if (row?.kind === "file") this.host.select(row.change, cx);
  }

  private toggleDirectory(): void {
    const row = this.rows[this.selected];
    if (row?.kind !== "directory") return;
    if (!this.collapsed.delete(row.key)) this.collapsed.add(row.key);
    const selected = this.rows[this.selected];
    this.rows = treeRows(this.host.changes(), this.collapsed);
    if (selected) this.selected = Math.min(this.selected, Math.max(0, this.rows.length - 1));
  }

  private activate(cx: Context): void {
    const row = this.rows[this.selected];
    if (row?.kind === "directory") this.toggleDirectory();
    else if (row) this.host.activate(row.change, cx);
  }

  private stageSelection(stage: boolean, cx: Context): void {
    const section: ChangeSection = stage ? "unstaged" : "staged";
    const keys = this.view();
    this.finish();
    const paths = [
      ...new Set(
        this.host
          .changes()
          .filter(
            (change) => keys.has(changeKey(change)) && (change.section === section || change.section === "working"),
          )
          .map((change) => change.path),
      ),
    ].sort();
    if (paths.length === 0) {
      this.host.error(stage ? "Select an Unstaged file to stage." : "Select a Staged file to unstage.");
      return;
    }
    this.run({ kind: stage ? "stage" : "unstage", paths }, cx);
  }

  private stageFocused(stage: boolean, cx: Context): void {
    if (this.view().size > 0) {
      this.stageSelection(stage, cx);
      return;
    }
    const row = this.rows[this.selected];
    const operation = row ? stagingOperation(row, this.host.changes()) : null;
    if (!operation) return;
    const stages = operation.kind === "stage" || operation.kind === "stage-all";
    if (stages === stage) this.run(operation, cx);
  }

  private run(operation: StagingOperation, cx: Context): void {
    const row = this.rows[this.selected];
    this.host.stage(operation, row ? rowKey(row, this.host.changes()) : "", cx);
  }

  key(event: KeyEvent, cx: Context): boolean {
    if (isChord(event)) return false;
    const key = event.keystroke;
    const page = Math.max(1, this.height);
    const moves: Record<string, number> = { down: 1, j: 1, up: -1, k: -1, pagedown: page, pageup: -page };
    if (key === "enter") this.activate(cx);
    else if (key === "space") this.toggleDirectory();
    else if (key === "s" || key === "shift-s") this.stageFocused(true, cx);
    else if (key === "u" || key === "shift-u") this.stageFocused(false, cx);
    else if (key === "v" && !this.keyboard) this.begin(this.selected, true);
    else if (key === "home") this.choose(0, cx);
    else if (key === "end") this.choose(this.rows.length - 1, cx);
    else if (moves[key] !== undefined) this.choose(this.selected + (moves[key] ?? 0), cx);
    else return false;
    return true;
  }

  private overlayHit(index: number, column: number): "stage" | "discard" | null {
    const visible = index - this.scroll;
    if (this.width < OVERLAY || visible < 0 || visible >= this.height) return null;
    const start = this.width - OVERLAY;
    if (column >= start) return "stage";
    if (start >= OVERLAY && column >= start - OVERLAY) return "discard";
    return null;
  }

  private rowAt(y: number | undefined): number | null {
    if (y === undefined) return null;
    const index = this.scroll + Math.floor(y / this.rowHeight);
    return index < this.rows.length ? index : null;
  }

  private rowHeight = 1;
  private cellWidth = 1;

  private mouseDown(event: MouseButtonEvent, left: boolean, cx: Context): void {
    cx.stop_propagation();
    this.pressed = left;
    const index = this.rowAt(event.local_position?.y) ?? 0;
    this.host.focus();
    this.host.clearDiffSelection();
    const column = Math.floor((event.local_position?.x ?? 0) / this.cellWidth);
    const row = this.rows[index];
    const changes = this.host.changes();
    const hit = left ? this.overlayHit(index, column) : null;
    const discard = hit === "discard" && row ? discardPaths(row, changes) : null;
    const operation = hit === "stage" && row ? stagingOperation(row, changes) : null;
    this.choose(index, cx);
    if (discard) {
      this.dragAnchor = null;
      this.host.discard(discard, cx);
    } else if (operation) {
      this.dragAnchor = null;
      this.run(operation, cx);
    } else if (left) {
      this.dragAnchor = this.fileKey(this.selected) ? this.selected : null;
      this.activate(cx);
    }
    cx.notify();
  }

  private mouseMove(y: number, cx: Context): void {
    const index = this.rowAt(y);
    if (index !== this.hovered) {
      this.hovered = index;
      cx.notify();
    }
    if (!this.pressed || this.dragAnchor === null) return;
    const target = index ?? this.rows.length - 1;
    if (!this.dragging) this.begin(this.dragAnchor, false);
    if (this.dragging && target !== this.selected) {
      this.choose(target, cx);
      cx.notify();
    }
  }

  pointerUp(cx: Context): void {
    this.pressed = false;
    if (this.dragging) {
      this.finish();
      cx.notify();
    } else this.dragAnchor = null;
  }

  private wheel(event: ScrollWheelEvent, look: Look, cx: Context): void {
    const lines = event.delta_lines;
    this.wheelX += lines ? lines.x * look.cell : event.delta.x;
    this.wheelY += lines ? lines.y * look.row : event.delta.y;
    const x = Math.trunc(this.wheelX / look.cell);
    const y = Math.trunc(this.wheelY / look.row);
    this.wheelX -= x * look.cell;
    this.wheelY -= y * look.row;
    if (x === 0 && y === 0) return;
    cx.stop_propagation();
    if (x !== 0) this.horizontal = Math.max(0, Math.min(this.horizontal - x, this.maxHorizontal()));
    if (y !== 0) {
      this.host.focus();
      this.choose(this.selected - y, cx);
    }
    cx.notify();
  }

  private line(look: Look, row: TreeRow): Span[] {
    const { t } = look;
    const indent = "  ".repeat(row.depth);
    if (row.kind === "directory") {
      const label = `${indent}${row.expanded ? GLYPH.expanded : GLYPH.collapsed} ${row.label}`;
      if (!row.section) return [{ text: label, color: t.text }];
      const section = row.section;
      const files = this.host.changes().filter((change) => change.section === section).length;
      return [{ text: label, color: t.accent, bold: true }, ...summarySpans(t, files, this.host.summaries()[section])];
    }
    const change = this.host.changes()[row.change];
    const status = change?.status ?? "";
    return [
      { text: indent, color: t.text },
      { text: status.slice(0, 1).padEnd(4), color: statusColor(t, status), bold: true },
      { text: ` ${row.label}`, color: t.text },
    ];
  }

  private widest(look: Look): number {
    return this.rows.reduce(
      (width, row) =>
        Math.max(
          width,
          this.line(look, row).reduce((total, span) => total + displayWidth(span.text), 0),
        ),
      0,
    );
  }

  private maxHorizontal(): number {
    return Math.max(0, this.widestCache - Math.max(0, this.width - 2));
  }

  private widestCache = 0;

  private overlayCell(look: Look, operation: StagingOperation, discard: boolean): Element[] {
    const { t } = look;
    const stages = operation.kind === "stage" || operation.kind === "stage-all";
    const cells: Element[] = [];
    if (discard)
      cells.push(
        div().flex_none().w(cols(look, OVERLAY)).bg(t.warning).text_color(t.textInverse).font_weight(700).child(" ↶ "),
      );
    cells.push(
      div()
        .flex_none()
        .w(cols(look, OVERLAY))
        .bg(stages ? t.success : t.warning)
        .text_color(t.textInverse)
        .font_weight(700)
        .child(stages ? " + " : " - "),
    );
    return cells;
  }

  private rowElement(look: Look, index: number, selection: Set<string>, owner: string | null): Element {
    const { t } = look;
    const row = this.rows[index];
    if (!row) return div();
    const changes = this.host.changes();
    const key = rowKey(row, changes);
    const focusedRow = index === this.selected;
    const selectedRow = row.kind === "file" && selection.has(key);
    const hovered = index === this.hovered;
    const background = focusedRow ? t.focus : hovered ? t.hover : selectedRow ? t.selection : null;
    const spans = sliceSpans(this.line(look, row), this.horizontal, Math.max(1, this.width - 2));
    const element = h_flex()
      .flex_none()
      .h(look.row)
      .min_w(0)
      .overflow_hidden()
      .whitespace_nowrap()
      .when(!!background, (el) => el.bg(background ?? t.background))
      .when(focusedRow || selectedRow, (el) => el.font_weight(700))
      .child(
        div()
          .flex_none()
          .w(cols(look, 2))
          .child(focusedRow ? GLYPH.marker : ""),
      )
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .overflow_hidden()
          .children(
            spans.map((span) =>
              div()
                .flex_none()
                .text_color(span.color)
                .when(!!span.bold, (el) => el.font_weight(700))
                .child(span.text),
            ),
          ),
      );
    if (owner !== null && owner === key)
      return element.child(
        div().flex_none().w(cols(look, OVERLAY)).bg(t.hover).flex().justify_center().child(spinner(look)),
      );
    const operation = hovered ? stagingOperation(row, changes) : null;
    if (operation) element.children(this.overlayCell(look, operation, !!discardPaths(row, changes)));
    return element;
  }

  render(
    look: Look,
    options: { focused: boolean; hints: boolean; repository: boolean; owner: string | null },
  ): Element {
    const { t } = look;
    this.rowHeight = look.screenRow;
    this.cellWidth = look.screenCell;
    this.widestCache = this.widest(look);
    this.horizontal = Math.min(this.horizontal, this.maxHorizontal());
    this.scroll = viewportOffset(this.scroll, this.selected, this.rows.length, this.height);
    const selection = this.view();
    const counted = countedTitle("Files", this.host.changes().length);
    const text = selection.size ? `${counted} · Selected ${selection.size}` : counted;
    const title = options.hints
      ? h_flex()
          .child(div().text_color(t.accent).font_weight(700).child("O"))
          .child(` Find Files${text.slice("Files".length)}`)
      : text;
    const list = v_flex().flex_1().min_w(0).min_h(0).overflow_hidden();
    const end = Math.min(this.rows.length, this.scroll + Math.max(1, this.height));
    for (let index = this.scroll; index < end; index++)
      list.child(this.rowElement(look, index, selection, options.owner));
    if (!options.repository) list.child(div().text_color(t.warning).whitespace_normal().child("Not a Git repository"));
    const bar = scrollbar(look, {
      axis: "vertical",
      total: this.rows.length,
      visible: this.height,
      offset: this.scroll,
    });
    const body = h_flex()
      .id("git-changes-tree")
      .flex_1()
      .min_h(0)
      .min_w(0)
      .items_stretch()
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        const height = Math.max(1, Math.floor(size.height / look.screenRow));
        const width = Math.floor(size.width / look.screenCell);
        if (height === this.height && width === this.width) return;
        this.height = height;
        this.width = width;
        cx.notify();
      })
      .on_scroll_wheel((event, cx) => this.wheel(event, look, cx))
      .on_mouse_down("left", (event, cx) => this.mouseDown(event, true, cx))
      .on_mouse_down("right", (event, cx) => this.mouseDown(event, false, cx))
      .on_mouse_up("left", (_, cx) => this.pointerUp(cx))
      .on_mouse_move((event, cx) => this.mouseMove(event.local_position.y, cx))
      .on_hover((hovered, cx) => {
        if (hovered || this.hovered === null) return;
        this.hovered = null;
        cx.notify();
      })
      .child(list)
      .when(!!bar, (el) => el.child(bar ?? div()));
    return box(look, { id: "git-changes-files", title, focused: options.focused }, body);
  }
}
