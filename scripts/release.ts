import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_ASSET, BUNDLE_LIMIT, bundleHeader } from "../src/version.ts";
import { run } from "./cli.ts";

const FIRST_VERSION = "0.1.0";
const MAIN = "refs/heads/main";
const VERSION_SOURCE = "src/version.ts";
const BUNDLE = `mods/git/${BUNDLE_ASSET}`;
const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_LINE = /^export const VERSION = "(\d+\.\d+\.\d+)";$/m;

type Bump = "patch" | "minor" | "major";

interface ReleaseInfo {
  body: string;
  isDraft: boolean;
  isPrerelease: boolean;
}

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

function releaseInfo(repo: string, tag: string): ReleaseInfo | null {
  const result = capture(["gh", "release", "view", tag, "--repo", repo, "--json", "body,isDraft,isPrerelease"]);
  if (result.exitCode !== 0) return null;
  return JSON.parse(result.stdout.toString()) as ReleaseInfo;
}

async function publish(repo: string, tag: string, marker: string, draft?: ReleaseInfo): Promise<void> {
  const note = `<!-- ${marker} -->`;
  if (draft && !draft.body.includes(note)) {
    throw new Error(`Cannot resume a release draft for ${tag} created outside this run.`);
  }
  const bundle = capture(["git", "show", `${tag}:${BUNDLE}`]);
  if (bundle.exitCode !== 0) throw new Error(bundle.stderr.toString().trim());
  const directory = await mkdtemp(join(tmpdir(), "herdr-git-release-"));
  try {
    const asset = join(directory, BUNDLE_ASSET);
    await Bun.write(asset, bundle.stdout);
    if (draft) {
      checked("gh", "release", "upload", tag, "--repo", repo, "--clobber", asset);
      checked("gh", "release", "edit", tag, "--repo", repo, "--draft=false", "--latest");
    } else {
      checked(
        "gh",
        "release",
        "create",
        tag,
        "--repo",
        repo,
        "--title",
        tag,
        "--verify-tag",
        "--generate-notes",
        "--notes",
        note,
        "--latest",
        asset,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function resumeRelease(
  repo: string,
  tag: string,
  latest: string | undefined,
  sha: string,
  main: string,
  marker: string,
): Promise<void> {
  const release = releaseInfo(repo, tag);
  if (release && !release.isDraft && !release.isPrerelease) return;
  if (release?.isPrerelease) throw new Error(`${tag} is already published as a prerelease.`);
  if (tag !== latest || git("rev-parse", `${tag}^{commit}^`) !== sha) {
    throw new Error(`Cannot resume publication of ${tag} from this run.`);
  }
  git("merge-base", "--is-ancestor", `${tag}^{commit}`, main);
  await publish(repo, tag, marker, release ?? undefined);
}

async function verifyFiles(version: string): Promise<void> {
  for (const path of ["RECIPE.md", "preview.png", "keys.json", BUNDLE, "mods/git/mod.json", "mods/git/git.svg"]) {
    const file = Bun.file(path);
    if (!(await file.exists()) || !file.size) throw new Error(`Missing or empty release file: ${path}`);
  }
  if (Bun.file("RECIPE.md").size > 64 * 1024) throw new Error("RECIPE.md exceeds the gallery's 64 KB limit.");
  const bundle = Bun.file(BUNDLE);
  if (bundle.size > BUNDLE_LIMIT || !(await bundle.text()).startsWith(bundleHeader(version))) {
    throw new Error(`${BUNDLE} must fit Herdr's file read limit and identify version v${version}.`);
  }
}

function verifyPreviousRelease(repo: string, tag: string, main: string): void {
  git("merge-base", "--is-ancestor", `${tag}^{commit}`, main);
  const release = releaseInfo(repo, tag);
  if (!release || release.isDraft || release.isPrerelease) {
    throw new Error(`${tag} has no published stable release. Re-run its original Release job.`);
  }
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
    await resumeRelease(repo, retry, latest, sha, main, marker);
    return;
  }

  if (main !== sha || git("rev-parse", "HEAD") !== sha) {
    throw new Error("main changed after dispatch. Start a new Release run from main.");
  }
  if (git("status", "--porcelain")) throw new Error("The release checkout must be clean.");
  if (latest) verifyPreviousRelease(repo, latest, main);

  const source = await Bun.file(VERSION_SOURCE).text();
  const current = latest?.slice(1) ?? FIRST_VERSION;
  if (source.match(VERSION_LINE)?.[1] !== current) throw new Error(`The source version must match v${current}.`);
  const version = latest ? bumpVersion(latest, bump) : FIRST_VERSION;
  const tag = `v${version}`;
  if (version !== current) {
    await Bun.write(VERSION_SOURCE, source.replace(VERSION_LINE, `export const VERSION = "${version}";`));
    checked("bun", "run", "build");
  }
  await verifyFiles(version);
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
  await publish(repo, tag, marker);
});
