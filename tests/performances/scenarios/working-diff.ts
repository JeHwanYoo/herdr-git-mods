import assert from "node:assert/strict";
import { readDiff } from "../../../src/git/diff.ts";
import type { RunGit } from "../../../src/git/repository.ts";
import type { Measure } from "../measure.ts";
import { addTrackedEdit } from "../working-tree.ts";

export default async function run(git: RunGit, measure: Measure, repo: string) {
  await addTrackedEdit(repo);
  await measure("working diff", 200, async () => {
    const diff = await readDiff(git, { path: "README", staged: null, unstaged: "modified" }, "unstaged");
    assert(diff.text.includes("+herdr-performance-fixture"));
  });
}
