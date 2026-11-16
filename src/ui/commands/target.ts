import type { AsyncContext } from "gpui-kit";
import type { RebaseTarget } from "../../git/rebase.ts";
import { type BranchTarget, readBranchTargets } from "../../git/ref-operations.ts";
import { commitSubject, type GitOperation } from "../../git/workflows.ts";
import type { PickerRow } from "../overlay.ts";
import { DIALOG } from "../theme.ts";
import { type CommandId, RESULT_NAMES } from "./catalog.ts";
import { type CommandHost, errorMessage } from "./host.ts";

type Choice = { operation: GitOperation } | { rebase: RebaseTarget } | { reset: BranchTarget };
export type TargetCommand = "checkout" | "rebase" | "interactive-rebase" | "cherry-pick" | "revert" | "reset";

export interface TargetFlows {
  rebase(target: RebaseTarget, cx: AsyncContext): void;
  reset(target: BranchTarget, cx: AsyncContext): void;
}

export class TargetPicker {
  private targets: BranchTarget[] = [];
  private loading = true;
  private error: string | null = null;
  private subject = "";
  private choices = new Map<string, Choice>();

  constructor(
    private readonly host: CommandHost,
    private readonly command: TargetCommand,
    private readonly commit: string,
    private readonly flows: TargetFlows,
  ) {}

  open(cx: AsyncContext): void {
    const services = this.host.services;
    this.subject = this.command === "interactive-rebase" && this.commit === this.host.context().head ? "HEAD" : "";
    services.overlay.open({
      kind: "picker",
      title: RESULT_NAMES[this.command],
      width: DIALOG.wide,
      rows: (query) => this.rows(query),
      footer: (query, count) => this.footer(query, count),
      primary: "[Enter] Continue",
      secondary: "[Esc] Cancel",
      onChoose: (row, cx) => this.choose(row, cx),
    });
    const git = services.git();
    const context = services.context();
    if (!git) return;
    cx.spawn(async (cx) => {
      try {
        const [targets, subject] = await Promise.all([readBranchTargets(git), commitSubject(git, this.commit)]);
        this.targets = targets;
        if (!this.subject) this.subject = subject ?? "";
      } catch (error) {
        this.error = `${errorMessage(error)}. Close and retry ${RESULT_NAMES[this.command]}.`;
      }
      if (context !== services.context()) return;
      this.loading = false;
      cx.notify();
    });
  }

  private commitChoice(commit: string, name: string): Choice {
    switch (this.command) {
      case "rebase":
        return { operation: { kind: "rebase", target: commit } };
      case "interactive-rebase":
        return { rebase: { kind: "inclusive", target: commit } };
      case "cherry-pick":
      case "revert":
        return { operation: { kind: this.command, target: commit } };
      case "reset":
        return { reset: { name, reference: commit, commit } };
      default:
        return { operation: { kind: "checkout-commit", target: commit } };
    }
  }

  private targetChoice(target: BranchTarget): { kind: string; choice: Choice } {
    const local = target.reference.startsWith("refs/heads/") ? target.reference.slice("refs/heads/".length) : null;
    const kind = local === null ? "remote branch" : "branch";
    switch (this.command) {
      case "rebase":
        return { kind, choice: { operation: { kind: "rebase", target: target.reference } } };
      case "interactive-rebase":
        return { kind, choice: { rebase: { kind: "onto", target: target.reference } } };
      case "cherry-pick":
      case "revert":
        return { kind, choice: { operation: { kind: this.command, target: target.commit } } };
      case "reset":
        return { kind, choice: { reset: target } };
      default:
        if (local !== null) return { kind: "branch", choice: { operation: { kind: "checkout-branch", name: local } } };
        return {
          kind: "remote, detached HEAD",
          choice: { operation: { kind: "checkout-commit", target: target.commit } },
        };
    }
  }

  private rows(query: string): PickerRow[] {
    const effect = this.command === "checkout" ? "detached HEAD" : "commit";
    const rows: PickerRow[] = [];
    this.choices.clear();
    const add = (id: string, label: string, choice: Choice) => {
      this.choices.set(id, choice);
      rows.push({ id, label });
    };
    if (/^[0-9a-f]{4,64}$/.test(query)) add(`hash:${query}`, `${query} · ${effect}`, this.commitChoice(query, query));
    if (!query)
      add(
        "commit",
        `${this.commit.slice(0, 8)} ${this.subject} · ${effect}`,
        this.commitChoice(this.commit, this.subject || this.commit.slice(0, 8)),
      );
    for (const target of this.targets) {
      if (!target.name.toLowerCase().includes(query)) continue;
      const { kind, choice } = this.targetChoice(target);
      add(`ref:${target.reference}`, `${target.name} · ${kind}`, choice);
    }
    return rows;
  }

  private footer(_query: string, count: number): string {
    if (this.loading) return "Loading branches";
    if (this.error) return `Error: ${this.error}`;
    return count ? "Choose a branch or type a commit hash" : "No matching branches or commit hash";
  }

  private choose(row: PickerRow, cx: AsyncContext): void {
    const choice = this.choices.get(row.id);
    if (!choice) return;
    if ("rebase" in choice) this.flows.rebase(choice.rebase, cx);
    else if ("reset" in choice) this.flows.reset(choice.reset, cx);
    else this.host.confirm(this.command as CommandId, choice.operation, cx);
  }
}
