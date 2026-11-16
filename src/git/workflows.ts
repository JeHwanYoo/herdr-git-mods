import type { RunGit } from "./repository.ts";

export type ResetMode = "soft" | "mixed" | "hard";

export type GitOperation =
  | { kind: "discard-tracked"; head: string }
  | { kind: "fetch" }
  | { kind: "pull" }
  | { kind: "commit"; message: string; amend: boolean }
  | { kind: "push"; force: boolean; remote: string; branch: string }
  | { kind: "add-remote"; name: string; url: string }
  | { kind: "remove-remote"; name: string }
  | { kind: "stash" }
  | { kind: "stash-pop" }
  | { kind: "create-branch"; name: string; commit: string }
  | { kind: "rename-branch"; reference: string; name: string; expected: string }
  | { kind: "delete-branch"; reference: string; expected: string }
  | { kind: "create-tag"; name: string; commit: string }
  | { kind: "checkout-commit"; target: string }
  | { kind: "checkout-branch"; name: string }
  | { kind: "rebase"; target: string }
  | { kind: "cherry-pick"; target: string }
  | { kind: "revert"; target: string }
  | { kind: "reset"; mode: ResetMode; target: string; targetName: string; branch: string; head: string };

function local(reference: string): string {
  return reference.startsWith("refs/heads/") ? reference.slice("refs/heads/".length) : reference;
}

const FIXED: Partial<Record<GitOperation["kind"], string[]>> = {
  fetch: ["fetch", "--all", "--prune"],
  pull: ["pull", "--ff-only"],
  stash: ["stash", "push", "--include-untracked"],
  "stash-pop": ["stash", "pop"],
};

function refArgs(operation: GitOperation): string[] | null {
  switch (operation.kind) {
    case "create-branch":
      return ["branch", "--", operation.name, operation.commit];
    case "rename-branch":
      return ["branch", "-m", "--", local(operation.reference), operation.name];
    case "delete-branch":
      return ["branch", "-d", "--", local(operation.reference)];
    case "create-tag":
      return ["tag", "--", operation.name, operation.commit];
    case "checkout-commit":
      return ["checkout", "--detach", operation.target];
    case "checkout-branch":
      return ["switch", "--", operation.name];
    default:
      return null;
  }
}

function historyArgs(operation: GitOperation): string[] | null {
  switch (operation.kind) {
    case "rebase":
      return ["rebase", operation.target];
    case "cherry-pick":
      return ["cherry-pick", operation.target];
    case "revert":
      return ["revert", "--no-edit", operation.target];
    case "reset":
      return ["reset", `--${operation.mode}`, operation.target];
    case "discard-tracked":
      return ["restore", `--source=${operation.head}`, "--staged", "--worktree", "--", "."];
    default:
      return null;
  }
}

function remoteArgs(operation: GitOperation): string[] | null {
  switch (operation.kind) {
    case "commit":
      return ["commit", ...(operation.amend ? ["--amend"] : []), "-m", operation.message];
    case "push":
      return [
        "push",
        ...(operation.force ? ["--force-with-lease"] : []),
        "--set-upstream",
        "--",
        operation.remote,
        `HEAD:refs/heads/${operation.branch}`,
      ];
    case "add-remote":
      return ["remote", "add", "--", operation.name, operation.url];
    case "remove-remote":
      return ["remote", "remove", "--", operation.name];
    default:
      return null;
  }
}

function operationArgs(operation: GitOperation): string[] {
  return FIXED[operation.kind] ?? refArgs(operation) ?? historyArgs(operation) ?? remoteArgs(operation) ?? [];
}

export function operationPreview(operation: GitOperation): string {
  return `git ${operationArgs(operation).join(" ")}`;
}

export function recoveryCommands(operation: GitOperation): string | null {
  if (operation.kind === "rebase") return "git rebase --continue | --skip | --abort";
  if (operation.kind === "cherry-pick") return "git cherry-pick --continue | --skip | --abort";
  if (operation.kind === "revert") return "git revert --continue | --skip | --abort";
  return null;
}

async function read(git: RunGit, args: string[]): Promise<string | null> {
  const result = await git(args);
  return result.code === 0 ? result.stdout.trim() : null;
}

