import manifest from "../package.json" with { type: "json" };
import { run } from "./cli.ts";

const REQUIRED = manifest.engines.bun;

async function check(): Promise<void> {
  if (!Bun.semver.satisfies(Bun.version, REQUIRED)) {
    throw new Error(`Bun ${Bun.version} is not supported. This project requires Bun ${REQUIRED}. Run \`bun upgrade\`.`);
  }
}

await run(check);
