import { h_flex, InputState, v_flex } from "gpui-base";
import { type AsyncContext, type Context, div, type Element, type FocusHandle, type KeyEvent } from "gpui-kit";
import type { Overlay, Tone } from "../overlay.ts";
import type { Look } from "../theme.ts";
import { textInput } from "../widgets.ts";

export interface DialogOptions {
  title: string | { text: string; tone: Tone };
  width: number;
  height?: number;
}

export abstract class Dialog {
  protected readonly handle: FocusHandle;
  private inputs: InputState[] = [];
  private spec: object | null = null;
  private released = false;

  constructor(
    protected readonly overlay: Overlay,
    cx: AsyncContext,
  ) {
    this.handle = cx.focus_handle();
  }

  protected input(placeholder = "", value = ""): InputState {
    const input = InputState.new({ placeholder, value });
    input.on("change", (_, cx) => {
      this.changed();
      cx.notify();
    });
    this.inputs.push(input);
    return input;
  }

  protected changed(): void {}

  protected abstract body(look: Look): Element;

  protected abstract key(event: KeyEvent, cx: Context): boolean;

  protected abstract options(): DialogOptions;

  protected show(): void {
    const options = this.options();
    const current = () => this.options();
    const spec = {
      kind: "custom" as const,
      title: options.title,
      width: options.width,
      get height() {
        return current().height;
      },
      render: (look: Look) => this.body(look).track_focus(this.handle),
      key: (event: KeyEvent, cx: Context) => this.key(event, cx),
      onCancel: () => this.release(),
    };
    this.spec = spec;
    this.overlay.open(spec);
    this.handle.focus();
  }

  isOpen(): boolean {
    return this.spec !== null && this.overlay.current() === this.spec;
  }

  close(cx: Context): void {
    if (this.isOpen()) this.overlay.close(cx);
    this.release();
  }

  protected release(): void {
    this.spec = null;
    if (this.released) return;
    this.released = true;
    for (const input of this.inputs) input.release();
    this.inputs = [];
    this.handle.release();
  }
}

export function inputBox(look: Look, id: string, title: string, input: InputState, focused = false): Element {
  const { t } = look;
  return v_flex()
    .id(id)
    .flex_none()
    .gap(4)
    .child(
      div()
        .text_size(Math.max(10, look.size - 2))
        .font_weight(600)
        .text_color(focused ? t.accentText : t.secondary)
        .child(title.toUpperCase()),
    )
    .child(
      h_flex()
        .h(look.row + 8)
        .px(8)
        .items_center()
        .bg(t.background)
        .border(1)
        .border_color(focused ? t.accent : t.lineStrong)
        .rounded(2)
        .child(textInput(look, input)),
    );
}
