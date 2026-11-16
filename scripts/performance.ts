import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readChanges } from "../src/git/comparison.ts";
import { readBlameRange, readDiff } from "../src/git/diff.ts";
import { readFiles, searchContents } from "../src/git/files.ts";
import { readHistoryPage } from "../src/git/history.ts";
import { type RunGit, readRepository } from "../src/git/repository.ts";
import { runStaging } from "../src/git/staging.ts";
import { rankPaths } from "../src/ui/explorer/search.ts";
import { PathTree } from "../src/ui/explorer/tree.ts";
import { cloneFixture, LINUX_FIXTURE, prepareFixtureCache } from "./performance-cache.ts";
import { phase, sampleProgress } from "./performance-progress.ts";

const root = await mkdtemp(join(tmpdir(), "herdr-linux-perf-"));
const repo = join(root, "linux");
const report = resolve(process.env.PERF_REPORT ?? "performance.json");
const startedAt = new Date().toISOString();
const setupStarted = performance.now();
let setupMs = 0;
let failure: string | null = null;
const rows: {
  name: string;
  budgetMs: number;
  firstMs: number;
  p95Ms: number;
  maxMs: number;
  samplesMs: number[];
  passed: boolean;
}[] = [];
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  GIT_AUTHOR_NAME: "Performance",
  GIT_AUTHOR_EMAIL: "performance@example.invalid",
  GIT_COMMITTER_NAME: "Performance",
  GIT_COMMITTER_EMAIL: "performance@example.invalid",
};

async function command(args: string[], cwd = root) {
  const child = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 600_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timer);
  }
}
const git: RunGit = (args) => command(args, repo);

async function measure(name: string, budgetMs: number, action: () => Promise<void>, cleanup?: () => Promise<void>) {
  console.log(`[MEASURE] ${name} · 21 samples · p95 <= ${budgetMs} ms, max <= ${budgetMs * 2} ms`);
  const samplesMs: number[] = [];
  for (let i = 0; i < 21; i++) {
    const start = performance.now();
    await action();
    const ms = performance.now() - start;
    samplesMs.push(ms);
    await cleanup?.();
    sampleProgress(name, i + 1, 21, ms);
  }
  const firstMs = samplesMs.shift() ?? 0;
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
  const maxMs = Math.max(...samplesMs, firstMs);
  const passed = p95Ms <= budgetMs && maxMs <= budgetMs * 2;
  rows.push({ name, budgetMs, firstMs, p95Ms, maxMs, samplesMs, passed });
  console.log(
    `${passed ? "PASS" : "FAIL"} ${name}: p95 ${p95Ms.toFixed(1)} ms / ${budgetMs} ms, max ${maxMs.toFixed(1)} ms`,
  );
}

try {
  console.log("Linux component gate · shallow v6.12 + synthetic history; not the full-history/UI gate.");
  console.log(`Report: ${report}`);
  const cache = await prepareFixtureCache();
  await cloneFixture(cache, repo);
  const revision = await git(["rev-parse", "HEAD"]);
  assert.equal(revision.stdout.trim(), LINUX_FIXTURE.revision);
  setupMs = performance.now() - setupStarted;
  await measure("repository status", 500, async () => {
    const result = await readRepository(git);
    assert.equal(result.state, "ready");
  });
  await measure("file listing and tree", 300, async () => {
    const files = await readFiles(git);
    assert(files.length > 70000 && files.includes("kernel/sched/core.c"));
    assert(new PathTree(files).rows(new Set()).some((row) => row.path === "kernel"));
  });
  const paths = await readFiles(git);
  await measure("interactive path search", 100, async () => {
    assert(rankPaths(paths, "kernel/sched/core.c").length > 0);
  });
  await phase("Create 120 synthetic history commits (fixture setup)", async () => {
    const tree = await git(["rev-parse", "HEAD^{tree}"]);
    let parent = revision.stdout.trim();
    for (let i = 0; i < 120; i++) {
      const commit = await git(["commit-tree", tree.stdout.trim(), "-p", parent, "-m", `Performance history ${i}`]);
      assert.equal(commit.code, 0, commit.stderr);
      parent = commit.stdout.trim();
    }
    assert.equal((await git(["update-ref", "refs/heads/performance-history", parent])).code, 0);
  });
  await measure("history first page", 500, async () => {
    const page = await readHistoryPage(git, { start: null, offset: 0, count: 100 }, null);
    assert.equal(page.commits.length, 100);
    assert(page.hasMore);
  });
  await measure("content search", 1000, async () => {
    const matches = await searchContents(git, "schedule");
    assert(matches.length > 0);
  });
  await measure("visible line blame", 500, async () => {
    assert.equal((await readBlameRange(git, "kernel/sched/core.c", 1, 40, null)).length, 40);
  });
  await appendFile(join(repo, "README"), "\nherdr-performance-fixture\n");
  await writeFile(join(repo, "herdr-performance-untracked.txt"), "untracked performance fixture\n");
  const repository = await readRepository(git);
  assert.equal(repository.state, "ready");
  if (repository.state !== "ready") throw new Error("Missing benchmark repository");
  await measure("changes from current status", 500, async () => {
    const changes = await readChanges(git, { kind: "last" }, repository.files);
    assert(changes.changes.some((file) => file.path === "README" && file.section === "unstaged"));
    assert(changes.changes.some((file) => file.path === "herdr-performance-untracked.txt" && file.status === "??"));
    assert.equal(changes.summaries.unstaged?.files, 2);
    assert((changes.summaries.unstaged?.additions ?? 0) >= 2);
  });
  await measure("working diff", 200, async () => {
    const diff = await readDiff(git, { path: "README", staged: null, unstaged: "modified" }, "unstaged");
    assert(diff.text.includes("+herdr-performance-fixture"));
  });
  await measure(
    "stage and refresh",
    500,
    async () => {
      await runStaging(git, { kind: "stage", paths: ["README"] });
      const status = await readRepository(git);
      assert(
        status.state === "ready" && status.files.some((file) => file.path === "README" && file.staged === "modified"),
      );
    },
    async () => {
      await runStaging(git, { kind: "unstage", paths: ["README"] });
    },
  );
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  console.log(`[REPORT] Writing ${report}`);
  await Bun.write(
    report,
    JSON.stringify(
      {
        startedAt,
        setupMs,
        failure,
        architecture: process.arch,
        cpuMax: await readFile("/sys/fs/cgroup/cpu.max", "utf8").catch(() => null),
        memoryMax: await readFile("/sys/fs/cgroup/memory.max", "utf8").catch(() => null),
        gitVersion: (await command(["--version"])).stdout.trim(),
        platform: process.platform,
        bun: Bun.version,
        fixture: "linux v6.12 depth=1 + 120 synthetic commits",
        rows,
      },
      null,
      2,
    ),
  );
  await phase("Remove temporary Linux checkout", () => rm(root, { recursive: true, force: true }));
}
if (rows.some((row) => !row.passed)) process.exitCode = 1;