async function must(git: RunGit, args: string[]): Promise<string> {
  const result = await git(args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} exited with ${result.code}`);
  return result.stdout.trim();
}

async function remoteNames(git: RunGit): Promise<string[]> {
  return (await must(git, ["remote"])).split("\n").filter(Boolean);
}

async function untrackedContent(git: RunGit): Promise<string[]> {
  const paths = (await must(git, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  const hashes: string[] = [];
  for (let index = 0; index < paths.length; index += 100)
    hashes.push(await must(git, ["hash-object", "--no-filters", "--", ...paths.slice(index, index + 100)]));
  return hashes;
}

async function fingerprint(git: RunGit): Promise<string> {
  return JSON.stringify([
    await read(git, ["rev-parse", "--verify", "HEAD"]),
    await read(git, ["symbolic-ref", "--quiet", "HEAD"]),
    await must(git, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    await must(git, ["diff", "--binary", "--no-ext-diff"]),
    await must(git, ["diff", "--cached", "--binary", "--no-ext-diff"]),
    await untrackedContent(git),
  ]);
}

async function branchGuard(git: RunGit, operation: GitOperation): Promise<void> {
  if (operation.kind !== "rename-branch" && operation.kind !== "delete-branch") return;
  if (!operation.reference.startsWith("refs/heads/")) throw new Error("Only local branches can be changed.");
  const record = await read(git, [
    "for-each-ref",
    "--format=%(objectname)%00%(HEAD)%00%(worktreepath)",
    operation.reference,
  ]);
  const [commit = "", head = "", worktree = ""] = (record ?? "").split("\0");
  if (commit !== operation.expected) throw new Error("Branch changed or no longer exists. Refresh and try again.");
  const current = head === "*";
  if (operation.kind === "delete-branch") {
    if (current || worktree) throw new Error("Cannot delete a branch checked out in a worktree.");
    return;
  }
  if (!current && worktree) throw new Error("Cannot rename a branch checked out in another worktree.");
  if (operation.name === local(operation.reference)) throw new Error("Enter a different branch name.");
  await must(git, ["check-ref-format", `refs/heads/${operation.name}`]);
}

async function guard(git: RunGit, operation: GitOperation): Promise<void> {
  if (operation.kind === "discard-tracked" && (await read(git, ["rev-parse", "HEAD"])) !== operation.head)
    throw new Error("Discard stopped because HEAD changed. Refresh and try again.");
  if (operation.kind === "push") {
    if ((await read(git, ["symbolic-ref", "--quiet", "--short", "HEAD"])) !== operation.branch)
      throw new Error("Push stopped because the current branch changed. Try again.");
    if (!(await remoteNames(git)).includes(operation.remote))
      throw new Error("The selected remote no longer exists. Try again.");
  }
  if (
    operation.kind === "reset" &&
    ((await read(git, ["symbolic-ref", "--quiet", "--short", "HEAD"])) !== operation.branch ||
      (await read(git, ["rev-parse", "--verify", "HEAD"])) !== operation.head)
  )
    throw new Error("Reset stopped because the current branch or HEAD changed. Refresh and try again.");
  await branchGuard(git, operation);
}

async function verifyDiscard(git: RunGit, head: string): Promise<void> {
  const remaining = await must(git, ["diff", "--name-only", "--ignore-submodules=dirty", head, "--"]);
  const staged = await must(git, ["diff", "--cached", "--name-only", head, "--"]);
  if (remaining || staged)
    throw new Error(
      `Discard incomplete. Tracked changes remain. Filename case collisions require a case-sensitive filesystem; concurrent edits can also leave changes.\nSome files may already have been restored. Review the file list.\n\n${remaining}\n${staged}`.trimEnd(),
    );
}

export class ReviewedOperation {
  private constructor(
    readonly operation: GitOperation,
    private readonly snapshot: string | null,
  ) {}

  static async review(git: RunGit, operation: GitOperation): Promise<ReviewedOperation> {
    return new ReviewedOperation(
      operation,
      operation.kind === "reset" || operation.kind === "discard-tracked" ? await fingerprint(git) : null,
    );
  }

  get preview(): string {
    return operationPreview(this.operation);
  }

  async run(git: RunGit): Promise<string> {
    if (this.snapshot !== null && (await fingerprint(git)) !== this.snapshot)
      throw new Error("Repository changed after review; review the operation again.");
    await guard(git, this.operation);
    const result = await git(["-c", "core.editor=true", ...operationArgs(this.operation)]);
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    const message = [stdout, stderr].filter(Boolean).join("\n") || "Git completed without output.";
    if (result.code !== 0) throw new Error(message);
    if (this.operation.kind === "discard-tracked") await verifyDiscard(git, this.operation.head);
    return message;
  }
}

export async function validateName(git: RunGit, kind: "branch" | "tag", name: string): Promise<string | null> {
  const result = await git(
    kind === "branch" ? ["check-ref-format", "--branch", name] : ["check-ref-format", `refs/tags/${name}`],
  );
  if (result.code === 0) return null;
  return result.stderr.trim() || `'${name}' is not a valid ${kind} name`;
}

export async function headMessage(git: RunGit): Promise<string> {
  return (await must(git, ["log", "-1", "--format=%B"])).trimEnd();
}

export async function commitSubject(git: RunGit, sha: string): Promise<string | null> {
  return read(git, ["show", "-s", "--format=%s", "--end-of-options", sha]);
}
