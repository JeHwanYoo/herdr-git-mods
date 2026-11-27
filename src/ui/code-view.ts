import { h_flex, v_flex } from "gpui-base";
import { type Context, div, type Element, type KeyEvent, type MouseButtonEvent, type ScrollWheelEvent } from "gpui-kit";
import {
  buildDiff,
  type Cell,
  type CellTone,
  codeCell,
  type DiffRow,
  expandTabs,
  type FoldKey,
  foldId,
  GUTTER,
  textCell,
} from "./changes/document.ts";
import { highlighter, languageName, type Token, tokenColor } from "./syntax.ts";
import { type Color, cols, type Look, rows } from "./theme.ts";
import { displayWidth, isChord, kbd, scrollbar } from "./widgets.ts";

type CodeTone = "plain" | "added" | "removed" | "fold";
export type ReviewSide = "Before" | "After";

export interface CodeLine {
  number: number | null;
  text: string;
  tokens: Token[];
  tone: CodeTone;
}

interface CodeMatch {
  row: number;
  start: number;
  end: number;
}

interface Segment {
  text: string;
  fg: Color;
  bg: Color | null;
  bold: boolean;
}

type Emphasis = "focus" | "selection" | null;

const HINT_KEYS: [string, string][] = [
  ["y", "Yank"],
  ["h", "History"],
  ["Esc", "Cancel"],
];

export function highlight(text: string, path: string): Token[] {
  return highlighter(path).line(text);
}

export function sourceLines(text: string, path: string): CodeLine[] {
  const code = highlighter(path);
  const lines = text ? text.replace(/\n$/, "").split("\n") : [];
  return lines.map((line, index) => ({ number: index + 1, text: line, tokens: code.line(line), tone: "plain" }));
}

function cellWidth(cell: Cell): number {
  return (cell.gutter ? GUTTER : 0) + cell.tokens.reduce((width, token) => width + displayWidth(token.text), 0);
}

function toneBackground(look: Look, tone: CellTone): Color | null {
  const { t } = look;
  if (tone === "added") return t.diffAdded;
  if (tone === "removed") return t.diffRemoved;
  if (tone === "blank") return t.inert;
  if (tone === "fold") return t.header;
  return null;
}

function gutterSegment(look: Look, cell: Cell, emphasized: Color | null): Segment {
  const { t } = look;
  const code = cell.number !== null;
  const text = cell.number === null ? " ".repeat(GUTTER) : `${String(cell.number).padStart(GUTTER - 1)} `;
  const strong = code && !!emphasized;
  return { text, fg: strong ? t.text : t.hint, bg: strong ? emphasized : null, bold: strong };
}

function tokenForeground(look: Look, cell: Cell, token: Token): Color {
  const { t } = look;
  if (cell.tone === "fold") return t.accent;
  if (cell.tone !== "meta") return tokenColor(look, token.kind);
  if (cell.meta === "hunk") return t.warning;
  return cell.meta === "file" ? t.accent : t.hint;
}

function cellSegments(look: Look, cell: Cell, emphasis: Emphasis): { segments: Segment[]; background: Color | null } {
  const { t } = look;
  const emphasized = emphasis === "focus" ? t.focus : emphasis === "selection" ? t.selection : null;
  const code = cell.number !== null;
  const bold = !code && !!emphasized;
  const segments: Segment[] = cell.gutter ? [gutterSegment(look, cell, emphasized)] : [];
  for (const token of cell.tokens)
    segments.push({ text: token.text, fg: tokenForeground(look, cell, token), bg: null, bold });
  return { segments, background: !code && emphasized ? emphasized : toneBackground(look, cell.tone) };
}

function splitAt(segments: Segment[], column: number): Segment[] {
  const output: Segment[] = [];
  let used = 0;
  for (const segment of segments) {
    const width = displayWidth(segment.text);
    if (used >= column || used + width <= column) {
      output.push(segment);
      used += width;
      continue;
    }
    let head = "";
    let headWidth = 0;
    for (const character of segment.text) {
      if (used + headWidth >= column) break;
      head += character;
      headWidth += displayWidth(character);
    }
    output.push({ ...segment, text: head }, { ...segment, text: segment.text.slice(head.length) });
    used += width;
  }
  return output;
}

