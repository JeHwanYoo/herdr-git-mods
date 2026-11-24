import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDiff } from "../../src/git/diff.ts";
import { readFiles } from "../../src/git/files.ts";
import {
  filteredCommitIndices,
  readCommitChanges,
  readHistoryPage,
  readRefs,
  readRefsFingerprint,
  relativeTime,
} from "../../src/git/history.ts";
import { type FileChange, type GitResult, mapGit, type Repository, readRepository } from "../../src/git/repository.ts";
import { ReviewedOperation } from "../../src/git/workflows.ts";

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

async function folder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "herdr-git-")));
  folders.push(dir);
  return dir;
}

async function repo(): Promise<string> {
  const dir = await folder();
  await must(dir, "init", "-b", "main");
  return dir;
}

async function commitFile(dir: string, name: string, text: string): Promise<void> {
  await writeFile(join(dir, name), text);
  await must(dir, "add", name);
  await must(dir, "commit", "-m", `add ${name}`);
}

function read(dir: string): Promise<Repository> {
  return readRepository((args) => git(dir, args));
}

async function ready(dir: string): Promise<Extract<Repository, { state: "ready" }>> {
  const repository = await read(dir);
  if (repository.state !== "ready") throw new Error(`expected a repository at ${dir}`);
  return repository;
}

function byPath(files: FileChange[]): Record<string, FileChange> {
  return Object.fromEntries(files.map((file) => [file.path, file]));
}

test("file browsing keeps staged deletions available without duplicating renamed paths", async () => {
  const dir = await repo();
  await commitFile(dir, "removed\tfile.txt", "deleted content\n");
  await commitFile(dir, "old-name.txt", "renamed content\n");
  await must(dir, "rm", "--", "removed\tfile.txt");
  await must(dir, "mv", "old-name.txt", "new-name.txt");
  await writeFile(join(dir, "untracked.txt"), "new file\n");
  const runner = (args: string[]) => git(dir, args);
  expect(await readFiles(runner)).toEqual(["new-name.txt", "removed\tfile.txt", "untracked.txt"]);
  await must(dir, "reset", "HEAD", "--", "removed\tfile.txt");
  expect(await readFiles(runner)).toEqual(["new-name.txt", "removed\tfile.txt", "untracked.txt"]);
});

for (const mode of ["soft", "mixed", "hard"] as const)
  test(`${mode} reset preserves the reviewed target and its documented index and working tree effects`, async () => {
    const dir = await repo();
    await commitFile(dir, "tracked.txt", "base\n");
    const target = (await must(dir, "rev-parse", "HEAD")).trim();
    await commitFile(dir, "tracked.txt", "second\n");
    await writeFile(join(dir, "tracked.txt"), "staged\n");
    await must(dir, "add", "tracked.txt");
    await writeFile(join(dir, "tracked.txt"), "working\n");
    await writeFile(join(dir, "untracked.txt"), "keep me\n");
    const runner = (args: string[]) => git(dir, args);
    const head = (await must(dir, "rev-parse", "HEAD")).trim();
    const plan = await ReviewedOperation.review(runner, {
      kind: "reset",
      mode,
      target,
      targetName: "base",
      branch: "main",
      head,
    });
    await plan.run(runner);
    expect((await must(dir, "rev-parse", "HEAD")).trim()).toBe(target);
    expect(await must(dir, "show", ":tracked.txt")).toBe(mode === "soft" ? "staged\n" : "base\n");
    expect(await Bun.file(join(dir, "tracked.txt")).text()).toBe(mode === "hard" ? "base\n" : "working\n");
    expect(await Bun.file(join(dir, "untracked.txt")).text()).toBe("keep me\n");
    expect((await ready(dir)).branch.name).toBe("main");
  });

test("reset refuses a changed untracked file after review and preserves the current checkout", async () => {
  const dir = await repo();
  await commitFile(dir, "tracked.txt", "base\n");
  const target = (await must(dir, "rev-parse", "HEAD")).trim();
  await commitFile(dir, "tracked.txt", "second\n");
  const head = (await must(dir, "rev-parse", "HEAD")).trim();
  await writeFile(join(dir, "draft.txt"), "reviewed\n");
  const runner = (args: string[]) => git(dir, args);
  const plan = await ReviewedOperation.review(runner, {
    kind: "reset",
    mode: "hard",
    target,
    targetName: "base",
    branch: "main",
    head,
  });
  await writeFile(join(dir, "draft.txt"), "edited after review\n");
  await expect(plan.run(runner)).rejects.toThrow("Repository changed");
  expect((await must(dir, "rev-parse", "HEAD")).trim()).toBe(head);
  expect(await Bun.file(join(dir, "tracked.txt")).text()).toBe("second\n");
  expect(await Bun.file(join(dir, "draft.txt")).text()).toBe("edited after review\n");
});

