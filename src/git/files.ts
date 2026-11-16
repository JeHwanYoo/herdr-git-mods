import type { RunGit } from "./repository.ts";

const CONTENT_RESULT_LIMIT = 1000;

export async function readFiles(git: RunGit): Promise<string[]> {
  const results = await Promise.all([
    git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
    git(["diff", "--cached", "--name-only", "-z", "--diff-filter=D", "--find-renames", "--no-ext-diff"]),
  ]);
  for (const result of results) if (result.code !== 0) throw new Error(result.stderr || "Cannot list repository files");
  return [...new Set(results.flatMap((result) => result.stdout.split("\0").filter(Boolean)))].sort();
}

export interface LineChange {
  oldStart: number;
  removed: string[];
  newStart: number;
  added: number;
}

function hunkRange(range: string): [number, number] {
  const [start, count] = range.split(",");
  return [Number(start) || 0, count === undefined ? 1 : Number(count) || 0];
}

function parseLineChanges(output: string): LineChange[] {
  const changes: LineChange[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("@@ ")) {
      const [old = "", next = ""] = line.slice(3).split(" ");
      const [oldStart, oldCount] = hunkRange(old.replace(/^-/, ""));
      const [newStart, newCount] = hunkRange(next.replace(/^\+/, ""));
      changes.push({
        oldStart: oldCount === 0 ? oldStart + 1 : oldStart,
        removed: [],
        newStart: newCount === 0 ? newStart + 1 : newStart,
        added: newCount,
      });
    } else if (line.startsWith("-")) {
      changes.at(-1)?.removed.push(line.slice(1).replace(/\r$/, ""));
    }
  }
  return changes;
}

export async function readLineChanges(git: RunGit, path: string): Promise<LineChange[]> {
  const result = await git(["diff", "--no-ext-diff", "--no-color", "--no-renames", "--unified=0", "HEAD", "--", path]);
  return result.code === 0 ? parseLineChanges(result.stdout) : [];
}

export interface LineHistoryCommit {
  sha: string;
  author: string;
  authorTime: number;
  summary: string;
  patch: string;
}

export async function readLineHistory(
  git: RunGit,
  file: string,
  ranges: readonly (readonly [number, number])[],
  revision: string | null,
): Promise<LineHistoryCommit[]> {
  const args = [
    "log",
    "--no-color",
    "--max-count=100",
    "--format=%x1e%H%x1f%an%x1f%at%x1f%s",
    ...ranges.map(([start, end]) => `-L${start},${end}:${file}`),
  ];
  if (revision) args.push(revision);
  const result = await git(args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Line history failed");
  return result.stdout
    .split("\u001e")
    .filter((record) => record.trim())
    .map((record) => {
      const newline = record.indexOf("\n");
      const header = newline < 0 ? record : record.slice(0, newline);
      const [sha = "", author = "", time = "", ...summary] = header.split("\u001f");
      return {
        sha,
        author,
        authorTime: Number(time) || 0,
        summary: summary.join("\u001f"),
        patch: newline < 0 ? "" : record.slice(newline + 1).replace(/^\n+/, ""),
      };
    });
}

export interface ContentMatch {
  path: string;
  line: number;
  start: number;
  end: number;
}

function matchRange(text: string, query: string, ignoreCase: boolean): [number, number] {
  const index = ignoreCase ? text.toLowerCase().indexOf(query.toLowerCase()) : text.indexOf(query);
  return index < 0 ? [0, 0] : [index, index + query.length];
}

export async function searchContents(git: RunGit, query: string): Promise<ContentMatch[]> {
  if (!query.trim()) return [];
  const paths = await readFiles(git);
  const matches: ContentMatch[] = [];
  for (let offset = 0; offset < paths.length && matches.length < CONTENT_RESULT_LIMIT; offset += 512) {
    matches.push(
      ...(await searchBatch(git, query, paths.slice(offset, offset + 512), CONTENT_RESULT_LIMIT - matches.length)),
    );
  }
  return matches;
}

async function searchBatch(git: RunGit, query: string, paths: string[], limit: number): Promise<ContentMatch[]> {
  const ignoreCase = query === query.toLowerCase();
  const result = await git([
    "--literal-pathspecs",
    "grep",
    "--threads=2",
    `--max-count=${limit}`,
    "--no-color",
    "--no-ext-grep",
    "--no-textconv",
    "--no-column",
    "--no-heading",
    "--no-break",
    "--full-name",
    "-H",
    ignoreCase ? "--ignore-case" : "--no-ignore-case",
    "--untracked",
    "--exclude-standard",
    "-I",
    "-n",
    "-z",
    "-F",
    "-e",
    query,
    "--",
    ...paths,
  ]);
  if (result.code === 1) return [];
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Content search failed");
  const matches: ContentMatch[] = [];
  const output = result.stdout;
  let offset = 0;
  while (offset < output.length && matches.length < limit) {
    const pathEnd = output.indexOf("\0", offset);
    const lineEnd = output.indexOf("\0", pathEnd + 1);
    if (pathEnd < 0 || lineEnd < 0) break;
    const newline = output.indexOf("\n", lineEnd + 1);
    const end = newline < 0 ? output.length : newline;
    const [start, stop] = matchRange(output.slice(lineEnd + 1, end).replace(/\r$/, ""), query, ignoreCase);
    matches.push({
      path: output.slice(offset, pathEnd),
      line: Number(output.slice(pathEnd + 1, lineEnd)),
      start,
      end: stop,
    });
    offset = end + 1;
  }
  return matches.sort((left, right) =>
    left.path === right.path ? left.line - right.line : left.path < right.path ? -1 : 1,
  );
}

export function fileLanguage(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const languages: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    rs: "rust",
    py: "python",
    go: "go",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    sh: "bash",
    toml: "toml",
    yaml: "yaml",
    yml: "yaml",
    c: "c",
    h: "c",
    cpp: "cpp",
    java: "java",
    swift: "swift",
    sql: "sql",
  };
  return languages[extension] ?? "text";
}
