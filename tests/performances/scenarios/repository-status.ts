import assert from "node:assert/strict";
import type { RunGit } from "../../../src/git/repository.ts";
import { readRepository } from "../../../src/git/repository.ts";
import type { Measure } from "../measure.ts";

export default async function run(git: RunGit, measure: Measure) {
  await measure("repository status", 500, async () => {
    const result = await readRepository(git);
    assert.equal(result.state, "ready");
  });
}
