import type { RunGit } from "./repository.ts";

export interface Remote {
  name: string;
  url: string;
  pushUrl: string;
}

async function must(git: RunGit, args: string[]): Promise<string> {
  const result = await git(args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} exited with ${result.code}`);
  return result.stdout.trim();
}

export async function readRemotes(git: RunGit): Promise<Remote[]> {
  const config = await git(["config", "--null", "--get-regexp", "^remote\\..*\\.url$"]);
  if (config.code !== 0 && config.code !== 1) throw new Error(config.stderr.trim() || "Could not read remotes");
  const names: string[] = [];
  for (const entry of config.stdout.split("\0")) {
    const key = entry.split("\n")[0] ?? "";
    if (!entry.includes("\n") || !key.startsWith("remote.") || !key.endsWith(".url")) continue;
    const name = key.slice("remote.".length, -".url".length);
    if (!names.includes(name)) names.push(name);
  }
  const remotes: Remote[] = [];
  for (const name of names)
    remotes.push({
      name,
      url: await must(git, ["remote", "get-url", "--", name]),
      pushUrl: await must(git, ["remote", "get-url", "--push", "--", name]),
    });
  return remotes;
}
