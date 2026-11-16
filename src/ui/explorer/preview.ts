import { exec, readTextFile } from "herdr";
import { type LineChange, readLineChanges } from "../../git/files.ts";
import type { RunGit } from "../../git/repository.ts";
import { type CodeLine, highlight, sourceLines } from "../code-view.ts";

const BYTE_LIMIT = 1024 * 1024;

export interface FilePreview {
  lines: CodeLine[];
  before: (number | null)[];
  notice: string | null;
}

export function previewNotice(notice: string): FilePreview {
  return { lines: [], before: [], notice };
}

function mergeChanges(source: CodeLine[], changes: readonly LineChange[], path: string): FilePreview {
  const lines: CodeLine[] = [];
  const before: (number | null)[] = [];
  const pushRemoved = (change: LineChange) =>
    change.removed.forEach((text, offset) => {
      lines.push({ number: null, text, tokens: highlight(text, path), tone: "removed" });
      before.push(change.oldStart + offset);
    });
  let pending = 0;
  let oldLine = 1;
  let addedUntil = 0;
  source.forEach((line, index) => {
    const number = index + 1;
    for (let change = changes[pending]; change && change.newStart <= number; change = changes[++pending]) {
      pushRemoved(change);
      oldLine = change.oldStart + change.removed.length;
      addedUntil = change.newStart + change.added;
    }
    if (number < addedUntil) {
      lines.push({ ...line, tone: "added" });
      before.push(null);
    } else {
      lines.push(line);
      before.push(oldLine++);
    }
  });
  for (const change of changes.slice(pending)) pushRemoved(change);
  return { lines, before, notice: null };
}

export async function readPreview(
  git: RunGit,
  root: string,
  on: string | null,
  file: string,
  newFile: boolean,
): Promise<FilePreview> {
  const absolute = `${root}/${file}`;
  try {
    const link = await exec("readlink", [absolute], { on });
    if (link.code === 0 && link.stdout.trim()) return previewNotice(`Symbolic link to ${link.stdout.trim()}`);
    const text = await readTextFile(absolute, { on });
    if (text === null) return previewNotice("Deleted in the working tree");
    if (text.length > BYTE_LIMIT) return previewNotice("File is larger than 1 MiB and is not previewed");
    if (text.includes("\0")) return previewNotice("Binary file");
    const source = sourceLines(text, file);
    const changes: LineChange[] = newFile
      ? [{ oldStart: 1, removed: [], newStart: 1, added: source.length }]
      : await readLineChanges(git, file);
    return mergeChanges(source, changes, file);
  } catch (error) {
    return previewNotice(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