function paint(segments: Segment[], from: number, to: number, fg: Color, bg: Color): Segment[] {
  let used = 0;
  return splitAt(splitAt(segments, from), to).map((segment) => {
    const start = used;
    used += displayWidth(segment.text);
    return start >= from && start < to ? { ...segment, fg, bg } : segment;
  });
}

function sliceSegments(segments: Segment[], offset: number, width: number): Segment[] {
  const output: Segment[] = [];
  let skipped = 0;
  let rendered = 0;
  for (const segment of segments) {
    let text = "";
    for (const character of segment.text) {
      const size = displayWidth(character);
      if (skipped < offset) {
        skipped += size;
        continue;
      }
      if (rendered + size > width) break;
      text += character;
      rendered += size;
    }
    if (text) output.push({ ...segment, text });
    if (rendered >= width) break;
  }
  return output;
}

function matchColumns(cell: Cell, match: CodeMatch): [number, number] {
  const source = cell.source ?? "";
  const gutter = cell.gutter ? GUTTER : 0;
  const width = (end: number) =>
    expandTabs([{ text: source.slice(0, end), kind: "plain" }]).reduce(
      (total, token) => total + displayWidth(token.text),
      0,
    );
  return [gutter + width(match.start), gutter + width(match.end)];
}

function rowElement(look: Look, segments: Segment[], background: Color | null): Element {
  const row = h_flex()
    .flex_none()
    .h(look.row)
    .w_full()
    .overflow_hidden()
    .whitespace_nowrap()
    .when(!!background, (el) => el.bg(background ?? look.t.background));
  for (const segment of segments)
    row.child(
      div()
        .flex_none()
        .text_color(segment.fg)
        .when(!!segment.bg, (el) => el.bg(segment.bg ?? look.t.background))
        .when(segment.bold, (el) => el.font_weight(700))
        .child(segment.text),
    );
  return row;
}

interface Measure {
  rows: number;
  cols: number;
}

interface PaintOptions {
  focusRow: number;
  selected: (row: number) => boolean;
  match?: CodeMatch;
}

interface ColumnSpec {
  id: string;
  cells: (row: number) => Cell | null;
  length: number;
  maxWidth: number;
  scroll: number;
  horizontal: number;
  measure: Measure;
  paint: PaintOptions;
  hint: { first: number; last: number } | null;
  onSize: (measure: Measure, cx: Context) => void;
  onWheel: (event: ScrollWheelEvent, cx: Context) => void;
  onDown: (row: number | null, event: MouseButtonEvent, cx: Context) => void;
  onMove: (row: number | null, cx: Context) => void;
  onUp: (cx: Context) => void;
  onVertical: (fraction: number, cx: Context) => void;
  onHorizontal: (fraction: number, cx: Context) => void;
}

function rowAt(look: Look, spec: ColumnSpec, y: number | undefined): number | null {
  if (y === undefined) return null;
  const row = spec.scroll + Math.floor(y / look.screenRow);
  return row >= 0 && row < spec.length ? row : null;
}

function selectionHint(look: Look, id: string, spec: ColumnSpec): Element | null {
  const hint = spec.hint;
  if (!hint) return null;
  const visibleFirst = Math.max(hint.first, spec.scroll);
  const visibleLast = Math.min(hint.last, spec.scroll + spec.measure.rows - 1);
  if (visibleFirst > visibleLast) return null;
  const below = visibleLast - spec.scroll + 1;
  const top = below + 2 <= spec.measure.rows ? below : Math.max(0, visibleFirst - spec.scroll - 2);
  const { t } = look;
  const keys = h_flex()
    .id(`${id}-hint`)
    .absolute()
    .top(rows(look, top))
    .left(cols(look, 6))
    .h(look.row + 10)
    .px(8)
    .gap(8)
    .items_center()
    .bg(t.panel)
    .border(1)
    .border_color(t.lineStrong)
    .rounded(2)
    .shadow_md()
    .whitespace_nowrap();
  for (const [key, label] of HINT_KEYS)
    keys.child(
      h_flex()
        .items_center()
        .gap(4)
        .child(kbd(look, key, true))
        .child(div().text_color(t.secondary).child(label)),
    );
  return keys;
}

