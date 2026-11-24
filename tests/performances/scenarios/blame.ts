import assert from "node:assert/strict";
import { readBlameRange } from "../../../src/git/diff.ts";
import type { RunGit } from "../../../src/git/repository.ts";
import type { Measure } from "../measure.ts";

export default async function run(git: RunGit, measure: Measure) {
  await measure("visible line blame", 500, async () => {
    assert.equal((await readBlameRange(git, "kernel/sched/core.c", 1, 40, null)).length, 40);
  });
}
