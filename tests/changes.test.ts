import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChanges } from "../src/git/comparison.ts";
import { readBlameRange, readTargetDiff } from "../src/git/diff.ts";
import { type GitResult, type RunGit, readRepository } from "../src/git/repository.ts";
import { runStaging } from "../src/git/staging.ts";

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

async function git(cwd: string, args: string[]): Promise<GitResult> {
  const child = Bun.spawn(["git", ...args], { cwd, env: ENV, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function must(cwd: string, ...args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

async function repo(): Promise<{ dir: string; run: RunGit }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "herdr-git-changes-")));
  folders.push(dir);
  await must(dir, "init", "-b", "main");
  return { dir, run: (args) => git(dir, args) };
}

async function commitFile(dir: string, name: string, text: string): Promise<string> {
  await writeFile(join(dir, name), text);
  await must(dir, "add", name);
  await must(dir, "commit", "-m", `add ${name}`);
  return (await must(dir, "rev-parse", "HEAD")).trim();
}

test("Diff Last lists staged and unstaged sections with counts when the tree is dirty", async () => {
  const { dir, run } = await repo();
  await commitFile(dir, "a.txt", "one\n");
  await writeFile(join(dir, "a.txt"), "one\ntwo\n");
  await must(dir, "add", "a.txt");
  await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n");
  await writeFile(join(dir, "new file.txt"), "x\ny\n");
  const snapshot = await readChanges(run, { kind: "last" });
  expect(snapshot.comparison).toBeNull();
  expect(snapshot.changes).toEqual([
    { section: "staged", status: "M", path: "a.txt" },
    { section: "unstaged", status: "M", path: "a.txt" },
    { section: "unstaged", status: "??", path: "new file.txt" },
  ]);
  expect(snapshot.summaries.staged).toEqual({ files: 1, additions: 1, deletions: 0 });
  expect(snapshot.summaries.unstaged).toEqual({ files: 2, additions: 3, deletions: 0 });
});

test("Diff Last on a clean main compares HEAD with its parent and titles the commit", async () => {
  const { dir, run } = await repo();
  const first = await commitFile(dir, "a.txt", "one\n");
  const second = await commitFile(dir, "b.txt", "two\n");
  const snapshot = await readChanges(run, { kind: "last" });
  expect(snapshot.comparison).toEqual({ kind: "commit", commit: second, parent: first });
  expect(snapshot.changes).toEqual([{ section: "commit", status: "A", path: "b.txt" }]);
  expect(snapshot.titles[second]).toBe("add b.txt");
});

test.each(["main", "topic", "detached"])("Diff Last shows the root commit additions on %s", async (ref) => {
  const { dir, run } = await repo();
  const root = await commitFile(dir, "first file.txt", "one\ntwo\n");
  if (ref === "topic") await must(dir, "checkout", "-b", "topic");
  if (ref === "detached") await must(dir, "checkout", "--detach");
  const snapshot = await readChanges(run, { kind: "last" });
  expect(snapshot.comparison).toEqual({ kind: "commit", commit: root, parent: null });
  expect(snapshot.changes).toEqual([{ section: "commit", status: "A", path: "first file.txt" }]);
  expect(snapshot.summaries.commit).toEqual({ files: 1, additions: 2, deletions: 0 });
  if (!snapshot.comparison) throw new Error("Missing root commit comparison");
  const diff = await readTargetDiff(run, snapshot.comparison, "first file.txt");
  expect(diff).toContain("--- /dev/null\n");
  expect(diff).toContain("+one\n+two\n");
});

test("Diff Last on a branch without its own commits shows nothing instead of the base commit", async () => {
  const { dir, run } = await repo();
  await commitFile(dir, "a.txt", "one\n");
  await commitFile(dir, "b.txt", "two\n");
  await must(dir, "checkout", "-b", "feature");
  const snapshot = await readChanges(run, { kind: "last" });
  expect(snapshot.changes).toEqual([]);
});

test("Compare and a single commit read name-status between the chosen revisions", async () => {
  const { dir, run } = await repo();
  const root = await commitFile(dir, "a.txt", "one\n");
  await must(dir, "mv", "a.txt", "moved a.txt");
  await must(dir, "commit", "-m", "move");
  const between = await readChanges(run, { kind: "between", base: root, compare: "HEAD" });
  expect(between.changes).toEqual([{ section: "commit", status: "R100", path: "moved a.txt" }]);
  const single = await readChanges(run, { kind: "commit", sha: root });
  expect(single.comparison).toEqual({ kind: "commit", commit: root, parent: null });
  expect(single.changes).toEqual([{ section: "commit", status: "A", path: "a.txt" }]);
  await expect(readChanges(run, { kind: "between", base: "missing", compare: "HEAD" })).rejects.toThrow();
});

test("untracked files diff against /dev/null and blame marks uncommitted lines", async () => {
  const { dir, run } = await repo();
  await commitFile(dir, "a.txt", "one\ntwo\n");
  await writeFile(join(dir, "a.txt"), "one\nchanged\n");
  await writeFile(join(dir, "fresh.txt"), "hello\n");
  expect(await readTargetDiff(run, { kind: "working-index" }, "fresh.txt")).toContain("+hello");
  const blame = await readBlameRange(run, "a.txt", 1, 2, null);
  expect(blame.map((entry) => [entry.line, entry.author, /^0+$/.test(entry.sha)])).toEqual([
    [1, "Test", false],
    [2, "Not Committed Yet", true],
  ]);
});

