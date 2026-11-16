import { afterEach, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cloneFixture, prepareFixtureCache } from "../scripts/performance-cache.ts";

const directories: string[] = [];
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "herdr-cache-test-")));
  directories.push(root);
  const upstream = join(root, "upstream");
  await mkdir(upstream);
  await git(upstream, "init", "-b", "main");
  await writeFile(join(upstream, "README"), "pinned version\n");
  await git(upstream, "add", "README");
  await git(upstream, "commit", "-m", "initial");
  await git(upstream, "tag", "v6.12");
  const revision = await git(upstream, "rev-parse", "HEAD");
  return {
    root,
    upstream,
    directory: join(root, "cache"),
    source: { url: pathToFileURL(upstream).href, tag: "v6.12", revision },
  };
}

test("cache hit fetches new upstream commits but isolated benchmarks keep the pinned revision", async () => {
  const { root, upstream, directory, source } = await fixture();
  const cache = await prepareFixtureCache(directory, source);
  const first = join(root, "first");
  await cloneFixture(cache, first, source);
  await writeFile(join(first, "README"), "benchmark mutation\n");
  await git(first, "add", "README");
  await git(first, "commit", "-m", "benchmark only");
  await writeFile(join(upstream, "README"), "latest upstream\n");
  await git(upstream, "add", "README");
  await git(upstream, "commit", "-m", "upstream update");
  const latest = await git(upstream, "rev-parse", "HEAD");
  expect(await prepareFixtureCache(directory, source)).toBe(cache);
  expect(await git(cache, "rev-parse", "refs/heads/upstream")).toBe(latest);
  expect(await git(cache, "rev-parse", "refs/tags/v6.12")).toBe(source.revision);
  const second = join(root, "second");
  await cloneFixture(cache, second, source);
  expect(await git(second, "rev-parse", "HEAD")).toBe(source.revision);
  expect(await git(second, "rev-list", "--count", "--all")).toBe("1");
  expect(await git(second, "rev-parse", "--is-shallow-repository")).toBe("true");
  expect(await readFile(join(second, "README"), "utf8")).toBe("pinned version\n");
  await rm(cache, { recursive: true });
  expect(await git(second, "show", "HEAD:README")).toBe("pinned version");
  expect(await git(first, "show", "HEAD:README")).toBe("benchmark mutation");
});

test("failed cache creation never publishes an invalid repository", async () => {
  const { directory, source } = await fixture();
  await expect(prepareFixtureCache(directory, { ...source, revision: "0".repeat(40) })).rejects.toThrow();
  await expect(access(join(directory, "linux-v6.12.git"))).rejects.toMatchObject({ code: "ENOENT" });
  const cache = await prepareFixtureCache(directory, source);
  expect(await git(cache, "rev-parse", "refs/tags/v6.12")).toBe(source.revision);
});

test("an upstream fetch failure fails instead of silently using stale cache", async () => {
  const { upstream, directory, source } = await fixture();
  const cache = await prepareFixtureCache(directory, source);
  await rename(upstream, `${upstream}-offline`);
  await expect(prepareFixtureCache(directory, source)).rejects.toThrow();
  expect(await git(cache, "rev-parse", "refs/tags/v6.12")).toBe(source.revision);
});
