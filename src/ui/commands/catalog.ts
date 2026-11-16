export type CommandId =
  | "refresh"
  | "update"
  | "switch-repository"
  | "reset"
  | "discard-all"
  | "fetch"
  | "pull"
  | "commit"
  | "push"
  | "add-remote"
  | "show-remotes"
  | "remove-remote"
  | "stash"
  | "stash-changes"
  | "stash-pop"
  | "branches"
  | "branch-at-head"
  | "branch-at-commit"
  | "tag"
  | "checkout"
  | "rebase"
  | "interactive-rebase"
  | "cherry-pick"
  | "revert"
  | "copy-sha";

export const COMMANDS: readonly CommandId[] = [
  "refresh",
  "switch-repository",
  "add-remote",
  "show-remotes",
  "fetch",
  "pull",
  "commit",
  "push",
  "branches",
  "branch-at-head",
  "checkout",
  "rebase",
  "interactive-rebase",
  "cherry-pick",
  "revert",
  "reset",
  "discard-all",
  "copy-sha",
  "stash",
  "update",
];

export interface CommandContext {
  repository: boolean;
  remotes: string[];
  branch: string | null;
  upstream: string | null;
  changes: boolean;
  staged: boolean;
  stash: boolean;
  head: string | null;
  selected: string | null;
}

export const TITLES: Record<CommandId, string> = {
  refresh: "Refresh",
  update: "Update Herdr Git Mods…",
  "switch-repository": "Switch workspace",
  reset: "Reset…",
  "discard-all": "Discard all tracked changes…",
  fetch: "Fetch",
  pull: "Pull",
  commit: "Commit…",
  push: "Push",
  "add-remote": "Add Remotes…",
  "show-remotes": "Show Remotes…",
  "remove-remote": "Remove Remote",
  stash: "Stash…",
  "stash-changes": "Stash changes",
  "stash-pop": "Pop stash",
  branches: "Branches…",
  "branch-at-head": "Branch at HEAD…",
  "branch-at-commit": "Branch at commit…",
  tag: "Tag…",
  checkout: "Checkout…",
  rebase: "Rebase…",
  "interactive-rebase": "Interactive rebase…",
  "cherry-pick": "Cherry-pick…",
  revert: "Revert…",
  "copy-sha": "Copy SHA…",
};

export const RESULT_NAMES: Record<CommandId, string> = {
  update: "Update Herdr Git Mods",
  "add-remote": "Add Remote",
  "show-remotes": "Remotes",
  "remove-remote": "Remove Remote",
  fetch: "Fetch",
  push: "Push",
  stash: "Stash",
  "stash-changes": "Stash",
  "stash-pop": "Stash pop",
  branches: "Branches",
  "branch-at-commit": "Branch",
  "branch-at-head": "Branch",
  tag: "Tag",
  checkout: "Checkout",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
  "copy-sha": "Copy SHA",
  reset: "Reset",
  "discard-all": "Discard changes",
  pull: "Pull",
  commit: "Commit",
  "interactive-rebase": "Interactive rebase",
  refresh: "Git operation",
  "switch-repository": "Git operation",
};

const PROGRESS: Partial<Record<CommandId, string>> = {
  fetch: "Fetching",
  pull: "Pulling",
  commit: "Committing",
  push: "Pushing",
  "stash-changes": "Stashing",
  branches: "Managing branches",
  "branch-at-head": "Creating",
  reset: "Resetting",
};

export function progressLabel(id: CommandId): string {
  return PROGRESS[id] ?? "Running";
}

const STATUS: Record<string, string> = {
  "no remotes configured": "No remote",
  "detached HEAD": "Detached HEAD",
  "no upstream configured": "No upstream",
  "working tree is clean": "Clean",
  "stash is empty": "No stash",
  "no commit selected": "No commit",
  "working tree has changes; stash or commit first": "Changes present",
};

export function statusLabel(reason: string | null): string {
  if (reason === null) return "";
  return STATUS[reason] ?? "Unavailable";
}

const ALWAYS: readonly CommandId[] = ["refresh", "update", "switch-repository"];
const OPEN: readonly CommandId[] = [
  "branches",
  "add-remote",
  "show-remotes",
  "remove-remote",
  "commit",
  "interactive-rebase",
  "stash",
];
const CLEAN: readonly CommandId[] = ["checkout", "rebase", "cherry-pick", "revert"];

const REASONS: Partial<Record<CommandId, (context: CommandContext) => string | null>> = {
  "discard-all": (context) => {
    if (!context.head) return "no HEAD commit to restore";
    return context.changes ? null : "working tree is clean";
  },
  reset: (context) => {
    if (!context.branch) return "checkout a branch before resetting";
    return context.head ? null : "no commits to reset";
  },
  "branch-at-head": (context) => (context.head ? null : "no commits available"),
  fetch: (context) => (context.remotes.length ? null : "no remotes configured"),
  pull: (context) => {
    if (!context.branch) return "detached HEAD";
    return context.upstream ? null : "no upstream configured";
  },
  push: (context) => {
    if (!context.branch) return "detached HEAD";
    return context.remotes.length ? null : "no remotes configured";
  },
  "stash-changes": (context) => (context.changes ? null : "working tree is clean"),
  "stash-pop": (context) => (context.stash ? null : "stash is empty"),
};

export function unavailable(id: CommandId, context: CommandContext): string | null {
  if (ALWAYS.includes(id)) return null;
  if (!context.repository) return "not a Git repository";
  const reason = REASONS[id];
  if (reason) return reason(context);
  if (OPEN.includes(id)) return null;
  if (!context.selected) return "no commit selected";
  return CLEAN.includes(id) && context.changes ? "working tree has changes; stash or commit first" : null;
}

export const RESET_MODES = [
  { mode: "soft", label: "Soft", summary: "Keep index and working tree" },
  { mode: "mixed", label: "Mixed", summary: "Reset index; keep working tree" },
  { mode: "hard", label: "Hard", summary: "Reset index and tracked working tree" },
] as const;
