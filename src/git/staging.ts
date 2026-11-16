import type { RunGit } from "./repository.ts";

export type StagingOperation =
  | { kind: "stage-all" }
  | { kind: "unstage-all" }
  | { kind: "stage"; paths: string[] }
  | { kind: "unstage"; paths: string[] }
  | { kind: "discard"; paths: string[] };

function stages(operation: StagingOperation): boolean {
  return operation.kind === "stage-all" || operation.kind === "stage";
}

function args(operation: StagingOperation): string[] {
  if (operation.kind === "stage-all") return ["add", "--all"];
  if (operation.kind === "unstage-all") return ["restore", "--staged", "--", "."];
  if (operation.kind === "stage") return ["add", "--all", "--", ...operation.paths];
  if (operation.kind === "unstage") return ["restore", "--staged", "--", ...operation.paths];
  return ["--literal-pathspecs", "restore", "--worktree", "--", ...operation.paths];
}

function unbornArgs(operation: StagingOperation): string[] | null {
  if (operation.kind === "unstage-all") return ["rm", "--cached", "-r", "--ignore-unmatch", "--", "."];
  if (operation.kind === "unstage") return ["rm", "--cached", "--ignore-unmatch", "--", ...operation.paths];
  return null;
}

export function stagingPreview(operation: StagingOperation): string {
  return `git ${args(operation).join(" ")}`;
}

export function stagingLabel(operation: StagingOperation): string {
  if (operation.kind === "discard") return "Discarding";
  return stages(operation) ? "Staging" : "Unstaging";
}

export function stagingMessage(operation: StagingOperation): string {
  if (operation.kind === "stage-all") return "Staged all changes";
  if (operation.kind === "unstage-all") return "Unstaged all changes";
  if (operation.kind === "discard") return "Git index updated";
  const verb = operation.kind === "stage" ? "Staged" : "Unstaged";
  return operation.paths.length === 1
    ? `${verb} ${operation.paths[0] ?? ""}`
    : `${verb} ${operation.paths.length} selected files`;
}

function output(result: { stdout: string; stderr: string }): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout && stderr) return `${stdout}\n${stderr}`;
  return stdout || stderr || "Git completed without output.";
}

async function listed(git: RunGit, command: string[], selected: string[]): Promise<string[]> {
  const result = await git([...command, "--", ...selected]);
  if (result.code !== 0) throw new Error(`Could not verify the index update: ${result.stderr.trim()}`);
  return result.stdout.split("\0").filter(Boolean);
}

async function verifyStaging(git: RunGit, operation: StagingOperation): Promise<void> {
  const stage = stages(operation);
  const selected = operation.kind === "stage-all" || operation.kind === "unstage-all" ? [] : operation.paths;
  const remaining = await listed(
    git,
    ["diff", "--name-only", "-z", "--ignore-submodules=dirty", ...(stage ? [] : ["--cached"])],
    selected,
  );
  if (stage) remaining.push(...(await listed(git, ["ls-files", "--others", "--exclude-standard", "-z"], selected)));
  const unique = [...new Set(remaining)].sort();
  if (unique.length === 0) return;
  const lines = [
    `Git completed, but ${unique.length} requested paths remain ${stage ? "unstaged" : "staged"}:`,
    ...unique.slice(0, 20),
  ];
  if (unique.length > 20) lines.push(`... and ${unique.length - 20} more`);
  lines.push("The operation may have applied partially. Review the refreshed file list.");
  if (stage)
    lines.push(
      "Check for concurrent file edits or filename case collisions. Case-colliding files require a case-sensitive filesystem.",
    );
  throw new Error(lines.join("\n"));
}

async function verifyDiscard(git: RunGit, selected: string[]): Promise<void> {
  const result = await git([
    "--literal-pathspecs",
    "diff",
    "--name-only",
    "--ignore-submodules=dirty",
    "--",
    ...selected,
  ]);
  if (result.code !== 0) throw new Error("Could not verify the discard result. Review the refreshed file list.");
  if (result.stdout)
    throw new Error(
      `Discard incomplete. Changes remain. Check for filename case collisions or concurrent edits. Some files may already have been restored.\n\n${result.stdout}`,
    );
}

export async function runStaging(git: RunGit, operation: StagingOperation): Promise<string> {
  if (operation.kind === "discard" && operation.paths.length === 0)
    throw new Error("No tracked unstaged files selected.");
  const unborn = (await git(["rev-parse", "--verify", "--quiet", "HEAD"])).code !== 0;
  const result = await git((unborn ? unbornArgs(operation) : null) ?? args(operation));
  if (result.code !== 0) throw new Error(output(result));
  if (operation.kind === "discard") await verifyDiscard(git, operation.paths);
  else await verifyStaging(git, operation);
  return output(result);
}
