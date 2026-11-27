import { Button, h_flex, Input, type InputState, v_flex } from "gpui-base";
import { type Context, div, type Element, type KeyEvent, type ScrollWheelEvent } from "gpui-kit";
import { ICON_CELLS, type IconName, iconCell } from "./icons.ts";
import { type Color, cols, GLYPH, type Look, SPINNER } from "./theme.ts";

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

export interface CellSpan {
  text: string;
  icon?: IconName;
  color?: Color;
  bg?: Color;
  border?: Color;
  bold?: boolean;
}

export function spansWidth(spans: readonly CellSpan[]): number {
  return spans.reduce((total, span) => total + displayWidth(span.text) + (span.icon ? ICON_CELLS : 0), 0);
}

export function spanElements(look: Look, spans: readonly CellSpan[]): Element[] {
  return spans.map(({ text, icon, color, bg, border, bold }) => {
    const span = h_flex()
      .flex_none()
      .items_center()
      .when(!!color, (el) => el.text_color(color ?? look.t.text))
      .when(!!bg, (el) => el.bg(bg ?? look.t.panel))
      .when(!!border, (el) =>
        el
          .border(1)
          .border_color(border ?? look.t.rule)
          .rounded(2),
      )
      .when(!!bold, (el) => el.font_weight(700));
    if (icon) span.child(iconCell(look, icon, color));
    return span.child(text);
  });
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

export function kbd(look: Look, key: string, active = false): Element {
  const { t } = look;
  return h_flex()
    .flex_none()
    .items_center()
    .justify_center()
    .px(4)
    .h(Math.max(16, look.row - 2))
    .bg(t.hover)
    .border(1)
    .border_b(2)
    .border_color(active ? t.accent : t.lineStrong)
    .rounded(2)
    .text_size(Math.max(10, look.size - 3))
    .font_weight(600)
    .text_color(active ? t.accentText : t.secondary)
    .child(key);
}

export function sectionLabel(look: Look, text: string, options?: { muted?: boolean; rule?: boolean }): Element {
  const { t } = look;
  const muted = options?.muted ?? false;
  return h_flex()
    .flex_1()
    .min_w(0)
    .items_center()
    .gap(8)
    .whitespace_nowrap()
    .child(
      div()
        .flex_none()
        .w(6)
        .h(6)
        .rounded_full()
        .bg(muted ? t.lineStrong : t.accent),
    )
    .child(
      div()
        .flex_none()
        .text_size(Math.max(10, look.size - 2))
        .font_weight(600)
        .text_color(muted ? t.hint : t.secondary)
        .child(text.toUpperCase()),
    )
    .when(!!options?.rule, (el) => el.child(div().flex_1().h(1).bg(t.rule)));
}

export interface BoxOptions {
  id: string;
  title?: string | Element;
  focused?: boolean;
  surface?: Color;
}

export function box(look: Look, options: BoxOptions, body: Element): Element {
  const { t } = look;
  const focused = options.focused ?? false;
  const surface = options.surface ?? (focused ? t.panelFocus : t.panel);
  const outer = v_flex()
    .id(options.id)
    .relative()
    .min_h(0)
    .min_w(0)
    .bg(surface)
    .border(1)
    .border_color(focused ? t.accentEdge : t.rule);
  if (options.title !== undefined) {
    const titleContent =
      typeof options.title === "string"
        ? div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(Math.max(10, look.size - 2))
            .font_weight(600)
            .text_color(t.text)
            .child(options.title.toUpperCase())
        : h_flex()
            .flex_1()
            .min_w(0)
            .items_center()
            .overflow_hidden()
            .whitespace_nowrap()
            .text_color(t.text)
            .child(options.title);
    outer.child(
      h_flex()
        .flex_none()
        .h(look.row + 6)
        .px(8)
        .gap(8)
        .items_center()
        .border_b(1)
        .border_color(t.rule)
        .child(div().flex_none().w(6).h(6).rounded_full().bg(t.accent))
        .child(titleContent),
    );
  }
  outer.child(v_flex().flex_1().min_h(0).min_w(0).px(4).py(2).child(body));
  if (focused) outer.child(div().absolute().bottom(0).left(0).right(0).h(2).bg(t.accent));
  return outer;
}

export type ActionVariant = "primary" | "secondary" | "danger";

export interface ActionCell {
  id: string;
  label: string;
  shortcut: string;
  icon?: IconName;
  symbol?: string;
  variant?: ActionVariant;
  enabled: boolean;
  selected?: boolean;
  running?: string | null;
  onClick: (cx: Context) => void;
}

const ACTION_SLOTS = 6;

function actionContent(look: Look, cell: ActionCell, hints: boolean, color: Color): Element[] {
  if (cell.running) return [spinner(look), div().text_color(color).ml(6).truncate().child(cell.running)];
  if (hints)
    return [
      kbd(look, cell.shortcut.toUpperCase(), cell.enabled),
      div().text_color(color).ml(6).truncate().child(cell.label),
    ];
  const symbol = cell.symbol ? `${cell.symbol} ` : "";
  const label = div()
    .text_color(color)
    .truncate()
    .child(symbol + cell.label);
  return cell.icon ? [iconCell(look, cell.icon, color), div().w(2), label] : [label];
}

function actionColors(
  look: Look,
  cell: ActionCell,
): { bg: Color; border: Color; text: Color; hoverBg: Color; hoverBorder: Color } {
  const { t } = look;
  if (cell.selected)
    return {
      bg: t.accentSoft,
      border: t.accentEdge,
      text: t.accentText,
      hoverBg: t.accentSoft,
      hoverBorder: t.accent,
    };
  if (cell.variant === "primary" && cell.enabled)
    return {
      bg: t.accent,
      border: t.accent,
      text: t.textInverse,
      hoverBg: t.accentStrong,
      hoverBorder: t.accentStrong,
    };
  if (cell.variant === "danger" && cell.enabled)
    return {
      bg: t.panel,
      border: t.error,
      text: t.error,
      hoverBg: t.diffRemoved,
      hoverBorder: t.error,
    };
  return {
    bg: t.panel,
    border: cell.enabled ? t.lineStrong : t.rule,
    text: cell.enabled ? t.text : t.muted,
    hoverBg: t.accentSoft,
    hoverBorder: t.accent,
  };
}

function actionButton(look: Look, cell: ActionCell, hints: boolean): Element {
  const { t } = look;
  const style = actionColors(look, cell);
  return Button.new(cell.id)
    .accessibility_label(cell.label)
    .relative()
    .flex_1()
    .min_w(0)
    .h(look.row + 6)
    .bg(style.bg)
    .border(1)
    .border_color(style.border)
    .rounded(2)
    .disabled(!cell.enabled)
    .when(!cell.enabled, (el) => el.opacity(0.42))
    .when(!!cell.selected || cell.variant === "primary", (el) => el.font_weight(600))
    .when(cell.enabled, (el) => el.hover((hovered) => hovered.bg(style.hoverBg).border_color(style.hoverBorder)))
    .child(
      h_flex()
        .size_full()
        .min_w(0)
        .px(6)
        .justify_center()
        .items_center()
        .overflow_hidden()
        .whitespace_nowrap()
        .children(actionContent(look, cell, hints, style.text)),
    )
    .when(!!cell.selected, (el) => el.child(div().absolute().bottom(0).left(0).right(0).h(2).bg(t.accent)))
    .on_click((_, cx) => {
      cx.stop_propagation();
      if (!cell.enabled) return;
      cell.onClick(cx);
      cx.notify();
    });
}

export function actionBar(look: Look, cells: ActionCell[], hints: boolean): Element {
  const bar = h_flex()
    .w_full()
    .h(look.row + 6)
    .flex_none()
    .gap(6);
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
  const label = Button.new(options.id)
    .accessibility_label(options.label)
    .relative()
    .flex_none()
    .h(look.row + 10)
    .px(10)
    .items_center()
    .text_size(Math.max(11, look.size - 1))
    .text_color(options.active ? t.accentText : t.secondary)
    .when(options.active, (el) => el.bg(t.accentSoft).font_weight(600))
    .hover((style) => style.bg(t.accentSoft).text_color(options.active ? t.accentText : t.text))
    .when(options.active, (el) => el.child(div().absolute().bottom(0).left(0).right(0).h(2).bg(t.accent)))
    .on_click((_, cx) => {
      cx.stop_propagation();
      options.onClick(cx);
      cx.notify();
    });
  const text = options.label.toUpperCase();
  if (!hints) return label.child(text);
  return label.child(
    h_flex()
      .items_center()
      .gap(6)
      .child(kbd(look, options.shortcut.toUpperCase(), options.active))
      .child(text),
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
  const { t } = look;
  const promptColor = options.active ? t.accentText : t.hint;
  return h_flex()
    .id(options.id)
    .relative()
    .flex_none()
    .h(look.row + 8)
    .px(8)
    .gap(6)
    .items_center()
    .bg(t.panel)
    .border(1)
    .border_color(options.active ? t.accent : t.lineStrong)
    .rounded(2)
    .child(div().flex_none().text_color(promptColor).font_weight(600).child("/"))
    .child(textInput(look, options.input, t.text))
    .when(options.active, (el) => el.child(div().absolute().bottom(0).left(0).right(0).h(2).bg(t.accent)));
}

export interface DialogFrameOptions {
  id: string;
  title: string | Element;
  width: number;
}

export function dialogFrame(look: Look, options: DialogFrameOptions, body: Element): Element {
  return box(
    look,
    { id: options.id, title: options.title, surface: look.t.panel },
    v_flex().min_w(0).min_h(0).flex_1().p(8).gap(6).child(body),
  )
    .shadow_lg()
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

function footerButton(look: Look, button: FooterButton, primary: boolean): Element {
  const { t } = look;
  const enabled = button.enabled ?? true;
  const filled = primary && enabled;
  return Button.new(button.id)
    .accessibility_label(button.label)
    .flex_1()
    .min_w(0)
    .h(look.row + 10)
    .disabled(!enabled)
    .when(!enabled, (el) => el.opacity(0.42))
    .child(
      h_flex()
        .size_full()
        .justify_center()
        .items_center()
        .border(1)
        .rounded(2)
        .when(filled, (el) =>
          el
            .bg(t.accent)
            .border_color(t.accent)
            .text_color(t.textInverse)
            .font_weight(600)
            .hover((style) => style.bg(t.accentStrong).border_color(t.accentStrong)),
        )
        .when(!filled, (el) =>
          el
            .bg(button.focused ? t.accentSoft : t.panel)
            .border_color(button.focused ? t.accent : enabled ? t.lineStrong : t.rule)
            .text_color(enabled ? t.text : t.muted)
            .when(!!button.focused, (el) => el.font_weight(600))
            .when(enabled, (el) => el.hover((style) => style.bg(t.accentSoft).border_color(t.accent))),
        )
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
    .pt(6)
    .gap(8)
    .child(footerButton(look, primary, true))
    .child(footerButton(look, secondary, false));
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
  const size = Math.max(6, (options.visible / options.total) * 100);
  const start = Math.min(100 - size, (options.offset / options.total) * 100);
  if (options.axis === "vertical")
    return div()
      .relative()
      .flex_none()
      .w(6)
      .h_full()
      .bg(t.hover)
      .child(div().absolute().top(`${start}%`).h(`${size}%`).left(1).right(1).bg(t.lineStrong).rounded(1));
  return div()
    .relative()
    .flex_none()
    .h(6)
    .w_full()
    .bg(t.hover)
    .child(div().absolute().left(`${start}%`).w(`${size}%`).top(1).bottom(1).bg(t.lineStrong).rounded(1));
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
      const active = selected && options.focused;
      const row = h_flex()
        .id(`${this.id}-row-${index}`)
        .flex_none()
        .h(look.row)
        .min_w(0)
        .items_center()
        .whitespace_nowrap()
        .overflow_hidden()
        .border_l(2)
        .border_color(active ? t.accent : "#00000000")
        .when(active, (el) => el.bg(t.accentSoft).font_weight(600))
        .hover((style) => style.bg(active ? t.accentSoft : t.hover))
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
            .text_color(active ? t.accentText : t.hint)
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
