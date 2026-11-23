import { Button, h_flex, Input, type InputState, v_flex } from "gpui-base";
import { type Context, div, type Element, type KeyEvent, type ScrollWheelEvent } from "gpui-kit";
import { type Color, cols, GLYPH, type Look, rows, SPINNER } from "./theme.ts";

const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

function charWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code === 0 || (code >= 0x300 && code <= 0x36f) || code === 0x200d) return 0;
  return WIDE_RANGES.some(([start, end]) => code >= start && code <= end) ? 2 : 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) width += charWidth(character);
  return width;
}

export function truncateToWidth(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  if (width <= 0) return "";
  let used = 1;
  let result = "";
  for (const character of text) {
    const next = charWidth(character);
    if (used + next > width) break;
    used += next;
    result += character;
  }
  return `${result}…`;
}

export function padToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
}

export function countedTitle(label: string, count: number): string {
  return count === 0 ? label : `${label}${GLYPH.separator}${count}`;
}

export function isChord(event: KeyEvent): boolean {
  return event.modifiers.alt || event.modifiers.control || event.modifiers.platform;
}

export function spinner(look: Look): Element {
  return div()
    .flex_none()
    .text_color(look.t.accent)
    .frames([...SPINNER.frames], SPINNER.ms);
}

export interface BoxOptions {
  id: string;
  title?: string | Element;
  focused?: boolean;
  surface?: Color;
}

export function box(look: Look, options: BoxOptions, body: Element): Element {
  const { t } = look;
  const half = look.row / 2;
  const edge = look.cell / 2;
  const surface = options.surface ?? t.background;
  const frame = v_flex()
    .flex_1()
    .min_h(0)
    .min_w(0)
    .border(1)
    .border_color(options.focused ? t.accent : t.rule)
    .pt(half - 1)
    .pb(half - 1)
    .px(edge - 1)
    .child(body);
  const outer = v_flex()
    .id(options.id)
    .relative()
    .min_h(0)
    .min_w(0)
    .pt(half)
    .pb(half)
    .px(edge)
    .bg(surface)
    .child(frame);
  if (options.title === undefined) return outer;
  return outer.child(
    h_flex()
      .absolute()
      .top(0)
      .left(look.cell)
      .h(look.row)
      .items_center()
      .bg(surface)
      .text_color(t.text)
      .whitespace_nowrap()
      .child(options.title),
  );
}

export interface ActionCell {
  id: string;
  label: string;
  shortcut: string;
  icon: string;
  enabled: boolean;
  selected?: boolean;
  running?: string | null;
  onClick: (cx: Context) => void;
}

const ACTION_SLOTS = 6;

function actionContent(look: Look, cell: ActionCell, hints: boolean, color: Color): Element[] {
  const gap = "  ";
  if (cell.running) return [spinner(look), div().text_color(color).child(`${gap}${cell.running}`)];
  if (hints)
    return [
      div()
        .text_color(cell.enabled ? look.t.accent : color)
        .font_weight(700)
        .child(cell.shortcut.toUpperCase()),
      div().text_color(color).child(`${gap}${cell.label}`),
    ];
  return [
    div()
      .text_color(color)
      .truncate()
      .child(cell.icon ? `${cell.icon}${gap}${cell.label}` : cell.label),
  ];
}

function actionButton(look: Look, cell: ActionCell, hints: boolean): Element {
  const { t } = look;
  const color = cell.selected ? t.accent : cell.enabled ? t.text : t.muted;
  return Button.new(cell.id)
    .accessibility_label(cell.label)
    .flex_1()
    .min_w(0)
    .h(look.row)
    .bg(t.panel)
    .disabled(!cell.enabled)
    .when(!!cell.selected, (el) => el.font_weight(700))
    .when(cell.enabled, (el) => el.hover((style) => style.bg(t.hover)))
    .child(
      h_flex()
        .size_full()
        .min_w(0)
        .justify_center()
        .items_center()
        .overflow_hidden()
        .whitespace_nowrap()
        .children(actionContent(look, cell, hints, color)),
    )
    .on_click((_, cx) => {
      cx.stop_propagation();
      if (!cell.enabled) return;
      cell.onClick(cx);
      cx.notify();
    });
}

export function actionBar(look: Look, cells: ActionCell[], hints: boolean): Element {
  const bar = h_flex().w_full().h(look.row).flex_none().gap(look.cell);
  for (const cell of cells.slice(0, ACTION_SLOTS)) bar.child(actionButton(look, cell, hints));
  for (let slot = cells.length; slot < ACTION_SLOTS; slot++) bar.child(div().flex_1().min_w(0));
  return bar;
}