test("a folder outside any repository reports none", async () => {
  const dir = await folder();
  expect(await read(dir)).toEqual({ state: "none" });
});

test("a repository without commits lists untracked files on its branch", async () => {
  const dir = await repo();
  await writeFile(join(dir, "notes.md"), "draft");
  const repository = await ready(dir);
  expect(repository.root).toBe(dir);
  expect(repository.branch.name).toBe("main");
  expect(repository.files).toEqual([{ path: "notes.md", staged: null, unstaged: "untracked" }]);
});

test("a recreated staged deletion is one selectable file with two diff sides", async () => {
  const dir = await repo();
  await commitFile(dir, "a.txt", "base\n");
  await must(dir, "rm", "--", "a.txt");
  await writeFile(join(dir, "a.txt"), "recreated\n");
  const files = (await ready(dir)).files;
  expect(files).toEqual([{ path: "a.txt", staged: "deleted", unstaged: "untracked" }]);
  const file = files[0];
  if (!file) throw new Error("Missing recreated file");
  const run = (args: string[]) => git(dir, args);
  expect((await readDiff(run, file, "staged")).text).toContain("-base");
  expect((await readDiff(run, file, "unstaged")).text).toContain("+recreated");
});

test("staged and unstaged changes are reported separately per file", async () => {
  const dir = await repo();
  await commitFile(dir, "a.txt", "one\n");
  await commitFile(dir, "b.txt", "two\n");
  await writeFile(join(dir, "a.txt"), "one\nstaged\n");
  await must(dir, "add", "a.txt");
  await writeFile(join(dir, "a.txt"), "one\nstaged\nunstaged\n");
  await rm(join(dir, "b.txt"));
  const files = byPath((await ready(dir)).files);
  expect(files["a.txt"]).toEqual({ path: "a.txt", staged: "modified", unstaged: "modified" });
  expect(files["b.txt"]).toEqual({ path: "b.txt", staged: null, unstaged: "deleted" });
});

test("a staged rename keeps both paths, including spaces", async () => {
  const dir = await repo();
  await commitFile(dir, "old name.txt", "same content\n");
  await rename(join(dir, "old name.txt"), join(dir, "new name.txt"));
  await must(dir, "add", "-A");
  expect((await ready(dir)).files).toEqual([
    { path: "new name.txt", from: "old name.txt", staged: "renamed", unstaged: null },
  ]);
});

test("a nested folder reports paths relative to the repository root", async () => {
  const dir = await repo();
  await must(dir, "commit", "--allow-empty", "-m", "start");
  await must(dir, "switch", "-c", "feature");
  await writeFile(join(dir, "top.txt"), "x");
  const nested = join(dir, "nested");
  await mkdir(nested);
  await writeFile(join(nested, "deep.txt"), "y");
  const repository = await ready(nested);
  expect(repository.root).toBe(dir);
  expect(repository.branch.name).toBe("feature");
  expect(repository.files.map((file) => file.path).sort()).toEqual(["nested/deep.txt", "top.txt"]);
});

test("a merge conflict marks the file as conflicted on both sides", async () => {
  const dir = await repo();
  await commitFile(dir, "c.txt", "base\n");
  await must(dir, "switch", "-c", "other");
  await commitFile(dir, "c.txt", "other\n");
  await must(dir, "switch", "main");
  await commitFile(dir, "c.txt", "main\n");
  expect((await git(dir, ["merge", "other"])).code).not.toBe(0);
  expect((await ready(dir)).files).toEqual([{ path: "c.txt", staged: "conflict", unstaged: "conflict" }]);
  const conflict: FileChange = { path: "c.txt", staged: "conflict", unstaged: "conflict" };
  for (const side of ["staged", "unstaged"] as const) {
    const diff = await readDiff((args) => git(dir, args), conflict, side);
    expect(diff.text).toContain("@@ -1 ");
    expect(diff.text).toContain("+<<<<<<< HEAD");
    expect(diff.text).toContain("+other");
    expect(diff.text).not.toContain("@@@");
  }
});

