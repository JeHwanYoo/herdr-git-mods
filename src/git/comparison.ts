import { type ChangeKind, type FileChange, mapGit, type RunGit, readRepository } from "./repository.ts";

export type ChangeSection = "working" | "commit" | "staged" | "unstaged";

export interface WorkingChange {
  section: ChangeSection;
  status: string;
  path: string;
}

export interface DiffSummary {
  files: number;
  additions: number;
  deletions: number;
}

export type DiffTarget =
  | { kind: "working-index" }
  | { kind: "index-head" }
  | { kind: "commit"; commit: string; parent: string | null };

type CommitTarget = Extract<DiffTarget, { kind: "commit" }>;

export type ComparisonMode =
  | { kind: "last" }
  | { kind: "between"; base: string; compare: string }
  | { kind: "commit"; sha: string };

export interface ChangesSnapshot {
  changes: WorkingChange[];
  comparison: DiffTarget | null;
  summaries: Partial<Record<ChangeSection, DiffSummary>>;
  titles: Record<string, string>;
}

export interface BranchTarget {
  name: string;
  reference: string;
  commit: string;
}

const SECTION_ORDER: Record<ChangeSection, number> = { working: 0, commit: 0, staged: 1, unstaged: 2 };
const STATUS: Record<ChangeKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  type: "T",
  conflict: "U",
  untracked: "??",
};
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

async function run(git: RunGit, args: string[]): Promise<string> {
  const result = await git(args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0] ?? ""} exited with ${result.code}`);
  return result.stdout;
}

async function attempt(git: RunGit, args: string[]): Promise<string | null> {
  const result = await git(args);
  return result.code === 0 ? result.stdout : null;
}

async function difference(git: RunGit, args: string[]): Promise<string> {
  const result = await git(args);
  if (result.code === 0 || (result.code === 1 && result.stdout)) return result.stdout;
  throw new Error(result.stderr.trim() || `git ${args[0] ?? ""} exited with ${result.code}`);
}

export function sectionTarget(section: ChangeSection): DiffTarget | null {
  if (section === "staged") return { kind: "index-head" };
  if (section === "unstaged") return { kind: "working-index" };
  return null;
}

export function emptyTree(git: RunGit): Promise<string> {
  return run(git, ["hash-object", "-t", "tree", "/dev/null"]).then((value) => value.trim());
}

async function resolveCommit(git: RunGit, revision: string): Promise<string> {
  const value = revision.trim();
  if (!value) throw new Error("Choose a branch or commit.");
  return (await run(git, ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`])).trim();
}

async function optionalCommit(git: RunGit, revision: string): Promise<string | null> {
  const value = await attempt(git, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
  return value?.trim() || null;
}

function parseNameStatus(output: string, section: ChangeSection): WorkingChange[] {
  const changes: WorkingChange[] = [];
  const fields = output.split("\0");
  let index = 0;
  while (index < fields.length - 1) {
    const status = fields[index++] ?? "";
    let path = fields[index++];
    if (status.startsWith("R") || status.startsWith("C")) path = fields[index++];
    if (!status || path === undefined) throw new Error("Git returned an incomplete changed path");
    changes.push({ section, status, path });
  }
  return changes;
}

function parseNumstat(output: string): DiffSummary {
  const summary: DiffSummary = { files: 0, additions: 0, deletions: 0 };
  const records = output.split("\0");
  for (let index = 0; index < records.length - 1; index++) {
    const record = records[index] ?? "";
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) throw new Error("Git returned an incomplete diff summary");
    summary.files++;
    summary.additions += Number.parseInt(record.slice(0, first), 10) || 0;
    summary.deletions += Number.parseInt(record.slice(first + 1, second), 10) || 0;
    if (second === record.length - 1) index += 2;
  }
  return summary;
}

