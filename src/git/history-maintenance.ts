import type { GitResult, RunGit } from "./repository.ts";

export interface HistoryPreparation {
  state: "ready" | "skipped";
  reason?: string;
}

function checked(result: GitResult, command: string): string {
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${command} exited with ${result.code}`);
  return result.stdout.trim();
}

async function config(git: RunGit, type: "--bool" | "--int", key: string): Promise<string | null> {
  const result = await git(["config", type, "--get", key]);
  return result.code === 1 ? null : checked(result, "config");
}

// Ready means preparation completed; Git may decline writes for grafts.
export async function prepareHistory(git: RunGit): Promise<HistoryPreparation> {
  const [enabled, auto] = await Promise.all([
    config(git, "--bool", "core.commitGraph"),
    config(git, "--int", "maintenance.commit-graph.auto"),
  ]);
  if (enabled === "false") return { state: "skipped", reason: "core.commitGraph=false" };
  if (auto === "0") return { state: "skipped", reason: "maintenance.commit-graph.auto=0" };

  const [shallow, replacements, refs] = await Promise.all([
    git(["rev-parse", "--is-shallow-repository"]),
    git(["for-each-ref", "--format=%(refname)", "refs/replace/"]),
    git(["show-ref", "--head", "--quiet"]),
  ]);
  const isShallow = checked(shallow, "rev-parse") === "true";
  const hasReplacements = checked(replacements, "for-each-ref") !== "";
  if (refs.code !== 1) checked(refs, "show-ref");
  if (isShallow) return { state: "skipped", reason: "Shallow repository" };
  if (hasReplacements) return { state: "skipped", reason: "Replacement refs" };
  if (refs.code === 1) return { state: "skipped", reason: "No commits" };

  checked(
    await git([
      "-c",
      "maintenance.autoDetach=false",
      "-c",
      "gc.autoDetach=false",
      "commit-graph",
      "write",
      "--split",
      "--reachable",
      "--no-progress",
    ]),
    "commit-graph",
  );
  return { state: "ready" };
}
