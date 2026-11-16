import { h_flex, Textarea, TextareaState, v_flex } from "gpui-base";
import { type AsyncContext, type Context, div, type Element, type KeyEvent } from "gpui-kit";
import {
  REBASE_ACTIONS,
  REBASE_DESCRIPTIONS,
  REBASE_LABELS,
  type RebaseAction,
  type RebasePlan,
  type RebaseTarget,
  type RebaseTask,
  readRebasePlan,
  runRebase,
  validatePlan,
} from "../../git/rebase.ts";
import { type Color, type Look, rows } from "../theme.ts";
import { box, dialogFooter, ListViewport, padToWidth, truncateToWidth } from "../widgets.ts";
import { Dialog, type DialogOptions } from "./dialog.ts";
import { type CommandHost, errorMessage } from "./host.ts";
import { showResult } from "./result.ts";

const KEYS = "persfd";
const WIDTH = 140;
const MENU_ROWS = 8;

export class RebaseEditor extends Dialog {
  private plan: RebasePlan | null = null;
  private busy = true;
  private status = "Loading commits…";
  private amendMessage = "";
  private anchor: number | null = null;
  private readonly list = new ListViewport("git-rebase-entries");
  private menu: ListViewport | null = null;
  private message: { index: number | null; state: TextareaState; error: string | null } | null = null;
  private confirmation: RebaseTask | null = null;

  constructor(
    private readonly host: CommandHost,
    cx: AsyncContext,
  ) {
    super(host.services.overlay, cx);
  }

  open(target: RebaseTarget, cx: AsyncContext): void {
    this.show();
    const git = this.host.services.git();
    const context = this.host.services.context();
    if (!git) return;
    cx.spawn(async (cx) => {
      try {
        const plan = await readRebasePlan(git, target);
        if (context !== this.host.services.context()) return;
        this.plan = plan;
        this.status = plan.active ? "Rebase paused. Resolve and stage files in Changes, then Continue." : "";
        this.amendMessage = plan.entries[0]?.message ?? "";
      } catch (error) {
        this.status = errorMessage(error);
      }
      this.busy = false;
      cx.notify();
    });
  }

  protected options(): DialogOptions {
    return { title: "Interactive rebase", width: WIDTH, height: 28 };
  }

  protected override release(): void {
    this.closeMessage();
    super.release();
  }

  private closeMessage(): void {
    this.message?.state.release();
    this.message = null;
    this.handle.focus();
  }

  private range(): [number, number] {
    const cursor = this.list.selected;
    return this.anchor === null ? [cursor, cursor] : [Math.min(this.anchor, cursor), Math.max(this.anchor, cursor)];
  }

  private editMessage(index: number | null, text: string): void {
    const state = TextareaState.new({ value: text, rows: 10 });
    this.message = { index, state, error: null };
    state.focus();
  }

  private setAction(action: RebaseAction): void {
    const [start, end] = this.range();
    const plan = this.plan;
    if (!plan) return;
    if (action === "reword") {
      if (start !== end) {
        this.status = "Reword edits one commit at a time.";
        return;
      }
      const entry = plan.entries[start];
      if (entry) this.editMessage(start, entry.message);
      return;
    }
    for (const entry of plan.entries.slice(start, end + 1)) entry.action = action;
    this.anchor = null;
    this.status = "";
  }

  private move(delta: -1 | 1): void {
    const [start, end] = this.range();
    const entries = this.plan?.entries;
    if (!entries) return;
    if (delta < 0 && start === 0) return;
    if (delta > 0 && end + 1 >= entries.length) return;
    const moved = entries.splice(delta < 0 ? start - 1 : end + 1, 1);
    entries.splice(delta < 0 ? end : start, 0, ...moved);
    this.list.selected += delta;
    if (this.anchor !== null) this.anchor += delta;
  }

  private choose(index: number): void {
    this.menu = null;
    if (index === 6) this.move(-1);
    else if (index === 7) this.move(1);
    else {
      const action = REBASE_ACTIONS[index];
      if (action) this.setAction(action);
    }
  }

  private start(): void {
    const plan = this.plan;
    if (!plan) return;
    const invalid = validatePlan(plan);
    if (invalid) this.status = invalid;
    else this.confirmation = { kind: "start", plan: { ...plan, entries: plan.entries.map((entry) => ({ ...entry })) } };
  }