function scrollTrack(
  look: Look,
  id: string,
  bar: Element,
  vertical: boolean,
  onPosition: (fraction: number, cx: Context) => void,
): Element {
  let dragging = false;
  const position = (event: {
    local_position?: { x: number; y: number };
    bounds?: { width: number; height: number };
  }) => {
    const local = event.local_position;
    const bounds = event.bounds;
    if (!local || !bounds) return null;
    const size = vertical ? bounds.height - look.screenRow : bounds.width - look.screenCell;
    return size <= 0 ? 0 : Math.max(0, Math.min(1, (vertical ? local.y : local.x) / size));
  };
  return div()
    .id(id)
    .flex_none()
    .when(vertical, (el) => el.h_full())
    .when(!vertical, (el) => el.w_full())
    .child(bar)
    .on_mouse_down("left", (event, cx) => {
      cx.stop_propagation();
      dragging = true;
      const fraction = position(event);
      if (fraction !== null) onPosition(fraction, cx);
    })
    .on_mouse_up("left", () => {
      dragging = false;
    })
    .on_mouse_move((event, cx) => {
      if (!dragging) return;
      const fraction = position(event);
      if (fraction !== null) onPosition(fraction, cx);
    })
    .on_hover((hovered) => {
      if (!hovered) dragging = false;
    });
}

function renderColumn(look: Look, spec: ColumnSpec): Element {
  const { measure, paint: options } = spec;
  const width = measure.cols > 0 ? measure.cols : 400;
  const list = v_flex().flex_1().min_w(0).min_h(0).overflow_hidden();
  const end = Math.min(spec.length, spec.scroll + Math.max(1, measure.rows));
  for (let row = spec.scroll; row < end; row++) {
    const cell = spec.cells(row);
    if (!cell) continue;
    const emphasis: Emphasis = options.selected(row) ? "selection" : row === options.focusRow ? "focus" : null;
    let { segments, background } = cellSegments(look, cell, emphasis);
    if (options.match?.row === row) {
      const [from, to] = matchColumns(cell, options.match);
      segments = paint(segments, from, to, look.t.textInverse, look.t.warning);
    }
    list.child(rowElement(look, sliceSegments(segments, spec.horizontal, width), background));
  }
  const area = v_flex()
    .id(`${spec.id}-rows`)
    .relative()
    .flex_1()
    .min_w(0)
    .min_h(0)
    .overflow_hidden()
    .on_size_change((size, cx) =>
      spec.onSize(
        { rows: Math.max(1, Math.floor(size.height / look.screenRow)), cols: Math.floor(size.width / look.screenCell) },
        cx,
      ),
    )
    .on_scroll_wheel((event, cx) => spec.onWheel(event, cx))
    .on_mouse_down("left", (event, cx) => spec.onDown(rowAt(look, spec, event.local_position?.y), event, cx))
    .on_mouse_up("left", (_, cx) => spec.onUp(cx))
    .on_mouse_move((event, cx) => spec.onMove(rowAt(look, spec, event.local_position.y), cx))
    .child(list);
  const hint = selectionHint(look, spec.id, spec);
  if (hint) area.child(hint);
  const vertical = scrollbar(look, {
    axis: "vertical",
    total: spec.length,
    visible: measure.rows,
    offset: spec.scroll,
  });
  const horizontal = scrollbar(look, {
    axis: "horizontal",
    total: spec.maxWidth,
    visible: measure.cols,
    offset: spec.horizontal,
  });
  const top = h_flex()
    .flex_1()
    .min_h(0)
    .min_w(0)
    .items_stretch()
    .child(area)
    .when(!!vertical, (el) => el.child(scrollTrack(look, `${spec.id}-vbar`, vertical ?? div(), true, spec.onVertical)));
  return v_flex()
    .id(spec.id)
    .flex_1()
    .min_h(0)
    .min_w(0)
    .child(top)
    .when(!!horizontal, (el) =>
      el.child(scrollTrack(look, `${spec.id}-hbar`, horizontal ?? div(), false, spec.onHorizontal)),
    );
}

