import { h_flex, InputState, v_flex } from "gpui-base";
import { type AsyncContext, type Context, div, type Element, type FocusHandle, type KeyEvent } from "gpui-kit";
import { type Color, cols, DIALOG, type Look, rows } from "./theme.ts";
import { box, dialogFooter, dialogFrame, footerHint, ListViewport, padToWidth, textInput } from "./widgets.ts";

export type Tone = "text" | "hint" | "secondary" | "muted" | "accent" | "warning" | "error" | "success";

type DialogLine = string | { text: string; tone: Tone; bold?: boolean };

export interface PickerRow {
  id: string;
  label: string;
  status?: string;
  disabled?: boolean;
}

export interface PickerSpec {
  kind: "picker";
  title: string;
  width?: number;
  search?: boolean;
  placeholder?: string;
  columns?: { label: string; status: string; width: number };
  rows: PickerRow[] | ((query: string) => PickerRow[]);
  footer?: string | ((query: string, count: number) => string);
  maxRows?: number;
  selected?: string;
  primary?: string;
  secondary?: string;
  onChoose: (row: PickerRow, cx: Context) => void;
  onCancel?: (cx: Context) => void;
}

export interface ConfirmSpec {
  kind: "confirm";
  title: string | { text: string; tone: Tone };
  width?: number;
  lines: DialogLine[];
  hint?: string;
  primary?: string;
  secondary?: string;
  enabled?: () => boolean;
  onConfirm: (cx: Context) => void;
  onCancel?: (cx: Context) => void;
}

interface FormField {
  label: string;
  placeholder?: string;
  value?: string;
}

export interface FormSpec {
  kind: "form";
  title: string;
  width?: number;
  lines?: DialogLine[];
  fields: FormField[];
  hint?: string;
  primary?: string;
  secondary?: string;
  onSubmit: (values: string[], cx: Context) => string | null;
  onCancel?: (cx: Context) => void;
}

export interface CustomSpec {
  kind: "custom";
  title: string | { text: string; tone: Tone };
  width?: number;
  height?: number;
  render: (look: Look) => Element;
  key?: (event: KeyEvent, cx: Context) => boolean;
  onCancel?: (cx: Context) => void;
}

export type DialogSpec = PickerSpec | ConfirmSpec | FormSpec | CustomSpec;

const PICKER_ROWS = 20;
const FIELD_ROWS = 3;

function toneColor(look: Look, tone: Tone): Color {
  const { t } = look;
  const colors: Record<Tone, Color> = {
    text: t.text,
    hint: t.hint,
    secondary: t.secondary,
    muted: t.muted,
    accent: t.accent,
    warning: t.warning,
    error: t.error,
    success: t.success,
  };
  return colors[tone];
}

function lineElement(look: Look, line: DialogLine): Element {
  const value = typeof line === "string" ? { text: line, tone: "text" as const } : line;
  return div()
    .flex_none()
    .min_h(look.row)
    .whitespace_normal()
    .text_color(toneColor(look, value.tone))
    .when(!!value.bold, (el) => el.font_weight(700))
    .child(value.text);
}

function lines(look: Look, content: DialogLine[]): Element {
  const split: DialogLine[] = [];
  for (const line of content) {
    if (typeof line === "string") split.push(...line.split("\n"));
    else split.push(line);
  }
  return v_flex()
    .min_w(0)
    .children(split.map((line) => lineElement(look, line)));
}

export class Overlay {
  private spec: DialogSpec | null = null;
  private inputs: InputState[] = [];
  private list = new ListViewport("git-dialog-list");
  private error: string | null = null;
  private readonly handle: FocusHandle;

  constructor(
    cx: AsyncContext,
    private readonly restoreFocus: (cx: Context) => void,
  ) {
    this.handle = cx.focus_handle();
  }

  isOpen(): boolean {
    return this.spec !== null;
  }

  current(): DialogSpec | null {
    return this.spec;
  }