test("ahead and behind counts follow the upstream branch", async () => {
  const origin = await folder();
  await must(origin, "init", "--bare", "-b", "main");
  const dir = await repo();
  await must(dir, "remote", "add", "origin", origin);
  await commitFile(dir, "a.txt", "1\n");
  await commitFile(dir, "b.txt", "2\n");
  await must(dir, "push", "-u", "origin", "main");
  await must(dir, "reset", "--hard", "HEAD~1");
  await commitFile(dir, "c.txt", "3\n");
  await commitFile(dir, "d.txt", "4\n");
  expect((await ready(dir)).branch).toEqual({
    name: "main",
    detached: false,
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
  });
});

test("a detached HEAD has no branch name", async () => {
  const dir = await repo();
  await commitFile(dir, "a.txt", "1\n");
  await must(dir, "switch", "--detach", "HEAD");
  const { branch } = await ready(dir);
  expect(branch.detached).toBe(true);
  expect(branch.name).toBeNull();
});

test("a failing git command surfaces its error instead of an empty list", async () => {
  const dir = await repo();
  await commitFile(dir, "a.txt", "1\n");
  await writeFile(join(dir, ".git", "index"), "not an index");
  await expect(read(dir)).rejects.toThrow(/index/i);
});

test("diffs distinguish staged and working changes for literal paths and renames", async () => {
  const dir = await repo();
  const path = "notes[1] 한글.txt";
  await writeFile(join(dir, path), "base\n");
  await must(dir, "--literal-pathspecs", "add", "--", path);
  await must(dir, "commit", "-m", "base");
  await writeFile(join(dir, path), "base\nstaged\n");
  await must(dir, "--literal-pathspecs", "add", "--", path);
  await writeFile(join(dir, path), "base\nstaged\nworking\n");
  const file = (await ready(dir)).files[0];
  if (!file) throw new Error("Expected changed file");
  const staged = await readDiff((args) => git(dir, args), file, "staged");
  const working = await readDiff((args) => git(dir, args), file, "unstaged");
  expect(staged.text).toContain("+staged");
  expect(staged.text).not.toContain("+working");
  expect(working.text).toContain("+working");
  expect(working.text).not.toContain("+staged");
  await commitFile(dir, "old name.txt", "unchanged\n".repeat(10));
  await must(dir, "mv", "--", "old name.txt", "renamed name.txt");
  const renamed = (await ready(dir)).files.find((entry) => entry.from === "old name.txt");
  if (!renamed) throw new Error("Expected renamed file");
  expect((await readDiff((args) => git(dir, args), renamed, "staged")).text).toContain("rename to renamed name.txt");
});

test("untracked text, empty and binary files open in an unborn repository", async () => {
  const dir = await repo();
  await writeFile(join(dir, "새 파일.txt"), "hello 世界\n");
  await writeFile(join(dir, "empty.txt"), "");
  await writeFile(join(dir, "binary.dat"), Buffer.from([0, 1, 2, 255]));
  const files = (await ready(dir)).files;
  const diff = async (path: string) => {
    const file = files.find((entry) => entry.path === path);
    if (!file) throw new Error(`Missing ${path}`);
    return readDiff((args) => git(dir, args), file, "unstaged");
  };
  expect((await diff("새 파일.txt")).text).toContain("+hello 世界");
  expect((await diff("empty.txt")).text).toContain("new file mode 100644");
  expect(await diff("binary.dat")).toMatchObject({ text: "", binary: true });
});

