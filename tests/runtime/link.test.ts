import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];

async function herdrHome() {
  const home = await mkdtemp(join(tmpdir(), "herdr-link-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function link(home: string) {
  return Bun.spawnSync([process.execPath, "scripts/link.ts"], {
    env: { ...process.env, HERDR_APP_HOME: home },
    stdin: "ignore",
  });
}

test("link adds the Git shortcut alongside existing shortcuts and preserves an already configured file", async () => {
  const home = await herdrHome();
  const path = join(home, "keys.json");
  const keys = { global: { "cmd-p": "app.palette" }, terminal: { "cmd-c": "terminal.copy" } };
  await writeFile(path, JSON.stringify(keys));
  expect(link(home).exitCode).toBe(0);
  const installed = JSON.parse(await readFile(path, "utf8"));
  expect(installed).toEqual({ ...keys, global: { ...keys.global, "cmd-g": "mod.open:git" } });
  const customFormat = JSON.stringify(installed);
  await writeFile(path, customFormat);
  expect(link(home).exitCode).toBe(0);
  expect(await readFile(path, "utf8")).toBe(customFormat);
});

test("unattended link keeps an existing Cmd+G action", async () => {
  const home = await herdrHome();
  const path = join(home, "keys.json");
  const keys = JSON.stringify({ global: { "cmd-g": { command: "layout.toggle", args: { id: "sidebar" } } } });
  await writeFile(path, keys);
  expect(link(home).exitCode).toBe(0);
  expect(await readFile(path, "utf8")).toBe(keys);
  expect(await Bun.file(join(home, "mods/git/main.js")).exists()).toBe(true);
});
