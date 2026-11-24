import { BUNDLE_ASSET, BUNDLE_LIMIT, bundleHeader, VERSION } from "../src/version.ts";
import { flags, run } from "./cli.ts";

const USAGE = `Usage:
  bun run build
  bun run build:check`;

const OUTPUT = `mods/git/${BUNDLE_ASSET}`;
const HOST_MODULES = ["gpui-kit", "gpui-base", "herdr"];

async function bundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: ["src/main.ts"],
    format: "esm",
    target: "browser",
    external: HOST_MODULES,
    banner: bundleHeader(VERSION).trimEnd(),
    plugins: [
      {
        name: "herdr-builtins",
        setup(build) {
          build.onResolve({ filter: /^node:(buffer|crypto|fs\/promises|process)$/ }, ({ path }) => ({
            path: path.slice("node:".length),
            external: true,
          }));
        },
      },
    ],
  });
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));
  const [output] = result.outputs;
  if (!output) throw new Error("The build produced no output.");
  if (output.size > BUNDLE_LIMIT) throw new Error(`${OUTPUT} exceeds Herdr's 1 MiB text read limit.`);
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
