import { h_flex, v_flex } from "gpui-base";
import { type Context, div, type Element, type KeyEvent } from "gpui-kit";
import type { Overlay } from "../overlay.ts";
import { DIALOG, GLYPH, type Look } from "../theme.ts";
import { dialogFooter, footerHint, isChord, ListViewport } from "../widgets.ts";
import { pathLabel, type RepositoryRow } from "./rows.ts";

const CHROME = 6;
const FRAME = 2;

export interface WorkspacePickerOptions {
  rows: () => RepositoryRow[];
  selected: number;
  choose: (row: RepositoryRow, cx: Context) => void;
}

function label(row: RepositoryRow): string {
  const name = pathLabel(row.path);
  if (row.kind.type === "current") return `Current · ${name}`;
  if (row.kind.type === "project") return `${GLYPH.repository} ${name}`;
  return `  ${GLYPH.worktree} ${name}`;
}

function rowElement(look: Look, row: RepositoryRow | undefined, index: number): Element {
  const { t } = look;
  const line = h_flex().flex_1().min_w(0).overflow_hidden();
  if (index < 9)
    line
      .child(div().text_color(t.hint).child("["))
      .child(
        div()
          .text_color(t.accent)
          .font_weight(700)
          .child(String(index + 1)),
      )
      .child(div().text_color(t.hint).child("] "));
  else line.child(div().child("    "));
  return line.child(
    div()
      .truncate()
      .child(row ? label(row) : ""),
  );
}

export function openWorkspacePicker(overlay: Overlay, options: WorkspacePickerOptions): void {
  const list = new ListViewport("git-workspace-picker");
  list.selected = options.selected;
  const height = Math.min(24, Math.max(8, options.rows().length + CHROME)) - FRAME;
  const choose = (index: number, cx: Context) => {
    const row = options.rows()[index];
    if (!row) return;
    overlay.close(cx);
    options.choose(row, cx);
  };
  const key = (event: KeyEvent, cx: Context): boolean => {
    if (isChord(event)) return false;
    const rows = options.rows();
    const digit = /^[1-9]$/.test(event.keystroke) ? Number(event.keystroke) - 1 : -1;
    if (digit >= 0) {
      if (digit < rows.length) {
        list.selected = digit;
        choose(digit, cx);
      }
      return true;
    }
    const outcome = list.key(event, rows.length);
    if (outcome === "activate") choose(list.selected, cx);
    else if (outcome === "cancel") overlay.close(cx);
    return outcome !== null;
  };
  overlay.open({
    kind: "custom",
    title: "Select Workspace",
    width: DIALOG.medium,
    height,
    key,
    render: (look) => {
      const rows = options.rows();
      return v_flex()
        .size_full()
        .min_h(0)
        .child(
          v_flex()
            .flex_1()
            .min_h(0)
            .child(
              list.render(look, {
                length: rows.length,
                focused: true,
                row: ({ index }) => rowElement(look, rows[index], index),
                onActivate: (index, cx) => choose(index, cx),
              }),
            ),
        )
        .child(footerHint(look, "1–9 Switch · ↑/↓ j/k Move"))
        .child(
          dialogFooter(
            look,
            { id: "git-workspace-switch", label: "[Enter] Switch", onClick: (cx) => choose(list.selected, cx) },
            { id: "git-workspace-close", label: "[Esc] Close", onClick: (cx) => overlay.close(cx) },
          ),
        );
    },
  });
}
