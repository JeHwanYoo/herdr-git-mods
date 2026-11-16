import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRebasePlan, runRebase } from "../src/git/rebase.ts";
import { readBranches } from "../src/git/ref-operations.ts";
import { readRemotes } from "../src/git/remotes.ts";
import type { GitResult } from "../src/git/repository.ts";
import { ReviewedOperation } from "../src/git/workflows.ts";

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
  return result.stdout.trim();
}

async function repo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "herdr-git-ops-")));
  folders.push(dir);
  await must(dir, "init", "-b", "main");
  return dir;
}

async function commit(dir: string, name: string, text: string, message: string): Promise<string> {
  await writeFile(join(dir, name), text);
  await must(dir, "add", name);
  await must(dir, "commit", "-m", message);
  return must(dir, "rev-parse", "HEAD");
}

async function subjects(dir: string): Promise<string[]> {
  return (await must(dir, "log", "--format=%s")).split("\n");
}

test("interactive rebase applies reword, squash and drop in the order shown newest first", async () => {
  const dir = await repo();
  const base = await commit(dir, "a.txt", "a\n", "base");
  await commit(dir, "b.txt", "b\n", "second");
  await commit(dir, "c.txt", "c\n", "third");
  await commit(dir, "d.txt", "d\n", "fourth");
  const runner = (args: string[]) => git(dir, args);
  const plan = await readRebasePlan(runner, { kind: "onto", target: base });
  expect(plan.entries.map((entry) => entry.message)).toEqual(["fourth", "third", "second"]);
  const [fourth, third, second] = plan.entries;
  if (!fourth || !third || !second) throw new Error("missing entries");
  second.action = "reword";
  second.message = "second, it's reworded";
  third.action = "fixup";
  fourth.action = "drop";
  const result = await runRebase(runner, { kind: "start", plan });
  expect(result).toMatchObject({ active: false, success: true });
  expect(await subjects(dir)).toEqual(["second, it's reworded", "base"]);
  expect(await must(dir, "ls-files")).toBe("a.txt\nb.txt\nc.txt");
});

test("interactive rebase refuses invalid plans and a HEAD that moved after review", async () => {
  const dir = await repo();
  await commit(dir, "a.txt", "a\n", "base");
  const first = await commit(dir, "b.txt", "b\n", "second");
  const runner = (args: string[]) => git(dir, args);
  const plan = await readRebasePlan(runner, { kind: "inclusive", target: first });
  const [entry] = plan.entries;
  if (!entry) throw new Error("missing entry");
  entry.action = "squash";
  await expect(runRebase(runner, { kind: "start", plan })).rejects.toThrow("Squash and Fixup");
  entry.action = "pick";
  await commit(dir, "c.txt", "c\n", "moved");
  await expect(runRebase(runner, { kind: "start", plan })).rejects.toThrow("Branch or HEAD changed");
  expect(await subjects(dir)).toEqual(["moved", "second", "base"]);
});

test("an edit stop is detected, amended, and continued to completion", async () => {
  const dir = await repo();
  await commit(dir, "a.txt", "a\n", "base");
  const target = await commit(dir, "b.txt", "b\n", "second");
  await commit(dir, "c.txt", "c\n", "third");
  const runner = (args: string[]) => git(dir, args);
  const plan = await readRebasePlan(runner, { kind: "inclusive", target });
  const second = plan.entries[1];
  if (!second) throw new Error("missing entry");
  second.action = "edit";
  const stopped = await runRebase(runner, { kind: "start", plan });
  expect(stopped).toMatchObject({ active: true, success: true, message: "second" });
  const reopened = await readRebasePlan(runner, { kind: "inclusive", target });
  expect(reopened).toMatchObject({ active: true, branch: "main" });
  expect((await runRebase(runner, { kind: "amend", message: "second amended" })).active).toBe(true);
  const done = await runRebase(runner, { kind: "continue" });
  expect(done).toMatchObject({ active: false, success: true });
  expect(await subjects(dir)).toEqual(["third", "second amended", "base"]);
  await expect(runRebase(runner, { kind: "abort" })).rejects.toThrow("No rebase is in progress");
});

