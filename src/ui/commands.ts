import type { AsyncContext, Context } from "gpui-kit";
import type { RebaseTarget } from "../git/rebase.ts";
import type { BranchTarget } from "../git/ref-operations.ts";
import { type GitOperation, operationPreview, ReviewedOperation, recoveryCommands } from "../git/workflows.ts";
import type { ChangesTab } from "./changes.ts";
import { BranchManager, openNamePrompt } from "./commands/branch.ts";
import {
  COMMANDS,
  type CommandContext,
  type CommandId,
  progressLabel,
  RESULT_NAMES,
  statusLabel,
  TITLES,
  unavailable,
} from "./commands/catalog.ts";
import { CommitDialog } from "./commands/commit.ts";
import { openConfirm } from "./commands/confirm.ts";
import { type CommandHost, errorMessage, type OperationDone } from "./commands/host.ts";
import { RebaseEditor } from "./commands/rebase.ts";
import { openAddRemote, RemoteList } from "./commands/remote.ts";
import { ResetFlow } from "./commands/reset.ts";
import { type ResultLine, showResult, showResultLines } from "./commands/result.ts";
import { type TargetCommand, TargetPicker } from "./commands/target.ts";
import { ModUpdate } from "./commands/update.ts";
import type { FilesTab } from "./explorer.ts";
import type { GraphTab } from "./graph.ts";
import type { PickerRow } from "./overlay.ts";
import type { AppShortcut, CommandHandler, GraphAction, QuickAction, QuickActionState, Services } from "./shell.ts";
import { DIALOG } from "./theme.ts";
import type { WorkspacesBox } from "./workspaces.ts";

const QUICK: Record<QuickAction, CommandId> = {
  fetch: "fetch",
  pull: "pull",
  commit: "commit",
  push: "push",
  branch: "branches",
  stash: "stash-changes",
};

const GRAPH: Record<GraphAction, CommandId> = {
  checkout: "checkout",
  rebase: "rebase",
  "cherry-pick": "cherry-pick",
  revert: "revert",
  reset: "reset",
  "copy-sha": "copy-sha",
};

const CONFIRMED: readonly CommandId[] = [
  "discard-all",
  "pull",
  "push",
  "cherry-pick",
  "revert",
  "stash-changes",
  "stash-pop",
];

export interface CommandTargets {
  changes: ChangesTab;
  graph: GraphTab;
  files: FilesTab;
  workspaces: WorkspacesBox;
}

function listStatus(query: string, count: number): string {
  if (!query) return "";
  if (count === 0) return "No matching commands";
  return count === 1 ? "1 matching command" : `${count} matching commands`;
}

function pullLines(preview: string, output: string, success: boolean): ResultLine[] {
  const lines: ResultLine[] = [{ text: preview, tone: "accent", bold: true }, { text: "" }];
  for (const line of output.split("\n")) {
    if (!success) lines.push({ text: line, tone: "error" });
    else if (line.startsWith("Updating ") || line === "Fast-forward" || line === "Already up to date.")
      lines.push({ text: line, tone: "success", bold: true });
    else lines.push({ text: line });
  }
  return lines;
}

export class Commands implements CommandHandler, CommandHost {
  private running: CommandId | null = null;
  readonly update: ModUpdate;

  constructor(
    readonly services: Services,
    private readonly targets: CommandTargets,
  ) {
    this.update = new ModUpdate(services.overlay);
  }

  release(): void {
    this.running = null;
    this.update.release();
  }

  context(): CommandContext {
    const repository = this.services.repository();
    const facts = this.services.facts();
    const ready = repository?.state === "ready" ? repository : null;
    return {
      repository: ready !== null,
      remotes: facts.remotes,
      branch: ready?.branch.name ?? null,
      upstream: ready?.branch.upstream ?? null,
      changes: (ready?.files.length ?? 0) > 0,
      staged: ready?.files.some((file) => file.staged !== null && file.staged !== "conflict") ?? false,
      stash: facts.stash,
      head: facts.head,
      selected: this.services.selectedCommit(),
    };
  }

  fail(name: string, message: string, cx?: AsyncContext): void {
    showResult(this.services.overlay, name, false, message, undefined, cx);
  }

  private rows(query: string): PickerRow[] {
    const context = this.context();
    return COMMANDS.filter((id) => TITLES[id].toLowerCase().includes(query)).map((id) => {
      const reason = unavailable(id, context);
      return {
        id,
        label: TITLES[id],
        status: (id === "update" ? this.update.status() : null) ?? statusLabel(reason),
        disabled: reason !== null,
      };
    });
  }

