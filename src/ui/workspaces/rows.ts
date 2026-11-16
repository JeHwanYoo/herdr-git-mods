import type { BranchStatus, ChangeOverview, ProjectStatus, WorktreeStatus } from "../../git/workspaces.ts";

type RowKind = { type: "current" } | { type: "project"; root: string } | { type: "worktree"; project: string };

export interface RepositoryRow {
  kind: RowKind;
  path: string;
  overview: ChangeOverview | null;
  branch: BranchStatus | null;
  worktrees: number;
  error: string | null;
}

export type ProjectResult = { ok: true; status: ProjectStatus } | { ok: false; error: string };

export function rowKey(row: RepositoryRow): string {
  const owner = row.kind.type === "project" ? row.kind.root : row.kind.type === "worktree" ? row.kind.project : "";
  return `${row.kind.type}\0${owner}\0${row.path}`;
}

export function currentRow(cwd: string | null, status: WorktreeStatus | null): RepositoryRow {
  return status
    ? {
        kind: { type: "current" },
        path: status.path,
        overview: status.overview,
        branch: status.branch,
        worktrees: 0,
        error: null,
      }
    : {
        kind: { type: "current" },
        path: cwd ?? "",
        overview: null,
        branch: null,
        worktrees: 0,
        error: "Not a Git repository",
      };
}

function worktreeRow(project: string, status: WorktreeStatus): RepositoryRow {
  return {
    kind: { type: "worktree", project },
    path: status.path,
    overview: status.overview,
    branch: status.branch,
    worktrees: 0,
    error: null,
  };
}

export function buildRows(
  current: RepositoryRow,
  roots: readonly string[],
  statuses: ReadonlyMap<string, ProjectResult>,
  expanded: (root: string) => boolean,
): RepositoryRow[] {
  const rows = [current];
  for (const root of roots) {
    const result = statuses.get(root);
    if (!result) continue;
    if (!result.ok) {
      rows.push({
        kind: { type: "project", root },
        path: root,
        overview: null,
        branch: null,
        worktrees: 0,
        error: "Unavailable",
      });
      continue;
    }
    const { primary, worktrees } = result.status;
    rows.push({
      kind: { type: "project", root },
      path: primary.path,
      overview: primary.overview,
      branch: primary.branch,
      worktrees: worktrees.length,
      error: null,
    });
    if (expanded(root)) rows.push(...worktrees.map((status) => worktreeRow(root, status)));
  }
  return rows;
}

export function pathLabel(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function worktreeLabel(path: string, project: string): string {
  if (pathLabel(path) !== pathLabel(project)) return pathLabel(path);
  const parent = path.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  return parent ? pathLabel(parent) : pathLabel(path);
}

export function rowHeight(row: RepositoryRow): number {
  return row.branch?.upstream ? 3 : 2;
}
