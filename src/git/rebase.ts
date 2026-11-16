import type { RunGit } from "./repository.ts";

export const REBASE_ACTIONS = ["pick", "edit", "reword", "squash", "fixup", "drop"] as const;
export type RebaseAction = (typeof REBASE_ACTIONS)[number];

export const REBASE_LABELS: Record<RebaseAction, string> = {
  pick: "Pick",
  edit: "Edit",
  reword: "Reword",
  squash: "Squash",
  fixup: "Fixup",
  drop: "Drop",
};

export const REBASE_DESCRIPTIONS: Record<RebaseAction, string> = {
  pick: "Use commit",
  edit: "Stop for amending",
  reword: "Edit commit message",
  squash: "Combine into the commit below; keep both messages",
  fixup: "Combine into the commit below; drop this message",
  drop: "Remove commit",
};

interface RebaseEntry {
  sha: string;
  author: string;
  date: string;
  message: string;
  action: RebaseAction;
}

export interface RebasePlan {
  branch: string;
  head: string;
  upstream: string | null;
  target: string;
  entries: RebaseEntry[];
  updateRefs: boolean;
  active: boolean;
}

export type RebaseTarget = { kind: "inclusive"; target: string } | { kind: "onto"; target: string };

export type RebaseTask =
  | { kind: "start"; plan: RebasePlan }
  | { kind: "continue" }
  | { kind: "skip" }
  | { kind: "abort" }
  | { kind: "amend"; message: string };

export interface RebaseResult {
  active: boolean;
  success: boolean;
  output: string;
  message: string;
}

async function must(git: RunGit, args: string[]): Promise<string> {
  const result = await git(args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Rebase failed");
  return result.stdout;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function shell(git: RunGit, body: string): Promise<{ code: number; stdout: string }> {
  return git(["-c", `alias.herdr-rebase-state=!f() { ${body}; }; f`, "herdr-rebase-state"]);
}

async function rebaseActive(git: RunGit): Promise<boolean> {
  const result = await shell(
    git,
    'test -d "$(git rev-parse --git-path rebase-merge)" || test -d "$(git rev-parse --git-path rebase-apply)"',
  );
  return result.code === 0;
}

export function validatePlan(plan: RebasePlan): string | null {
  if (!plan.entries.length) return "No commits to rebase.";
  let previous = false;
  const seen = new Set<string>();
  for (const entry of [...plan.entries].reverse()) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(entry.sha) || seen.has(entry.sha))
      return "Invalid or duplicate commit in rebase plan.";
    seen.add(entry.sha);
    if ((entry.action === "squash" || entry.action === "fixup") && !previous)
      return "Squash and Fixup need a retained commit below them.";
    if (entry.action === "reword" && !entry.message.trim()) return "Reword needs a non-empty message.";
    previous ||= entry.action !== "drop";
  }
  return null;
}

function todo(plan: RebasePlan): string {
  const lines: string[] = [];
  let markers: string[] = [];
  for (const entry of [...plan.entries].reverse()) {
    if (entry.action !== "squash" && entry.action !== "fixup" && entry.action !== "drop") {
      lines.push(...markers);
      markers = [];
    }
    lines.push(`${entry.action === "reword" ? "pick" : entry.action} ${entry.sha}`);
    if (entry.action === "reword")
      lines.push(
        `exec printf '%s\\n' ${entry.message.split("\n").map(quote).join(" ")} | git -c core.editor=true commit --amend --allow-empty -F -`,
      );
    markers.push(`# herdr-end ${entry.sha}`);
  }
  lines.push(...markers);
  return `${lines.join("\n")}\n`;
}

