import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChanges } from "../../src/git/comparison.ts";
import { shareSummaryReads } from "../../src/git/read-sharing.ts";
import { type GitResult, readRepository } from "../../src/git/repository.ts";
import { type GitAt, inspectProject, inspectWorktree, projectRoot } from "../../src/git/workspaces.ts";

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

const gitAt: GitAt = (cwd) => (args) => git(cwd, args);

async function must(cwd: string, ...args: string[]): Promise<void> {
  const result = await git(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

async function folder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "herdr-git-workspaces-")));
  folders.push(dir);
  return dir;
}

async function project(): Promise<string> {
  const base = await folder();
  const root = join(base, "project");
  await mkdir(root);
  await must(root, "init", "-b", "main");
  await writeFile(join(root, "tracked.txt"), "one\ntwo\nthree\n");
  await must(root, "add", "tracked.txt");
  await must(root, "commit", "-m", "Base");
  return root;
}

test("dirty counts combine staged, unstaged and untracked lines from a subfolder", async () => {
  const root = await project();
  await writeFile(join(root, "tracked.txt"), "one\nchanged\nthree\nfour\n");
  await writeFile(join(root, "staged.txt"), "a\nb\n");
  await must(root, "add", "staged.txt");
  await mkdir(join(root, "nested dir"));
  await writeFile(join(root, "nested dir", "new file.txt"), "x\ny\nz");
  await writeFile(join(root, "binary.bin"), "a\0b\n");

  const status = await inspectWorktree(gitAt, join(root, "nested dir"), null);

  expect(status.path).toBe(root);
  expect(status.branch).toEqual({ checkedOut: "main", upstream: null, ahead: 0, behind: 0 });
  expect(status.overview).toEqual({ changedPaths: 4, additions: 2 + 2 + 3, deletions: 1 });
});

test("an unchanged clean worktree reuses its previous status and a detached one names its commit", async () => {
  const root = await project();
  const first = await inspectWorktree(gitAt, root, null);
  expect(await inspectWorktree(gitAt, root, first)).toBe(first);

  await must(root, "checkout", "--detach");
  const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const detached = await inspectWorktree(gitAt, root, first);
  expect(detached.branch.checkedOut).toBe(`Detached ${head.slice(0, 8)}`);
});

test("upstream tracking reports ahead and behind counts", async () => {
  const root = await project();
  const clone = join(root, "..", "clone");
  await must(root, "clone", root, clone);
  await writeFile(join(clone, "local.txt"), "local\n");
  await must(clone, "add", "local.txt");
  await must(clone, "commit", "-m", "Local");
  await writeFile(join(root, "remote.txt"), "remote\n");
  await must(root, "add", "remote.txt");
  await must(root, "commit", "-m", "Remote 1");
  await writeFile(join(root, "remote.txt"), "remote\nagain\n");
  await must(root, "commit", "-am", "Remote 2");
  await must(clone, "fetch");

  const status = await inspectWorktree(gitAt, clone, null);

  expect(status.branch).toEqual({ checkedOut: "main", upstream: "origin/main", ahead: 1, behind: 2 });
});

test("a project with a worktree inside its own folder lists that worktree", async () => {
  const root = await project();
  await must(root, "worktree", "add", "-b", "nested", join(root, ".worktrees", "nested"));

  const status = await inspectProject(gitAt, root, [], null);

  expect(status.worktrees.map((worktree) => worktree.path)).toEqual([join(root, ".worktrees", "nested")]);
  expect(status.primary.overview).toEqual({ changedPaths: 1, additions: 0, deletions: 0 });
});

test("a project resolves from a linked worktree and lists its worktrees with their own changes", async () => {
  const root = await project();
  const linked = join(root, "..", "feature-a");
  await must(root, "worktree", "add", "-b", "feature-a", linked);
  await writeFile(join(linked, "tracked.txt"), "one\ntwo\nthree\nfeature\n");

  expect(await projectRoot(gitAt(linked))).toBe(root);
  const status = await inspectProject(gitAt, root, [], null);

  expect(status.root).toBe(root);
  expect(status.primary.overview.changedPaths).toBe(0);
  expect(status.worktrees.map((tree) => [tree.path, tree.branch.checkedOut, tree.overview])).toEqual([
    [linked, "feature-a", { changedPaths: 1, additions: 1, deletions: 0 }],
  ]);
});

