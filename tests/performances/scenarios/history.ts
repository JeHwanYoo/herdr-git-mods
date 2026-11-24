import assert from "node:assert/strict";
import { readHistoryPage } from "../../../src/git/history.ts";
import type { RunGit } from "../../../src/git/repository.ts";
import type { Measure } from "../measure.ts";
import { phase } from "../progress.ts";

export default async function run(git: RunGit, measure: Measure) {
  await phase("Create 120 synthetic history commits (fixture setup)", async () => {
    const tree = await git(["rev-parse", "HEAD^{tree}"]);
    let parent = (await git(["rev-parse", "HEAD"])).stdout.trim();
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
}