class Wheel {
  private x = 0;
  private y = 0;

  steps(event: ScrollWheelEvent, look: Look): { x: number; y: number } {
    const lines = event.delta_lines;
    const dx = lines ? lines.x * look.cell : event.delta.x;
    const dy = lines ? lines.y * look.row : event.delta.y;
    if (event.modifiers.shift && Math.abs(dx) < Math.abs(dy)) this.x += dy;
    else {
      this.x += dx;
      this.y += dy;
    }
    const x = Math.trunc(this.x / look.cell);
    const y = Math.trunc(this.y / look.row);
    this.x -= x * look.cell;
    this.y -= y * look.row;
    return { x: -x, y: -y };
  }
}

class Selection {
  rows = new Set<number>();
  anchor: number | null = null;
  keyboard = false;
  dragging = false;

  clear(): void {
    this.rows.clear();
    this.anchor = null;
    this.keyboard = false;
    this.dragging = false;
  }

  active(): boolean {
    return this.anchor !== null || this.rows.size > 0;
  }

  effective(cursor: number, selectable: (row: number) => boolean): number[] {
    const result = new Set(this.rows);
    if (this.anchor !== null)
      for (let row = Math.min(this.anchor, cursor); row <= Math.max(this.anchor, cursor); row++)
        if (selectable(row)) result.add(row);
    return [...result].sort((left, right) => left - right);
  }

  finish(cursor: number, selectable: (row: number) => boolean): void {
    this.rows = new Set(this.effective(cursor, selectable));
    this.anchor = null;
    this.keyboard = false;
    this.dragging = false;
  }
}

function moveKey(key: string, page: number): number | "home" | "end" | null {
  const steps: Record<string, number> = { up: -1, k: -1, down: 1, j: 1, pageup: -page, pagedown: page };
  if (key === "home") return "home";
  if (key === "end") return "end";
  return steps[key] ?? null;
}

function clamp(value: number, length: number): number {
  return Math.max(0, Math.min(value, Math.max(0, length - 1)));
}

export interface CodeViewOptions {
  focused: boolean;
  match?: CodeMatch;
  hint?: boolean;
  onCursor?: (row: number, cx: Context) => void;
}

export class CodeView {
  cursor = 0;
  private items: CodeLine[] = [];
  private cells: Cell[] = [];
  private widest = 0;
  private scroll = 0;
  private horizontal = 0;
  private measure: Measure = { rows: 0, cols: 0 };
  private selectionState = new Selection();
  private wheel = new Wheel();

  constructor(private readonly id: string) {}

  set(lines: CodeLine[], _language: string): void {
    const same =
      lines === this.items ||
      (lines.length === this.items.length &&
        lines.every(
          (line, index) => line.text === this.items[index]?.text && line.number === this.items[index]?.number,
        ));
    this.items = lines;
    this.cells = lines.map((line) =>
      line.tone === "fold"
        ? textCell(line.text, "fold")
        : codeCell(line.number, line.number === null ? null : line.text, line.tokens, line.tone),
    );
    this.widest = this.cells.reduce((width, cell) => Math.max(width, cellWidth(cell)), 0);
    if (same) {
      this.cursor = clamp(this.cursor, lines.length);
      return;
    }
    this.cursor = 0;
    this.scroll = 0;
    this.horizontal = 0;
    this.selectionState.clear();
  }

  lines(): CodeLine[] {
    return this.items;
  }

  selection(): { start: number; end: number } | null {
    const rows = this.selectionState.effective(this.cursor, (row) => this.selectable(row));
    const first = rows[0];
    const last = rows[rows.length - 1];
    return first === undefined || last === undefined ? null : { start: first, end: last };
  }

  clearSelection(): void {
    this.selectionState.clear();
  }

  reveal(row: number): void {
    this.cursor = clamp(row, this.cells.length);
    this.follow();
  }

  release(): void {
    this.selectionState.clear();
  }

  private selectable(row: number): boolean {
    return this.cells[row]?.number !== null && this.cells[row] !== undefined;
  }

