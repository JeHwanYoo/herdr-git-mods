import { h_flex, type InputState, v_flex } from "gpui-base";
import { type AsyncContext, type Context, div, type Element, type KeyEvent } from "gpui-kit";
import { type BranchInfo, branchName, readBranches } from "../../git/ref-operations.ts";
import { type GitOperation, operationPreview, validateName } from "../../git/workflows.ts";
import { type Color, DIALOG, type Look, rows } from "../theme.ts";
import { dialogFooter, ListViewport, truncateToWidth } from "../widgets.ts";
import { TITLES, unavailable } from "./catalog.ts";
import { Dialog, type DialogOptions, inputBox } from "./dialog.ts";
import { type CommandHost, errorMessage } from "./host.ts";

type NamedCommand = "branch-at-head" | "branch-at-commit" | "tag";

export function openNamePrompt(host: CommandHost, command: NamedCommand, value = "", error?: string): void {
  const overlay = host.services.overlay;
  overlay.open({
    kind: "form",
    title: TITLES[command],
    width: DIALOG.medium,
    fields: [{ label: "Name", value }],
    primary: "[Enter] Continue",
    onSubmit: (fields, cx) => {
      const name = (fields[0] ?? "").trim();
      const git = host.services.git();
      if (!git) return "Error: Not a Git repository";
      const context = host.context();
      const commit = command === "branch-at-head" ? context.head : context.selected;
      if (!commit) return `Error: ${command === "branch-at-head" ? "no commits available" : "no commit selected"}`;
      const repository = host.services.context();
      cx.spawn(async (cx) => {
        const invalid = await validateName(git, command === "tag" ? "tag" : "branch", name);
        if (repository !== host.services.context()) return;
        if (invalid) openNamePrompt(host, command, name, `Invalid name: ${invalid}`);
        else
          host.confirm(
            command,
            command === "tag" ? { kind: "create-tag", name, commit } : { kind: "create-branch", name, commit },
            cx,
          );
        cx.notify();
      });
      return null;
    },
  });
  if (error) overlay.setError(`Error: ${error}`);
}

type State =
  | { kind: "list" }
  | { kind: "rename"; branch: BranchInfo; input: InputState }
  | { kind: "delete"; branch: BranchInfo };
type Action = "new" | "rename" | "delete" | "refresh" | "close";

const ACTIONS: readonly { id: Action; label: string }[] = [
  { id: "new", label: "[Ctrl+N] New" },
  { id: "rename", label: "[F2] Rename" },
  { id: "delete", label: "[Del] Delete" },
  { id: "refresh", label: "[F5] Refresh" },
  { id: "close", label: "[Esc] Close" },
];

const isLocal = (branch: BranchInfo) => branch.reference.startsWith("refs/heads/");

export class BranchManager extends Dialog {
  private entries: BranchInfo[] = [];
  private loading = true;
  private readError: string | null = null;
  private message: { success: boolean; text: string } | null = null;
  private renameError: string | null = null;
  private preferred: string | null = null;
  private state: State = { kind: "list" };
  private readonly query: InputState;
  private readonly list = new ListViewport("git-branches");
  private request = 0;

  constructor(
    private readonly host: CommandHost,
    cx: AsyncContext,
  ) {
    super(host.services.overlay, cx);
    this.query = this.input();
  }

  open(cx: AsyncContext): void {
    this.show();
    this.query.focus();
    this.load(cx);
  }

  protected options(): DialogOptions {
    return { title: "Branches", width: DIALOG.wide, height: 20 };
  }

  protected override changed(): void {
    this.renameError = null;
    if (this.state.kind === "list") this.list.reset();
  }

  private load(cx: AsyncContext): void {
    const git = this.host.services.git();
    if (!git) return;
    const request = ++this.request;
    this.loading = true;
    this.readError = null;
    cx.spawn(async (cx) => {
      try {
        const entries = await readBranches(git);
        if (request !== this.request) return;
        this.entries = entries;
        const index = this.rows().findIndex((branch) => branch.reference === this.preferred);
        if (index >= 0) this.list.selected = index;
        this.preferred = null;
      } catch (error) {
        if (request !== this.request) return;
        this.readError = `F5 to retry. ${errorMessage(error)}`;
      }
      this.loading = false;
      this.list.clamp(this.rows().length);
      cx.notify();
    });
  }

  private rows(): BranchInfo[] {
    const query = this.query.value().toLowerCase();
    return this.entries.filter((branch) => branch.reference.toLowerCase().includes(query));
  }

  private selected(): BranchInfo | null {
    return this.rows()[this.list.selected] ?? null;
  }

  private mutating(): boolean {
    return this.host.services.busy() === "Managing branches";
  }

