import assert from "node:assert/strict";
import type { RunGit } from "../../../src/git/repository.ts";
import { readRepository } from "../../../src/git/repository.ts";
import { runStaging } from "../../../src/git/staging.ts";
import type { Measure } from "../measure.ts";
import { addTrackedEdit } from "../working-tree.ts";

export default async function run(git: RunGit, measure: Measure, repo: string) {
  await addTrackedEdit(repo);
  await measure(
    "stage and refresh",
    500,
    async () => {
      await runStaging(git, { kind: "stage", paths: ["README"] });
      const status = await readRepository(git);
      assert(
        status.state === "ready" && status.files.some((file) => file.path === "README" && file.staged === "modified"),
      );
    },
    async () => {
      await runStaging(git, { kind: "unstage", paths: ["README"] });
    },
  );
}
