import type { ChangeSection, WorkingChange } from "../../git/comparison.ts";

export type TreeRow =
  | { kind: "directory"; depth: number; label: string; key: string; expanded: boolean; section: ChangeSection | null }
  | { kind: "file"; depth: number; label: string; change: number };

interface PathNode {
  directories: Map<string, PathNode>;
  files: Map<string, number>;
}

const SECTIONS: readonly ChangeSection[] = ["working", "commit", "staged", "unstaged"];

const SECTION_LABELS: Record<ChangeSection, string> = {
  working: "Working changes",
  commit: "Commit changes",
  staged: "Staged",
  unstaged: "Unstaged",
};

function node(): PathNode {
  return { directories: new Map(), files: new Map() };
}

function compareNames(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a !== b) return a < b ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function insert(root: PathNode, path: string, index: number): void {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  let current = root;
  for (const part of parts) {
    let child = current.directories.get(part);
    if (!child) {
      child = node();
      current.directories.set(part, child);
    }
    current = child;
  }
  current.files.set(name, index);
}

function emit(tree: PathNode, depth: number, prefix: string, collapsed: ReadonlySet<string>, rows: TreeRow[]): void {
  for (const name of [...tree.directories.keys()].sort(compareNames)) {
    const key = `${prefix}${name}`;
    const expanded = !collapsed.has(key);
    rows.push({ kind: "directory", depth, label: name, key, expanded, section: null });
    const child = tree.directories.get(name);
    if (expanded && child) emit(child, depth + 1, `${key}/`, collapsed, rows);
  }
  for (const name of [...tree.files.keys()].sort(compareNames))
    rows.push({ kind: "file", depth, label: name, change: tree.files.get(name) ?? 0 });
}

export function treeRows(changes: readonly WorkingChange[], collapsed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const section of SECTIONS) {
    const tree = node();
    let members = 0;
    for (const [index, change] of changes.entries())
      if (change.section === section) {
        insert(tree, change.path, index);
        members++;
      }
    if (members === 0) continue;
    const key = `${section}:`;
    const expanded = !collapsed.has(key);
    rows.push({ kind: "directory", depth: 0, label: SECTION_LABELS[section], key, expanded, section });
    if (expanded) emit(tree, 1, key, collapsed, rows);
  }
  return rows;
}
