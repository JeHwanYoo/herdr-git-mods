import assert from "node:assert/strict";
import { readFiles } from "../../../src/git/files.ts";
import type { RunGit } from "../../../src/git/repository.ts";
import { rankPaths } from "../../../src/ui/explorer/search.ts";
import type { Measure } from "../measure.ts";

export default async function run(git: RunGit, measure: Measure) {
  const paths = await readFiles(git);
  await measure("interactive path search", 100, async () => {
    assert(rankPaths(paths, "kernel/sched/core.c").length > 0);
  });
}