  private follow(): void {
    const height = Math.max(1, this.measure.rows);
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    else if (this.cursor >= this.scroll + height) this.scroll = this.cursor - height + 1;
  }

  private scrollBy(rows: number): void {
    this.scroll = Math.max(0, Math.min(this.scroll + rows, Math.max(0, this.cells.length - this.measure.rows)));
  }

  private scrollHorizontal(columns: number): void {
    this.horizontal = Math.max(0, Math.min(this.horizontal + columns, Math.max(0, this.widest - this.measure.cols)));
  }

  private toggleKeyboardSelection(): void {
    if (this.selectionState.keyboard) this.selectionState.finish(this.cursor, (row) => this.selectable(row));
    else if (this.selectable(this.cursor)) {
      this.selectionState.clear();
      this.selectionState.anchor = this.cursor;
      this.selectionState.keyboard = true;
    }
  }

  private command(key: string): boolean {
    if (key === "left" || key === "right") this.scrollHorizontal(key === "left" ? -1 : 1);
    else if (key === "v") this.toggleKeyboardSelection();
    else if (key === "escape" && this.selectionState.active()) this.selectionState.clear();
    else {
      const step = moveKey(key, Math.max(1, this.measure.rows));
      if (step === null) return false;
      this.reveal(step === "home" ? 0 : step === "end" ? this.cells.length - 1 : this.cursor + step);
    }
    return true;
  }

  key(event: KeyEvent, cx: Context): boolean {
    if (isChord(event) || !this.command(event.keystroke)) return false;
    cx.stop_propagation();
    cx.notify();
    return true;
  }

  render(look: Look, options: CodeViewOptions): Element {
    this.scroll = Math.min(this.scroll, Math.max(0, this.cells.length - 1));
    const selected = new Set(this.selectionState.effective(this.cursor, (row) => this.selectable(row)));
    const first = Math.min(...selected);
    const last = Math.max(...selected);
    return renderColumn(look, {
      id: this.id,
      cells: (row) => this.cells[row] ?? null,
      length: this.cells.length,
      maxWidth: this.widest,
      scroll: this.scroll,
      horizontal: this.horizontal,
      measure: this.measure,
      paint: {
        focusRow: options.focused ? this.cursor : -1,
        selected: (row) => selected.has(row),
        match: options.match,
      },
      hint: options.hint && selected.size > 0 && !this.selectionState.dragging ? { first, last } : null,
      onSize: (measure, cx) => {
        if (measure.rows === this.measure.rows && measure.cols === this.measure.cols) return;
        this.measure = measure;
        cx.notify();
      },
      onWheel: (event, cx) => {
        const steps = this.wheel.steps(event, look);
        if (steps.x === 0 && steps.y === 0) return;
        cx.stop_propagation();
        this.scrollBy(steps.y);
        this.scrollHorizontal(steps.x);
        cx.notify();
      },
      onDown: (row, _, cx) => {
        if (row === null) return;
        this.cursor = row;
        options.onCursor?.(row, cx);
        if (this.selectionState.keyboard) this.selectionState.finish(this.cursor, (index) => this.selectable(index));
        else if (this.selectable(row)) {
          this.selectionState.clear();
          this.selectionState.anchor = row;
          this.selectionState.dragging = true;
        }
        cx.notify();
      },
      onMove: (row, cx) => {
        if (row === null || !this.selectionState.dragging || row === this.cursor) return;
        this.cursor = row;
        options.onCursor?.(row, cx);
        cx.notify();
      },
      onUp: (cx) => {
        if (!this.selectionState.dragging) return;
        this.selectionState.finish(this.cursor, (row) => this.selectable(row));
        cx.notify();
      },
      onVertical: (fraction, cx) => {
        this.scroll = Math.round(fraction * Math.max(0, this.cells.length - this.measure.rows));
        cx.notify();
      },
      onHorizontal: (fraction, cx) => {
        this.horizontal = Math.round(fraction * Math.max(0, this.widest - this.measure.cols));
        cx.notify();
      },
    });
  }
}

export interface DiffSelection {
  side: ReviewSide;
  lines: number[];
  code: string[];
}