  private allowed(action: Action): string | null {
    if (action === "close") return null;
    if (this.loading) return "Loading branches. Please wait.";
    if (action === "new") return unavailable("branch-at-head", this.host.context());
    if (action === "refresh") return null;
    const branch = this.selected();
    if (!branch) return "Select a local branch.";
    if (!isLocal(branch)) return "Only local branches can be renamed or deleted.";
    if (action === "delete" && (branch.current || branch.worktree))
      return "Cannot delete a branch checked out in a worktree.";
    if (action === "rename" && !branch.current && branch.worktree)
      return "Cannot rename a branch checked out in another worktree.";
    return null;
  }

  private act(action: Action, cx: AsyncContext): void {
    if (this.mutating()) return;
    const reason = this.allowed(action);
    if (reason) {
      this.message = { success: false, text: reason };
      return;
    }
    const branch = this.selected();
    if (action === "close") this.close(cx);
    else if (action === "refresh") {
      this.state = { kind: "list" };
      this.load(cx);
    } else if (action === "new") {
      this.close(cx);
      this.host.dispatch("branch-at-head", cx);
    } else if (branch && action === "rename") {
      const input = this.input("", branchName(branch.reference));
      this.message = null;
      this.state = { kind: "rename", branch, input };
      input.focus();
    } else if (branch) {
      this.message = null;
      this.state = { kind: "delete", branch };
      this.handle.focus();
    }
  }

  private operation(): GitOperation | null {
    const state = this.state;
    if (state.kind === "rename")
      return {
        kind: "rename-branch",
        reference: state.branch.reference,
        name: state.input.value(),
        expected: state.branch.commit,
      };
    if (state.kind === "delete")
      return { kind: "delete-branch", reference: state.branch.reference, expected: state.branch.commit };
    return null;
  }

  private submit(cx: AsyncContext): void {
    if (this.mutating() || this.loading) return;
    const state = this.state;
    if (state.kind === "rename") {
      const name = state.input.value();
      if (!name) this.renameError = "Enter a branch name.";
      else if (name === branchName(state.branch.reference)) this.renameError = "Enter a different branch name.";
      if (this.renameError) return;
    }
    const operation = this.operation();
    if (!operation) return;
    this.host.run("branches", operation, cx, (success, output, cx) => this.finish(operation, success, output, cx));
  }

  private finish(operation: GitOperation, success: boolean, output: string, cx: AsyncContext): boolean {
    if (!this.isOpen()) return false;
    if (!success && operation.kind === "rename-branch" && this.state.kind === "rename") {
      this.renameError = output;
      return true;
    }
    this.state = { kind: "list" };
    this.query.focus();
    this.message = { success, text: output || (success ? "Branch updated." : "Branch change failed.") };
    this.preferred = operation.kind === "rename-branch" ? `refs/heads/${operation.name}` : null;
    this.load(cx);
    return true;
  }

  private cancelForm(): void {
    this.state = { kind: "list" };
    this.renameError = null;
    this.query.focus();
  }

  protected key(event: KeyEvent, cx: Context): boolean {
    const key = event.keystroke;
    if (this.state.kind !== "list") {
      if (key === "enter") this.submit(cx);
      else if (key === "escape") this.cancelForm();
      else if (key === "f5") this.act("refresh", cx);
      else return false;
      return true;
    }
    const shortcuts: Record<string, Action> = {
      "ctrl-n": "new",
      f2: "rename",
      enter: "rename",
      delete: "delete",
      f5: "refresh",
      escape: "close",
    };
    const action = shortcuts[key];
    if (action) this.act(action, cx);
    else return this.list.key(event, this.rows().length, false) === "moved";
    return true;
  }

  private selectionStatus(): { text: string; tone: "hint" | "text" }[] {
    const lines: { text: string; tone: "hint" | "text" }[] = [];
    const branch = this.selected();
    if (!this.rows().length)
      lines.push({ text: this.entries.length ? "No matching branches." : "No branches yet.", tone: "hint" });
    else if (branch) lines.push({ text: branch.reference, tone: "text" });
    const reason = this.message
      ? null
      : (["new", "rename", "delete"] as const).map((action) => this.allowed(action)).find(Boolean);
    if (reason) lines.push({ text: reason, tone: "hint" });
    return lines;
  }

  private statusLines(look: Look): Element[] {
    const { t } = look;
    const lines: Element[] = [];
    const line = (text: string, color: Color) => lines.push(div().whitespace_normal().text_color(color).child(text));
    if (this.loading) line("Loading branches", t.hint);
    if (this.readError) for (const text of this.readError.split("\n")) line(text, t.error);
    else if (!this.loading) for (const entry of this.selectionStatus()) line(entry.text, t[entry.tone]);
    if (this.message)
      for (const text of this.message.text.split("\n")) line(text, this.message.success ? t.accent : t.error);
    line("Remote branches reflect the last fetch.", t.hint);
    return lines;
  }

