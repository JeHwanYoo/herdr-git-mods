import type { ChangeKind, FileChange } from "../../git/repository.ts";

export interface PathRow {
  depth: number;
  label: string;
  path: string;
  directory: boolean;
  expanded: boolean;
}

interface Node {
  directories: Map<string, Node>;
  files: Map<string, string>;
}

function node(): Node {
  return { directories: new Map(), files: new Map() };
}

function compareNames(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a !== b) return a < b ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export class PathTree {
  private readonly root = node();

  constructor(paths: readonly string[]) {
    for (const path of paths) {
      const parts = path.split("/");
      const name = parts.pop() ?? path;
      let current = this.root;
      for (const part of parts) {
        let child = current.directories.get(part);
        if (!child) {
          child = node();
          current.directories.set(part, child);
        }
        current = child;
      }
      current.files.set(name, path);
    }
  }

  rows(expanded: ReadonlySet<string>): PathRow[] {
    const rows: PathRow[] = [];
    const emit = (current: Node, depth: number, prefix: string) => {
      for (const name of [...current.directories.keys()].sort(compareNames)) {
        const path = `${prefix}${name}`;
        const open = expanded.has(path);
        rows.push({ depth, label: name, path, directory: true, expanded: open });
        const child = current.directories.get(name);
        if (open && child) emit(child, depth + 1, `${path}/`);
      }
      for (const name of [...current.files.keys()].sort(compareNames))
        rows.push({ depth, label: name, path: current.files.get(name) ?? name, directory: false, expanded: false });
    };
    emit(this.root, 0, "");
    return rows;
  }
}

const LETTERS: Record<ChangeKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  type: "T",
  conflict: "U",
  untracked: "?",
};

export function workingStatus(file: FileChange): string {
  if (file.staged === "conflict" || file.unstaged === "conflict") return "U";
  if (file.unstaged === "untracked") return "?";
  if (file.unstaged === "deleted") return "D";
  const kind = file.staged ?? file.unstaged;
  return kind ? LETTERS[kind] : "M";
}

export function pathStatuses(files: readonly FileChange[]): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const file of files) {
    const status = workingStatus(file);
    if (!statuses.has(file.path)) statuses.set(file.path, status);
    for (let end = file.path.indexOf("/"); end >= 0; end = file.path.indexOf("/", end + 1)) {
      const folder = file.path.slice(0, end);
      const existing = statuses.get(folder);
      if (existing === undefined) statuses.set(folder, status);
      else if (existing !== status) statuses.set(folder, "M");
    }
  }
  return statuses;
}
