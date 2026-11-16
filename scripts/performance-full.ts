import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readChanges } from "../src/git/comparison.ts";
import { type HistoryCursor, readHistoryPage } from "../src/git/history.ts";
import { type HistoryPreparation, prepareHistory } from "../src/git/history-maintenance.ts";
import { type RunGit, readRepository } from "../src/git/repository.ts";
import { phase, sampleProgress } from "./performance-progress.ts";

const source = process.argv[2];
if (!source || process.argv.length !== 3) throw new Error("Usage: bun run performance:full /path/to/full/linux");
const root = await mkdtemp(join(tmpdir(), "herdr-full-history-"));
const repo = join(root, "linux");
const report = resolve(process.env.PERF_REPORT ?? "performance-full.json");
const startedAt = new Date().toISOString();
const setupStarted = performance.now();
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};
interface Row {
  name: string;
  budgetMs: number;
  firstMs: number;
  p95Ms: number;
  maxMs: number;
  samplesMs: number[];
  passed: boolean;
}
const rows: Row[] = [];
let failure: string | null = null;
let setupMs = 0;
let unpreparedMs = 0;
let preparationMs = 0;
let firstUseMs = 0;
let revision = "";
let commits = 0;
let files = 0;
let refs = 0;
let preparation: HistoryPreparation | null = null;

async function command(args: string[], cwd = repo) {
  const child = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 300_000);
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
const git: RunGit = (args) => command(args);