test("a plain folder cannot be added as a project", async () => {
  const plain = await folder();
  await expect(projectRoot(gitAt(plain))).rejects.toThrow("Choose a directory inside a Git repository.");
});

test("Changes and Workspaces share active status and in-flight summaries without caching settled counts", async () => {
  const root = await project();
  await writeFile(join(root, "tracked.txt"), "one\ntwo\nthree\nstaged\n");
  await must(root, "add", "tracked.txt");
  await writeFile(join(root, "tracked.txt"), "one\ntwo\nthree\nstaged\nunstaged\n");
  await writeFile(join(root, "new\nfile\t.txt"), "new\n");
  const repository = await readRepository(gitAt(root));
  if (repository.state !== "ready") throw new Error("Missing repository");
  const commands: string[][] = [];
  const run = shareSummaryReads((args) => {
    commands.push(args);
    return git(root, args);
  });
  const [changes, workspace] = await Promise.all([
    readChanges(run, { kind: "last" }, repository.files),
    inspectWorktree(() => run, root, null, false, repository),
  ]);
  expect(commands).toHaveLength(3);
  expect(commands.every((args) => args.includes("--numstat"))).toBe(true);
  expect(changes.summaries.unstaged).toEqual({ files: 2, additions: 2, deletions: 0 });
  expect(workspace.overview).toEqual({ changedPaths: 2, additions: 3, deletions: 0 });

  await writeFile(join(root, "tracked.txt"), "one\ntwo\nthree\nstaged\nunstaged\nagain\n");
  await writeFile(join(root, "new\nfile\t.txt"), "new\nagain\nmore\n");
  const nextRepository = await readRepository(gitAt(root));
  if (nextRepository.state !== "ready") throw new Error("Missing repository");
  expect(nextRepository.porcelain).toBe(repository.porcelain);
  const next = await inspectWorktree(() => run, root, workspace, false, nextRepository);
  expect(commands).toHaveLength(6);
  expect(next.overview).toEqual({ changedPaths: 2, additions: 6, deletions: 0 });
});

test("a clean status from a different repository is never reused even with identical porcelain", async () => {
  const root = await project();
  const clone = join(root, "..", "clone");
  await must(root, "clone", root, clone);
  await must(clone, "branch", "--unset-upstream");
  const first = await inspectWorktree(gitAt, root, null);
  const second = await inspectWorktree(gitAt, clone, first);
  expect(second.fingerprint).toBe(first.fingerprint);
  expect(second.path).toBe(clone);
  expect(second).not.toBe(first);
  const repository = await readRepository(gitAt(root));
  if (repository.state !== "ready") throw new Error("Missing repository");
  const unrelated = await inspectWorktree(gitAt, clone, first, false, repository);
  expect(unrelated.path).toBe(clone);
});

test("a project uses its active snapshot without assuming other worktrees have the same status", async () => {
  const root = await project();
  const linked = join(root, "..", "linked");
  await must(root, "worktree", "add", "-b", "linked", linked);
  await writeFile(join(linked, "tracked.txt"), "one\ntwo\nthree\nlinked\n");
  const repository = await readRepository(gitAt(linked));
  if (repository.state !== "ready") throw new Error("Missing repository");
  const commands: { cwd: string; args: string[] }[] = [];
  const status = await inspectProject(
    (cwd) => (args) => {
      commands.push({ cwd, args });
      return git(cwd, args);
    },
    root,
    [],
    null,
    repository,
  );
  expect(status.primary.overview.changedPaths).toBe(0);
  expect(status.worktrees[0]?.overview).toEqual({ changedPaths: 1, additions: 1, deletions: 0 });
  expect(commands.filter(({ cwd, args }) => cwd === linked && args.includes("status"))).toHaveLength(0);
  expect(commands.filter(({ cwd, args }) => cwd === root && args.includes("status"))).toHaveLength(1);
});
