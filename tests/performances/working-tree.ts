import { appendFile } from "node:fs/promises";
import { join } from "node:path";

export async function addTrackedEdit(repo: string) {
  await appendFile(join(repo, "README"), "\nherdr-performance-fixture\n");
}
