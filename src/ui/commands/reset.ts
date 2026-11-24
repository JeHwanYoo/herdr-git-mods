import { h_flex, v_flex } from "gpui-base";
import { type AsyncContext, type Context, div, type Element, type KeyEvent } from "gpui-kit";
import type { BranchTarget } from "../../git/ref-operations.ts";
import type { ResetMode } from "../../git/workflows.ts";
import { shortCommit } from "../shell.ts";
import { DIALOG, type Look, rows } from "../theme.ts";
import { box, dialogFooter, displayWidth, ListViewport, padToWidth } from "../widgets.ts";
import { RESET_MODES } from "./catalog.ts";
import { Dialog, type DialogOptions } from "./dialog.ts";
import type { CommandHost } from "./host.ts";

type Step = "mode" | "confirm";

export interface ResetRequest {
  branch: string;
  head: string;
  target: BranchTarget;
}

const EFFECT: Record<ResetMode, string> = {
  soft: "The current branch moves to the target. The index and working tree are preserved.",
  mixed: "The current branch and index move to the target. The working tree is preserved.",
  hard: "The current branch, index, and tracked working tree move to the target.",
};

const HARD_WARNING = "Tracked changes will be discarded. Obstructing untracked paths may be removed.";
const REMOTE_NOTE = "Remote refs are not changed. The target branch is not checked out.";
const NOTE_COLUMNS = DIALOG.wide - 6;
const CONFIRM_CHROME = 14;

function wrappedRows(text: string): number {
  return Math.max(1, Math.ceil(displayWidth(text) / NOTE_COLUMNS));
}

export class ResetFlow extends Dialog {
  private step: Step = "mode";
  private readonly modeList = new ListViewport("git-reset-modes");

  constructor(
    private readonly host: CommandHost,
    private readonly request: ResetRequest,
    cx: AsyncContext,
  ) {
    super(host.services.overlay, cx);
  }

  open(): void {
    this.show();
  }

  protected options(): DialogOptions {
    return { title: "Reset", width: DIALOG.wide, height: this.step === "confirm" ? this.confirmHeight() : 11 };
  }

  private confirmHeight(): number {
    const mode = this.mode().mode;
    const notes = [EFFECT[mode], REMOTE_NOTE, ...(mode === "hard" ? [HARD_WARNING] : [])];
    return CONFIRM_CHROME + notes.reduce((sum, note) => sum + wrappedRows(note), 0);
  }

  private mode(): (typeof RESET_MODES)[number] {
    return RESET_MODES[Math.min(this.modeList.selected, RESET_MODES.length - 1)] ?? RESET_MODES[0];
  }

  private advance(cx: Context): void {
    if (this.step === "mode") this.step = "confirm";
    else this.execute(cx);
  }

  private back(cx: Context): void {
    if (this.step === "mode") this.close(cx);
    else this.step = "mode";
  }

  private execute(cx: Context): void {
    const { target, branch, head } = this.request;
    const mode = this.mode().mode;
    this.close(cx);
    this.host.run(
      "reset",
      {
        kind: "reset",
        mode,
        target: target.commit,
        targetName: target.name,
        branch,
        head,
      },
      cx,
    );
  }

  protected key(event: KeyEvent, cx: Context): boolean {
    if (event.keystroke === "enter") this.advance(cx);
    else if (event.keystroke === "escape") this.back(cx);
    else if (this.step === "mode") return this.modeList.key(event, RESET_MODES.length) === "moved";
    else return false;
    return true;
  }

  private pair(look: Look, label: string, ...values: string[]): Element {
    const { t } = look;
    const row = h_flex().h(look.row).child(div().text_color(t.hint).child(label));
    values.forEach((value, index) => {
      if (index > 0) row.child(div().child(" · "));
      row.child(div().text_color(t.accent).font_weight(700).child(value));
    });
    return row;
  }

  private header(look: Look): Element {
    const { t } = look;
    const header = v_flex()
      .flex_none()
      .child(
        h_flex()
          .h(look.row)
          .child(div().text_color(t.hint).child("Current branch  "))
          .child(div().text_color(t.accent).font_weight(700).child(this.request.branch))
          .child(div().text_color(t.hint).child("    HEAD  "))
          .child(div().text_color(t.accent).font_weight(700).child(shortCommit(this.request.head))),
      );
    const { target } = this.request;
    if (this.step === "mode") header.child(this.pair(look, "Target  ", shortCommit(target.commit), target.name));
    return header;
  }

  private modes(look: Look): Element {
    return box(
      look,
      { id: "git-reset-mode-box", title: "Reset mode" },
      this.modeList.render(look, {
        length: RESET_MODES.length,
        focused: true,
        marker: true,
        row: ({ index }) => {
          const mode = RESET_MODES[index];
          return div().child(mode ? `${padToWidth(mode.label, 7)} ${mode.summary}` : "");
        },
        onActivate: (index, cx) => {
          this.modeList.selected = index;
          this.advance(cx);
        },
      }),
    ).flex_1();
  }

  private confirmation(look: Look): Element {
    const { t } = look;
    const mode = this.mode();
    const body = v_flex()
      .min_w(0)
      .child(this.pair(look, "From    ", this.request.branch, shortCommit(this.request.head)));
    const { target } = this.request;
    body
      .child(this.pair(look, "Target  ", target.name, shortCommit(target.commit)))
      .child(this.pair(look, "Mode    ", mode.label))
      .child(div().h(look.row))
      .child(div().text_color(t.accent).child(`git reset --${mode.mode} ${target.commit}`))
      .child(div().h(look.row));
    body.child(
      div()
        .whitespace_normal()
        .text_color(mode.mode === "mixed" ? t.warning : t.text)
        .child(EFFECT[mode.mode]),
    );
    if (mode.mode === "hard")
      body.child(div().whitespace_normal().text_color(t.error).font_weight(700).child(HARD_WARNING));
    body.child(div().h(look.row)).child(div().whitespace_normal().text_color(t.hint).child(REMOTE_NOTE));
    return box(look, { id: "git-reset-confirm-box", title: "Confirm Reset" }, body).flex_1();
  }

  protected body(look: Look): Element {
    const content = this.step === "mode" ? this.modes(look) : this.confirmation(look);
    const labels = this.step === "mode" ? ["[Enter] Continue", "[Esc] Cancel"] : ["[Enter] Reset", "[Esc] Back"];
    return v_flex()
      .size_full()
      .min_h(rows(look, 10))
      .child(this.header(look))
      .child(v_flex().flex_1().min_h(0).child(content))
      .child(
        dialogFooter(
          look,
          { id: "git-reset-primary", label: labels[0] ?? "", onClick: (cx) => this.advance(cx) },
          { id: "git-reset-secondary", label: labels[1] ?? "", onClick: (cx) => this.back(cx) },
        ),
      );
  }
}