  open(spec: DialogSpec): void {
    this.releaseInputs();
    this.spec = spec;
    this.error = null;
    this.list.reset();
    if (spec.kind === "picker" && (spec.search ?? true))
      this.inputs = [InputState.new({ placeholder: spec.placeholder ?? "" })];
    if (spec.kind === "form")
      this.inputs = spec.fields.map((field) =>
        InputState.new({ placeholder: field.placeholder ?? "", value: field.value ?? "" }),
      );
    for (const input of this.inputs)
      input.on("change", (_, cx) => {
        this.error = null;
        if (this.spec?.kind === "picker") this.list.reset();
        cx.notify();
      });
    if (spec.kind === "picker" && spec.selected !== undefined) {
      const index = this.pickerRows(spec).findIndex((row) => row.id === spec.selected);
      if (index >= 0) this.list.selected = index;
    }
    const [first] = this.inputs;
    if (first) first.focus();
    else this.handle.focus();
  }

  setError(message: string | null): void {
    this.error = message;
  }

  close(cx: Context): void {
    if (!this.spec) return;
    this.spec = null;
    this.error = null;
    this.releaseInputs();
    this.restoreFocus(cx);
  }

  release(): void {
    this.spec = null;
    this.releaseInputs();
    this.handle.release();
  }

  private releaseInputs(): void {
    for (const input of this.inputs) input.release();
    this.inputs = [];
  }

  private query(): string {
    return this.inputs[0]?.value().trim().toLowerCase() ?? "";
  }

  private pickerRows(spec: PickerSpec): PickerRow[] {
    const query = this.query();
    if (typeof spec.rows === "function") return spec.rows(query);
    return spec.rows.filter((row) => `${row.label} ${row.status ?? ""}`.toLowerCase().includes(query));
  }

  private cancel(cx: Context): void {
    const spec = this.spec;
    this.close(cx);
    spec?.onCancel?.(cx);
  }

  private choose(spec: PickerSpec, cx: Context): void {
    const row = this.pickerRows(spec)[this.list.selected];
    if (!row) return;
    this.close(cx);
    spec.onChoose(row, cx);
  }

  private confirm(spec: ConfirmSpec, cx: Context): void {
    if (spec.enabled && !spec.enabled()) return;
    this.close(cx);
    spec.onConfirm(cx);
  }

  private submit(spec: FormSpec, cx: Context): void {
    const error = spec.onSubmit(
      this.inputs.map((input) => input.value()),
      cx,
    );
    if (error !== null) this.error = error;
    else if (this.spec === spec) this.close(cx);
  }

  private primary(cx: Context): void {
    const spec = this.spec;
    if (spec?.kind === "picker") this.choose(spec, cx);
    else if (spec?.kind === "confirm") this.confirm(spec, cx);
    else if (spec?.kind === "form") this.submit(spec, cx);
  }

  private key(event: KeyEvent, cx: Context): void {
    const spec = this.spec;
    if (!spec) return;
    let handled = true;
    if (spec.kind === "custom" && spec.key?.(event, cx)) handled = true;
    else if (event.keystroke === "escape") this.cancel(cx);
    else if (event.keystroke === "enter" && spec.kind !== "custom") this.primary(cx);
    else if (spec.kind === "picker") {
      const outcome = this.list.key(event, this.pickerRows(spec).length, !(spec.search ?? true));
      handled = outcome === "moved";
    } else handled = false;
    if (!handled) return;
    cx.stop_propagation();
    cx.notify();
  }

  private footer(look: Look, primary: string, secondary: string): Element {
    return dialogFooter(
      look,
      { id: "git-dialog-primary", label: primary, onClick: (cx) => this.primary(cx) },
      { id: "git-dialog-secondary", label: secondary, onClick: (cx) => this.cancel(cx) },
    );
  }

  private hint(look: Look, text: string): Element {
    if (this.error) return footerHint(look, this.error).text_color(look.t.error);
    return footerHint(look, text);
  }

  private searchBox(look: Look): Element | null {
    const [input] = this.inputs;
    if (!input) return null;
    return box(look, { id: "git-dialog-search", title: "Search" }, h_flex().h(look.row).child(textInput(look, input)));
  }

