import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type BundleFile, installRelease, latestRelease, type ModRelease } from "../../src/runtime/mod-release.ts";
import { bundleHeader } from "../../src/version.ts";

const installed = `${bundleHeader("0.1.9")}export default "old";\n`;
const replacement = `${bundleHeader("0.1.10")}export default "새 버전";\n`;
const checksum = createHash("sha256").update(replacement).digest("hex");
const release: ModRelease = { tag: "v0.1.10", sha256: checksum };
const asset = {
  name: "main.js",
  state: "uploaded",
  size: Buffer.byteLength(replacement),
  digest: `sha256:${checksum}`,
};

async function check(tag: string, assets: unknown[], prerelease = false) {
  return latestRelease("0.1.9", async () => JSON.stringify({ tag_name: tag, draft: false, prerelease, assets }));
}

test("offers a newer stable bundle and ignores older or equal release tags", async () => {
  expect(await check("v0.1.10", [asset])).toEqual(release);
  expect(await check("v0.1.9", [])).toBeNull();
  expect(await check("v0.1.8", [])).toBeNull();
  await expect(check("v0.1.11", [asset], true)).rejects.toThrow("stable release");
  await expect(check("v0.1.11", [])).rejects.toThrow("no verifiable main.js");
});

function installation() {
  let contents = installed;
  const file: BundleFile = {
    read: async () => contents,
    replace: async (text, expected) => {
      if (contents !== expected) throw new Error("Stale bundle");
      contents = text;
      return null;
    },
  };
  return file;
}

test("installs the verified bundle and preserves the existing bytes on a bad download", async () => {
  const file = installation();
  await expect(installRelease("0.1.9", release, file, async () => replacement.replace("새", "다음"))).rejects.toThrow(
    "failed verification",
  );
  expect(await file.read()).toBe(installed);
  await installRelease("0.1.9", release, file, async () => replacement);
  expect(await file.read()).toBe(replacement);
});

test("rejects a stale updater after another pane has replaced the bundle", async () => {
  const file = installation();
  await expect(
    installRelease("0.1.9", release, file, async () => {
      await installRelease("0.1.9", release, file, async () => replacement);
      return replacement;
    }),
  ).rejects.toThrow("Stale bundle");
  await expect(installRelease("0.1.9", release, file, async () => replacement)).rejects.toThrow(
    "installed bundle changed",
  );
  expect(await file.read()).toBe(replacement);
});
