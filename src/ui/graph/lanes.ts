import { h_flex, v_flex } from "gpui-base";
import { div, type Element, PathBuilder } from "gpui-kit";
import { type Color, cols, type Look, lane } from "../theme.ts";
import { type LayoutRow, laneCell, ROW_HEIGHT } from "./layout.ts";

export interface LaneViewport {
  width: number;
  scroll: number;
  total: number;
  first: boolean;
  selected: boolean;
  background: Color;
}

const UP = 1;
const DOWN = 2;
const LEFT = 4;
const RIGHT = 8;

interface Cell {
  joins: number;
  color: number;
  node: string | null;
}

const JOIN_SYMBOLS: Record<number, string> = {
  [UP | DOWN | LEFT | RIGHT]: "┼",
  [UP | DOWN | RIGHT]: "├",
  [UP | DOWN | LEFT]: "┤",
  [LEFT | RIGHT | DOWN]: "┬",
  [LEFT | RIGHT | UP]: "┴",
  [DOWN | RIGHT]: "╭",
  [DOWN | LEFT]: "╮",
  [UP | RIGHT]: "╰",
  [UP | LEFT]: "╯",
};

function symbol(cell: Cell): string {
  if (cell.node) return cell.node;
  if (cell.joins === 0) return " ";
  const exact = JOIN_SYMBOLS[cell.joins];
  if (exact) return exact;
  return cell.joins & (LEFT | RIGHT) && !(cell.joins & (UP | DOWN)) ? "─" : "│";
}

function join(cells: Cell[], index: number, joins: number, color: number): void {
  const cell = cells[index];
  if (!cell) return;
  if ((cell.joins & (UP | DOWN)) === 0 || (joins & (UP | DOWN)) !== 0) cell.color = color;
  cell.joins |= joins;
}

function blank(width: number): Cell[] {
  return Array.from({ length: width }, () => ({ joins: 0, color: 0, node: null }));
}

function glyphCells(row: LayoutRow, width: number): [Cell[], Cell[]] {
  const nodeLine = blank(width);
  const linkLine = blank(width);
  row.above.forEach((color, column) => {
    if (color !== null && column !== row.column) join(nodeLine, laneCell(column), UP | DOWN, color);
  });
  const node = nodeLine[laneCell(row.column)];
  if (node) {
    node.node = row.uncommitted ? "○" : "●";
    node.color = row.color;
  }
  for (const edge of row.edges) {
    const from = laneCell(edge.from);
    const to = laneCell(edge.to);
    if (from === to) {
      join(linkLine, from, UP | DOWN, edge.color);
      continue;
    }
    const [start, end] = from < to ? [RIGHT, LEFT] : [LEFT, RIGHT];
    join(linkLine, from, UP | start, edge.color);
    for (let cell = Math.min(from, to) + 1; cell < Math.max(from, to); cell++)
      join(linkLine, cell, LEFT | RIGHT, edge.color);
    join(linkLine, to, DOWN | end, edge.color);
  }
  return [nodeLine, linkLine];
}

function glyphLine(look: Look, cells: Cell[], view: LaneViewport, marks: [string, string]): Element {
  const line = h_flex().h(look.row).flex_none().overflow_hidden();
  const visible = cells.slice(view.scroll, view.scroll + view.width);
  visible.forEach((cell, index) => {
    const mark = index === 0 ? marks[0] : index === visible.length - 1 ? marks[1] : "";
    line.child(
      div()
        .flex_none()
        .w(look.cell)
        .text_color(mark ? look.t.hint : lane(look.t, cell.color))
        .child(mark || symbol(cell)),
    );
  });
  return line;
}

function clipMarks(view: LaneViewport): [string, string] {
  if (!view.first) return ["", ""];
  return [view.scroll > 0 ? "‹" : "", view.total > view.scroll + view.width ? "›" : ""];
}

export function glyphLanes(look: Look, row: LayoutRow, view: LaneViewport): Element {
  const [nodeLine, linkLine] = glyphCells(row, view.total);
  return v_flex()
    .flex_none()
    .w(cols(look, view.width))
    .overflow_hidden()
    .child(glyphLine(look, nodeLine, view, clipMarks(view)))
    .child(glyphLine(look, linkLine, view, ["", ""]));
}

function strokes(look: Look, row: LayoutRow, x: (column: number) => number): Element[] {
  const top = 0;
  const center = 0.5 * look.row;
  const bottom = ROW_HEIGHT * look.row;
  const width = Math.max(look.cell * 0.18, 1.4);
  const paths = new Map<number, PathBuilder>();
  const path = (color: number) => {
    const existing = paths.get(color);
    if (existing) return existing;
    const created = PathBuilder.stroke(width);
    paths.set(color, created);
    return created;
  };
  row.above.forEach((color, column) => {
    if (color !== null) path(color).move_to(x(column), top).line_to(x(column), center);
  });
  for (const edge of row.edges) {
    const builder = path(edge.color).move_to(x(edge.from), center);
    if (edge.from === edge.to) builder.line_to(x(edge.to), bottom);
    else builder.cubic_bezier_to(x(edge.to), bottom, x(edge.from), 1.5 * look.row, x(edge.to), look.row);
  }
  return [...paths].map(([color, builder]) =>
    div()
      .absolute()
      .inset_0()
      .child(window.paint_path(builder.build(), lane(look.t, color)).size_full()),
  );
}

function dot(x: number, y: number, radius: number, color: Color): Element {
  return div()
    .absolute()
    .left(x - radius)
    .top(y - radius)
    .w(radius * 2)
    .h(radius * 2)
    .rounded_full()
    .bg(color);
}

export function curveLanes(look: Look, row: LayoutRow, view: LaneViewport): Element {
  const x = (column: number) => (laneCell(column) + 0.5 - view.scroll) * look.cell;
  const radius = Math.max(look.cell * 0.5, 3.5);
  const stroke = Math.max(look.cell * 0.18, 1.4);
  const color = lane(look.t, row.color);
  const center = 0.5 * look.row;
  const node = x(row.column);
  const element = div()
    .relative()
    .flex_none()
    .w(cols(look, view.width))
    .h(ROW_HEIGHT * look.row)
    .overflow_hidden()
    .children(strokes(look, row, x));
  if (view.selected) element.child(dot(node, center, radius * 1.6, `${color.slice(0, 7)}46` as Color));
  element.child(dot(node, center, radius, color));
  if (row.uncommitted) element.child(dot(node, center, Math.max(0, radius - stroke), view.background));
  const [left, right] = clipMarks(view);
  if (left) element.child(div().absolute().top(0).left(0).text_color(look.t.hint).child(left));
  if (right)
    element.child(
      div()
        .absolute()
        .top(0)
        .left(cols(look, view.width - 1))
        .text_color(look.t.hint)
        .child(right),
    );
  return element;
}