function workingChanges(files: readonly FileChange[]): WorkingChange[] {
  const changes: WorkingChange[] = [];
  for (const file of files) {
    if (file.staged) changes.push({ section: "staged", status: STATUS[file.staged], path: file.path });
    if (file.unstaged) changes.push({ section: "unstaged", status: STATUS[file.unstaged], path: file.path });
  }
  return changes.sort(
    (left, right) =>
      SECTION_ORDER[left.section] - SECTION_ORDER[right.section] ||
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
}

async function branchStart(git: RunGit, branch: string | null): Promise<string | null> {
  if (!branch) return null;
  const log = await attempt(git, ["reflog", "show", "--format=%H%x00%gs", branch]);
  if (!log) return null;
  for (const line of log.split("\n").reverse()) {
    const [sha, subject = ""] = line.split("\0");
    if (
      sha &&
      (subject.startsWith("branch: Created from ") ||
        subject.startsWith("commit (initial):") ||
        subject.startsWith("clone: from "))
    )
      return sha;
  }
  return null;
}

async function lastCommitTarget(git: RunGit, head: string): Promise<DiffTarget> {
  const [previous, branch] = await Promise.all([
    optionalCommit(git, "HEAD^1"),
    attempt(git, ["symbolic-ref", "--quiet", "HEAD"]).then((value) => value?.trim() || null),
  ]);
  if (!previous || branch === "refs/heads/main") return { kind: "commit", commit: head, parent: previous };
  const base = await branchStart(git, branch);
  if (!base) return { kind: "commit", commit: head, parent: previous };
  const ancestor = (await git(["merge-base", "--is-ancestor", base, previous])).code === 0;
  return { kind: "commit", commit: head, parent: ancestor ? previous : head };
}

async function comparisonBetween(git: RunGit, base: string, compare: string): Promise<CommitTarget> {
  const [parent, commit] = await Promise.all([resolveCommit(git, base), resolveCommit(git, compare)]);
  return { kind: "commit", commit, parent };
}

function targetArgs(target: DiffTarget, empty: () => Promise<string>): Promise<string[]> {
  if (target.kind === "working-index") return Promise.resolve([]);
  if (target.kind === "index-head") return Promise.resolve(["--cached"]);
  if (target.parent) return Promise.resolve([target.parent, target.commit]);
  return empty().then((tree) => [tree, target.commit]);
}

async function untrackedSummary(git: RunGit, paths: readonly string[]): Promise<DiffSummary> {
  const parts = await mapGit(paths, async (path) =>
    parseNumstat(
      await difference(git, [
        ...READ,
        "diff",
        "--no-ext-diff",
        "--no-index",
        "--numstat",
        "-z",
        "--",
        "/dev/null",
        path,
      ]),
    ),
  );
  return parts.reduce(
    (total, part) => ({
      files: total.files + part.files,
      additions: total.additions + part.additions,
      deletions: total.deletions + part.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

async function readSummary(
  git: RunGit,
  target: DiffTarget,
  untracked: readonly string[] = [],
  tracked = true,
): Promise<DiffSummary> {
  const args = await targetArgs(target, () => emptyTree(git));
  const [summary, extra] = await Promise.all([
    tracked
      ? run(git, [
          ...READ,
          "diff",
          "--no-ext-diff",
          "--numstat",
          "-z",
          "--find-renames",
          "--find-copies",
          ...args,
          "--",
        ]).then(parseNumstat)
      : Promise.resolve({ files: 0, additions: 0, deletions: 0 }),
    untrackedSummary(git, untracked),
  ]);
  return {
    files: summary.files + extra.files,
    additions: summary.additions + extra.additions,
    deletions: summary.deletions + extra.deletions,
  };
}

export async function readWorkingSummaries(
  git: RunGit,
  files: readonly FileChange[],
): Promise<ChangesSnapshot["summaries"]> {
  const summaries: ChangesSnapshot["summaries"] = {};
  const untracked = files.filter((file) => file.unstaged === "untracked").map((file) => file.path);
  await Promise.all(
    (["staged", "unstaged"] as const).map(async (section) => {
      const count = files.filter((file) => file[section]).length;
      if (count === 0) return;
      const target = sectionTarget(section);
      if (!target) return;
      const summary = await readSummary(
        git,
        target,
        section === "unstaged" ? untracked : [],
        files.some((file) => file[section] && file[section] !== "untracked"),
      );
      summaries[section] = { ...summary, files: count };
    }),
  );
  return summaries;
}

async function readTitles(git: RunGit, target: DiffTarget | null): Promise<Record<string, string>> {
  if (target?.kind !== "commit") return {};
  const revisions = target.parent ? [target.parent, target.commit] : [target.commit];
  const output = await attempt(git, ["log", "--no-walk", "--format=%H%x00%s", "--end-of-options", ...revisions, "--"]);
  const titles: Record<string, string> = {};
  for (const line of output?.split("\n") ?? []) {
    const [sha, subject] = line.split("\0");
    if (sha && subject !== undefined) titles[sha] = subject;
  }
  return titles;
}

async function commitChanges(git: RunGit, target: CommitTarget): Promise<WorkingChange[]> {
  const base = target.parent ?? (await emptyTree(git));
  return parseNameStatus(
    await run(git, ["diff", "--no-ext-diff", "--name-status", "-z", "-M", "-C", base, target.commit, "--"]),
    "commit",
  );
}

async function resolveLast(git: RunGit): Promise<DiffTarget | null> {
  const head = await optionalCommit(git, "HEAD");
  if (!head) return null;
  return lastCommitTarget(git, head);
}

async function resolveChanges(
  git: RunGit,
  mode: ComparisonMode,
  files: readonly FileChange[],
): Promise<{ changes: WorkingChange[]; comparison: DiffTarget | null }> {
  if (mode.kind !== "last") {
    const comparison =
      mode.kind === "between"
        ? await comparisonBetween(git, mode.base, mode.compare)
        : {
            kind: "commit" as const,
            commit: await resolveCommit(git, mode.sha),
            parent: await optionalCommit(git, `${mode.sha}^1`),
          };
    return { changes: await commitChanges(git, comparison), comparison };
  }
  const local = workingChanges(files);
  if (local.length > 0) return { changes: local, comparison: null };
  const comparison = await resolveLast(git);
  return { changes: comparison?.kind === "commit" ? await commitChanges(git, comparison) : [], comparison };
}

export async function readChanges(
  git: RunGit,
  mode: ComparisonMode,
  files?: readonly FileChange[],
): Promise<ChangesSnapshot> {
  let currentFiles = files ?? [];
  let currentGit = git;
  if (mode.kind === "last" && files === undefined) {
    const repository = await readRepository(git);
    if (repository.state !== "ready") throw new Error("Not a Git repository");
    currentFiles = repository.files;
    currentGit = (args) => git(["-C", repository.root, ...args]);
  }
  const { changes, comparison } = await resolveChanges(currentGit, mode, currentFiles);
  const [summaries, titles] = await Promise.all([
    comparison
      ? changes.length
        ? readSummary(currentGit, comparison).then((summary) => ({ commit: summary }))
        : Promise.resolve({})
      : readWorkingSummaries(currentGit, currentFiles),
    readTitles(currentGit, comparison),
  ]);
  return { changes, comparison, summaries, titles };
}

export async function readBranchTargets(git: RunGit): Promise<BranchTarget[]> {
  const output = await run(git, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%00%(refname:short)%00%(objectname)",
    "refs/heads",
    "refs/remotes",
  ]);
  const targets: BranchTarget[] = [];
  for (const record of output.split("\n")) {
    if (!record) continue;
    const [reference, name, commit] = record.split("\0");
    if (!reference || !name || !commit) throw new Error("Git returned an incomplete branch target");
    if (reference.startsWith("refs/remotes/") && name.endsWith("/HEAD")) continue;
    targets.push({ name, reference, commit });
  }
  return targets;
}
