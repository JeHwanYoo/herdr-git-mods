import { scenarios } from "./scenarios/index.ts";

const names = Object.keys(scenarios);

export const usage = [
  "bun run performance [scenario]",
  "bun run performance full-history /path/to/full/linux",
  `Component scenarios: ${names.join(", ")}`,
].join("\n");

export function parseSelection(args: string[]) {
  const [scenario, source] = args;
  if (scenario === "full-history" && source && args.length === 2) return { scenario, source };
  if (!scenario || (args.length === 1 && names.includes(scenario))) return { scenario, source: undefined };
  throw new Error(usage);
}
