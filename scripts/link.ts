import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { flags, run } from "./cli.ts";

const USAGE = `Usage:
  bun run link
  bun run unlink`;
const home = process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app");
const modDir = join(home, "mods", "git");
const marker = join(modDir, ".herdr-git-link");
const options = flags(process.argv.slice(2), ["--remove"], USAGE);

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
  console.log(`Copied mods/git to ${modDir}. Merge keys.json into your Herdr keys to use Cmd+G.`);
});