  openPalette(cx: Context): void {
    this.services.overlay.open({
      kind: "picker",
      title: "Commands",
      width: DIALOG.wide,
      columns: { label: "Command", status: "Status", width: 42 },
      rows: (query) => this.rows(query),
      footer: (query, count) => listStatus(query, count),
      primary: "[Enter] Run",
      secondary: "[Esc] Close",
      onChoose: (row, cx) => this.dispatch(row.id as CommandId, cx),
    });
    cx.notify();
  }

  quickAction(action: QuickAction, cx: Context): void {
    if (action === "stash") this.openStash(cx);
    else this.dispatch(QUICK[action], cx);
  }

  quickActionState(action: QuickAction): QuickActionState {
    const id = QUICK[action];
    const busy = this.services.busy();
    return {
      enabled:
        action === "stash" ? this.services.repository()?.state === "ready" : unavailable(id, this.context()) === null,
      running: busy && this.running === id ? progressLabel(id) : null,
    };
  }

  shortcut(shortcut: AppShortcut, cx: Context): boolean {
    if (shortcut === "workspace") this.targets.workspaces.manage(cx);
    else if (shortcut === "files-search") {
      if (this.services.activeTab() === "files") this.targets.files.shortcut("files-search");
      else {
        this.services.setTab("changes", cx);
        this.targets.changes.openFilesSearch(cx);
      }
    } else if (shortcut in QUICK) this.quickAction(shortcut as QuickAction, cx);
    else if (this.services.activeTab() !== "graph") return false;
    else if (shortcut === "actions") this.openCommitActions();
    else if (shortcut in GRAPH) this.graphAction(shortcut as GraphAction, cx);
    else return false;
    return true;
  }

  private graphAction(action: GraphAction, cx: AsyncContext): void {
    const context = this.context();
    const id = GRAPH[action];
    if (!context.selected) {
      this.fail(RESULT_NAMES[id], "no commit selected");
      return;
    }
    this.dispatch(id, cx);
  }

  private openCommitActions(): void {
    const sha = this.services.selectedCommit();
    if (!sha) return;
    const context = this.context();
    const ids: CommandId[] = [
      "branch-at-commit",
      "tag",
      "rebase",
      "interactive-rebase",
      "checkout",
      "cherry-pick",
      "revert",
      "reset",
      "copy-sha",
    ];
    this.services.overlay.open({
      kind: "picker",
      title: "Commit actions",
      search: false,
      rows: ids.map((id) => ({ id, label: TITLES[id], disabled: unavailable(id, context) !== null })),
      footer: sha.slice(0, 8),
      primary: "[Enter] Continue",
      onChoose: (row, cx) => this.dispatch(row.id as CommandId, cx),
    });
  }

  private openStash(cx: AsyncContext): void {
    if (this.services.repository()?.state !== "ready") {
      this.fail(RESULT_NAMES["stash-changes"], "not a Git repository", cx);
      return;
    }
    const context = this.context();
    this.services.overlay.open({
      kind: "picker",
      title: "Stash",
      width: DIALOG.medium,
      search: false,
      rows: (["stash-changes", "stash-pop"] as const).map((id) => {
        const reason = unavailable(id, context);
        return { id, label: TITLES[id], status: statusLabel(reason), disabled: reason !== null };
      }),
      footer: "Choose a stash operation",
      primary: "[Enter] Continue",
      onChoose: (row, cx) => this.dispatch(row.id as CommandId, cx),
    });
  }

  private openResetFlow(target: BranchTarget, cx: AsyncContext): void {
    const { branch, head } = this.context();
    if (!branch || !head) {
      this.fail(RESULT_NAMES.reset, "Checkout a branch before resetting", cx);
      return;
    }
    new ResetFlow(this, { branch, head, target }, cx).open();
  }

  private openRebaseEditor(target: RebaseTarget, cx: AsyncContext): void {
    new RebaseEditor(this, cx).open(target, cx);
  }

  private openTarget(id: TargetCommand, cx: AsyncContext): void {
    const context = this.context();
    const commit = context.selected ?? (id === "interactive-rebase" || id === "reset" ? context.head : null);
    if (!commit || !context.repository) return;
    new TargetPicker(this, id, commit, {
      rebase: (target, cx) => this.openRebaseEditor(target, cx),
      reset: (target, cx) => this.openResetFlow(target, cx),
    }).open(cx);
  }

  confirm(command: CommandId, operation: GitOperation, cx: AsyncContext): void {
    openConfirm(this, command, operation, cx);
  }

