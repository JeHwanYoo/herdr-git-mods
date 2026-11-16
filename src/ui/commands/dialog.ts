import { h_flex, InputState } from "gpui-base";
import type { AsyncContext, Context, Element, FocusHandle, KeyEvent } from "gpui-kit";
import type { Overlay, Tone } from "../overlay.ts";
import type { Look } from "../theme.ts";
import { box, textInput } from "../widgets.ts";

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
    const spec = {
      kind: "custom" as const,
      title: options.title,
      width: options.width,
      height: options.height,
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
  return box(look, { id, title, focused }, h_flex().h(look.row).child(textInput(look, input))).flex_none();
}