  private picker(look: Look, spec: PickerSpec): Element {
    const { t } = look;
    const all = this.pickerRows(spec);
    const visible = Math.max(1, Math.min(all.length, spec.maxRows ?? PICKER_ROWS));
    const columns = spec.columns;
    const query = this.query();
    const footer = typeof spec.footer === "function" ? spec.footer(query, all.length) : (spec.footer ?? "");
    const body = v_flex().min_w(0);
    const search = this.searchBox(look);
    if (search) body.child(search);
    if (columns)
      body.child(
        div()
          .flex_none()
          .h(look.row)
          .bg(t.header)
          .text_color(t.accent)
          .font_weight(700)
          .whitespace_nowrap()
          .child(`  ${padToWidth(columns.label, columns.width)}${columns.status}`),
      );
    body.child(
      v_flex()
        .h(rows(look, visible))
        .flex_none()
        .child(
          this.list.render(look, {
            length: all.length,
            focused: true,
            row: ({ index }) => {
              const row = all[index];
              if (!row) return div();
              const width = columns?.width ?? 0;
              return h_flex()
                .flex_1()
                .min_w(0)
                .child(
                  div()
                    .flex_none()
                    .when(width > 0, (el) => el.w(cols(look, width)))
                    .when(width === 0, (el) => el.flex_1())
                    .truncate()
                    .text_color(row.disabled ? t.muted : t.text)
                    .child(row.label),
                )
                .when(!!row.status, (el) =>
                  el.child(
                    div()
                      .flex_none()
                      .text_color(row.disabled ? t.warning : t.secondary)
                      .child(row.status ?? ""),
                  ),
                );
            },
            onActivate: (_, cx) => this.choose(spec, cx),
          }),
        ),
    );
    return body
      .child(this.hint(look, footer))
      .child(this.footer(look, spec.primary ?? "[Enter] Run", spec.secondary ?? "[Esc] Cancel"));
  }

  private confirmBody(look: Look, spec: ConfirmSpec): Element {
    return v_flex()
      .min_w(0)
      .child(lines(look, spec.lines))
      .child(this.hint(look, spec.hint ?? ""))
      .child(this.footer(look, spec.primary ?? "[Enter] Run", spec.secondary ?? "[Esc] Cancel"));
  }

  private form(look: Look, spec: FormSpec): Element {
    const body = v_flex()
      .min_w(0)
      .child(lines(look, spec.lines ?? []));
    for (const [index, field] of spec.fields.entries()) {
      const input = this.inputs[index];
      if (input)
        body.child(
          box(
            look,
            { id: `git-dialog-field-${index}`, title: field.label },
            h_flex().h(look.row).child(textInput(look, input)),
          )
            .h(rows(look, FIELD_ROWS))
            .flex_none(),
        );
    }
    return body
      .child(this.hint(look, spec.hint ?? ""))
      .child(this.footer(look, spec.primary ?? "[Enter] Save", spec.secondary ?? "[Esc] Cancel"));
  }

  private body(look: Look, spec: DialogSpec): Element {
    if (spec.kind === "picker") return this.picker(look, spec);
    if (spec.kind === "confirm") return this.confirmBody(look, spec);
    if (spec.kind === "form") return this.form(look, spec);
    return v_flex()
      .min_w(0)
      .min_h(0)
      .flex_1()
      .when(spec.height !== undefined, (el) => el.h(rows(look, spec.height ?? 0)))
      .child(spec.render(look));
  }

  render(look: Look): Element | null {
    const spec = this.spec;
    if (!spec) return null;
    const title =
      typeof spec.title === "string"
        ? spec.title
        : div().text_color(toneColor(look, spec.title.tone)).font_weight(700).child(spec.title.text);
    const width = spec.width ?? (spec.kind === "picker" ? DIALOG.wide : DIALOG.medium);
    const frame = dialogFrame(look, { id: "git-dialog", title, width }, this.body(look, spec))
      .track_focus(this.handle)
      .on_key_down((event, cx) => this.key(event, cx));
    return v_flex()
      .id("git-dialog-layer")
      .absolute()
      .inset_0()
      .items_center()
      .justify_center()
      .on_mouse_down("left", (_, cx) => cx.stop_propagation())
      .child(frame);
  }
}