export interface SplitDiffOptions {
  focused: boolean;
  hint?: boolean;
  onPointer?: (side: ReviewSide, row: number, cx: Context) => void;
  onClick?: (side: ReviewSide, row: number, cx: Context) => void;
}

function sideCell(row: DiffRow | undefined, side: ReviewSide): Cell | null {
  if (!row) return null;
  return side === "Before" ? row.before : row.after;
}

export class SplitDiff {
  side: ReviewSide = "After";
  cursor = 0;
  private patch = "";
  private path = "";
  private rows: DiffRow[] = [];
  private toggles = new Set<string>();
  private widths: Record<ReviewSide, number> = { Before: 0, After: 0 };
  private scroll = 0;
  private horizontal = 0;
  private measures: Record<ReviewSide, Measure> = { Before: { rows: 0, cols: 0 }, After: { rows: 0, cols: 0 } };
  private selectionState = new Selection();
  private selectionSide: ReviewSide = "After";
  private wheel = new Wheel();

  constructor(private readonly id: string) {}

  set(patch: string, path: string): void {
    if (patch === this.patch && path === this.path && this.rows.length > 0) return;
    const sameFile = path === this.path && this.rows.length > 0;
    const saved = sameFile ? this.selectedLines() : null;
    this.patch = patch;
    this.path = path;
    if (!sameFile) {
      this.toggles.clear();
      this.scroll = 0;
      this.horizontal = 0;
      this.cursor = 0;
      this.side = "After";
      this.selectionState.clear();
    }
    this.rebuild();
    this.restore(saved);
  }

  plain(text: string): void {
    this.patch = "";
    this.path = "";
    this.toggles.clear();
    this.rows = text.split("\n").map((line) => ({ before: textCell(line), after: textCell(line), fold: null }));
    this.widths = { Before: 0, After: 0 };
    this.scroll = 0;
    this.horizontal = 0;
    this.cursor = 0;
    this.selectionState.clear();
  }

  clear(): void {
    this.plain("");
    this.rows = [];
  }

  detach(): void {
    this.patch = "";
    this.path = "";
  }

  language(): string {
    return this.path ? languageName(this.path) : "Plain text";
  }

  length(): number {
    return this.rows.length;
  }

  release(): void {
    this.selectionState.clear();
  }

  private rebuild(): void {
    this.rows = buildDiff(this.patch, this.path, this.toggles);
    this.widths = {
      Before: this.rows.reduce((width, row) => Math.max(width, cellWidth(row.before)), 0),
      After: this.rows.reduce((width, row) => Math.max(width, cellWidth(row.after)), 0),
    };
    this.cursor = clamp(this.cursor, this.rows.length);
    this.scroll = Math.min(this.scroll, this.maxScroll());
  }

  private viewRows(): number {
    return Math.max(1, Math.min(this.measures.Before.rows || Infinity, this.measures.After.rows || Infinity, 10000));
  }

  private maxScroll(): number {
    return Math.max(0, this.rows.length - this.viewRows());
  }

  private maxHorizontal(): number {
    return Math.max(0, this.widths.Before - this.measures.Before.cols, this.widths.After - this.measures.After.cols);
  }

  lineNumber(side: ReviewSide, row: number): number | null {
    return sideCell(this.rows[row], side)?.number ?? null;
  }

  rowForLine(side: ReviewSide, line: number): number | null {
    const index = this.rows.findIndex((row) => sideCell(row, side)?.number === line);
    return index < 0 ? null : index;
  }

  private selectable(side: ReviewSide, row: number): boolean {
    return sideCell(this.rows[row], side)?.source !== null && this.rows[row] !== undefined;
  }

  selecting(): boolean {
    return this.selectionState.anchor !== null || this.selectionState.keyboard || this.selectionState.dragging;
  }

  hasSelection(): boolean {
    return this.selectionState.active();
  }

  keyboardSelecting(): boolean {
    return this.selectionState.keyboard;
  }

  dragging(): boolean {
    return this.selectionState.dragging;
  }

  private effectiveRows(): number[] {
    if (this.selectionState.anchor !== null && this.selectionSide !== this.side) return [...this.selectionState.rows];
    return this.selectionState.effective(this.cursor, (row) => this.selectable(this.selectionSide, row));
  }

