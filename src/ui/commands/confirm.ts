import { v_flex } from "gpui-base";
import { type AsyncContext, type Context, div, type Element, type KeyEvent } from "gpui-kit";
import { commitSubject, type GitOperation, operationPreview } from "../../git/workflows.ts";
import { shortCommit } from "../shell.ts";
import { DIALOG, type Look } from "../theme.ts";
import { dialogFooter, footerHint } from "../widgets.ts";
import { type CommandId, TITLES } from "./catalog.ts";
import type { CommandHost } from "./host.ts";

const RECOVERY = "The repository may change. Conflicts are left intact for recovery.";
const FORCE = "Overwrites the remote branch. The lease refuses the push when the remote moved since your last fetch.";

function commitTarget(operation: GitOperation): string | null {
  switch (operation.kind) {
    case "checkout-commit":
    case "cherry-pick":
    case "revert":
    case "rebase":
      return operation.target;
    default:
      return null;
  }
}

interface Facts {
  branch: string;
  root: string;
  label: string;
}

function historyText(operation: GitOperation, facts: Facts, preview: string): string | null {
  switch (operation.kind) {
    case "checkout-commit":
      return `Checkout target: ${facts.label}\n\n${preview}\n\nChecks out this commit with a detached HEAD.`;
    case "checkout-branch":
      return `Checkout branch: ${operation.name}\n\n${preview}\n\nSwitches the working tree to this branch.`;
    case "cherry-pick":
    case "revert":
      return `Current branch: ${facts.branch}\n${operation.kind === "cherry-pick" ? "Commit to apply" : "Commit to revert"}: ${facts.label}\n\n${preview}\n\nConflicts are left intact for recovery.`;
    case "rebase":
      return `Branch: ${facts.branch}\nRebase onto: ${facts.label}\n\n${preview}\n\nRewrites commit history.`;
    default:
      return null;
  }
}

function describe(operation: GitOperation, facts: Facts): string {
  const preview = operationPreview(operation);
  if (operation.kind === "discard-tracked")
    return `Repository: ${facts.root}\nRestore to HEAD: ${operation.head}\n\nDiscard ALL staged and unstaged changes to tracked files?\nUntracked files are kept. Submodule working trees are not restored.\n\nThis permanently deletes uncommitted tracked-file changes.\nFilename case collisions may prevent a clean working tree.\n\n${preview}`;
  if (operation.kind === "pull" || operation.kind === "push")
    return `Branch: ${facts.branch}\n\n${preview}\n\n${operation.kind === "push" && operation.force ? FORCE : RECOVERY}`;
  if (operation.kind === "remove-remote")
    return `Remove remote ${operation.name}?\n\n${preview}\n\nRemoves its local configuration and remote-tracking branches.`;
  return historyText(operation, facts, preview) ?? `Run this Git operation?\n\n${preview}\n\n${RECOVERY}`;
}

function stripRef(target: string): string {
  if (target.startsWith("refs/heads/")) return target.slice("refs/heads/".length);
  if (target.startsWith("refs/remotes/")) return target.slice("refs/remotes/".length);
  return target;
}

async function facts(host: CommandHost, operation: GitOperation): Promise<Facts> {
  const repository = host.services.repository();
  const branch = host.context().branch ?? "detached HEAD";
  const root = repository?.state === "ready" ? repository.root : "";
  const target = commitTarget(operation);
  if (!target) return { branch, root, label: "" };
  const shown = stripRef(target);
  const git = host.services.git();
  const subject = git && /^[0-9a-f]{40,64}$/.test(target) ? await commitSubject(git, target) : null;
  return { branch, root, label: subject === null ? shown : `${shortCommit(target)} · ${subject}` };
}

export function openConfirm(host: CommandHost, command: CommandId, operation: GitOperation, cx: AsyncContext): void {
  const context = host.services.context();
  cx.spawn(async (cx) => {
    const details = await facts(host, operation);
    if (context !== host.services.context()) return;
    if (operation.kind === "push") {
      new PushConfirm(host, operation, details).open();
      cx.notify();
      return;
    }
    host.services.overlay.open({
      kind: "confirm",
      title: "Confirm Git operation",
      width: DIALOG.medium,
      lines: [describe(operation, details)],
      hint: TITLES[command],
      onConfirm: (cx) => host.run(command, operation, cx),
    });
    cx.notify();
  });
}

class PushConfirm {
  private operation: Extract<GitOperation, { kind: "push" }>;

  constructor(
    private readonly host: CommandHost,
    operation: Extract<GitOperation, { kind: "push" }>,
    private readonly details: Facts,
  ) {
    this.operation = { ...operation };
  }

  open(): void {
    this.host.services.overlay.open({
      kind: "custom",
      title: "Confirm Git operation",
      width: DIALOG.medium,
      render: (look) => this.render(look),
      key: (event, cx) => this.key(event, cx),
    });
  }

  private cycle(delta: number): void {
    const remotes = this.host.context().remotes;
    if (!remotes.length) return;
    const index = remotes.indexOf(this.operation.remote);
    const next = remotes[(index + delta + remotes.length) % remotes.length];
    if (next) this.operation.remote = next;
  }

  private submit(cx: Context): void {
    this.host.services.overlay.close(cx);
    this.host.run("push", { ...this.operation }, cx);
  }

  private key(event: KeyEvent, cx: Context): boolean {
    if (event.keystroke === "enter") this.submit(cx);
    else if (event.keystroke === "left") this.cycle(-1);
    else if (event.keystroke === "right") this.cycle(1);
    else if (event.keystroke === "space") this.operation.force = !this.operation.force;
    else return false;
    return true;
  }

  private render(look: Look): Element {
    const { t } = look;
    const fallback = this.host.context().remotes[0] === this.operation.remote ? " (default)" : "";
    return v_flex()
      .min_w(0)
      .child(div().whitespace_normal().child(describe(this.operation, this.details)))
      .child(div().h(look.row))
      .child(
        div()
          .id("git-push-remote")
          .h(look.row)
          .text_color(t.hint)
          .cursor_pointer()
          .child(`Remote: ${this.operation.remote}${fallback}  [←/→] Change`)
          .on_click((_, cx) => {
            this.cycle(1);
            cx.notify();
          }),
      )
      .child(
        div()
          .id("git-push-force")
          .h(look.row)
          .text_color(this.operation.force ? t.warning : t.hint)
          .cursor_pointer()
          .child(`[${this.operation.force ? "x" : " "}] Force with lease  [Space]`)
          .on_click((_, cx) => {
            this.operation.force = !this.operation.force;
            cx.notify();
          }),
      )
      .child(footerHint(look, TITLES.push))
      .child(
        dialogFooter(
          look,
          { id: "git-push-run", label: "[Enter] Run", onClick: (cx) => this.submit(cx) },
          { id: "git-push-cancel", label: "[Esc] Cancel", onClick: (cx) => this.host.services.overlay.close(cx) },
        ),
      );
  }
}
