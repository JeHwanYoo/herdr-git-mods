import type { ChangeKind, RunGit } from "./repository.ts";

export const HISTORY_PAGE_SIZE = 100;

export type CommitRefKind = "head" | "local" | "remote" | "remote-head" | "tag" | "other";

export interface CommitRef {
  name: string;
  kind: CommitRefKind;
}

export interface Commit {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: string;
  refs: CommitRef[];
  subject: string;
  body: string;
}

export interface ChangedPath {
  status: string;
  path: string;
  from?: string;
}

export interface HistoryCursor {
  start: string | null;
  revisions: string[];
  traversalRevisions: string[];
}

export interface HistoryPage {
  commits: Commit[];
  offset: number;
  hasMore: boolean;
  cursor: HistoryCursor;
}

export interface GitRef {
  name: string;
  fullName: string;
  kind: "branch" | "remote" | "tag";
  sha: string;
  current: boolean;
  objectId: string;
}

const READ = [
  "--no-optional-locks",
  "--literal-pathspecs",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "diff.autoRefreshIndex=false",
];
const FIELDS = "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1f%b";
const RECORD = "\u001e";
const FIELD = "\u001f";

async function run(git: RunGit, args: string[]): Promise<string> {
  const result = await git([...READ, ...args]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} exited with ${result.code}`);
  return result.stdout;
}

async function optional(git: RunGit, args: string[]): Promise<string> {
  const result = await git([...READ, ...args]);
  return result.code === 0 ? result.stdout.trim() : "";
}

function objectId(value: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error("Invalid commit identity");
  return value;
}

function lines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function historyCursor(git: RunGit, start: string | null): Promise<HistoryCursor> {
  const revisions = (
    start
      ? [(await run(git, ["rev-parse", "--verify", "--end-of-options", `${start}^{commit}`])).trim()]
      : lines(await run(git, ["rev-list", "--all", "--no-walk=unsorted"]))
  ).map(objectId);
  if (revisions.length < 2) return { start, revisions, traversalRevisions: revisions };
  const independent = new Set(lines(await run(git, ["merge-base", "--independent", ...revisions])).map(objectId));
  const traversalRevisions = revisions.filter((sha) => independent.has(sha));
  return { start, revisions, traversalRevisions };
}

export async function readHistoryPage(
  git: RunGit,
  request: { start: string | null; offset: number; count: number },
  cursor: HistoryCursor | null,
): Promise<HistoryPage> {
  const snapshot = cursor && cursor.start === request.start ? cursor : await historyCursor(git, request.start);
  const count = Math.max(1, Math.floor(request.count));
  if (!snapshot.revisions.length) return { commits: [], offset: request.offset, hasMore: false, cursor: snapshot };
  const output = await run(git, [
    "log",
    "--topo-order",
    "--date-order",
    "--decorate=full",
    "--no-color",
    "--no-show-signature",
    FIELDS,
    `--skip=${request.offset}`,
    `--max-count=${count + 1}`,
    ...snapshot.traversalRevisions,
    "--",
  ]);
  const commits = parseHistory(output);
  return {
    commits: commits.slice(0, count),
    offset: request.offset,
    hasMore: commits.length > count,
    cursor: snapshot,
  };
}

function splitFields(record: string, limit: number): string[] {
  const fields: string[] = [];
  let rest = record;
  while (fields.length < limit - 1) {
    const index = rest.indexOf(FIELD);
    if (index < 0) break;
    fields.push(rest.slice(0, index));
    rest = rest.slice(index + 1);
  }
  fields.push(rest);
  return fields;
}

function required(fields: string[], index: number, name: string): string {
  const value = fields[index];
  if (value === undefined) throw new Error(`Git returned a commit without ${name}`);
  return value;
}

function parseHistory(output: string): Commit[] {
  return output
    .split(RECORD)
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const fields = splitFields(record.replace(/^\n+|\n+$/g, ""), 8);
      return {
        sha: objectId(required(fields, 0, "SHA")),
        parents: required(fields, 1, "parents").split(/\s+/).filter(Boolean).map(objectId),
        authorName: required(fields, 2, "author name"),
        authorEmail: required(fields, 3, "author email"),
        authorTime: required(fields, 4, "author time"),
        refs: required(fields, 5, "refs")
          .split(", ")
          .filter((value) => value !== "")
          .flatMap(parseRefs),
        subject: required(fields, 6, "subject"),
        body: (fields[7] ?? "").trimEnd(),
      };
    });
}

function parseRefs(value: string): CommitRef[] {
  const trimmed = value.trim();
  const head = "HEAD -> refs/heads/";
  if (trimmed.startsWith(head))
    return [
      { name: "HEAD", kind: "head" },
      { name: trimmed.slice(head.length), kind: "local" },
    ];
  return [parseRef(trimmed)];
}

const REF_PREFIXES: readonly [string, CommitRefKind][] = [
  ["refs/heads/", "local"],
  ["refs/remotes/", "remote"],
  ["tag: refs/tags/", "tag"],
  ["refs/tags/", "tag"],
];

function parseRef(value: string): CommitRef {
  for (const [prefix, kind] of REF_PREFIXES) {
    if (!value.startsWith(prefix)) continue;
    const name = value.slice(prefix.length);
    return { name, kind: kind === "remote" && name.endsWith("/HEAD") ? "remote-head" : kind };
  }
  return { name: value, kind: value === "HEAD" ? "head" : "other" };
}

export function isHead(commit: Commit): boolean {
  return commit.refs.some((reference) => reference.kind === "head");
}

export function filteredCommitIndices(commits: readonly Commit[], query: string): number[] {
  const needle = query.toLowerCase();
  const indices: number[] = [];
  commits.forEach((commit, index) => {
    if (commitMatches(commit, needle)) indices.push(index);
  });
  return indices;
}

function commitMatches(commit: Commit, needle: string): boolean {
  return (
    needle === "" ||
    commit.sha.toLowerCase().startsWith(needle) ||
    commit.authorName.toLowerCase().includes(needle) ||
    commit.authorEmail.toLowerCase().includes(needle) ||
    commit.subject.toLowerCase().includes(needle) ||
    commit.body.toLowerCase().includes(needle) ||
    commit.refs.some((reference) => reference.name.toLowerCase().includes(needle))
  );
}

export async function readCommitChanges(git: RunGit, sha: string): Promise<ChangedPath[]> {
  const output = await run(git, [
    "diff-tree",
    "--root",
    "--no-commit-id",
    "--name-status",
    "-r",
    "-M",
    "-C",
    "-z",
    objectId(sha),
    "--",
  ]);
  return parseChanges(output);
}

function parseChanges(output: string): ChangedPath[] {
  const fields = output.split("\0");
  const changes: ChangedPath[] = [];
  let index = 0;
  while (index < fields.length - 1) {
    const status = fields[index++] ?? "";
    const first = fields[index++];
    if (!status || first === undefined) throw new Error("Incomplete commit file response");
    if (status.startsWith("R") || status.startsWith("C")) {
      const path = fields[index++];
      if (path === undefined) throw new Error("Incomplete rename response");
      changes.push({ status, path, from: first });
    } else changes.push({ status, path: first });
  }
  return changes;
}

export async function readRefsFingerprint(git: RunGit): Promise<string> {
  const [refs, head, branch] = await Promise.all([
    run(git, ["for-each-ref", "--format=%(objectname) %(refname)"]),
    optional(git, ["rev-parse", "--verify", "--quiet", "HEAD"]),
    optional(git, ["symbolic-ref", "--quiet", "HEAD"]),
  ]);
  return `${branch}\n${head}\n${refs}`;
}

export async function readRefs(git: RunGit): Promise<GitRef[]> {
  const output = await run(git, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(HEAD)",
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]);
  return lines(output).map((line) => {
    const [fullName = "", sha = "", peeled = "", current = ""] = line.split("\0");
    const kind = fullName.startsWith("refs/heads/")
      ? "branch"
      : fullName.startsWith("refs/remotes/")
        ? "remote"
        : "tag";
    return {
      fullName,
      name: fullName.replace(/^refs\/(heads|remotes|tags)\//, ""),
      kind,
      sha: objectId(peeled || sha),
      current: current === "*",
      objectId: objectId(sha),
    };
  });
}

const STATUS_LETTERS: Record<ChangeKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  type: "T",
  conflict: "U",
  untracked: "?",
};

export function statusLetter(kind: ChangeKind): string {
  return STATUS_LETTERS[kind];
}

function parseIsoTime(value: string): number | null {
  const match = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)(?:\.\d+)?(Z|z|[+-]\d{2}:?\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  return daysFromCivil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second - utcOffset(match[7] ?? "Z");
}

function utcOffset(offset: string): number {
  if (offset === "Z" || offset === "z") return 0;
  const digits = offset.slice(1).replace(":", "");
  const seconds = Number(digits.slice(0, 2)) * 3_600 + Number(digits.slice(2)) * 60;
  return offset.startsWith("-") ? -seconds : seconds;
}

function daysFromCivil(year: number, month: number, day: number): number {
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const monthIndex = (month + 9) % 12;
  const dayOfYear = Math.floor((153 * monthIndex + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

function count(value: number, unit: string): string {
  return value === 1 ? `1 ${unit} ago` : `${value} ${unit}s ago`;
}

function plural(value: number, unit: string): string {
  return value === 1 ? `1 ${unit}` : `${value} ${unit}s`;
}

export function relativeTime(secondsAgo: number): string {
  if (secondsAgo < 0) return "in the future";
  if (secondsAgo < 90) return count(secondsAgo, "second");
  const minutes = Math.floor((secondsAgo + 30) / 60);
  if (minutes < 90) return count(minutes, "minute");
  const hours = Math.floor((minutes + 30) / 60);
  if (hours < 36) return count(hours, "hour");
  const days = Math.floor((hours + 12) / 24);
  if (days < 14) return count(days, "day");
  if (days < 70) return count(Math.floor((days + 3) / 7), "week");
  if (days < 365) return count(Math.floor((days + 15) / 30), "month");
  const years = Math.floor(days / 365);
  const months = Math.floor(((days % 365) + 15) / 30);
  return months === 0 ? count(years, "year") : `${plural(years, "year")}, ${plural(months, "month")} ago`;
}

export function authorRelative(commit: Commit, nowSeconds: number): string {
  const time = parseIsoTime(commit.authorTime);
  return time === null ? "" : relativeTime(Math.floor(nowSeconds) - time);
}
