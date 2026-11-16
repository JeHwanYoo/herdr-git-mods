import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.ts";

const FILES = ["herdr.d.ts", "gpui-kit.d.ts"];
const TARGET = ".herdr-types";

const home = process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app");

async function copy(name: string): Promise<void> {
  const source = Bun.file(join(home, name));
  if (!(await source.exists())) {
    throw new Error(`${join(home, name)} is missing. Start the Herdr app once, or set HERDR_APP_HOME.`);
  }
  await Bun.write(join(TARGET, name), source);
}

async function sync(): Promise<void> {
  await mkdir(TARGET, { recursive: true });
  for (const name of FILES) await copy(name);
  console.log(`Copied ${FILES.join(", ")} from ${home} to ${TARGET}/.`);
}

await run(sync);
