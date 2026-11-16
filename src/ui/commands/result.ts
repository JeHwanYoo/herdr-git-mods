import { Button, h_flex, v_flex } from "gpui-base";
import { type AsyncContext, div, type Element } from "gpui-kit";
import type { CustomSpec, Overlay } from "../overlay.ts";
import { DIALOG, type Look, rows } from "../theme.ts";

const VISIBLE_MS = 2000;
const CHROME = 6;

export interface ResultLine {
  text: string;
  tone?: "text" | "accent" | "success" | "error" | "warning" | "hint";
  bold?: boolean;
}

function color(look: Look, tone: ResultLine["tone"]) {
  const { t } = look;
  if (tone === "accent") return t.accent;
  if (tone === "success") return t.success;
  if (tone === "error") return t.error;
  if (tone === "warning") return t.warning;
  if (tone === "hint") return t.hint;
  return t.text;
}

function closeButton(look: Look, overlay: Overlay): Element {
  const { t } = look;
  return Button.new("git-result-close")
    .accessibility_label("Close")
    .w_full()
    .h(rows(look, 3))
    .child(
      h_flex()
        .size_full()
        .justify_center()
        .items_center()
        .border(1)
        .border_color(t.rule)
        .hover((style) => style.bg(t.hover))
        .child("[Esc] Close"),
    )
    .on_click((_, cx) => {
      cx.stop_propagation();
      overlay.close(cx);
      cx.notify();
    });
}

export function showResultLines(
  overlay: Overlay,
  title: string,
  success: boolean,
  content: ResultLine[],
  cx?: AsyncContext,
): void {
  const height = Math.max(9, Math.min(20, content.length + CHROME));
  const spec: CustomSpec = {
    kind: "custom",
    title: { text: title, tone: success ? "success" : "error" },
    width: DIALOG.card,
    height: height - 2,
    render: (look) =>
      v_flex()
        .size_full()
        .min_h(0)
        .child(
          v_flex()
            .flex_1()
            .min_h(0)
            .overflow_hidden()
            .children(
              content.map((line) =>
                div()
                  .flex_none()
                  .min_h(look.row)
                  .whitespace_normal()
                  .text_color(color(look, line.tone ?? (success ? "text" : "error")))
                  .when(!!line.bold, (el) => el.font_weight(700))
                  .child(line.text),
              ),
            ),
        )
        .child(div().flex_none().h(look.row))
        .child(closeButton(look, overlay)),
    key: (event, cx) => {
      if (event.keystroke !== "enter") return false;
      overlay.close(cx);
      return true;
    },
  };
  overlay.open(spec);
  if (success && cx)
    cx.timer.after(VISIBLE_MS, (cx) => {
      if (overlay.current() !== spec) return;
      overlay.close(cx);
      cx.notify();
    });
}

export function showResult(
  overlay: Overlay,
  name: string,
  success: boolean,
  message: string,
  preview?: string,
  cx?: AsyncContext,
): void {
  const body: ResultLine[] = message.split("\n").map((text) => ({ text, tone: success ? "text" : "error" }));
  const content: ResultLine[] = preview ? [{ text: preview, tone: "accent", bold: true }, { text: "" }, ...body] : body;
  showResultLines(overlay, `${name} ${success ? "complete" : "failed"}`, success, content, cx);
}
