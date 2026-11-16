export function flags(args: string[], allowed: string[], usage: string): Set<string> {
  if (args.some((arg) => !allowed.includes(arg))) fail(usage);
  return new Set(args);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export async function run(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