async function must(args: string[], cwd = repo): Promise<string> {
  const result = await command(args, cwd);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function measure(name: string, budgetMs: number, action: (iteration: number) => Promise<void>) {
  console.log(`[MEASURE] ${name} · 21 samples · p95 <= ${budgetMs} ms, max <= ${budgetMs * 2} ms`);
  const samplesMs: number[] = [];
  for (let iteration = 0; iteration < 21; iteration++) {
    const began = performance.now();
    await action(iteration);
    const ms = performance.now() - began;
    samplesMs.push(ms);
    sampleProgress(name, iteration + 1, 21, ms);
  }
  const firstMs = samplesMs.shift() ?? 0;
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
  const maxMs = Math.max(firstMs, ...samplesMs);
  const passed = p95Ms <= budgetMs && maxMs <= budgetMs * 2;
  rows.push({ name, budgetMs, firstMs, p95Ms, maxMs, samplesMs, passed });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: p95 ${p95Ms.toFixed(1)} ms, max ${maxMs.toFixed(1)} ms`);
}

async function historyGate(): Promise<void> {
  console.log("[MEASURE] Unprepared first page · commit-graph disabled; no progress timer during measurement");
  const unprepared = performance.now();
  const revisions = (await must(["rev-list", "--all", "--no-walk=unsorted"])).split("\n");
  const baseline = await readHistoryPage(
    (args) => git(["-c", "core.commitGraph=false", ...args]),
    { start: null, offset: 0, count: 100 },
    { start: null, revisions, traversalRevisions: revisions },
  );
  unpreparedMs = performance.now() - unprepared;
  assert.equal(baseline.commits.length, 100);
  console.log(`[DONE] Unprepared first page · ${unpreparedMs.toFixed(1)} ms`);
  console.log("[MEASURE] Prepare commit-graph + first page · one-time cost, reported separately");
  const began = performance.now();
  preparation = await prepareHistory(git);
  preparationMs = performance.now() - began;
  assert.equal(preparation.state, "ready", `Preparation skipped: ${JSON.stringify(preparation)}`);
  const first = await readHistoryPage(git, { start: null, offset: 0, count: 100 }, null);
  firstUseMs = performance.now() - began;
  assert.deepEqual(first.commits, baseline.commits);
  console.log(
    `Unprepared traversal ${unpreparedMs.toFixed(1)} ms; preparation ${preparationMs.toFixed(1)} ms; preparation + first page ${firstUseMs.toFixed(1)} ms`,
  );
  await measure("prepared history first 100", 500, async () => {
    const page = await readHistoryPage(git, { start: null, offset: 0, count: 100 }, null);
    assert.deepEqual(page.commits, first.commits);
    assert(page.hasMore);
  });
  let cursor: HistoryCursor = first.cursor;
  const paged = first.commits.map((commit) => commit.sha);
  await measure("prepared history next 100", 500, async (iteration) => {
    const offset = (iteration + 1) * 100;
    const page = await readHistoryPage(git, { start: null, offset, count: 100 }, cursor);
    assert.equal(page.commits.length, 100);
    assert.equal(page.offset, offset);
    cursor = page.cursor;
    paged.push(...page.commits.map((commit) => commit.sha));
  });
  console.log(`[VERIFY] Checking ${paged.length} commits against Git for order and duplicates`);
  const expected = await must([
    "log",
    "--topo-order",
    "--date-order",
    "--format=%H",
    `--max-count=${paged.length}`,
    ...cursor.revisions,
    "--",
  ]);
  assert.deepEqual(paged, expected.split("\n"));
  assert.equal(new Set(paged).size, paged.length, "Pagination duplicated commits");
}

async function changesGate(): Promise<void> {
  console.log("[SETUP] Create tracked/untracked changes and read one shared status snapshot");
  await appendFile(join(repo, "README"), "\nherdr-full-history-performance\n");
  await writeFile(join(repo, "herdr-performance-untracked.txt"), "untracked performance fixture\n");
  const repository = await readRepository(git);
  assert.equal(repository.state, "ready");
  if (repository.state !== "ready") throw new Error("Missing benchmark repository");
  await measure("changes from current status", 500, async () => {
    const changes = await readChanges(git, { kind: "last" }, repository.files);
    assert(changes.changes.some((file) => file.path === "README" && file.section === "unstaged"));
    assert(changes.changes.some((file) => file.path === "herdr-performance-untracked.txt" && file.status === "??"));
    assert((changes.summaries.unstaged?.additions ?? 0) >= 2);
  });
}

try {
  console.log("Full-history Linux gate · prepared queries; setup/first-use reported separately; no native UI timing.");
  console.log(`Report: ${report}`);
  await phase("Validate full-history source", async () => {
    assert.equal(await must(["rev-parse", "--is-shallow-repository"], resolve(source)), "false");
  });
  await phase(`Create isolated full-history clone at ${repo}`, () =>
    must(["clone", "--shared", "--no-checkout", "--quiet", resolve(source), repo], root),
  );
  await phase("Check out complete Linux working tree", () => must(["checkout", "--quiet", "HEAD"]));
  await phase("Count and validate Linux commits, files and refs", async () => {
    revision = await must(["rev-parse", "HEAD"]);
    commits = Number(await must(["rev-list", "--count", "--all"]));
    files = (await must(["ls-files", "-z"])).split("\0").filter(Boolean).length;
    refs = (await must(["for-each-ref", "--format=%(refname)"])).split("\n").filter(Boolean).length;
    assert(commits > 500_000, "Use the complete Linux history, not a shallow/synthetic fixture");
    assert(files > 70_000, "Use a complete Linux checkout");
    assert.equal(await must(["ls-files", "kernel/sched/core.c"]), "kernel/sched/core.c");
  });
  console.log(`[FIXTURE] ${commits} commits · ${files} files · ${refs} refs`);
  setupMs = performance.now() - setupStarted;
  await historyGate();
  await changesGate();
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
        platform: process.platform,
        architecture: process.arch,
        bun: Bun.version,
        gitVersion: (await command(["--version"], root)).stdout.trim(),
        source: resolve(source),
        revision,
        commits,
        files,
        refs,
        setupMs,
        unpreparedMs,
        preparationMs,
        firstUseMs,
        preparation,
        failure,
        rows,
      },
      null,
      2,
    ),
  );
  await phase("Remove temporary Linux checkout", () => rm(root, { recursive: true, force: true }));
}
if (rows.some((row) => !row.passed)) process.exitCode = 1;
