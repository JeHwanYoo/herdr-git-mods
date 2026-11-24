import assert from "node:assert/strict";
import { type HistoryCursor, readHistoryPage } from "../../../src/git/history.ts";
import { prepareHistory } from "../../../src/git/history-maintenance.ts";
import type { RunGit } from "../../../src/git/repository.ts";
import type { Measure } from "../measure.ts";

export async function runPreparedHistory(git: RunGit, must: (args: string[]) => Promise<string>, measure: Measure) {
  console.log("[MEASURE] Unprepared first page · commit-graph disabled; no progress timer during measurement");
  const unprepared = performance.now();
  const revisions = (await must(["rev-list", "--all", "--no-walk=unsorted"])).split("\n");
  const baseline = await readHistoryPage(
    (args) => git(["-c", "core.commitGraph=false", ...args]),
    { start: null, offset: 0, count: 100 },
    { start: null, revisions, traversalRevisions: revisions },
  );
  const unpreparedMs = performance.now() - unprepared;
  assert.equal(baseline.commits.length, 100);
  console.log(`[DONE] Unprepared first page · ${unpreparedMs.toFixed(1)} ms`);
  console.log("[MEASURE] Prepare commit-graph + first page · one-time cost, reported separately");
  const began = performance.now();
  const preparation = await prepareHistory(git);
  const preparationMs = performance.now() - began;
  assert.equal(preparation.state, "ready", `Preparation skipped: ${JSON.stringify(preparation)}`);
  const first = await readHistoryPage(git, { start: null, offset: 0, count: 100 }, null);
  const firstUseMs = performance.now() - began;
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
  return { unpreparedMs, preparationMs, firstUseMs, preparation };
}
