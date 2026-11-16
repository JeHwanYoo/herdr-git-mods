import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLineChanges, readLineHistory, searchContents } from "../src/git/files.ts";
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

async function repo(file: string, text: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "herdr-git-files-")));
  folders.push(dir);
  await must(dir, "init", "-b", "main");
  await writeFile(join(dir, file), text);
  await must(dir, "add", ".");
  await must(dir, "commit", "-m", "base");
  return dir;
}

test("working tree line changes place removed lines and count added ones against HEAD", async () => {
  const dir = await repo("file.txt", "one\n-- two\nthree\nfour\n");
  const runner = (args: string[]) => git(dir, args);
  await writeFile(join(dir, "file.txt"), "one\nTWO\nthree\nextra\n");
  expect(await readLineChanges(runner, "file.txt")).toEqual([
    { oldStart: 2, removed: ["-- two"], newStart: 2, added: 1 },
    { oldStart: 4, removed: ["four"], newStart: 4, added: 1 },
  ]);
  await writeFile(join(dir, "file.txt"), "one\nthree\nfour\nfive\n");
  expect(await readLineChanges(runner, "file.txt")).toEqual([
    { oldStart: 2, removed: ["-- two"], newStart: 2, added: 0 },
    { oldStart: 5, removed: [], newStart: 4, added: 1 },
  ]);
});

test("line history lists the commits that touched the selected lines, newest first", async () => {
  const dir = await repo("notes.txt", "alpha\nbeta\ngamma\n");
  await writeFile(join(dir, "notes.txt"), "alpha\nBETA\ngamma\n");
  await must(dir, "commit", "-am", "Shout beta");
  await writeFile(join(dir, "notes.txt"), "ALPHA\nBETA\ngamma\n");
  await must(dir, "commit", "-am", "Shout alpha");
  const history = await readLineHistory((args) => git(dir, args), "notes.txt", [[2, 2]], null);
  expect(history.map((entry) => entry.summary)).toEqual(["Shout beta", "base"]);
  expect(history[0]?.author).toBe("Test");
  expect(history[0]?.patch).toContain("+BETA");
});

test("content search is smart-case and reports where the query sits in each line", async () => {
  const dir = await repo("app.rs", 'fn main() {\n    let cargo = "Cargo";\n}\n');
  await writeFile(join(dir, "untracked.txt"), "cargo\n");
  const runner = (args: string[]) => git(dir, args);
  expect(await searchContents(runner, "cargo")).toEqual([
    { path: "app.rs", line: 2, start: 8, end: 13 },
    { path: "untracked.txt", line: 1, start: 0, end: 5 },
  ]);
  expect(await searchContents(runner, "Cargo")).toEqual([{ path: "app.rs", line: 2, start: 17, end: 22 }]);
});

test("content search reaches later batches and respects literal filenames and the result cap", async () => {
  const dir = await repo("base.txt", "nothing\n");
  await Promise.all(
    Array.from({ length: 520 }, (_, index) =>
      writeFile(join(dir, `file-${String(index).padStart(4, "0")}.txt`), "nothing\n"),
    ),
  );
  await writeFile(join(dir, "z[1].txt"), "needle\n".repeat(1005));
  await writeFile(join(dir, "z1.txt"), "different\n");
  const runner = (args: string[]) => git(dir, args);
  const matches = await searchContents(runner, "needle");
  expect(matches).toHaveLength(1000);
  expect(matches[0]).toEqual({ path: "z[1].txt", line: 1, start: 0, end: 6 });
  expect(matches.at(-1)?.line).toBe(1000);
  expect(await searchContents(runner, "absent-value")).toEqual([]);
});