  private submit(task: RebaseTask, cx: AsyncContext): void {
    const services = this.host.services;
    this.busy = true;
    this.confirmation = null;
    this.status = "Running interactive rebase…";
    services.mutate(
      services.context(),
      "Running",
      async (git, cx) => {
        try {
          const result = await runRebase(git, task);
          if (!this.isOpen()) return;
          if (!result.active) {
            this.close(cx);
            showResult(services.overlay, "Interactive rebase", result.success, result.output, undefined, cx);
            return;
          }
          this.busy = false;
          this.status = result.output;
          this.amendMessage = result.message;
          if (this.plan) this.plan.active = true;
        } catch (error) {
          this.busy = false;
          this.status = errorMessage(error);
        }
      },
      cx,
    );
  }

  private messageKey(key: string, cx: AsyncContext): boolean {
    const message = this.message;
    if (!message) return false;
    if (key === "escape") this.closeMessage();
    else if (key === "ctrl-u") message.state.set_value("");
    else if (key === "enter") {
      const text = message.state.value();
      if (!text.trim()) {
        message.error = "Enter a commit message.";
        return true;
      }
      const index = message.index;
      this.closeMessage();
      const entry = index === null ? null : this.plan?.entries[index];
      if (entry) {
        entry.message = text;
        entry.action = "reword";
      } else if (index === null) this.submit({ kind: "amend", message: text }, cx);
    } else return false;
    return true;
  }

  private menuKey(event: KeyEvent): boolean {
    const menu = this.menu;
    if (!menu) return false;
    const index = KEYS.indexOf(event.key);
    if (event.keystroke === "escape") this.menu = null;
    else if (event.keystroke === "enter") this.choose(menu.selected);
    else if (index >= 0 && event.keystroke.length === 1) this.choose(index);
    else menu.key(event, MENU_ROWS, false);
    return true;
  }

  private recover(key: string, cx: AsyncContext): boolean {
    if (key === "c") this.submit({ kind: "continue" }, cx);
    else if (key === "s") this.confirmation = { kind: "skip" };
    else if (key === "a") this.confirmation = { kind: "abort" };
    else if (key === "m") this.editMessage(null, this.amendMessage);
    else return false;
    return true;
  }

  private listKey(event: KeyEvent, plan: RebasePlan): boolean {
    const key = event.keystroke;
    const length = plan.entries.length;
    const index = KEYS.indexOf(key);
    if (key === "space") plan.updateRefs = !plan.updateRefs;
    else if (key === "enter") this.start();
    else if (key === "ctrl-up") this.choose(6);
    else if (key === "ctrl-down") this.choose(7);
    else if (key === "?" || key === "shift-/") this.menu = new ListViewport("git-rebase-menu");
    else if (key === "v" && this.anchor === null && length) {
      this.anchor = this.list.selected;
      this.status = "";
    } else if (key.length === 1 && index >= 0) this.choose(index);
    else return this.list.key(event, length, false) === "moved";
    return true;
  }

  private modalKey(key: string, cx: Context): boolean | null {
    if (this.busy) {
      if (key === "escape" && !this.plan) this.close(cx);
      return true;
    }
    if (this.confirmation) {
      if (key === "escape") this.confirmation = null;
      else if (key === "enter") this.submit(this.confirmation, cx);
      return true;
    }
    return null;
  }

  protected key(event: KeyEvent, cx: Context): boolean {
    const key = event.keystroke;
    const modal = this.modalKey(key, cx);
    if (modal !== null) return modal;
    if (this.message) return this.messageKey(key, cx);
    if (this.menu) return this.menuKey(event);
    if (key === "escape") {
      if (this.anchor === null) this.close(cx);
      this.anchor = null;
      this.status = "";
      return true;
    }
    const plan = this.plan;
    if (!plan) return false;
    if (plan.active) return this.recover(key, cx);
    return this.listKey(event, plan);
  }

  private actionColor(look: Look, action: RebaseAction): Color {
    if (action === "drop") return look.t.error;
    if (action === "pick") return look.t.success;
    return look.t.warning;
  }

