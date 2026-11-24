import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { phase } from "./progress.ts";

export const LINUX_FIXTURE = {
  url: "https://github.com/torvalds/linux.git",
  tag: "v6.12",
  revision: "adc218676eef25575469234709c2d87185ca223a",
};

export function performanceCacheDirectory(): string {
  return resolve(
    process.env.PERF_CACHE_DIR ??
      join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "herdr-git-mods", "performance"),
  );
}

async function git(args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 600_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, stderr);
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function validate(cache: string, fixture: typeof LINUX_FIXTURE): Promise<void> {
  assert.equal(await git(["-C", cache, "rev-parse", "--is-bare-repository"]), "true", `Not a bare cache: ${cache}`);
  assert.equal(await git(["-C", cache, "remote", "get-url", "origin"]), fixture.url, `Wrong cache upstream: ${cache}`);
  assert.equal(
    await git(["-C", cache, "rev-parse", `refs/tags/${fixture.tag}^{commit}`]),
    fixture.revision,
    `Cached ${fixture.tag} does not match the pinned benchmark revision: ${cache}`,
  );
}

async function update(cache: string, fixture: typeof LINUX_FIXTURE): Promise<void> {
  await phase("Fetch upstream HEAD and refresh pinned fixture tag", () =>
    git([
      "-C",
      cache,
      "fetch",
      "--depth=1",
      "--no-tags",
      "origin",
      "+HEAD:refs/heads/upstream",
      `+refs/tags/${fixture.tag}:refs/tags/${fixture.tag}`,
    ]),
  );
  await validate(cache, fixture);
}

export async function prepareFixtureCache(
  directory = performanceCacheDirectory(),
  fixture = LINUX_FIXTURE,
): Promise<string> {
  const cache = join(directory, `linux-${fixture.tag}.git`);
  let exists = true;
  try {
    await access(cache);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  if (exists) {
    console.log(`[CACHE HIT] ${cache}`);
    await validate(cache, fixture);
    await update(cache, fixture);
    return cache;
  }
  console.log(`[CACHE MISS] ${cache}`);
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(directory, ".linux-download-"));
  const incoming = join(temporary, "repository.git");
  try {
    await phase(`Clone ${fixture.tag} into persistent cache (first download)`, () =>
      git(["clone", "--bare", "--depth=1", "--single-branch", "--branch", fixture.tag, fixture.url, incoming]),
    );
    await update(incoming, fixture);
    await rename(incoming, cache);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return cache;
}

export async function cloneFixture(cache: string, destination: string, fixture = LINUX_FIXTURE): Promise<void> {
  await phase(`Create isolated ${fixture.tag} checkout from cache (no network)`, () =>
    git([
      "clone",
      "--no-local",
      "--depth=1",
      "--single-branch",
      "--no-tags",
      "--branch",
      fixture.tag,
      pathToFileURL(resolve(cache)).href,
      destination,
    ]),
  );
}