  selection(): DiffSelection | null {
    const lines: number[] = [];
    const code: string[] = [];
    for (const row of this.effectiveRows()) {
      const cell = sideCell(this.rows[row], this.selectionSide);
      if (cell?.number === null || cell?.number === undefined || cell.source === null) continue;
      lines.push(cell.number);
      code.push(cell.source);
    }
    return lines.length ? { side: this.selectionSide, lines, code } : null;
  }

  linesOn(side: ReviewSide): number[] {
    const lines: number[] = [];
    for (const row of this.effectiveRows()) {
      const line = sideCell(this.rows[row], side)?.number;
      if (line !== null && line !== undefined) lines.push(line);
    }
    return lines;
  }

  private selectedLines(): DiffSelection | null {
    return this.selectionState.active() ? this.selection() : null;
  }

  private restore(saved: DiffSelection | null): void {
    this.selectionState.clear();
    if (!saved) return;
    for (const line of saved.lines) {
      const row = this.rowForLine(saved.side, line);
      if (row !== null) this.selectionState.rows.add(row);
    }
    this.selectionSide = saved.side;
  }

  beginSelection(side: ReviewSide, row: number, keyboard: boolean): boolean {
    if (!this.selectable(side, row)) return false;
    this.side = side;
    this.cursor = row;
    this.selectionState.clear();
    this.selectionSide = side;
    this.selectionState.anchor = row;
    this.selectionState.keyboard = keyboard;
    this.selectionState.dragging = !keyboard;
    return true;
  }

  finishSelection(): void {
    this.selectionState.finish(this.cursor, (row) => this.selectable(this.selectionSide, row));
  }

  clearSelection(): void {
    this.selectionState.clear();
  }

  toggleFold(row: number): boolean {
    const key: FoldKey | null = this.rows[row]?.fold ?? null;
    if (!key) return false;
    this.finishSelection();
    const id = foldId(key);
    if (!this.toggles.delete(id)) this.toggles.add(id);
    this.rebuild();
    const index = this.rows.findIndex((entry) => entry.fold && foldId(entry.fold) === id);
    if (index >= 0) this.cursor = index;
    return true;
  }

  revealLine(side: ReviewSide, line: number): boolean {
    let row = this.rowForLine(side, line);
    if (row === null) {
      const fold = this.rows.find((entry) => {
        if (!entry.fold) return false;
        const [start, end] =
          side === "Before" ? [entry.fold.oldStart, entry.fold.oldEnd] : [entry.fold.newStart, entry.fold.newEnd];
        return line >= start && line < end;
      })?.fold;
      if (!fold) return false;
      const id = foldId(fold);
      if (fold.kind === "context") this.toggles.add(id);
      else this.toggles.delete(id);
      this.rebuild();
      row = this.rowForLine(side, line);
      if (row === null) return false;
    }
    this.side = side;
    this.focusRow(row);
    return true;
  }

  focusFirstChange(): void {
    this.side = "After";
    this.scroll = 0;
    this.horizontal = 0;
    this.selectionState.clear();
    const changed = this.rows.findIndex((row) => row.after.source !== null && row.before.source !== row.after.source);
    this.cursor =
      changed >= 0
        ? changed
        : Math.max(
            0,
            this.rows.findIndex((row) => row.after.source !== null),
          );
    this.follow();
  }

  focusRow(row: number): void {
    this.cursor = clamp(row, this.rows.length);
    this.follow();
  }

  private follow(): void {
    const height = this.viewRows();
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    else if (this.cursor >= this.scroll + height) this.scroll = this.cursor - height + 1;
  }

  scrollBy(rows: number): void {
    this.scroll = Math.max(0, Math.min(this.scroll + rows, this.maxScroll()));
  }

  page(): number {
    return this.viewRows();
  }

  private scrollHorizontal(columns: number): void {
    this.horizontal = Math.max(0, Math.min(this.horizontal + columns, this.maxHorizontal()));
  }

