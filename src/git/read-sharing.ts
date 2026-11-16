import type { GitResult, RunGit } from "./repository.ts";

export function shareSummaryReads(git: RunGit): RunGit {
  const pending = new Map<string, Promise<GitResult>>();
  return (args) => {
    if (!args.includes("diff") || !args.includes("--numstat")) return git(args);
    const key = JSON.stringify(args);
    const existing = pending.get(key);
    if (existing) return existing;
    const result = git(args);
    pending.set(key, result);
    void result.then(
      () => pending.delete(key),
      () => pending.delete(key),
    );
    return result;
  };
}
