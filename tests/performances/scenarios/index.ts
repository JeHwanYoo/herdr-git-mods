import runBlame from "./blame.ts";
import runChanges from "./changes.ts";
import runContentSearch from "./content-search.ts";
import runFileTree from "./file-tree.ts";
import runHistory from "./history.ts";
import runPathSearch from "./path-search.ts";
import runRepositoryStatus from "./repository-status.ts";
import runStaging from "./staging.ts";
import runWorkingDiff from "./working-diff.ts";

export const scenarios = {
  "repository-status": runRepositoryStatus,
  "file-tree": runFileTree,
  "path-search": runPathSearch,
  history: runHistory,
  "content-search": runContentSearch,
  blame: runBlame,
  changes: runChanges,
  "working-diff": runWorkingDiff,
  staging: runStaging,
};
