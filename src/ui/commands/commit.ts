import { h_flex, type InputState, Textarea, TextareaState, v_flex } from "gpui-base";
import { type AsyncContext, type Context, div, type Element, type KeyEvent } from "gpui-kit";
import { headMessage } from "../../git/workflows.ts";
import { DIALOG, type Look, rows } from "../theme.ts";
import { box, dialogFooter, footerHint } from "../widgets.ts";
import { Dialog, type DialogOptions, inputBox } from "./dialog.ts";
import { type CommandHost, errorMessage } from "./host.ts";

type Focus = "subject" | "description" | "amend" | "submit" | "cancel";
const CYCLE: readonly Focus[] = ["subject", "description", "amend", "submit", "cancel"];

export interface CommitValues {
  subject: string;
  description: string;
  amend: boolean;
  error: string | null;
}

function splitMessage(message: string): { subject: string; description: string } {
  const index = message.indexOf("\n");
  if (index < 0) return { subject: message.replace(/\r$/, ""), description: "" };
  return {
    subject: message.slice(0, index).replace(/\r$/, ""),
    description: message.slice(index + 1).replace(/^[\r\n]+|[\r\n]+$/g, ""),
  };
}

export class CommitDialog extends Dialog {
  private focus: Focus = "subject";
  private amend: boolean;
  private error: string | null;
  private progress: string | null = null;
  private readonly subject: InputState;
  private readonly description: TextareaState;

  constructor(
    private readonly host: CommandHost,
    cx: AsyncContext,
    values?: CommitValues,
  ) {
    super(host.services.overlay, cx);
    this.subject = this.input("Subject", values?.subject ?? "");
    this.description = TextareaState.new({ placeholder: "Description", value: values?.description ?? "", rows: 6 });
    this.description.on("change", (_, cx) => {
      this.error = null;
      cx.notify();
    });
    this.amend = values?.amend ?? false;
    this.error = values?.error ?? null;
  }

  open(): void {
    this.show();
    this.subject.focus();
  }

  protected options(): DialogOptions {
    return { title: "Commit", width: DIALOG.wide, height: 18 };
  }

  protected override changed(): void {
    this.error = null;
  }

  protected override release(): void {
    super.release();
    this.description.release();
  }

  private values(): CommitValues {
    return {
      subject: this.subject.value(),
      description: this.description.value(),
      amend: this.amend,
      error: this.error,
    };
  }

  private message(): string {
    const subject = this.subject.value().trim();
    const description = this.description.value().trim();
    return description ? `${subject}\n\n${description}` : subject;
  }

  private setFocus(focus: Focus): void {
    this.focus = focus;
    if (focus === "subject") this.subject.focus();
    else if (focus === "description") this.description.focus();
    else this.handle.focus();
  }

  private toggleAmend(cx: AsyncContext): void {
    this.amend = !this.amend;
    this.error = null;
    this.setFocus("subject");
    if (!this.amend) return;
    const git = this.host.services.git();
    if (!git) {
      this.error = "Not a Git repository";
      this.amend = false;
      return;
    }
    if (!this.host.context().head) {
      this.error = "No HEAD commit to amend.";
      this.amend = false;
      return;
    }
    this.progress = "Loading HEAD message";
    cx.spawn(async (cx) => {
      try {
        const { subject, description } = splitMessage(await headMessage(git));
        if (this.isOpen() && this.amend) {
          this.subject.set_value(subject);
          this.description.set_value(description);
        }
      } catch (error) {
        this.error = errorMessage(error);
      }
      this.progress = null;
      cx.notify();
    });
  }

  private submit(cx: AsyncContext): void {
    const context = this.host.context();
    if (!this.subject.value().trim()) this.error = "Enter a commit subject.";
    else if (this.amend && !context.head) this.error = "No HEAD commit to amend.";
    else if (!this.amend && !context.staged) this.error = "Stage changes before committing.";
    if (this.error) return;
    const values = this.values();
    const message = this.message();
    this.close(cx);
    this.host.run("commit", { kind: "commit", message, amend: values.amend }, cx, (success, output, cx) => {
      if (success) return false;
      new CommitDialog(this.host, cx, { ...values, error: output }).open();
      return true;
    });
  }

  private activate(cx: AsyncContext): void {
    if (this.focus === "cancel") this.close(cx);
    else this.submit(cx);
  }

  protected key(event: KeyEvent, cx: Context): boolean {
    const key = event.keystroke;
    const index = CYCLE.indexOf(this.focus);
    if (key === "tab") this.setFocus(CYCLE[(index + 1) % CYCLE.length] ?? "subject");
    else if (key === "shift-tab") this.setFocus(CYCLE[(index + CYCLE.length - 1) % CYCLE.length] ?? "subject");
    else if (key === "shift-enter" && this.focus === "subject") this.setFocus("description");
    else if (key === "enter") this.activate(cx);
    else if (key === "space" && this.focus === "amend") this.toggleAmend(cx);
    else return false;
    return true;
  }

  private check(
    look: Look,
    id: string,
    label: string,
    on: boolean,
    focus: Focus,
    toggle: (cx: Context) => void,
  ): Element {
    const { t } = look;
    return div()
      .id(id)
      .flex_none()
      .h(look.row)
      .cursor_pointer()
      .when(this.focus === focus, (el) => el.bg(t.focus).font_weight(700))
      .hover((style) => style.bg(t.hover))
      .child(`[${on ? "x" : " "}] ${label}`)
      .on_click((_, cx) => {
        cx.stop_propagation();
        toggle(cx);
        cx.notify();
      });
  }

  private status(look: Look): Element {
    const { t } = look;
    if (this.error) return div().h(look.row).truncate().text_color(t.error).child(`Error: ${this.error}`);
    if (this.progress) return footerHint(look, this.progress);
    return div().h(look.row);
  }

  protected body(look: Look): Element {
    const { t } = look;
    return v_flex()
      .size_full()
      .min_h(rows(look, 14))
      .child(inputBox(look, "git-commit-subject", "Subject", this.subject, this.focus === "subject"))
      .child(
        box(
          look,
          { id: "git-commit-description", title: "Description", focused: this.focus === "description" },
          h_flex().size_full().child(Textarea.new(this.description).size_full().text_color(t.text)),
        )
          .flex_1()
          .min_h(rows(look, 5)),
      )
      .child(this.check(look, "git-commit-amend", "Amend", this.amend, "amend", (cx) => this.toggleAmend(cx)))
      .child(this.status(look))
      .child(
        dialogFooter(
          look,
          {
            id: "git-commit-submit",
            label: "[Enter] Commit",
            focused: this.focus === "submit",
            onClick: (cx) => this.submit(cx),
          },
          {
            id: "git-commit-cancel",
            label: "[Esc] Cancel",
            focused: this.focus === "cancel",
            onClick: (cx) => this.close(cx),
          },
        ),
      );
  }
}