test("staging verifies the index and unstaging works before the first commit", async () => {
  const { dir, run } = await repo();
  await writeFile(join(dir, "a.txt"), "one\n");
  await runStaging(run, { kind: "stage", paths: ["a.txt"] });
  expect(await must(dir, "diff", "--cached", "--name-only")).toBe("a.txt\n");
  await runStaging(run, { kind: "unstage-all" });
  expect(await must(dir, "diff", "--cached", "--name-only")).toBe("");
  await commitFile(dir, "a.txt", "one\n");
  await writeFile(join(dir, "a.txt"), "two\n");
  await runStaging(run, { kind: "discard", paths: ["a.txt"] });
  expect(await must(dir, "status", "--porcelain")).toBe("");
  await expect(runStaging(run, { kind: "discard", paths: [] })).rejects.toThrow("No tracked unstaged files selected.");
});

test("the repository snapshot preserves unusual staged, unstaged and renamed paths without another scan", async () => {
  const { dir, run } = await repo();
  const original = "old\tname\n.txt";
  const renamed = "new\nname\t.txt";
  const modified = "both\nsides\t.txt";
  const untracked = "new\tfile\n.txt";
  await commitFile(dir, original, "before\n");
  await commitFile(dir, modified, "base\n");
  await must(dir, "mv", "--", original, renamed);
  await writeFile(join(dir, modified), "base\nstaged\n");
  await must(dir, "add", "--", modified);
  await writeFile(join(dir, modified), "base\nstaged\nunstaged\n");
  await writeFile(join(dir, untracked), "one\ntwo\n");
  const repository = await readRepository(run);
  if (repository.state !== "ready") throw new Error("Missing repository");
  const commands: string[][] = [];
  const snapshot = await readChanges(
    (args) => {
      commands.push(args);
      return run(args);
    },
    { kind: "last" },
    repository.files,
  );
  expect(snapshot.changes).toEqual([
    { section: "staged", status: "M", path: modified },
    { section: "staged", status: "R", path: renamed },
    { section: "unstaged", status: "M", path: modified },
    { section: "unstaged", status: "??", path: untracked },
  ]);
  expect(snapshot.summaries.staged).toEqual({ files: 2, additions: 1, deletions: 0 });
  expect(snapshot.summaries.unstaged).toEqual({ files: 2, additions: 3, deletions: 0 });
  expect(commands).toHaveLength(3);
  expect(commands.every((args) => args.includes("--numstat"))).toBe(true);
  await must(dir, "commit", "-m", "Rename and stage");
  const committed = await readChanges(run, { kind: "commit", sha: "HEAD" });
  expect(committed.changes).toContainEqual({ section: "commit", status: "R100", path: renamed });
});

test("a supplied unborn status and standalone subfolder reads retain literal untracked paths", async () => {
  const { dir, run } = await repo();
  const staged = "staged\nfile\t.txt";
  const untracked = "new\nfile\t.txt";
  await writeFile(join(dir, staged), "one\n");
  await must(dir, "add", "--", staged);
  await writeFile(join(dir, untracked), "two\nthree\n");
  await mkdir(join(dir, "nested"));
  const repository = await readRepository(run);
  if (repository.state !== "ready") throw new Error("Missing repository");
  const snapshot = await readChanges(run, { kind: "last" }, repository.files);
  expect(snapshot.changes).toEqual([
    { section: "staged", status: "A", path: staged },
    { section: "unstaged", status: "??", path: untracked },
  ]);
  expect(snapshot.summaries.staged).toEqual({ files: 1, additions: 1, deletions: 0 });
  expect(snapshot.summaries.unstaged).toEqual({ files: 1, additions: 2, deletions: 0 });
  const nested = await readChanges((args) => git(join(dir, "nested"), args), { kind: "last" });
  expect(nested).toEqual(snapshot);
});

test("a supplied status keeps both conflict sections and a recreated staged deletion", async () => {
  const { dir, run } = await repo();
  await commitFile(dir, "conflict.txt", "base\n");
  await commitFile(dir, "recreated.txt", "old\n");
  await must(dir, "checkout", "-b", "other");
  await writeFile(join(dir, "conflict.txt"), "other\n");
  await must(dir, "commit", "-am", "Other");
  await must(dir, "checkout", "main");
  await writeFile(join(dir, "conflict.txt"), "main\n");
  await must(dir, "commit", "-am", "Main");
  expect((await run(["merge", "other"])).code).not.toBe(0);
  await must(dir, "rm", "recreated.txt");
  await writeFile(join(dir, "recreated.txt"), "new\n");
  const repository = await readRepository(run);
  if (repository.state !== "ready") throw new Error("Missing repository");
  const snapshot = await readChanges(run, { kind: "last" }, repository.files);
  expect(snapshot.changes).toEqual([
    { section: "staged", status: "U", path: "conflict.txt" },
    { section: "staged", status: "D", path: "recreated.txt" },
    { section: "unstaged", status: "U", path: "conflict.txt" },
    { section: "unstaged", status: "??", path: "recreated.txt" },
  ]);
});
