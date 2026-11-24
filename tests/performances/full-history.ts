import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunGit } from "../../src/git/repository.ts";
import { createMeasure, type Row } from "./measure.ts";
import { phase } from "./progress.ts";
import runChanges from "./scenarios/changes.ts";
import { runPreparedHistory } from "./scenarios/prepared-history.ts";

export async function runFullHistory(source: string) {
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
  const rows: Row[] = [];
  const measure = createMeasure(rows);
  let failure: string | null = null;
  let setupMs = 0;
  let history: Awaited<ReturnType<typeof runPreparedHistory>> | undefined;
  let revision = "";
  let commits = 0;
  let files = 0;
  let refs = 0;

  async function command(args: string[], cwd = repo) {
    const child = Bun.spawn(["git", "-c", `safe.directory=${resolve(source)}`, ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
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

  try {
    console.log(
      "Full-history Linux gate · prepared queries; setup/first-use reported separately; no native UI timing.",
    );
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
    history = await runPreparedHistory(git, must, measure);
    await runChanges(git, measure, repo);
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
          ...history,
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
}
