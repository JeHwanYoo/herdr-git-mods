import { cp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import shortcuts from "../keys.json" with { type: "json" };
import { flags, run } from "./cli.ts";

const USAGE = `Usage:
  bun run link
  bun run unlink`;
const home = process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app");
const modDir = join(home, "mods", "git");
const marker = join(modDir, ".herdr-git-link");
const options = flags(process.argv.slice(2), ["--remove"], USAGE);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function installShortcut(): Promise<void> {
  const path = join(home, "keys.json");
  const action = shortcuts.global["cmd-g"];
  if (!(await Bun.file(path).exists())) {
    await writeFile(path, `${JSON.stringify(shortcuts, null, 2)}\n`, { flag: "wx" });
    console.log("Registered Cmd+G for Git.");
    return;
  }
  const target = await realpath(path);
  const original = await readFile(target, "utf8");
  const keys: unknown = JSON.parse(original);
  if (!isObject(keys)) throw new Error(`Expected an object in ${path}`);
  const global = keys.global === undefined ? {} : keys.global;
  if (!isObject(global)) throw new Error(`Expected an object for global bindings in ${path}`);
  const current = global["cmd-g"];
  if (current === action) return;
  if (current !== undefined) {
    const question = `Cmd+G is bound to ${JSON.stringify(current)}. Replace it with ${action}? [y/N]`;
    const answer = process.stdin.isTTY ? prompt(question) : null;
    if (!/^y(es)?$/i.test(answer?.trim() ?? "")) {
      console.log("Kept the existing Cmd+G binding. Run bun run link in a terminal to replace it.");
      return;
    }
  }
  global["cmd-g"] = action;
  keys.global = global;
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(keys, null, 2)}\n`, { flag: "wx", mode: (await stat(target)).mode });
    if ((await readFile(target, "utf8")) !== original) throw new Error(`${path} changed. Run bun run link again.`);
    await rename(temporary, target);
    console.log("Registered Cmd+G for Git.");
  } finally {
    await rm(temporary, { force: true });
  }
}

await run(async () => {
  const owned = await Bun.file(marker).exists();
  if (options.has("--remove")) {
    if (owned) await rm(modDir, { recursive: true, force: true });
    else console.log(`Left ${modDir} alone: this script did not create it.`);
    return;
  }
  if ((await Bun.file(join(modDir, "main.js")).exists()) && !owned) {
    throw new Error(`Not created by this script, so left alone: ${modDir}`);
  }
  await mkdir(join(home, "mods"), { recursive: true });
  await cp(resolve("mods", "git"), modDir, {
    recursive: true,
    filter: (path) => !path.endsWith(".d.ts") && !path.endsWith("jsconfig.json"),
  });
  await writeFile(marker, "");
  console.log(`Copied mods/git to ${modDir}.`);
  await installShortcut();
});
