import { readWorkingSummaries } from "./comparison.ts";
import { type FileChange, mapGit, parseRepositoryStatus, type Repository, type RunGit } from "./repository.ts";

export interface BranchStatus {
  checkedOut: string;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface ChangeOverview {
  changedPaths: number;
  additions: number;
  deletions: number;
}

export interface WorktreeStatus {
  path: string;
  overview: ChangeOverview;
  branch: BranchStatus;
  fingerprint: string;
}

export interface ProjectStatus {
  root: string;
  primary: WorktreeStatus;
  worktrees: WorktreeStatus[];
}

export type GitAt = (cwd: string) => RunGit;

interface WorktreeReport {
  branch: BranchStatus;
  files: readonly FileChange[];
  fingerprint: string;
}

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const CLEAN: ChangeOverview = { changedPaths: 0, additions: 0, deletions: 0 };

async function run(git: RunGit, args: string[]): Promise<string> {
  const result = await git([...READ, ...args]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} exited with ${result.code}`);
  return result.stdout;
}

async function worktreePaths(git: RunGit): Promise<string[]> {
  const output = await run(git, ["worktree", "list", "--porcelain", "-z"]);
  return output
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice(9));
}

export async function projectRoot(git: RunGit): Promise<string> {
  const top = await git([...READ, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new Error("Choose a directory inside a Git repository.");
  const [root] = await worktreePaths(git);
  if (!root) throw new Error("Git returned no worktrees");
  return root;
}

function aheadBehind(value: string): [number, number] {
  const [ahead, behind] = value.split(" ");
  const parse = (count: string | undefined, sign: string, label: string) => {
    const number = count?.startsWith(sign) ? Number(count.slice(1)) : Number.NaN;
    if (!Number.isInteger(number)) throw new Error(`Git returned an invalid ${label} count`);
    return number;
  };
  return [parse(ahead, "+", "ahead"), parse(behind, "-", "behind")];
}

function branchStatus(headers: ReadonlyMap<string, string>): BranchStatus {
  const head = headers.get("branch.head");
  if (head === undefined) throw new Error("Git returned a status without a branch head");
  const oid = headers.get("branch.oid");
  if (head === "(detached)" && oid === undefined) throw new Error("Git returned a detached status without a commit");
  const counts = headers.get("branch.ab");
  const [ahead, behind] = counts === undefined ? [0, 0] : aheadBehind(counts);
  return {
    checkedOut: head === "(detached)" ? `Detached ${(oid ?? "").slice(0, 8)}` : head,
    upstream: counts === undefined ? null : (headers.get("branch.upstream") ?? null),
    ahead,
    behind,
  };
}

function parseWorktreeReport(output: string, files?: readonly FileChange[]): WorktreeReport {
  const headers = new Map<string, string>();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index] ?? "";
    if (record.startsWith("# ")) {
      const [key = "", ...value] = record.slice(2).split(" ");
      headers.set(key, value.join(" "));
    } else if (record.startsWith("2 ")) {
      index++;
    }
  }
  return { branch: branchStatus(headers), files: files ?? parseRepositoryStatus(output).files, fingerprint: output };
}

async function changeOverview(git: RunGit, report: WorktreeReport): Promise<ChangeOverview> {
  if (report.files.length === 0) return CLEAN;
  const summaries = await readWorkingSummaries(git, report.files);
  return {
    changedPaths: report.files.length,
    additions: (summaries.staged?.additions ?? 0) + (summaries.unstaged?.additions ?? 0),
    deletions: (summaries.staged?.deletions ?? 0) + (summaries.unstaged?.deletions ?? 0),
  };
}

async function readReport(git: RunGit): Promise<WorktreeReport> {
  return parseWorktreeReport(
    await run(git, [
      "-c",
      "status.relativePaths=false",
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
    ]),
  );
}

export async function inspectWorktree(
  gitAt: GitAt,
  path: string,
  previous: WorktreeStatus | null,
  discover = true,
  repository?: Extract<Repository, { state: "ready" }>,
): Promise<WorktreeStatus> {
  const supplied = repository?.root === path ? repository : null;
  const report = supplied ? parseWorktreeReport(supplied.porcelain, supplied.files) : await readReport(gitAt(path));
  const root =
    supplied?.root ?? (discover ? (await run(gitAt(path), ["rev-parse", "--show-toplevel"])).replace(/\n$/, "") : path);
  const unchanged = previous?.path === root && previous.fingerprint === report.fingerprint ? previous : null;
  if (unchanged && report.files.length === 0) return unchanged;
  return {
    path: root,
    overview: await changeOverview(gitAt(root), report),
    branch: report.branch,
    fingerprint: report.fingerprint,
  };
}

export async function inspectProject(
  gitAt: GitAt,
  root: string,
  previous: readonly WorktreeStatus[],
  fresh: WorktreeStatus | null,
  repository?: Extract<Repository, { state: "ready" }>,
): Promise<ProjectStatus> {
  const paths = await worktreePaths(gitAt(root));
  const statuses = await mapGit(paths, (path) =>
    fresh?.path === path
      ? Promise.resolve(fresh)
      : inspectWorktree(gitAt, path, previous.find((status) => status.path === path) ?? null, false, repository),
  );
  const [primary, ...worktrees] = statuses;
  if (!primary) throw new Error("Git returned no worktrees");
  return { root: primary.path, primary, worktrees };
}
