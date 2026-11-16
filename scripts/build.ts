import { flags, run } from "./cli.ts";

const USAGE = `Usage:
  bun run build
  bun run build:check`;

const OUTPUT = "mods/git/main.js";
const HOST_MODULES = ["gpui-kit", "gpui-base", "herdr"];

async function bundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: ["src/main.ts"],
    format: "esm",
    target: "browser",
    external: HOST_MODULES,
  });
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));
  const [output] = result.outputs;
  if (!output) throw new Error("The build produced no output.");
  return output.text();
}

async function write(): Promise<void> {
  await Bun.write(OUTPUT, await bundle());
  console.log(`Built ${OUTPUT}.`);
}

async function check(): Promise<void> {
  const current = await Bun.file(OUTPUT)
    .text()
    .catch(() => "");
  if (current !== (await bundle())) {
    throw new Error(`${OUTPUT} is out of date. Run \`bun run build\` and commit the result.`);
  }
  console.log(`${OUTPUT} is up to date.`);
}

const options = flags(process.argv.slice(2), ["--check"], USAGE);
await run(async () => {
  if (options.has("--check")) await check();
  else await write();
});
