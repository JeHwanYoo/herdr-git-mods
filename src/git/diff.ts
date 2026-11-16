import { type DiffTarget, emptyTree } from "./comparison.ts";
import type { FileChange, RunGit } from "./repository.ts";

export type DiffSide = "staged" | "unstaged";

export interface DiffDocument {
  text: string;
  binary: boolean;
  truncated: boolean;
}

export async function readDiff(git: RunGit, file: FileChange, side: DiffSide): Promise<DiffDocument> {
  if (file.staged === "conflict" || file.unstaged === "conflict")
    return preview(git, ["diff"], ["HEAD", "--", file.path]);
  const untracked = side === "unstaged" && file.unstaged === "untracked";
  const paths = file.from ? [file.from, file.path] : [file.path];
  const target = untracked
    ? ["--no-index", "--", "/dev/null", file.path]
    : [...(side === "staged" ? ["--cached"] : []), "--", ...paths];
  return preview(git, ["diff"], target, untracked);
}

export function readComparison(
  git: RunGit,
  base: string | null,
  target: string,
  file: { path: string; from?: string },
): Promise<DiffDocument> {
  const paths = file.from ? [file.from, file.path] : [file.path];
  return preview(git, base ? ["diff"] : ["diff-tree", "--root", "--no-commit-id", "-r"], [
    ...(base ? [base, target] : [target]),
    "--",
    ...paths,
  ]);
}

async function preview(
  git: RunGit,
  command: string[],
  target: string[],
  allowDifference = false,
): Promise<DiffDocument> {
  const args = [
    "--no-optional-locks",
    "--literal-pathspecs",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotePath=false",
    "-c",
    "diff.autoRefreshIndex=false",
    ...command,
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--find-renames",
    "--unified=100000",
  ];
  const run = async (format: string) => {
    const result = await git([...args, format, ...target]);
    if (result.code !== 0 && !(allowDifference && result.code === 1))
      throw new Error(result.stderr.trim() || `git diff exited with ${result.code}`);
    return result.stdout;
  };
  const stats = await run("--numstat");
  if (stats.startsWith("-\t-\t")) return { text: "", binary: true, truncated: false };
  const text = await run("--patch");
  return { text: text.slice(0, 200000), binary: false, truncated: text.length > 200000 };
}

const FULL_CONTEXT = "--unified=1000000";

export async function readTargetDiff(git: RunGit, target: DiffTarget, path: string): Promise<string> {
  if (target.kind === "working-index") {
    const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z", "--", path]);
    if (untracked.code === 0 && untracked.stdout.split("\0").includes(path)) {
      const result = await git([
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-color",
        FULL_CONTEXT,
        "--",
        "/dev/null",
        path,
      ]);
      if (result.code === 0 || (result.code === 1 && result.stdout)) return result.stdout;
      throw new Error(result.stderr.trim() || `git diff exited with ${result.code}`);
    }
  }
  const args = ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--find-copies", FULL_CONTEXT];
  if (target.kind === "index-head") args.push("--cached");
  if (target.kind === "commit") args.push(target.parent ?? (await emptyTree(git)), target.commit);
  const result = await git([...args, "--", path]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git diff exited with ${result.code}`);
  return result.stdout;
}

export interface BlameEntry {
  sha: string;
  author: string;
  authorEmail: string;
  authorTime: number;
  summary: string;
  line: number;
}

function parseBlameRecord(record: string): BlameEntry {
  const lines = record.split("\n");
  const [sha, , final] = (lines[0] ?? "").split(" ");
  const line = Number(final);
  if (!sha || !Number.isSafeInteger(line)) throw new Error("Git returned incomplete blame output");
  const entry: BlameEntry = { sha, author: "", authorEmail: "", authorTime: 0, summary: "", line };
  for (const field of lines.slice(1)) {
    if (field.startsWith("\t")) break;
    if (field.startsWith("author ")) entry.author = field.slice(7);
    else if (field.startsWith("author-mail ")) entry.authorEmail = field.slice(12).replace(/^<|>$/g, "");
    else if (field.startsWith("author-time ")) entry.authorTime = Number(field.slice(12)) || 0;
    else if (field.startsWith("summary ")) entry.summary = field.slice(8);
  }
  return entry;
}

export async function readBlameRange(
  git: RunGit,
  file: string,
  start: number,
  end: number,
  revision: string | null,
): Promise<BlameEntry[]> {
  const args = ["blame", "--line-porcelain", "-L", `${start},${end}`];
  if (revision) args.push(revision);
  const result = await git([...args, "--", file]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git blame exited with ${result.code}`);
  const entries: BlameEntry[] = [];
  let record: string[] = [];
  for (const line of result.stdout.split("\n")) {
    record.push(line);
    if (!line.startsWith("\t")) continue;
    entries.push(parseBlameRecord(record.join("\n")));
    record = [];
  }
  return entries;
}

export function blameRevision(target: DiffTarget): string | null {
  return target.kind === "commit" ? target.commit : null;
}
