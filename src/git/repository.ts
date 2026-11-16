export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunGit = (args: string[]) => Promise<GitResult>;

export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "copied" | "type" | "conflict" | "untracked";

export interface FileChange {
  path: string;
  from?: string;
  staged: ChangeKind | null;
  unstaged: ChangeKind | null;
}

interface Branch {
  name: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export type Repository =
  | { state: "none" }
  | { state: "ready"; root: string; branch: Branch; files: FileChange[]; porcelain: string };

const GIT_PROCESSES = 8;

export async function mapGit<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const pending = items.entries();
  const reader = async (): Promise<void> => {
    for (const [index, item] of pending) results[index] = await read(item);
  };
  await Promise.all(Array.from({ length: Math.min(GIT_PROCESSES, items.length) }, reader));
  return results;
}

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

const KINDS: Record<string, ChangeKind> = {
  M: "modified",
  T: "type",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
};

export async function readRepository(git: RunGit): Promise<Repository> {
  const top = await git([...READ, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) {
    if (/not a git repository/i.test(top.stderr)) return { state: "none" };
    throw new Error(top.stderr.trim() || `git rev-parse exited with ${top.code}`);
  }
  const status = await git([
    ...READ,
    "-c",
    "status.relativePaths=false",
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=all",
  ]);
  if (status.code !== 0) throw new Error(status.stderr.trim() || `git status exited with ${status.code}`);
  return {
    state: "ready",
    root: top.stdout.replace(/\n$/, ""),
    ...parseRepositoryStatus(status.stdout),
    porcelain: status.stdout,
  };
}

export function parseRepositoryStatus(output: string): { branch: Branch; files: FileChange[] } {
  const branch: Branch = { name: null, detached: false, upstream: null, ahead: 0, behind: 0 };
  const files: FileChange[] = [];
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? "";
    if (record.startsWith("# ")) readBranchHeader(record.slice(2), branch);
    else if (record.startsWith("1 ")) files.push(changed(fields(record, 9)));
    else if (record.startsWith("2 ")) files.push({ ...changed(fields(record, 10)), from: records[++i] ?? "" });
    else if (record.startsWith("u "))
      files.push({ path: lastField(record, 11), staged: "conflict", unstaged: "conflict" });
    else if (record.startsWith("? ")) files.push({ path: record.slice(2), staged: null, unstaged: "untracked" });
  }
  return { branch, files: combineChanges(files) };
}

function combineChanges(files: FileChange[]): FileChange[] {
  const paths = new Map<string, FileChange>();
  for (const file of files) {
    const existing = paths.get(file.path);
    paths.set(
      file.path,
      existing
        ? {
            ...existing,
            staged: file.staged ?? existing.staged,
            unstaged: file.unstaged ?? existing.unstaged,
          }
        : file,
    );
  }
  return [...paths.values()];
}

function readBranchHeader(header: string, branch: Branch): void {
  const [key, ...rest] = header.split(" ");
  const value = rest.join(" ");
  if (key === "branch.head") {
    branch.detached = value === "(detached)";
    branch.name = branch.detached ? null : value;
  } else if (key === "branch.upstream") {
    branch.upstream = value;
  } else if (key === "branch.ab") {
    const [ahead, behind] = value.split(" ");
    branch.ahead = Math.abs(Number(ahead));
    branch.behind = Math.abs(Number(behind));
  }
}

function fields(record: string, count: number): string[] {
  const parts = record.split(" ");
  return [...parts.slice(0, count - 1), parts.slice(count - 1).join(" ")];
}

function lastField(record: string, count: number): string {
  return fields(record, count)[count - 1] ?? "";
}

function changed(parts: string[]): FileChange {
  const xy = parts[1] ?? "..";
  return {
    path: parts[parts.length - 1] ?? "",
    staged: KINDS[xy.charAt(0)] ?? null,
    unstaged: KINDS[xy.charAt(1)] ?? null,
  };
}