  private branchRow(look: Look, branch: BranchInfo, width: number): Element {
    const { t } = look;
    const local = isLocal(branch);
    const kind = local ? "Local" : "Remote";
    const flag = branch.current ? " *" : branch.worktree ? " Worktree" : "";
    const commit = branch.commit.slice(0, 8);
    const nameWidth = Math.max(1, width - 2 - (kind.length + commit.length + flag.length + 2));
    return h_flex()
      .child(
        div()
          .text_color(local ? t.accent : t.secondary)
          .child(kind),
      )
      .child(div().child(" "))
      .child(
        div()
          .text_color(t.text)
          .child(truncateToWidth(branchName(branch.reference), nameWidth)),
      )
      .child(div().child(" "))
      .child(div().text_color(t.hint).child(commit))
      .when(!!flag, (el) =>
        el.child(
          div()
            .text_color(branch.current ? t.accent : t.warning)
            .when(branch.current, (el) => el.font_weight(700))
            .child(flag),
        ),
      );
  }

  private listBody(look: Look): Element {
    const rowsList = this.rows();
    const buttons = h_flex().flex_none().gap(look.cell);
    for (const action of ACTIONS) {
      const enabled = this.allowed(action.id) === null;
      buttons.child(
        div()
          .id(`git-branches-${action.id}`)
          .flex_1()
          .min_w(0)
          .h(rows(look, 3))
          .flex()
          .items_center()
          .justify_center()
          .border(1)
          .border_color(look.t.rule)
          .text_color(enabled ? look.t.text : look.t.muted)
          .truncate()
          .when(enabled, (el) => el.cursor_pointer().hover((style) => style.bg(look.t.hover)))
          .child(action.label)
          .on_click((_, cx) => {
            cx.stop_propagation();
            this.act(action.id, cx);
            cx.notify();
          }),
      );
    }
    return v_flex()
      .size_full()
      .child(inputBox(look, "git-branches-search", "Search", this.query, true))
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .child(
            this.list.render(look, {
              length: rowsList.length,
              focused: true,
              marker: true,
              row: ({ index }) => {
                const branch = rowsList[index];
                return branch ? this.branchRow(look, branch, DIALOG.wide - 4) : div();
              },
              onSelect: (index) => {
                this.list.selected = index;
              },
            }),
          ),
      )
      .child(v_flex().flex_none().max_h(rows(look, 6)).overflow_hidden().children(this.statusLines(look)))
      .child(buttons);
  }

  private formBody(look: Look, state: Exclude<State, { kind: "list" }>): Element {
    const { t } = look;
    const busy = this.mutating();
    const details = v_flex().flex_1().min_h(0).overflow_hidden();
    const line = (text: string, color: Color) => details.child(div().whitespace_normal().text_color(color).child(text));
    if (busy) line("Applying branch change", t.hint);
    if (state.kind === "rename" && this.renameError) {
      for (const text of this.renameError.split("\n")) line(text, t.error);
      line("F5 refresh; Cancel to reselect.", t.hint);
    }
    if (state.kind === "delete") {
      line("Only deletes the local branch. Git refuses unmerged branches; remote branches are unchanged.", t.text);
      if (this.message) for (const text of this.message.text.split("\n")) line(text, t.error);
    }
    const operation = this.operation();
    line(operation ? operationPreview(operation) : "", t.accent);
    line(state.branch.reference, t.text);
    line(state.branch.commit, t.text);
    const repository = this.host.services.repository();
    line(repository?.state === "ready" ? repository.root : "", t.text);
    return v_flex()
      .size_full()
      .when(state.kind === "rename", (el) =>
        el.child(state.kind === "rename" ? inputBox(look, "git-branch-name", "New name", state.input, true) : div()),
      )
      .child(details)
      .child(
        dialogFooter(
          look,
          {
            id: "git-branch-submit",
            label: state.kind === "rename" ? "[Enter] Save" : "[Enter] Delete",
            enabled: !busy,
            onClick: (cx) => this.submit(cx),
          },
          { id: "git-branch-cancel", label: "[Esc] Cancel", enabled: !busy, onClick: () => this.cancelForm() },
        ),
      );
  }

  protected body(look: Look): Element {
    const state = this.state;
    return v_flex()
      .size_full()
      .min_h(rows(look, 16))
      .child(state.kind === "list" ? this.listBody(look) : this.formBody(look, state));
  }
}
