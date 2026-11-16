import type { RunGit } from "./repository.ts";

export interface BranchInfo {
  reference: string;
  commit: string;
  current: boolean;
  worktree: string | null;
}

export interface BranchTarget {
  name: string;
  reference: string;
  commit: string;
}

async function must(git: RunGit, args: string[]): Promise<string> {
  const result = await git(args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} exited with ${result.code}`);
  return result.stdout;
}

export function branchName(reference: string): string {
  for (const prefix of ["refs/heads/", "refs/remotes/"])
    if (reference.startsWith(prefix)) return reference.slice(prefix.length);
  return reference;
}

export async function readBranches(git: RunGit): Promise<BranchInfo[]> {
  const output = await must(git, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(symref)%00%(worktreepath)",
    "refs/heads/",
    "refs/remotes/",
  ]);
  const branches: BranchInfo[] = [];
  for (const line of output.split("\n")) {
    const [reference = "", commit = "", head = "", symref = "", worktree = ""] = line.split("\0");
    if (!reference || !commit || symref) continue;
    branches.push({ reference, commit, current: head === "*", worktree: worktree || null });
  }
  return branches.sort(
    (left, right) =>
      Number(!left.current) - Number(!right.current) ||
      Number(!left.reference.startsWith("refs/heads/")) - Number(!right.reference.startsWith("refs/heads/")) ||
      branchName(left.reference).localeCompare(branchName(right.reference)),
  );
}

export async function readBranchTargets(git: RunGit): Promise<BranchTarget[]> {
  const output = await must(git, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%00%(refname:short)%00%(objectname)",
    "refs/heads",
    "refs/remotes",
  ]);
  const targets: BranchTarget[] = [];
  for (const line of output.split("\n")) {
    const [reference = "", name = "", commit = ""] = line.split("\0");
    if (!reference || !name || !commit) continue;
    if (reference.startsWith("refs/remotes/") && name.endsWith("/HEAD")) continue;
    targets.push({ name, reference, commit });
  }
  return targets;
}
