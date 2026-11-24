import { run } from "./cli.ts";

const FIRST_VERSION = "0.1.0";
const MAIN = "refs/heads/main";
const VERSION_SOURCE = "src/ui/shell.ts";
const BUNDLE = "mods/git/main.js";
const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_LINE = /^export const VERSION = "(\d+\.\d+\.\d+)";$/m;

type Bump = "patch" | "minor" | "major";

function capture(args: string[]) {
  return Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
}

function git(...args: string[]): string {
  const result = capture(["git", ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `git ${args[0]} failed.`);
  return result.stdout.toString().trim();
}

function checked(...args: string[]): void {
  const result = Bun.spawnSync(args, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")} failed.`);
}

function bumpVersion(tag: string, bump: Bump): string {
  const parts = tag.slice(1).split(".").map(BigInt);
  const [major = 0n, minor = 0n, patch = 0n] = parts;
  switch (bump) {
    case "patch":
      return `${major}.${minor}.${patch + 1n}`;
    case "minor":
      return `${major}.${minor + 1n}.0`;
    case "major":
      return `${major + 1n}.0.0`;
  }
}

function published(repo: string, tag: string): boolean {
  const result = capture(["gh", "release", "view", tag, "--repo", repo, "--json", "isDraft,isPrerelease"]);
  if (result.exitCode !== 0) return false;
  const release = JSON.parse(result.stdout.toString()) as { isDraft: boolean; isPrerelease: boolean };
  if (release.isDraft || release.isPrerelease) throw new Error(`${tag} already has a draft or prerelease on GitHub.`);
  return true;
}

function publish(repo: string, tag: string): void {
  checked("gh", "release", "create", tag, "--repo", repo, "--title", tag, "--verify-tag", "--generate-notes");
}

function resumeRelease(repo: string, tag: string, latest: string | undefined, sha: string, main: string): void {
  if (published(repo, tag)) return;
  if (tag !== latest || git("rev-parse", `${tag}^{commit}^`) !== sha) {
    throw new Error(`Cannot resume publication of ${tag} from this run.`);
  }
  git("merge-base", "--is-ancestor", `${tag}^{commit}`, main);
  publish(repo, tag);
}

async function verifyFiles(): Promise<void> {
  for (const path of ["RECIPE.md", "preview.png", "keys.json", BUNDLE, "mods/git/mod.json", "mods/git/git.svg"]) {
    const file = Bun.file(path);
    if (!(await file.exists()) || !file.size) throw new Error(`Missing or empty release file: ${path}`);
  }
  if (Bun.file("RECIPE.md").size > 64 * 1024) throw new Error("RECIPE.md exceeds the gallery's 64 KB limit.");
}

await run(async () => {
  const { GITHUB_REPOSITORY: repo, GITHUB_SHA: sha, GITHUB_RUN_ID: runId, RELEASE_BUMP: bump } = process.env;
  if (!repo || !sha || !runId || !/^\d+$/.test(runId)) throw new Error("Run this script from the Release workflow.");
  if (bump !== "patch" && bump !== "minor" && bump !== "major") throw new Error("Choose patch, minor, or major.");

  git("fetch", "--prune", "origin", `+${MAIN}:refs/remotes/origin/main`, "+refs/tags/*:refs/tags/*");
  const main = git("rev-parse", "refs/remotes/origin/main");
  const marker = `Release run: ${runId}`;
  const tags = git("tag", "--sort=-version:refname")
    .split("\n")
    .filter((tag) => SEMVER_TAG.test(tag));
  const latest = tags[0];
  const retry = tags.find((tag) => git("for-each-ref", "--format=%(contents:subject)", `refs/tags/${tag}`) === marker);
  if (retry) {
    resumeRelease(repo, retry, latest, sha, main);
    return;
  }

  if (main !== sha || git("rev-parse", "HEAD") !== sha) {
    throw new Error("main changed after dispatch. Start a new Release run from main.");
  }
  if (git("status", "--porcelain")) throw new Error("The release checkout must be clean.");
  if (latest) {
    git("merge-base", "--is-ancestor", `${latest}^{commit}`, main);
    if (!published(repo, latest))
      throw new Error(`${latest} has no published release. Re-run its original Release job.`);
  }

  const source = await Bun.file(VERSION_SOURCE).text();
  const current = latest?.slice(1) ?? FIRST_VERSION;
  if (source.match(VERSION_LINE)?.[1] !== current) throw new Error(`The source version must match v${current}.`);
  const version = latest ? bumpVersion(latest, bump) : FIRST_VERSION;
  const tag = `v${version}`;
  if (version !== current) {
    await Bun.write(VERSION_SOURCE, source.replace(VERSION_LINE, `export const VERSION = "${version}";`));
    checked("bun", "run", "build");
  }
  await verifyFiles();
  checked("bun", "run", "ci");

  git("add", VERSION_SOURCE, BUNDLE);
  git(
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit",
    "--allow-empty",
    "-m",
    `chore(release): ${tag}`,
  );
  git(
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "tag",
    "-a",
    tag,
    "-m",
    marker,
  );
  git("push", "--atomic", `--force-with-lease=${MAIN}:${sha}`, "origin", `HEAD:${MAIN}`, `refs/tags/${tag}`);
  publish(repo, tag);
});
