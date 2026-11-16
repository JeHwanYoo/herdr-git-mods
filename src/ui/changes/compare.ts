import { h_flex, InputState, v_flex } from "gpui-base";
import { type AsyncContext, type Context, div, type Element, type KeyEvent } from "gpui-kit";
import { type BranchTarget, readBranchTargets } from "../../git/comparison.ts";
import type { Services } from "../shell.ts";
import { DIALOG, GLYPH, type Look, rows } from "../theme.ts";
import { box, dialogFooter, textInput, viewportOffset } from "../widgets.ts";

const HEIGHT = 18;
const FIXED_ROWS = 3 + 3 + 1 + 3;

class CompareDialog {
  private readonly inputs: [InputState, InputState];
  private focused = 1;
  private targets: BranchTarget[] = [];
  private selected: number | null = null;
  private scroll = 0;
  private loading = true;
  private error: string | null = null;

  constructor(
    private readonly services: Services,
    base: string,
    compare: string,
    private readonly onApply: (base: string, compare: string, cx: Context) => void,
  ) {
    this.inputs = [InputState.new({ value: base }), InputState.new({ value: compare })];
    for (const input of this.inputs)
      input.on("change", (_, cx) => {
        this.selected = null;
        this.scroll = 0;
        this.error = null;
        cx.notify();
      });
  }

  load(cx: AsyncContext): void {
    const git = this.services.git();
    const context = this.services.context();
    if (!git) {
      this.loading = false;
      this.error = "Not a Git repository";
      return;
    }
    cx.spawn(async (cx) => {
      try {
        const targets = await readBranchTargets(git);
        if (context === this.services.context()) this.targets = targets;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  focus(): void {
    this.inputs[this.focused]?.focus();
  }

  release(): void {
    for (const input of this.inputs) input.release();
  }

  private filtered(): BranchTarget[] {
    const query = (this.inputs[this.focused]?.value() ?? "").toLowerCase();
    return this.targets.filter(
      (target) => target.name.toLowerCase().includes(query) || target.reference.toLowerCase().includes(query),
    );
  }

  private switchField(index: number): void {
    this.focused = index;
    this.selected = null;
    this.scroll = 0;
    this.focus();
  }

  private choose(index: number): void {
    const target = this.filtered()[index];
    if (!target) return;
    this.inputs[this.focused]?.set_value(target.reference);
    this.switchField(1 - this.focused);
  }

  private apply(cx: Context): void {
    const [base, compare] = this.inputs.map((input) => input.value().trim());
    if (!base || !compare) {
      this.error = "Choose a branch or commit.";
      return;
    }
    this.release();
    this.services.overlay.close(cx);
    this.onApply(base, compare, cx);
  }

  private move(key: string, length: number): boolean {
    if (length === 0) return ["up", "down", "pageup", "pagedown", "home", "end"].includes(key);
    const page = Math.max(1, this.listRows());
    const current = this.selected ?? 0;
    const next: Record<string, number> = {
      down: this.selected === null ? 0 : current + 1,
      up: current - 1,
      pagedown: current + page,
      pageup: current - page,
      home: 0,
      end: length - 1,
    };
    const target = next[key];
    if (target === undefined) return false;
    this.selected = Math.max(0, Math.min(length - 1, target));
    return true;
  }

  key(event: KeyEvent, cx: Context): boolean {
    const key = event.keystroke;
    if (key === "tab" || key === "shift-tab") this.switchField(1 - this.focused);
    else if (key === "enter") {
      if (this.selected === null) this.apply(cx);
      else this.choose(this.selected);
    } else if (!this.move(key, this.filtered().length)) return false;
    cx.stop_propagation();
    cx.notify();
    return true;
  }

  private listRows(): number {
    return HEIGHT - FIXED_ROWS;
  }

  private field(look: Look, index: number): Element {
    const input = this.inputs[index];
    return box(
      look,
      { id: `git-compare-field-${index}`, title: index === 0 ? "Base" : "Compare", focused: this.focused === index },
      h_flex()
        .h(look.row)
        .child(input ? textInput(look, input) : div()),
    )
      .h(rows(look, 3))
      .flex_none()
      .on_mouse_down("left", () => {
        this.focused = index;
        this.selected = null;
        this.scroll = 0;
      });
  }

  render(look: Look): Element {
    const { t } = look;
    const targets = this.filtered();
    const height = this.listRows();
    this.scroll = viewportOffset(this.scroll, this.selected ?? 0, targets.length, height);
    const list = v_flex().h(rows(look, height)).flex_none().overflow_hidden();
    for (const [offset, target] of targets.slice(this.scroll, this.scroll + height).entries()) {
      const index = this.scroll + offset;
      const selected = this.selected === index;
      list.child(
        div()
          .id(`git-compare-target-${index}`)
          .h(look.row)
          .whitespace_nowrap()
          .overflow_hidden()
          .text_color(selected ? t.accent : t.hint)
          .when(selected, (el) => el.font_weight(700))
          .hover((style) => style.bg(t.hover))
          .child(`${selected ? GLYPH.marker.trim() : " "} ${target.name}`)
          .on_click((_, cx) => {
            cx.stop_propagation();
            this.choose(index);
            cx.notify();
          }),
      );
    }
    const status = this.error
      ? div().h(look.row).text_color(t.error).truncate().child(this.error)
      : div()
          .h(look.row)
          .text_color(t.hint)
          .child(this.loading ? "Loading branches" : "");
    return v_flex()
      .min_w(0)
      .child(this.field(look, 0))
      .child(this.field(look, 1))
      .child(list)
      .child(status)
      .child(
        dialogFooter(
          look,
          { id: "git-compare-apply", label: "[Enter] Compare", onClick: (cx) => this.apply(cx) },
          {
            id: "git-compare-cancel",
            label: "[Esc] Cancel",
            onClick: (cx) => {
              this.release();
              this.services.overlay.close(cx);
            },
          },
        ),
      );
  }
}

export function openCompareDialog(
  services: Services,
  base: string,
  compare: string,
  onApply: (base: string, compare: string, cx: Context) => void,
  cx: AsyncContext,
): void {
  const dialog = new CompareDialog(services, base, compare, onApply);
  services.overlay.open({
    kind: "custom",
    title: "Compare",
    width: DIALOG.medium,
    height: HEIGHT,
    render: (look) => dialog.render(look),
    key: (event, cx) => dialog.key(event, cx),
    onCancel: () => dialog.release(),
  });
  dialog.focus();
  dialog.load(cx);
}
