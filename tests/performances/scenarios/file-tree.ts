import assert from "node:assert/strict";
import { readFiles } from "../../../src/git/files.ts";
import type { RunGit } from "../../../src/git/repository.ts";
import { PathTree } from "../../../src/ui/explorer/tree.ts";
import type { Measure } from "../measure.ts";

export default async function run(git: RunGit, measure: Measure) {
  await measure("file listing and tree", 300, async () => {
    const files = await readFiles(git);
    assert(files.length > 70000 && files.includes("kernel/sched/core.c"));
    assert(new PathTree(files).rows(new Set()).some((row) => row.path === "kernel"));
  });
}