  run(command: CommandId, operation: GitOperation, cx: AsyncContext, done?: OperationDone): void {
    const services = this.services;
    if (services.busy()) {
      this.fail("Action", "Wait for the current Git operation.", cx);
      return;
    }
    const git = services.git();
    if (!git) {
      this.fail(RESULT_NAMES[command], "Not a Git repository", cx);
      return;
    }
    const context = services.context();
    this.running = command;
    cx.spawn(async (cx) => {
      let reviewed: ReviewedOperation;
      try {
        reviewed = await ReviewedOperation.review(git, operation);
      } catch (error) {
        this.fail(RESULT_NAMES[command], errorMessage(error), cx);
        cx.notify();
        return;
      }
      services.mutate(
        context,
        progressLabel(command),
        async (git, cx) => {
          let output: string;
          let success = true;
          try {
            output = await reviewed.run(git);
          } catch (error) {
            success = false;
            const recovery = recoveryCommands(operation);
            output = `${errorMessage(error)}${recovery ? `\n\nResolve conflicts, then use: ${recovery}` : ""}`;
          }
          if (!done?.(success, output, cx)) this.report(command, operation, success, output, cx);
          if (!success) throw new Error(output.split("\n")[0] ?? output);
        },
        cx,
      );
      cx.notify();
    });
  }

  private report(
    command: CommandId,
    operation: GitOperation,
    success: boolean,
    output: string,
    cx: AsyncContext,
  ): void {
    const overlay = this.services.overlay;
    const preview = operationPreview(operation);
    if (success && operation.kind === "remove-remote") {
      new RemoteList(this, cx).open(cx);
      return;
    }
    if (operation.kind === "pull") {
      showResultLines(
        overlay,
        `Pull ${success ? "complete" : "failed"}`,
        success,
        pullLines(preview, output, success),
        cx,
      );
      return;
    }
    const title =
      success && command === "commit" ? "✓ Committed" : `${RESULT_NAMES[command]} ${success ? "complete" : "failed"}`;
    const lines: ResultLine[] = [{ text: preview, tone: "accent", bold: true }, { text: "" }];
    for (const text of output.split("\n")) lines.push({ text, tone: success ? "text" : "error" });
    showResultLines(overlay, title, success, lines, cx);
  }

  private operation(id: CommandId): GitOperation | string {
    const context = this.context();
    switch (id) {
      case "discard-all":
        return context.head ? { kind: "discard-tracked", head: context.head } : "no HEAD commit to restore";
      case "fetch":
        return { kind: "fetch" };
      case "pull":
        return { kind: "pull" };
      case "push": {
        const remote = context.remotes[0];
        if (!remote) return "no remotes configured";
        return context.branch ? { kind: "push", force: false, remote, branch: context.branch } : "detached HEAD";
      }
      case "stash-changes":
        return { kind: "stash" };
      case "stash-pop":
        return { kind: "stash-pop" };
      default:
        return "operation is unavailable";
    }
  }

  private flows(id: CommandId, cx: AsyncContext): boolean {
    const flows: Partial<Record<CommandId, () => void>> = {
      update: () => this.update.open(cx),
      refresh: () => this.services.refresh("repository", cx),
      "switch-repository": () => this.targets.workspaces.manage(cx),
      reset: () => this.openTarget("reset", cx),
      "copy-sha": () => this.targets.graph.copySha(cx),
      commit: () => new CommitDialog(this, cx).open(),
      stash: () => this.openStash(cx),
      "add-remote": () => openAddRemote(this),
      "show-remotes": () => new RemoteList(this, cx).open(cx),
      branches: () => new BranchManager(this, cx).open(cx),
      checkout: () => this.openTarget("checkout", cx),
      rebase: () => this.openTarget("rebase", cx),
      "interactive-rebase": () => this.openTarget("interactive-rebase", cx),
      "cherry-pick": () => this.openTarget("cherry-pick", cx),
      revert: () => this.openTarget("revert", cx),
      "branch-at-head": () => openNamePrompt(this, "branch-at-head"),
      "branch-at-commit": () => openNamePrompt(this, "branch-at-commit"),
      tag: () => openNamePrompt(this, "tag"),
    };
    const flow = flows[id];
    flow?.();
    return flow !== undefined;
  }

  dispatch(id: CommandId, cx: AsyncContext): void {
    if (this.services.busy() && id !== "switch-repository") {
      this.fail("Action", "Wait for the current Git operation.", cx);
      return;
    }
    const reason = unavailable(id, this.context());
    if (reason) {
      this.fail(RESULT_NAMES[id], reason, cx);
      return;
    }
    if (!this.flows(id, cx)) {
      const operation = this.operation(id);
      if (typeof operation === "string") this.fail(RESULT_NAMES[id], `${TITLES[id]}: ${operation}`, cx);
      else if (CONFIRMED.includes(id)) this.confirm(id, operation, cx);
      else this.run(id, operation, cx);
    }
    cx.notify();
  }
}
