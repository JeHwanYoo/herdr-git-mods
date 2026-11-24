import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunGit } from "../../src/git/repository.ts";
import { cloneFixture, LINUX_FIXTURE, prepareFixtureCache } from "./fixture-cache.ts";
import { runFullHistory } from "./full-history.ts";
import { createMeasure, type Row } from "./measure.ts";
import { phase } from "./progress.ts";
import { scenarios } from "./scenarios/index.ts";
import { parseSelection } from "./selection.ts";

const selection = parseSelection(process.argv.slice(2));
if (selection.source) {
  await runFullHistory(selection.source);
} else {
  const root = await mkdtemp(join(tmpdir(), "herdr-linux-perf-"));
  const repo = join(root, "linux");
  const report = resolve(process.env.PERF_REPORT ?? "performance.json");
  const startedAt = new Date().toISOString();
  const setupStarted = performance.now();
  let setupMs = 0;
  let failure: string | null = null;
  const rows: Row[] = [];
  const measure = createMeasure(rows);
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

  try {
    console.log("Linux component gate · pinned shallow v6.12");
    console.log(`Report: ${report}`);
    const cache = await prepareFixtureCache();
    await cloneFixture(cache, repo);
    const revision = await git(["rev-parse", "HEAD"]);
    assert.equal(revision.stdout.trim(), LINUX_FIXTURE.revision);
    setupMs = performance.now() - setupStarted;
    for (const [name, run] of Object.entries(scenarios)) {
      if (selection.scenario && selection.scenario !== name) continue;
      await run(git, measure, repo);
      if (name === "changes" || name === "working-diff") {
        const restored = await git(["restore", "--staged", "--worktree", "--", "README"]);
        assert.equal(restored.code, 0, restored.stderr);
        await rm(join(repo, "herdr-performance-untracked.txt"), { force: true });
      }
    }
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
          fixture: "linux v6.12 depth=1",
          scenario: selection.scenario ?? "all",
          rows,
        },
        null,
        2,
      ),
    );
    await phase("Remove temporary Linux checkout", () => rm(root, { recursive: true, force: true }));
  }
  if (rows.some((row) => !row.passed)) process.exitCode = 1;
}