async function activePlan(git: RunGit, head: string): Promise<RebasePlan> {
  const name = await shell(git, 'cat "$(git rev-parse --git-path rebase-merge/head-name)"');
  const branch = name.code === 0 ? name.stdout.trim().replace(/^refs\/heads\//, "") : "Rebase in progress";
  return {
    branch,
    head,
    upstream: null,
    target: "Rebase in progress",
    entries: [
      {
        sha: head,
        author: "",
        date: "",
        message: (await must(git, ["log", "-1", "--format=%B"])).trimEnd(),
        action: "edit",
      },
    ],
    updateRefs: false,
    active: true,
  };
}

export async function readRebasePlan(git: RunGit, target: RebaseTarget): Promise<RebasePlan> {
  const head = (await must(git, ["rev-parse", "HEAD"])).trim();
  if (await rebaseActive(git)) return activePlan(git, head);
  const branchResult = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branchResult.code !== 0) throw new Error("Checkout a branch before rebasing.");
  const sha = (await must(git, ["rev-parse", "--verify", "--end-of-options", `${target.target}^{commit}`])).trim();
  let upstream: string | null = sha;
  if (target.kind === "inclusive") {
    const parent = await git(["rev-parse", "--verify", "--end-of-options", `${sha}^`]);
    upstream = parent.code === 0 ? parent.stdout.trim() : null;
  }
  const output = await must(git, [
    "log",
    "--topo-order",
    "--date-order",
    "--no-merges",
    "--format=%H%x00%an%x00%aI%x00%B%x00",
    upstream ? `${upstream}..${head}` : head,
  ]);
  const fields = output.split("\0");
  const entries: RebaseEntry[] = [];
  for (let index = 0; index + 3 < fields.length; index += 4)
    entries.push({
      sha: (fields[index] ?? "").trim(),
      author: fields[index + 1] ?? "",
      date: (fields[index + 2] ?? "").slice(0, 10),
      message: (fields[index + 3] ?? "").trimEnd(),
      action: "pick",
    });
  return {
    branch: branchResult.stdout.trim(),
    head,
    upstream,
    target: target.target,
    entries,
    updateRefs: false,
    active: false,
  };
}

async function startArgs(git: RunGit, plan: RebasePlan): Promise<string[]> {
  const invalid = validatePlan(plan);
  if (invalid) throw new Error(invalid);
  if (await rebaseActive(git)) throw new Error("A rebase is already in progress. Reopen Interactive rebase.");
  const head = (await must(git, ["rev-parse", "HEAD"])).trim();
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head !== plan.head || branch.stdout.trim() !== plan.branch)
    throw new Error("Branch or HEAD changed. Close and reopen Interactive rebase.");
  if ((await must(git, ["status", "--porcelain"])).trim())
    throw new Error("Commit or stash working changes before rebasing.");
  const merge =
    'NR == FNR { if ($1 == "pick") key=$2; if ($1 == "update-ref") refs[key]=refs[key] $0 "\\n"; next } { print } $1 == "#" && $2 == "herdr-end" { printf "%s", refs[$3] }';
  const script = plan.updateRefs
    ? `temporary=$(mktemp "$1.herdr.XXXXXX") || exit 1; printf '%s' ${quote(todo(plan))} | awk ${quote(merge)} "$1" - > "$temporary" && cat "$temporary" > "$1"; result=$?; rm -f "$temporary"; exit "$result"`
    : `printf '%s' ${quote(todo(plan))} > "$1"`;
  return [
    "-c",
    `alias.herdr-rebase=!env GIT_SEQUENCE_EDITOR=${quote(`sh -c ${quote(script)} --`)} GIT_EDITOR=true git`,
    "herdr-rebase",
    "-c",
    "core.abbrev=false",
    "-c",
    "rebase.abbreviateCommands=false",
    "rebase",
    "-i",
    "--no-autosquash",
    "--no-autostash",
    "--no-rebase-merges",
    "--reschedule-failed-exec",
    "--empty=keep",
    plan.updateRefs ? "--update-refs" : "--no-update-refs",
    plan.upstream ?? "--root",
  ];
}

async function recoveryArgs(git: RunGit, task: Exclude<RebaseTask, { kind: "start" }>): Promise<string[]> {
  if (!(await rebaseActive(git))) throw new Error("No rebase is in progress. Close and refresh.");
  if (task.kind !== "amend") return ["rebase", `--${task.kind}`];
  const amend = await shell(git, 'test -e "$(git rev-parse --git-path rebase-merge/amend)"');
  if (amend.code !== 0) throw new Error("Amend is available only at an Edit stop. Resolve conflicts and use Continue.");
  if (!task.message.trim()) throw new Error("Enter a commit message.");
  return ["commit", "--amend", "--allow-empty", "-m", task.message];
}

export async function runRebase(git: RunGit, task: RebaseTask): Promise<RebaseResult> {
  const args = task.kind === "start" ? await startArgs(git, task.plan) : await recoveryArgs(git, task);
  const result = await git(["-c", "core.editor=true", ...args]);
  const message = await git(["log", "-1", "--format=%B"]);
  return {
    active: await rebaseActive(git),
    success: result.code === 0,
    output: `${result.stdout}\n${result.stderr}`.replace(/\r\n?/g, "\n").trim(),
    message: message.code === 0 ? message.stdout.trimEnd() : "",
  };
}
