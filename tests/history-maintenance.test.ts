import { afterEach, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readHistoryPage } from "../src/git/history.ts";
import { prepareHistory } from "../src/git/history-maintenance.ts";
import type { GitResult } from "../src/git/repository.ts";

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[], date?: string): Promise<GitResult> {
  const env = date ? { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : ENV;
  const child = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

async function must(cwd: string, ...args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function folder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "herdr-history-")));
  folders.push(dir);
  return dir;
}

async function repo(): Promise<string> {
  const dir = await folder();
  await must(dir, "init", "-b", "main");
  return dir;
}

async function commit(dir: string, subject: string): Promise<string> {
  await must(dir, "commit", "--allow-empty", "-m", subject);
  return must(dir, "rev-parse", "HEAD");
}

async function graphPath(dir: string): Promise<string> {
  return must(
    dir,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "objects/info/commit-graphs/commit-graph-chain",
  );
}

test("preparation is idempotent, shared by linked worktrees, and changes neither refs nor configuration", async () => {
  const dir = await repo();
  await commit(dir, "base");
  await commit(dir, "second");
  const worktree = join(await folder(), "linked");
  await must(dir, "worktree", "add", "--detach", worktree);
  const refs = await must(dir, "show-ref", "--head");
  const config = await must(dir, "config", "--local", "--list");
  expect(await prepareHistory((args) => git(worktree, args))).toEqual({ state: "ready" });
  const graph = await graphPath(dir);
  expect(await graphPath(worktree)).toBe(graph);
  const chain = await readFile(graph, "utf8");
  expect(chain.trim()).not.toBe("");
  expect(await prepareHistory((args) => git(dir, args))).toEqual({ state: "ready" });
  expect(await readFile(graph, "utf8")).toBe(chain);
  expect(await must(dir, "show-ref", "--head")).toBe(refs);
  expect(await must(dir, "config", "--local", "--list")).toBe(config);
});

for (const [key, value] of [
  ["core.commitGraph", "false"],
  ["maintenance.commit-graph.auto", "0"],
] as const) {
  test(`preparation respects ${key}=${value} without blocking history`, async () => {
    const dir = await repo();
    const sha = await commit(dir, "base");
    await must(dir, "config", key, value);
    const run = (args: string[]) => git(dir, args);
    expect(await prepareHistory(run)).toEqual({ state: "skipped", reason: `${key}=${value}` });
    await expect(access(await graphPath(dir))).rejects.toThrow();
    expect((await readHistoryPage(run, { start: null, offset: 0, count: 10 }, null)).commits.map((c) => c.sha)).toEqual(
      [sha],
    );
  });
}

test("unborn and shallow repositories skip preparation but still provide history", async () => {
  const dir = await repo();
  expect(await prepareHistory((args) => git(dir, args))).toEqual({ state: "skipped", reason: "No commits" });
  await commit(dir, "base");
  const tip = await commit(dir, "tip");
  const shallow = join(await folder(), "shallow");
  await must(dir, "clone", "--depth=1", `file://${dir}`, shallow);
  const run = (args: string[]) => git(shallow, args);
  expect(await prepareHistory(run)).toEqual({ state: "skipped", reason: "Shallow repository" });
  await expect(access(await graphPath(shallow))).rejects.toThrow();
  expect((await readHistoryPage(run, { start: null, offset: 0, count: 10 }, null)).commits.map((c) => c.sha)).toEqual([
    tip,
  ]);
});

test("replacement refs and grafts never produce a graph or change substituted ancestry", async () => {
  const dir = await repo();
  const root = await commit(dir, "root");
  const tip = await commit(dir, "tip");
  const run = (args: string[]) => git(dir, args);
  await must(dir, "replace", tip, root);
  expect(await prepareHistory(run)).toEqual({ state: "skipped", reason: "Replacement refs" });
  await expect(access(await graphPath(dir))).rejects.toThrow();
  await must(dir, "replace", "-d", tip);
  const grafts = await must(dir, "rev-parse", "--path-format=absolute", "--git-path", "info/grafts");
  await writeFile(grafts, `${tip}\n`);
  const before = await readHistoryPage(run, { start: "HEAD", offset: 0, count: 10 }, null);
  expect(before.commits.map((c) => c.sha)).toEqual([tip]);
  expect(await prepareHistory(run)).toEqual({ state: "ready" });
  await expect(access(await graphPath(dir))).rejects.toThrow();
  expect((await readHistoryPage(run, { start: "HEAD", offset: 0, count: 10 }, null)).commits).toEqual(before.commits);
});

test("preparation errors are observable and do not make history unavailable", async () => {
  const dir = await repo();
  const tip = await commit(dir, "tip");
  const run = (args: string[]) => git(dir, args);
  const lock = `${await graphPath(dir)}.lock`;
  await mkdir(dirname(lock), { recursive: true });
  await writeFile(lock, "held by another writer\n");
  await expect(prepareHistory(run)).rejects.toThrow();
  expect((await readHistoryPage(run, { start: "HEAD", offset: 0, count: 10 }, null)).commits.map((c) => c.sha)).toEqual(
    [tip],
  );
});

test("prepared pagination preserves date-order with equal dates, clock skew, redundant refs and moving HEAD", async () => {
  const dir = await repo();
  const root = await commit(dir, "root");
  const tree = await must(dir, "rev-parse", "HEAD^{tree}");
  const node = async (subject: string, parents: string[], date: string): Promise<string> => {
    const result = await git(dir, ["commit-tree", tree, ...parents.flatMap((sha) => ["-p", sha]), "-m", subject], date);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const left = await node("left", [root], "2020-01-03T00:00:00Z");
  const right = await node("right", [root], "2020-01-03T00:00:00Z");
  const skewed = await node("skewed child", [left], "2020-01-01T00:00:00Z");
  const merge = await node("merge", [skewed, right], "2020-01-04T00:00:00Z");
  const unrelated = await node("unrelated history", [], "2020-01-02T00:00:00Z");
  await must(dir, "update-ref", "refs/heads/main", merge);
  await must(dir, "update-ref", "refs/heads/other", right);
  await must(dir, "tag", "old-root", root);
  await must(dir, "tag", "unrelated", unrelated);
  const run = (args: string[]) => git(dir, args);
  const initial = await readHistoryPage(run, { start: null, offset: 0, count: 20 }, null);
  expect(initial.cursor.revisions).toEqual(expect.arrayContaining([merge, right, root, unrelated]));
  expect(initial.cursor.traversalRevisions).toEqual(
    initial.cursor.revisions.filter((sha) => sha === merge || sha === unrelated),
  );
  const expected = await must(
    dir,
    "log",
    "--topo-order",
    "--date-order",
    "--format=%H",
    ...initial.cursor.revisions,
    "--",
  );
  expect(await prepareHistory(run)).toEqual({ state: "ready" });
  const first = await readHistoryPage(run, { start: null, offset: 0, count: 2 }, null);
  await commit(dir, "new HEAD after first page");
  await must(dir, "tag", "-d", "unrelated");
  const second = await readHistoryPage(run, { start: null, offset: 2, count: 2 }, first.cursor);
  const third = await readHistoryPage(run, { start: null, offset: 4, count: 2 }, second.cursor);
  const actual = [...first.commits, ...second.commits, ...third.commits].map((c) => c.sha);
  expect(actual).toEqual(expected.split("\n"));
  expect(actual).toEqual(initial.commits.map((c) => c.sha));
  expect(third.hasMore).toBe(false);
  expect(second.cursor).toBe(first.cursor);
});