export interface TabLabelOptions {
  id: string;
  label: string;
  shortcut: string;
  active: boolean;
  onClick: (cx: Context) => void;
}

export function tabLabel(look: Look, options: TabLabelOptions, hints: boolean): Element {
  const { t } = look;
  const color = options.active ? t.textInverse : t.hint;
  const label = Button.new(options.id)
    .accessibility_label(options.label)
    .flex_none()
    .h(look.row)
    .items_center()
    .text_color(color)
    .when(options.active, (el) => el.bg(t.accent).font_weight(700))
    .hover((style) => style.bg(options.active ? t.accent : t.hover))
    .on_click((_, cx) => {
      cx.stop_propagation();
      options.onClick(cx);
      cx.notify();
    });
  if (!hints) return label.child(` ${options.label} `);
  return label.child(
    h_flex()
      .child(
        div()
          .font_weight(700)
          .when(options.active, (el) => el.underline())
          .when(!options.active, (el) => el.text_color(t.accent))
          .child(options.shortcut),
      )
      .child(` ${options.label}`),
  );
}

export function textInput(look: Look, input: InputState, color?: Color): Element {
  return Input.new(input)
    .flex_1()
    .min_w(0)
    .h(look.row)
    .text_color(color ?? look.t.text);
}

export interface FilterBarOptions {
  id: string;
  input: InputState;
  active: boolean;
  title?: string;
}

export function filterBar(look: Look, options: FilterBarOptions): Element {
  const color = options.active ? look.t.warning : look.t.text;
  return box(
    look,
    { id: options.id, title: options.title ?? "Filter" },
    h_flex()
      .h(look.row)
      .items_center()
      .text_color(color)
      .child(div().flex_none().child("/ "))
      .child(textInput(look, options.input, color)),
  ).flex_none();
}

export interface DialogFrameOptions {
  id: string;
  title: string | Element;
  width: number;
}

export function dialogFrame(look: Look, options: DialogFrameOptions, body: Element): Element {
  return box(look, { id: options.id, title: options.title }, body)
    .w(cols(look, options.width))
    .max_w("100%")
    .max_h("100%")
    .on_mouse_down("left", (_, cx) => cx.stop_propagation());
}

export interface FooterButton {
  id: string;
  label: string;
  focused?: boolean;
  enabled?: boolean;
  onClick: (cx: Context) => void;
}

function footerButton(look: Look, button: FooterButton): Element {
  const { t } = look;
  const enabled = button.enabled ?? true;
  return Button.new(button.id)
    .accessibility_label(button.label)
    .flex_1()
    .min_w(0)
    .h(rows(look, 3))
    .disabled(!enabled)
    .child(
      h_flex()
        .size_full()
        .justify_center()
        .items_center()
        .border(1)
        .border_color(t.rule)
        .text_color(enabled ? t.text : t.muted)
        .when(!!button.focused, (el) => el.bg(t.focus).font_weight(700))
        .when(enabled, (el) => el.hover((style) => style.bg(t.hover)))
        .child(button.label),
    )
    .on_click((_, cx) => {
      cx.stop_propagation();
      if (!enabled) return;
      button.onClick(cx);
      cx.notify();
    });
}

export function dialogFooter(look: Look, primary: FooterButton, secondary: FooterButton): Element {
  return h_flex()
    .flex_none()
    .w_full()
    .py(look.row / 2 - 1)
    .gap(look.cell)
    .child(footerButton(look, primary))
    .child(footerButton(look, secondary));
}

export function footerHint(look: Look, text: string): Element {
  return div().flex_none().h(look.row).text_color(look.t.hint).truncate().child(text);
}

export interface ScrollbarOptions {
  axis: "vertical" | "horizontal";
  total: number;
  visible: number;
  offset: number;
}

export function scrollbar(look: Look, options: ScrollbarOptions): Element | null {
  if (options.total <= options.visible || options.total <= 0) return null;
  const { t } = look;
  const size = Math.max(4, (options.visible / options.total) * 100);
  const start = Math.min(100 - size, (options.offset / options.total) * 100);
  if (options.axis === "vertical")
    return div()
      .relative()
      .flex_none()
      .w(look.cell)
      .h_full()
      .child(
        div()
          .absolute()
          .top(0)
          .bottom(0)
          .left(look.cell / 2 - 1)
          .w(2)
          .bg(t.muted),
      )
      .child(div().absolute().top(`${start}%`).h(`${size}%`).left(0).right(0).bg(t.accent));
  return div()
    .relative()
    .flex_none()
    .h(look.row)
    .w_full()
    .child(
      div()
        .absolute()
        .left(0)
        .right(0)
        .top(look.row / 2)
        .h(1)
        .bg(t.muted),
    )
    .child(
      div()
        .absolute()
        .left(`${start}%`)
        .w(`${size}%`)
        .top(look.row / 2)
        .bottom(0)
        .bg(t.accent),
    );
}