  private command(key: string): boolean {
    const actions: Record<string, () => void> = {
      pagedown: () => this.scrollBy(this.page()),
      pageup: () => this.scrollBy(-this.page()),
      enter: () => this.toggleFold(this.cursor),
      space: () => this.toggleFold(this.cursor),
      right: () => this.scrollHorizontal(1),
      left: () => this.scrollHorizontal(-1),
      home: () => this.focusRow(0),
      end: () => this.focusRow(this.rows.length - 1),
      down: () => this.focusRow(this.cursor + 1),
      j: () => this.focusRow(this.cursor + 1),
      up: () => this.focusRow(this.cursor - 1),
      k: () => this.focusRow(this.cursor - 1),
    };
    if (key === "v" && !this.selectionState.keyboard) this.beginSelection(this.side, this.cursor, true);
    else if (key === "escape" && this.selectionState.active()) this.selectionState.clear();
    else {
      const action = actions[key];
      if (!action) return false;
      action();
    }
    return true;
  }

  key(event: KeyEvent, cx: Context): boolean {
    if (isChord(event) || !this.command(event.keystroke)) return false;
    cx.stop_propagation();
    cx.notify();
    return true;
  }

  private onDown(side: ReviewSide, row: number | null, options: SplitDiffOptions, cx: Context): void {
    if (row === null) return;
    this.side = side;
    this.cursor = row;
    if (options.onClick) options.onClick(side, row, cx);
    else if (!this.toggleFold(row)) {
      if (this.selectionState.keyboard) this.finishSelection();
      else this.beginSelection(side, row, false);
    }
    cx.notify();
  }

  private onMove(side: ReviewSide, row: number | null, options: SplitDiffOptions, cx: Context): void {
    if (row === null) return;
    if (this.selectionState.dragging) {
      if (side !== this.selectionSide || row === this.cursor) return;
      this.cursor = row;
      cx.notify();
      return;
    }
    if (side === this.side && row === this.cursor) return;
    this.side = side;
    this.cursor = row;
    options.onPointer?.(side, row, cx);
    cx.notify();
  }

  pointerUp(cx: Context): void {
    if (!this.selectionState.dragging) return;
    this.finishSelection();
    cx.notify();
  }

  private column(look: Look, side: ReviewSide, options: SplitDiffOptions): Element {
    const selected = new Set(this.selectionSide === side ? this.effectiveRows() : []);
    const showHint =
      !!options.hint && selected.size > 0 && !this.selectionState.dragging && this.selectionSide === side;
    return renderColumn(look, {
      id: `${this.id}-${side.toLowerCase()}`,
      cells: (row) => sideCell(this.rows[row], side),
      length: this.rows.length,
      maxWidth: this.widths[side],
      scroll: this.scroll,
      horizontal: this.horizontal,
      measure: this.measures[side],
      paint: {
        focusRow: options.focused && this.side === side ? this.cursor : -1,
        selected: (row) => selected.has(row),
      },
      hint: showHint ? { first: Math.min(...selected), last: Math.max(...selected) } : null,
      onSize: (measure, cx) => {
        const current = this.measures[side];
        if (measure.rows === current.rows && measure.cols === current.cols) return;
        this.measures[side] = measure;
        cx.notify();
      },
      onWheel: (event, cx) => {
        const steps = this.wheel.steps(event, look);
        if (steps.x === 0 && steps.y === 0) return;
        cx.stop_propagation();
        this.scrollBy(steps.y);
        this.scrollHorizontal(steps.x);
        cx.notify();
      },
      onDown: (row, _, cx) => this.onDown(side, row, options, cx),
      onMove: (row, cx) => this.onMove(side, row, options, cx),
      onUp: (cx) => this.pointerUp(cx),
      onVertical: (fraction, cx) => {
        this.scroll = Math.round(fraction * this.maxScroll());
        cx.notify();
      },
      onHorizontal: (fraction, cx) => {
        this.horizontal = Math.round(fraction * this.maxHorizontal());
        cx.notify();
      },
    });
  }

  render(look: Look, options: SplitDiffOptions): { before: Element; after: Element } {
    this.scroll = Math.min(this.scroll, this.maxScroll());
    this.horizontal = Math.min(this.horizontal, this.maxHorizontal());
    return { before: this.column(look, "Before", options), after: this.column(look, "After", options) };
  }
}
