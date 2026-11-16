import { searchContents } from "../../git/files.ts";
import type { RunGit } from "../../git/repository.ts";

const PATH_RESULT_LIMIT = 200;

type MatchType = "filename" | "path" | "content";

export interface SearchResult {
  path: string;
  line: number | null;
  range: [number, number] | null;
  type: MatchType;
}

export type ResultRow = { kind: "group"; label: string; count: number } | { kind: "result"; index: number };

function visible(path: string): boolean {
  return !path.split("/").some((part) => part.startsWith("."));
}

function fuzzySpread(haystack: string, needle: string): number | null {
  const wanted = [...needle];
  let next = 0;
  let first = -1;
  let index = 0;
  for (const character of haystack) {
    if (character === wanted[next]) {
      if (first < 0) first = index;
      next++;
      if (next === wanted.length) return index - first;
    }
    index++;
  }
  return wanted.length === 0 ? 0 : null;
}

interface Ranked {
  key: [number, number, number];
  result: SearchResult;
}

function rankPath(path: string, needle: string): Ranked | null {
  const lower = path.toLowerCase();
  const nameStart = lower.lastIndexOf("/") + 1;
  const name = lower.slice(nameStart);
  const span = (start: number): [number, number] => [start, start + needle.length];
  let rank: number;
  let spread = 0;
  let type: MatchType = "filename";
  let range: [number, number] | null = null;
  const inName = name.indexOf(needle);
  const nameSpread = inName < 0 ? fuzzySpread(name, needle) : null;
  const inPath = lower.indexOf(needle);
  if (name === needle) [rank, range] = [0, [nameStart, lower.length]];
  else if (inName === 0) [rank, range] = [1, span(nameStart)];
  else if (inName > 0) [rank, range] = [2, span(nameStart + inName)];
  else if (nameSpread !== null) [rank, spread] = [3, nameSpread];
  else if (inPath >= 0) [rank, type, range] = [4, "path", span(inPath)];
  else {
    const pathSpread = fuzzySpread(lower, needle);
    if (pathSpread === null) return null;
    [rank, spread, type] = [4, pathSpread + 1, "path"];
  }
  if (lower.length !== path.length) range = null;
  return { key: [rank, spread, path.length], result: { path, line: null, range, type } };
}

export function rankPaths(paths: readonly string[], query: string): SearchResult[] {
  const needle = query.toLowerCase();
  const ranked: Ranked[] = [];
  for (const path of paths) {
    if (!visible(path)) continue;
    const entry = rankPath(path, needle);
    if (entry) ranked.push(entry);
  }
  ranked.sort((left, right) => {
    for (let index = 0; index < 3; index++) {
      const difference = (left.key[index] ?? 0) - (right.key[index] ?? 0);
      if (difference) return difference;
    }
    return left.result.path < right.result.path ? -1 : left.result.path > right.result.path ? 1 : 0;
  });
  return ranked.slice(0, PATH_RESULT_LIMIT).map((entry) => entry.result);
}

export async function searchLines(git: RunGit, query: string): Promise<SearchResult[]> {
  const matches = await searchContents(git, query);
  return matches
    .filter((match) => visible(match.path))
    .map((match) => ({ path: match.path, line: match.line, range: [match.start, match.end], type: "content" }));
}

export function resultRows(results: readonly SearchResult[]): ResultRow[] {
  const found = results.findIndex((result) => result.type === "content");
  const lines = found < 0 ? results.length : found;
  const rows: ResultRow[] = [];
  const groups: [string, number, number][] = [
    ["Files", 0, lines],
    ["Lines", lines, results.length],
  ];
  for (const [label, start, end] of groups) {
    if (start === end) continue;
    rows.push({ kind: "group", label, count: end - start });
    for (let index = start; index < end; index++) rows.push({ kind: "result", index });
  }
  return rows;
}

export function sameResult(left: SearchResult, right: SearchResult): boolean {
  return left.path === right.path && left.line === right.line && left.type === right.type;
}
