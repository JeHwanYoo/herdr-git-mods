import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readChanges } from "../../../src/git/comparison.ts";
import type { RunGit } from "../../../src/git/repository.ts";
import { readRepository } from "../../../src/git/repository.ts";
import type { Measure } from "../measure.ts";
import { addTrackedEdit } from "../working-tree.ts";

export default async function run(git: RunGit, measure: Measure, repo: string) {
  await addTrackedEdit(repo);
  await writeFile(join(repo, "herdr-performance-untracked.txt"), "untracked performance fixture\n");
  const repository = await readRepository(git);
  assert.equal(repository.state, "ready");
  if (repository.state !== "ready") throw new Error("Missing benchmark repository");
  await measure("changes from current status", 500, async () => {
    const changes = await readChanges(git, { kind: "last" }, repository.files);
    assert(changes.changes.some((file) => file.path === "README" && file.section === "unstaged"));
    assert(changes.changes.some((file) => file.path === "herdr-performance-untracked.txt" && file.status === "??"));
    assert.equal(changes.summaries.unstaged?.files, 2);
    assert((changes.summaries.unstaged?.additions ?? 0) >= 2);
  });
}