  private table(look: Look, plan: RebasePlan): Element {
    const { t } = look;
    const [first, last] = this.range();
    const visual = this.anchor !== null;
    const cell = (width: number, text: string, color: Color = t.text) =>
      div()
        .flex_none()
        .w(width * look.cell)
        .truncate()
        .text_color(color)
        .child(text);
    const header = h_flex()
      .h(look.row)
      .pl(2 * look.cell)
      .text_color(t.accent)
      .font_weight(700)
      .child(cell(9, "Action", t.accent))
      .child(div().flex_1().child("Commit"))
      .child(cell(18, "Author", t.accent))
      .child(cell(8, "SHA", t.accent))
      .child(cell(10, "Date", t.accent));
    return v_flex()
      .flex_1()
      .min_h(0)
      .child(header)
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .child(
            this.list.render(look, {
              length: plan.entries.length,
              focused: !visual,
              marker: true,
              row: ({ index }) => {
                const entry = plan.entries[index];
                if (!entry) return div();
                return h_flex()
                  .flex_1()
                  .min_w(0)
                  .when(visual && index >= first && index <= last, (el) => el.bg(t.selection))
                  .child(cell(9, REBASE_LABELS[entry.action], this.actionColor(look, entry.action)))
                  .child(
                    div()
                      .flex_1()
                      .min_w(0)
                      .truncate()
                      .child(entry.message.split("\n")[0] ?? ""),
                  )
                  .child(cell(18, entry.author))
                  .child(cell(8, entry.sha.slice(0, 8)))
                  .child(cell(10, entry.date));
              },
              onActivate: (index) => {
                this.list.selected = index;
                this.anchor = null;
                this.menu = new ListViewport("git-rebase-menu");
              },
            }),
          ),
      );
  }

  private actionKeys(look: Look): Element {
    const row = h_flex().h(look.row);
    REBASE_ACTIONS.forEach((action, index) => {
      if (index) row.child(div().child("  "));
      row
        .child(div().text_color(look.t.hint).child(`${KEYS[index]} `))
        .child(div().text_color(this.actionColor(look, action)).child(REBASE_LABELS[action]));
    });
    return row;
  }

  private guidance(look: Look): Element {
    const { t } = look;
    const [first, last] = this.range();
    if (this.status) return div().h(look.row).truncate().text_color(t.warning).child(this.status);
    if (this.anchor !== null)
      return div()
        .h(look.row)
        .text_color(t.accent)
        .child(`Visual: ${last - first + 1} commits · p/e/s/f/d set all · Ctrl+↑/↓ move the block · Esc clear`);
    return div().h(look.row).text_color(t.hint).child("v select lines · Ctrl+↑/↓ move commit · ? what the keys do");
  }

  private recovery(look: Look): Element {
    const row = h_flex().h(look.row);
    for (const [key, label] of [
      ["c", "[c] Continue"],
      ["s", "[s] Skip"],
      ["a", "[a] Abort"],
      ["m", "[m] Amend message"],
    ] as const)
      row.child(
        div()
          .id(`git-rebase-${key}`)
          .flex_1()
          .text_color(look.t.accent)
          .cursor_pointer()
          .child(label)
          .on_click((_, cx) => {
            this.recover(key, cx);
            cx.notify();
          }),
      );
    return row;
  }

  private overlayPanel(look: Look): Element | null {
    const { t } = look;
    if (this.confirmation) {
      const task = this.confirmation;
      const text =
        task.kind === "start"
          ? `Rewrite ${task.plan.entries.length} commits on ${task.plan.branch}?\nTarget: ${task.plan.target}\nUpdate dependent branches: ${task.plan.updateRefs}`
          : task.kind === "skip"
            ? "Skip the current commit and continue?"
            : "Abort rebase and restore the original branch?";
      return box(
        look,
        { id: "git-rebase-confirm", title: "Confirm interactive rebase" },
        v_flex()
          .size_full()
          .child(div().flex_1().whitespace_normal().child(text))
          .child(
            dialogFooter(
              look,
              { id: "git-rebase-confirm-run", label: "[Enter] Confirm", onClick: (cx) => this.submit(task, cx) },
              {
                id: "git-rebase-confirm-back",
                label: "[Esc] Back",
                onClick: () => {
                  this.confirmation = null;
                },
              },
            ),
          ),
      ).h(rows(look, 10));
    }
    const message = this.message;
    if (message)
      return box(
        look,
        { id: "git-rebase-message", title: "Commit message", focused: true },
        v_flex()
          .size_full()
          .child(Textarea.new(message.state).flex_1().text_color(t.text))
          .child(
            div()
              .h(rows(look, 2))
              .text_color(message.error ? t.error : t.hint)
              .child(message.error ?? "Enter saves · Shift+Enter new line · Ctrl+U clears · paste supported"),
          )
          .child(
            dialogFooter(
              look,
              { id: "git-rebase-message-save", label: "[Enter] Save", onClick: (cx) => this.messageKey("enter", cx) },
              { id: "git-rebase-message-cancel", label: "[Esc] Cancel", onClick: () => this.closeMessage() },
            ),
          ),
      ).h(rows(look, 20));
    return this.menuPanel(look);
  }

  private menuPanel(look: Look): Element | null {
    const menu = this.menu;
    if (!menu) return null;
    const { t } = look;
    const [first, last] = this.range();
    const title = last > first ? `Actions for ${last - first + 1} commits` : "Actions";
    return box(
      look,
      { id: "git-rebase-menu-box", title },
      v_flex()
        .size_full()
        .child(
          v_flex()
            .flex_1()
            .min_h(0)
            .child(
              menu.render(look, {
                length: MENU_ROWS,
                focused: true,
                marker: true,
                row: ({ index }) => {
                  const action = REBASE_ACTIONS[index];
                  if (!action)
                    return h_flex()
                      .child(
                        div()
                          .text_color(t.accent)
                          .child(index === 6 ? "Ctrl+↑  " : "Ctrl+↓  "),
                      )
                      .child(div().child(index === 6 ? "Move up" : "Move down"));
                  return h_flex()
                    .child(div().text_color(t.accent).child(`${KEYS[index]}  `))
                    .child(div().text_color(this.actionColor(look, action)).child(padToWidth(REBASE_LABELS[action], 8)))
                    .child(div().child(REBASE_DESCRIPTIONS[action]));
                },
                onActivate: (index) => this.choose(index),
              }),
            ),
        )
        .child(
          div()
            .h(look.row)
            .text_color(t.hint)
            .child("Press the key itself on the list, or pick a row here · Esc closes"),
        ),
    ).h(rows(look, 12));
  }

  protected body(look: Look): Element {
    const { t } = look;
    const plan = this.plan;
    const content = v_flex().flex_1().min_h(0);
    if (plan) {
      content
        .child(div().h(look.row).child(`Rebase: ${plan.branch}`))
        .child(
          div()
            .h(look.row)
            .child(`On: ${truncateToWidth(plan.target, WIDTH - 8)}`),
        )
        .child(
          div()
            .id("git-rebase-update-refs")
            .h(look.row)
            .text_color(t.hint)
            .cursor_pointer()
            .child(`[${plan.updateRefs ? "x" : " "}] Update dependent branches  [Space]`)
            .on_click((_, cx) => {
              plan.updateRefs = !plan.updateRefs;
              cx.notify();
            }),
        );
      if (plan.active)
        content
          .child(div().flex_1().min_h(0).whitespace_normal().overflow_hidden().child(this.status))
          .child(this.recovery(look));
      else content.child(this.table(look, plan));
    }
    const footer = v_flex().flex_none().h(rows(look, 2));
    if (this.busy) footer.child(div().h(look.row).text_color(t.hint).child(`⠋ ${this.status}`));
    else if (!plan) footer.child(div().text_color(t.error).child(this.status));
    else if (!plan.active) footer.child(this.actionKeys(look)).child(this.guidance(look));
    const active = !!plan?.active;
    const layer = this.overlayPanel(look);
    return v_flex()
      .relative()
      .size_full()
      .min_h(rows(look, 24))
      .child(content)
      .child(footer)
      .child(
        dialogFooter(
          look,
          {
            id: "git-rebase-primary",
            label: active ? "Resolve / stage in Changes" : "[Enter] Rebase",
            enabled: !active,
            onClick: () => this.start(),
          },
          { id: "git-rebase-close", label: "[Esc] Close", onClick: (cx) => this.close(cx) },
        ),
      )
      .when(layer !== null, (el) =>
        el.child(
          v_flex()
            .absolute()
            .inset_0()
            .items_center()
            .justify_center()
            .child(
              div()
                .w(76 * look.cell)
                .bg(t.background)
                .child(layer ?? div()),
            ),
        ),
      );
  }
}