export function viewportOffset(offset: number, selected: number, length: number, height: number): number {
  const clamped = Math.max(0, Math.min(offset, length - 1));
  if (length === 0 || height === 0) return clamped;
  const target = Math.max(0, Math.min(selected, length - 1));
  if (target < clamped) return target;
  if (target >= clamped + height) return target + 1 - height;
  return clamped;
}

export type ListOutcome = "moved" | "activate" | "cancel" | null;

interface RowState {
  index: number;
  selected: boolean;
  focused: boolean;
}

export interface ListOptions {
  length: number;
  focused: boolean;
  marker?: boolean;
  row: (state: RowState) => Element;
  onActivate?: (index: number, cx: Context) => void;
  onSelect?: (index: number, cx: Context) => void;
}

export class ListViewport {
  selected = 0;
  scroll = 0;
  private height = 0;
  private wheel = 0;

  constructor(readonly id: string) {}

  pageRows(): number {
    return Math.max(1, this.height);
  }

  reset(): void {
    this.selected = 0;
    this.scroll = 0;
  }

  clamp(length: number): void {
    const last = Math.max(0, length - 1);
    this.selected = Math.min(this.selected, last);
    this.scroll = Math.min(this.scroll, last);
  }

  moveBy(delta: number, length: number): boolean {
    const before = this.selected;
    this.selected = length === 0 ? 0 : Math.max(0, Math.min(length - 1, this.selected + delta));
    return before !== this.selected;
  }

  key(event: KeyEvent, length: number, vim = true): ListOutcome {
    if (event.modifiers.alt || event.modifiers.control || event.modifiers.platform) return null;
    const steps: Record<string, number> = {
      up: -1,
      down: 1,
      pageup: -this.pageRows(),
      pagedown: this.pageRows(),
      home: -length,
      end: length,
    };
    if (vim) Object.assign(steps, { k: -1, j: 1 });
    if (event.keystroke === "enter") return "activate";
    if (event.keystroke === "escape") return "cancel";
    const step = steps[event.keystroke];
    if (step === undefined) return null;
    this.moveBy(step, length);
    return "moved";
  }

  private scrollWheel(event: ScrollWheelEvent, look: Look, options: ListOptions, cx: Context): void {
    this.wheel += event.delta_lines ? event.delta_lines.y * look.row : event.delta.y;
    const steps = Math.trunc(this.wheel / look.row);
    if (steps === 0) return;
    this.wheel -= steps * look.row;
    cx.stop_propagation();
    if (this.moveBy(-steps, options.length)) {
      options.onSelect?.(this.selected, cx);
      cx.notify();
    }
  }

  render(look: Look, options: ListOptions): Element {
    const { t } = look;
    this.clamp(options.length);
    this.scroll = viewportOffset(this.scroll, this.selected, options.length, this.height);
    const end = Math.min(options.length, this.scroll + Math.max(1, this.height));
    const list = v_flex().flex_1().min_w(0).min_h(0).overflow_hidden();
    for (let index = this.scroll; index < end; index++) {
      const selected = index === this.selected;
      const row = h_flex()
        .id(`${this.id}-row-${index}`)
        .flex_none()
        .h(look.row)
        .min_w(0)
        .items_center()
        .whitespace_nowrap()
        .overflow_hidden()
        .when(selected && options.focused, (el) => el.bg(t.focus).font_weight(700))
        .hover((style) => style.bg(t.hover))
        .on_click((_, cx) => {
          cx.stop_propagation();
          this.selected = index;
          options.onSelect?.(index, cx);
          options.onActivate?.(index, cx);
          cx.notify();
        });
      if (options.marker ?? true)
        row.child(
          div()
            .flex_none()
            .w(cols(look, 2))
            .child(selected ? GLYPH.marker : ""),
        );
      list.child(row.child(options.row({ index, selected, focused: options.focused })));
    }
    const bar = scrollbar(look, {
      axis: "vertical",
      total: options.length,
      visible: this.height,
      offset: this.scroll,
    });
    return h_flex()
      .id(this.id)
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
      .on_scroll_wheel((event, cx) => this.scrollWheel(event, look, options, cx))
      .child(list)
      .when(!!bar, (el) => el.child(bar ?? div()));
  }
}
