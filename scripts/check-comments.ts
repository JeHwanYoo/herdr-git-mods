import { parseSync } from "oxc-parser";
import { run } from "./cli.ts";

const ROOTS = ["src", "tests", "scripts"];

function lineAndColumn(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return `${line}:${column}`;
}

async function sourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of ROOTS) {
    for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: root })) files.push(`${root}/${path}`);
  }
  return files.sort();
}

async function violations(file: string): Promise<string[]> {
  const source = await Bun.file(file).text();
  const result = parseSync(file, source);
  return [
    ...result.errors.map((error) => `${file}: cannot parse (${error.message})`),
    ...result.comments.map((comment) => `${file}:${lineAndColumn(source, comment.start)}`),
  ];
}

async function check(): Promise<void> {
  const files = await sourceFiles();
  const found = (await Promise.all(files.map(violations))).flat();
  if (found.length) throw new Error(`Comments are not allowed:\n${found.join("\n")}`);
  console.log(`No comments in ${files.length} files.`);
}

await run(check);