test("history pages stay on their snapshot and parse refs, bodies and HEAD decorations", async () => {
  const dir = await repo();
  const run = (args: string[]) => git(dir, args);
  const empty = await readHistoryPage(run, { start: null, offset: 0, count: 100 }, null);
  expect(empty).toMatchObject({ commits: [], hasMore: false });
  await commitFile(dir, "base.txt", "base\n");
  await must(dir, "switch", "-c", "feature");
  await writeFile(join(dir, "feature.txt"), "feature\n");
  await must(dir, "add", "feature.txt");
  await must(dir, "commit", "-m", "기능 [one] (#12)\n\nSearchable body.\nSecond line.");
  const feature = (await must(dir, "rev-parse", "HEAD")).trim();
  await must(dir, "tag", "-a", "v1", "-m", "Release");
  await must(dir, "switch", "main");
  await commitFile(dir, "main.txt", "main\n");
  await must(dir, "merge", "--no-ff", "feature", "-m", "Merge feature");
  const first = await readHistoryPage(run, { start: null, offset: 0, count: 2 }, null);
  expect(first.hasMore).toBe(true);
  expect(first.commits[0]?.parents.length).toBe(2);
  expect(first.commits[0]?.refs).toEqual([
    { name: "HEAD", kind: "head" },
    { name: "main", kind: "local" },
  ]);
  await commitFile(dir, "new.txt", "new after paging\n");
  const second = await readHistoryPage(run, { start: null, offset: 2, count: 100 }, first.cursor);
  const commits = [...first.commits, ...second.commits];
  expect(new Set(commits.map((entry) => entry.sha)).size).toBe(4);
  expect(second.hasMore).toBe(false);
  const tagged = commits.find((entry) => entry.sha === feature);
  expect(tagged).toMatchObject({ subject: "기능 [one] (#12)", body: "Searchable body.\nSecond line." });
  expect(tagged?.refs).toEqual([
    { name: "v1", kind: "tag" },
    { name: "feature", kind: "local" },
  ]);
  expect(filteredCommitIndices(commits, "searchable").map((index) => commits[index]?.sha)).toEqual([feature]);
  expect(filteredCommitIndices(commits, feature.slice(0, 6).toUpperCase()).length).toBe(1);
  const anchored = await readHistoryPage(run, { start: feature, offset: 0, count: 100 }, null);
  expect(anchored.commits.map((entry) => entry.subject)).toEqual(["기능 [one] (#12)", "add base.txt"]);
  const refs = await readRefs(run);
  expect(refs.find((ref) => ref.kind === "tag")?.sha).toBe(feature);
  expect(refs.find((ref) => ref.current)?.name).toBe("main");
  const before = await readRefsFingerprint(run);
  await must(dir, "switch", "--detach", "HEAD");
  expect(await readRefsFingerprint(run)).not.toBe(before);
  await commitFile(dir, "detached.txt", "detached\n");
  const detached = await readHistoryPage(run, { start: null, offset: 0, count: 100 }, null);
  expect(detached.commits[0]).toMatchObject({ subject: "add detached.txt", refs: [{ name: "HEAD", kind: "head" }] });
});

test("commit changes handle root commits, literal renamed paths and merges like diff-tree", async () => {
  const dir = await repo();
  const run = (args: string[]) => git(dir, args);
  const path = "notes[1] 한글\tfile.txt";
  await writeFile(join(dir, path), "unchanged\n".repeat(10));
  await must(dir, "--literal-pathspecs", "add", "--", path);
  await must(dir, "commit", "-m", "Root commit");
  const root = (await must(dir, "rev-parse", "HEAD")).trim();
  expect(await readCommitChanges(run, root)).toEqual([{ status: "A", path }]);
  await must(dir, "mv", "--", path, "renamed name.txt");
  await must(dir, "commit", "-m", "Rename");
  const rename = (await must(dir, "rev-parse", "HEAD")).trim();
  expect(await readCommitChanges(run, rename)).toEqual([{ status: "R100", path: "renamed name.txt", from: path }]);
  await must(dir, "switch", "-c", "feature");
  await commitFile(dir, "feature.txt", "feature content\n");
  await must(dir, "switch", "main");
  await commitFile(dir, "main.txt", "main content\n");
  await must(dir, "merge", "--no-ff", "feature", "-m", "Merge");
  expect(await readCommitChanges(run, (await must(dir, "rev-parse", "HEAD")).trim())).toEqual([]);
});

test("relative commit times use Git's wording", () => {
  expect(relativeTime(-5)).toBe("in the future");
  expect(relativeTime(89)).toBe("89 seconds ago");
  expect(relativeTime(90)).toBe("2 minutes ago");
  expect(relativeTime(36 * 3_600)).toBe("2 days ago");
  expect(relativeTime(14 * 86_400)).toBe("2 weeks ago");
  expect(relativeTime(364 * 86_400)).toBe("12 months ago");
  expect(relativeTime(365 * 86_400)).toBe("1 year ago");
  expect(relativeTime(400 * 86_400)).toBe("1 year, 1 month ago");
});

test("per-file Git reads keep a bounded number of processes and their order", async () => {
  let running = 0;
  let peak = 0;
  const paths = Array.from({ length: 200 }, (_, index) => `file-${index}`);
  const results = await mapGit(paths, async (path) => {
    running++;
    peak = Math.max(peak, running);
    await Bun.sleep(1);
    running--;
    return path;
  });
  expect(results).toEqual(paths);
  expect(peak).toBeLessThanOrEqual(8);
});