test("branch rename and delete refuse moved branches and worktree checkouts", async () => {
  const dir = await repo();
  await commit(dir, "a.txt", "a\n", "base");
  await must(dir, "branch", "feature");
  await must(dir, "branch", "other");
  const tree = join(dir, "..", `${dir.split("/").pop()}-tree`);
  folders.push(tree);
  await must(dir, "worktree", "add", tree, "other");
  const runner = (args: string[]) => git(dir, args);
  const branches = await readBranches(runner);
  expect(branches[0]).toMatchObject({ reference: "refs/heads/main", current: true });
  const feature = branches.find((branch) => branch.reference === "refs/heads/feature");
  const other = branches.find((branch) => branch.reference === "refs/heads/other");
  if (!feature || !other) throw new Error("missing branches");
  expect(other.worktree).toBe(await realpath(tree));
  const remove = await ReviewedOperation.review(runner, {
    kind: "delete-branch",
    reference: other.reference,
    expected: other.commit,
  });
  await expect(remove.run(runner)).rejects.toThrow("checked out in a worktree");
  const rename = await ReviewedOperation.review(runner, {
    kind: "rename-branch",
    reference: feature.reference,
    name: "renamed",
    expected: feature.commit,
  });
  await commit(dir, "b.txt", "b\n", "move main");
  await must(dir, "branch", "-f", "feature", "HEAD");
  await expect(rename.run(runner)).rejects.toThrow("Branch changed");
  const fresh = (await readBranches(runner)).find((branch) => branch.reference === "refs/heads/feature");
  if (!fresh) throw new Error("missing branch");
  await ReviewedOperation.review(runner, {
    kind: "rename-branch",
    reference: fresh.reference,
    name: "renamed",
    expected: fresh.commit,
  }).then((operation) => operation.run(runner));
  expect(await must(dir, "branch", "--list", "renamed")).toContain("renamed");
});

test("discarding tracked changes keeps untracked files and stops when HEAD moved", async () => {
  const dir = await repo();
  const head = await commit(dir, "a.txt", "a\n", "base");
  await writeFile(join(dir, "a.txt"), "edited\n");
  await writeFile(join(dir, "new.txt"), "keep\n");
  const runner = (args: string[]) => git(dir, args);
  await (await ReviewedOperation.review(runner, { kind: "discard-tracked", head })).run(runner);
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("a\n");
  expect(await Bun.file(join(dir, "new.txt")).text()).toBe("keep\n");
  await writeFile(join(dir, "a.txt"), "edited again\n");
  const stale = await ReviewedOperation.review(runner, { kind: "discard-tracked", head });
  await must(dir, "commit", "-am", "moved");
  await expect(stale.run(runner)).rejects.toThrow("Repository changed");
});

test("push refuses a changed branch", async () => {
  const dir = await repo();
  await commit(dir, "a.txt", "a\n", "base");
  const remote = `${dir}-remote.git`;
  folders.push(remote);
  await must(dir, "init", "--bare", "-b", "main", remote);
  await must(dir, "remote", "add", "origin", remote);
  await must(dir, "branch", "alpha");
  const runner = (args: string[]) => git(dir, args);
  expect(await readRemotes(runner)).toEqual([{ name: "origin", url: remote, pushUrl: remote }]);
  const push = await ReviewedOperation.review(runner, { kind: "push", force: false, remote: "origin", branch: "main" });
  await must(dir, "switch", "alpha");
  await expect(push.run(runner)).rejects.toThrow("current branch changed");
  await must(dir, "switch", "main");
  await push.run(runner);
  expect(await must(remote, "rev-parse", "main")).toBe(await must(dir, "rev-parse", "HEAD"));
});
