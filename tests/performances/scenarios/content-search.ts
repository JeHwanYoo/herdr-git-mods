import assert from "node:assert/strict";
import { searchContents } from "../../../src/git/files.ts";
import type { RunGit } from "../../../src/git/repository.ts";
import type { Measure } from "../measure.ts";

export default async function run(git: RunGit, measure: Measure) {
  await measure("content search", 1000, async () => {
    const matches = await searchContents(git, "schedule");
    assert(matches.length > 0);
  });
}
