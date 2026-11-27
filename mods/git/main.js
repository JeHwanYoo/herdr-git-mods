// Herdr Git Mods v0.3.0

// src/main.ts
import { v_flex as v_flex24 } from "gpui-base";
import { div as div28, View } from "gpui-kit";
import { exec as exec6, nextCommand, watchFolder } from "herdr";

// src/git/read-sharing.ts
function shareSummaryReads(git) {
  const pending = new Map;
  return (args) => {
    if (!args.includes("diff") || !args.includes("--numstat"))
      return git(args);
    const key = JSON.stringify(args);
    const existing = pending.get(key);
    if (existing)
      return existing;
    const result = git(args);
    pending.set(key, result);
    result.then(() => pending.delete(key), () => pending.delete(key));
    return result;
  };
}

// src/git/repository.ts
var GIT_PROCESSES = 8;
async function mapGit(items, read) {
  const results = new Array(items.length);
  const pending = items.entries();
  const reader = async () => {
    for (const [index, item] of pending)
      results[index] = await read(item);
  };
  await Promise.all(Array.from({ length: Math.min(GIT_PROCESSES, items.length) }, reader));
  return results;
}
var READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
var KINDS = {
  M: "modified",
  T: "type",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied"
};
async function readRepository(git) {
  const top = await git([...READ, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) {
    if (/not a git repository/i.test(top.stderr))
      return { state: "none" };
    throw new Error(top.stderr.trim() || `git rev-parse exited with ${top.code}`);
  }
  const status = await git([
    ...READ,
    "-c",
    "status.relativePaths=false",
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=all"
  ]);
  if (status.code !== 0)
    throw new Error(status.stderr.trim() || `git status exited with ${status.code}`);
  return {
    state: "ready",
    root: top.stdout.replace(/\n$/, ""),
    ...parseRepositoryStatus(status.stdout),
    porcelain: status.stdout
  };
}
function parseRepositoryStatus(output) {
  const branch = { name: null, detached: false, upstream: null, ahead: 0, behind: 0 };
  const files = [];
  const records = output.split("\x00");
  for (let i = 0;i < records.length; i++) {
    const record = records[i] ?? "";
    if (record.startsWith("# "))
      readBranchHeader(record.slice(2), branch);
    else if (record.startsWith("1 "))
      files.push(changed(fields(record, 9)));
    else if (record.startsWith("2 "))
      files.push({ ...changed(fields(record, 10)), from: records[++i] ?? "" });
    else if (record.startsWith("u "))
      files.push({ path: lastField(record, 11), staged: "conflict", unstaged: "conflict" });
    else if (record.startsWith("? "))
      files.push({ path: record.slice(2), staged: null, unstaged: "untracked" });
  }
  return { branch, files: combineChanges(files) };
}
function combineChanges(files) {
  const paths = new Map;
  for (const file of files) {
    const existing = paths.get(file.path);
    paths.set(file.path, existing ? {
      ...existing,
      staged: file.staged ?? existing.staged,
      unstaged: file.unstaged ?? existing.unstaged
    } : file);
  }
  return [...paths.values()];
}
function readBranchHeader(header, branch) {
  const [key, ...rest] = header.split(" ");
  const value = rest.join(" ");
  if (key === "branch.head") {
    branch.detached = value === "(detached)";
    branch.name = branch.detached ? null : value;
  } else if (key === "branch.upstream") {
    branch.upstream = value;
  } else if (key === "branch.ab") {
    const [ahead, behind] = value.split(" ");
    branch.ahead = Math.abs(Number(ahead));
    branch.behind = Math.abs(Number(behind));
  }
}
function fields(record, count) {
  const parts = record.split(" ");
  return [...parts.slice(0, count - 1), parts.slice(count - 1).join(" ")];
}
function lastField(record, count) {
  return fields(record, count)[count - 1] ?? "";
}
function changed(parts) {
  const xy = parts[1] ?? "..";
  return {
    path: parts[parts.length - 1] ?? "",
    staged: KINDS[xy.charAt(0)] ?? null,
    unstaged: KINDS[xy.charAt(1)] ?? null
  };
}

// src/runtime/context.ts
import { focused, panes, spaces } from "herdr";

// src/runtime/repository-selection.ts
class RepositorySelection {
  tab;
  source;
  followed;
  selected = null;
  constructor(tab = null, source = null, followed = null) {
    this.tab = tab;
    this.source = source;
    this.followed = followed;
  }
  select(location) {
    this.selected = location ? { ...location } : null;
  }
  read(focus, panes) {
    const followed = this.follow(focus, panes);
    return this.selected ? { ...this.selected } : followed;
  }
  follow(focus, panes) {
    if (this.tab && focus.tab !== this.tab)
      return this.followed ? { ...this.followed } : null;
    if (focus.terminal) {
      this.source = focus.pane;
      this.followed = { cwd: focus.cwd, on: focus.on };
    } else {
      const source = panes.find((pane) => pane.pane === this.source && pane.tab === focus.tab && pane.terminal);
      if (source?.cwd)
        this.followed = { cwd: source.cwd, on: focus.on };
    }
    return this.followed ? { ...this.followed } : null;
  }
}

// src/runtime/context.ts
class RepositoryContext {
  selection = new RepositorySelection;
  bind(tab, source, location) {
    this.selection = new RepositorySelection(tab, source, location);
  }
  select(location) {
    this.selection.select(location);
  }
  current() {
    return this.selection.read(...this.focus());
  }
  followed() {
    return this.selection.follow(...this.focus());
  }
  focus() {
    const now = focused();
    const space = spaces().find((entry) => entry.active);
    const live = panes();
    const pane = now?.pane ? live.find((entry) => entry.pane === now.pane) : null;
    const remote = now?.pane === null && now.terminal?.includes("/") ? now.terminal.split("/")[0] ?? null : null;
    return [
      {
        tab: now?.tab ?? null,
        pane: now?.pane ?? null,
        terminal: now?.terminal ?? null,
        cwd: pane?.cwd || now?.cwd || space?.folder || null,
        on: now?.pane === null ? remote : space?.machine ?? null
      },
      live
    ];
  }
}

// src/runtime/pane.ts
import { appHome, closeOverlay, exec, focused as focused2, notify, panes as panes2, props, run, spaces as spaces2 } from "herdr";

// src/runtime/pane-target.ts
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function documentValue(reply) {
  if (reply.error) {
    const message = record(reply.error) ? reply.error.message : null;
    throw new Error(typeof message === "string" ? message : "Could not read the tab layout");
  }
  const result = reply.result;
  if (record(result) && typeof result.version === "number" && result.version > 0 && record(result.value))
    return result.value;
  throw new Error("The tab layout is unavailable");
}
function documentReply(output) {
  for (const line of output.split(`
`)) {
    if (!line.trim())
      continue;
    const reply = JSON.parse(line);
    if (!record(reply) || reply.id !== 2)
      continue;
    return documentValue(reply);
  }
  throw new Error("Herdr core did not return the tab layout");
}
function tabRoot(document, tab) {
  if (Array.isArray(document.spaces))
    for (const space of document.spaces) {
      if (!record(space) || !Array.isArray(space.tabs))
        continue;
      const entry = space.tabs.find((entry) => record(entry) && entry.id === tab);
      if (record(entry) && record(entry.root))
        return entry.root;
    }
  throw new Error("The tab is no longer available");
}
function gitPane(node) {
  if (typeof node.id !== "string" || !node.id)
    throw new Error("The tab layout has an invalid node");
  if (node.type === "block")
    return record(node.content) && node.content.mod === "git" ? node.id : null;
  if (node.type !== "row" && node.type !== "column" || !Array.isArray(node.children))
    throw new Error("The tab layout has an unsupported split");
  let found = null;
  for (const child of node.children) {
    if (!record(child))
      throw new Error("The tab layout has an invalid split");
    found ??= gitPane(child);
  }
  return found;
}
async function readGitPaneTarget(execute, tab, on, windows = false) {
  const hello = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { generation: 1 } });
  const request = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "doc.get", params: { name: "herdr-app", on } });
  const result = windows ? await execute("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `@('${hello.replaceAll("'", "''")}','${request.replaceAll("'", "''")}') | & hc connect`
  ]) : await execute("sh", ["-c", 'printf "%s\\n" "$1" "$2" | hc connect', "herdr-git", hello, request]);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || "Could not read the tab layout");
  const rawTab = on && tab.startsWith(`${on}/`) ? tab.slice(on.length + 1) : tab;
  const root = tabRoot(documentReply(result.stdout), rawTab);
  const existing = gitPane(root);
  const pane = existing ?? root.id;
  if (typeof pane !== "string" || !pane)
    throw new Error("The tab layout has no root");
  return { pane: on && !pane.startsWith(`${on}/`) ? `${on}/${pane}` : pane, close: existing !== null };
}

// src/runtime/pane.ts
function textProperty(input, key) {
  if (typeof input !== "object" || input === null || !(key in input))
    return null;
  const value = Reflect.get(input, key);
  return typeof value === "string" ? value : null;
}

class GitPlacement {
  launcher;
  tab;
  constructor(source, cx) {
    const input = props();
    const overlay = textProperty(input, "overlay");
    this.tab = textProperty(input, "tab");
    this.launcher = overlay !== null;
    if (overlay)
      launchGitPane(overlay, source, cx);
    else
      source.bind(this.tab, textProperty(input, "sourcePane"), {
        cwd: textProperty(input, "cwd"),
        on: textProperty(input, "on")
      });
  }
  close() {
    const pane = panes2().find((pane) => pane.tab === this.tab && pane.mod === "git");
    if (pane)
      run("pane.close", { pane: pane.pane });
  }
}
async function openPane(target, tab, sourcePane, location, cx) {
  const before = new Set(panes2().filter((pane) => pane.tab === tab).map((pane) => pane.pane));
  run("pane.split", { pane: target, direction: "right", mod: "git", props: { tab, ...location, sourcePane } });
  for (let step = 0;step < 20; step++) {
    const made = panes2().find((pane) => pane.tab === tab && pane.mod === "git" && !before.has(pane.pane));
    if (made) {
      if (focused2()?.tab === tab)
        run("pane.focus", { pane: made.pane });
      return;
    }
    await cx.sleep(25);
  }
  throw new Error("The Git pane did not open");
}
function launchGitPane(overlay, repository, cx) {
  const start = focused2();
  const space = spaces2().find((space) => space.id === start?.space);
  const on = space?.machine ?? null;
  const source = panes2().find((pane) => pane.tab === start?.tab && pane.terminal);
  const location = repository.current() ?? { cwd: source?.cwd || space?.folder || null, on };
  cx.spawn(async (cx) => {
    try {
      if (!start?.tab)
        throw new Error("Open a terminal tab first");
      const target = await readGitPaneTarget(exec, start.tab, on, /^[A-Za-z]:|\\/.test(appHome()));
      if (focused2()?.tab !== start.tab)
        throw new Error("Tab changed; open Git again");
      if (target.close) {
        run("pane.close", { pane: target.pane });
        return;
      }
      await openPane(target.pane, start.tab, start.terminal ? start.pane : source?.pane ?? null, location, cx);
    } catch (error) {
      notify({ title: "Git", body: error instanceof Error ? error.message : String(error), level: "error" });
    } finally {
      closeOverlay(overlay);
    }
  });
}

// src/ui/changes.ts
import { h_flex as h_flex8, v_flex as v_flex8 } from "gpui-base";
import { div as div9 } from "gpui-kit";

// src/git/comparison.ts
var SECTION_ORDER = { working: 0, commit: 0, staged: 1, unstaged: 2 };
var STATUS = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  type: "T",
  conflict: "U",
  untracked: "??"
};
var READ2 = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
async function run2(git, args) {
  const result = await git(args);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `git ${args[0] ?? ""} exited with ${result.code}`);
  return result.stdout;
}
async function attempt(git, args) {
  const result = await git(args);
  return result.code === 0 ? result.stdout : null;
}
async function difference(git, args) {
  const result = await git(args);
  if (result.code === 0 || result.code === 1 && result.stdout)
    return result.stdout;
  throw new Error(result.stderr.trim() || `git ${args[0] ?? ""} exited with ${result.code}`);
}
function sectionTarget(section) {
  if (section === "staged")
    return { kind: "index-head" };
  if (section === "unstaged")
    return { kind: "working-index" };
  return null;
}
function emptyTree(git) {
  return run2(git, ["hash-object", "-t", "tree", "/dev/null"]).then((value) => value.trim());
}
async function resolveCommit(git, revision) {
  const value = revision.trim();
  if (!value)
    throw new Error("Choose a branch or commit.");
  return (await run2(git, ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`])).trim();
}
async function optionalCommit(git, revision) {
  const value = await attempt(git, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
  return value?.trim() || null;
}
function parseNameStatus(output, section) {
  const changes = [];
  const fields = output.split("\x00");
  let index = 0;
  while (index < fields.length - 1) {
    const status = fields[index++] ?? "";
    let path = fields[index++];
    if (status.startsWith("R") || status.startsWith("C"))
      path = fields[index++];
    if (!status || path === undefined)
      throw new Error("Git returned an incomplete changed path");
    changes.push({ section, status, path });
  }
  return changes;
}
function parseNumstat(output) {
  const summary = { files: 0, additions: 0, deletions: 0 };
  const records = output.split("\x00");
  for (let index = 0;index < records.length - 1; index++) {
    const record = records[index] ?? "";
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0)
      throw new Error("Git returned an incomplete diff summary");
    summary.files++;
    summary.additions += Number.parseInt(record.slice(0, first), 10) || 0;
    summary.deletions += Number.parseInt(record.slice(first + 1, second), 10) || 0;
    if (second === record.length - 1)
      index += 2;
  }
  return summary;
}
function workingChanges(files) {
  const changes = [];
  for (const file of files) {
    if (file.staged)
      changes.push({ section: "staged", status: STATUS[file.staged], path: file.path });
    if (file.unstaged)
      changes.push({ section: "unstaged", status: STATUS[file.unstaged], path: file.path });
  }
  return changes.sort((left, right) => SECTION_ORDER[left.section] - SECTION_ORDER[right.section] || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
async function branchStart(git, branch) {
  if (!branch)
    return null;
  const log = await attempt(git, ["reflog", "show", "--format=%H%x00%gs", branch]);
  if (!log)
    return null;
  for (const line of log.split(`
`).reverse()) {
    const [sha, subject = ""] = line.split("\x00");
    if (sha && (subject.startsWith("branch: Created from ") || subject.startsWith("commit (initial):") || subject.startsWith("clone: from ")))
      return sha;
  }
  return null;
}
async function lastCommitTarget(git, head) {
  const [previous, branch] = await Promise.all([
    optionalCommit(git, "HEAD^1"),
    attempt(git, ["symbolic-ref", "--quiet", "HEAD"]).then((value) => value?.trim() || null)
  ]);
  if (!previous || branch === "refs/heads/main")
    return { kind: "commit", commit: head, parent: previous };
  const base = await branchStart(git, branch);
  if (!base)
    return { kind: "commit", commit: head, parent: previous };
  const ancestor = (await git(["merge-base", "--is-ancestor", base, previous])).code === 0;
  return { kind: "commit", commit: head, parent: ancestor ? previous : head };
}
async function comparisonBetween(git, base, compare) {
  const [parent, commit] = await Promise.all([resolveCommit(git, base), resolveCommit(git, compare)]);
  return { kind: "commit", commit, parent };
}
function targetArgs(target, empty) {
  if (target.kind === "working-index")
    return Promise.resolve([]);
  if (target.kind === "index-head")
    return Promise.resolve(["--cached"]);
  if (target.parent)
    return Promise.resolve([target.parent, target.commit]);
  return empty().then((tree) => [tree, target.commit]);
}
async function untrackedSummary(git, paths) {
  const files = paths.filter((path) => !path.endsWith("/"));
  const parts = await mapGit(files, async (path) => parseNumstat(await difference(git, [
    ...READ2,
    "diff",
    "--no-ext-diff",
    "--no-index",
    "--numstat",
    "-z",
    "--",
    "/dev/null",
    path
  ])));
  return parts.reduce((total, part) => ({
    files: total.files + part.files,
    additions: total.additions + part.additions,
    deletions: total.deletions + part.deletions
  }), { files: 0, additions: 0, deletions: 0 });
}
async function readSummary(git, target, untracked = [], tracked = true) {
  const args = await targetArgs(target, () => emptyTree(git));
  const [summary, extra] = await Promise.all([
    tracked ? run2(git, [
      ...READ2,
      "diff",
      "--no-ext-diff",
      "--numstat",
      "-z",
      "--find-renames",
      "--find-copies",
      ...args,
      "--"
    ]).then(parseNumstat) : Promise.resolve({ files: 0, additions: 0, deletions: 0 }),
    untrackedSummary(git, untracked)
  ]);
  return {
    files: summary.files + extra.files,
    additions: summary.additions + extra.additions,
    deletions: summary.deletions + extra.deletions
  };
}
async function readWorkingSummaries(git, files) {
  const summaries = {};
  const untracked = files.filter((file) => file.unstaged === "untracked").map((file) => file.path);
  await Promise.all(["staged", "unstaged"].map(async (section) => {
    const count = files.filter((file) => file[section]).length;
    if (count === 0)
      return;
    const target = sectionTarget(section);
    if (!target)
      return;
    const summary = await readSummary(git, target, section === "unstaged" ? untracked : [], files.some((file) => file[section] && file[section] !== "untracked"));
    summaries[section] = { ...summary, files: count };
  }));
  return summaries;
}
async function readTitles(git, target) {
  if (target?.kind !== "commit")
    return {};
  const revisions = target.parent ? [target.parent, target.commit] : [target.commit];
  const output = await attempt(git, ["log", "--no-walk", "--format=%H%x00%s", "--end-of-options", ...revisions, "--"]);
  const titles = {};
  for (const line of output?.split(`
`) ?? []) {
    const [sha, subject] = line.split("\x00");
    if (sha && subject !== undefined)
      titles[sha] = subject;
  }
  return titles;
}
async function commitChanges(git, target) {
  const base = target.parent ?? await emptyTree(git);
  return parseNameStatus(await run2(git, ["diff", "--no-ext-diff", "--name-status", "-z", "-M", "-C", base, target.commit, "--"]), "commit");
}
async function resolveLast(git) {
  const head = await optionalCommit(git, "HEAD");
  if (!head)
    return null;
  return lastCommitTarget(git, head);
}
async function resolveChanges(git, mode, files) {
  if (mode.kind !== "last") {
    const comparison = mode.kind === "between" ? await comparisonBetween(git, mode.base, mode.compare) : {
      kind: "commit",
      commit: await resolveCommit(git, mode.sha),
      parent: await optionalCommit(git, `${mode.sha}^1`)
    };
    return { changes: await commitChanges(git, comparison), comparison };
  }
  const local = workingChanges(files);
  if (local.length > 0)
    return { changes: local, comparison: null };
  const comparison = await resolveLast(git);
  return { changes: comparison?.kind === "commit" ? await commitChanges(git, comparison) : [], comparison };
}
async function readChanges(git, mode, files) {
  let currentFiles = files ?? [];
  let currentGit = git;
  if (mode.kind === "last" && files === undefined) {
    const repository = await readRepository(git);
    if (repository.state !== "ready")
      throw new Error("Not a Git repository");
    currentFiles = repository.files;
    currentGit = (args) => git(["-C", repository.root, ...args]);
  }
  const { changes, comparison } = await resolveChanges(currentGit, mode, currentFiles);
  const [summaries, titles] = await Promise.all([
    comparison ? changes.length ? readSummary(currentGit, comparison).then((summary) => ({ commit: summary })) : Promise.resolve({}) : readWorkingSummaries(currentGit, currentFiles),
    readTitles(currentGit, comparison)
  ]);
  return { changes, comparison, summaries, titles };
}
async function readBranchTargets(git) {
  const output = await run2(git, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%00%(refname:short)%00%(objectname)",
    "refs/heads",
    "refs/remotes"
  ]);
  const targets = [];
  for (const record of output.split(`
`)) {
    if (!record)
      continue;
    const [reference, name, commit] = record.split("\x00");
    if (!reference || !name || !commit)
      throw new Error("Git returned an incomplete branch target");
    if (reference.startsWith("refs/remotes/") && name.endsWith("/HEAD"))
      continue;
    targets.push({ name, reference, commit });
  }
  return targets;
}

// src/git/diff.ts
async function readDiff(git, file, side) {
  if (file.staged === "conflict" || file.unstaged === "conflict")
    return preview(git, ["diff"], ["HEAD", "--", file.path]);
  const untracked = side === "unstaged" && file.unstaged === "untracked";
  const paths = file.from ? [file.from, file.path] : [file.path];
  const target = untracked ? ["--no-index", "--", "/dev/null", file.path] : [...side === "staged" ? ["--cached"] : [], "--", ...paths];
  return preview(git, ["diff"], target, untracked);
}
function readComparison(git, base, target, file) {
  const paths = file.from ? [file.from, file.path] : [file.path];
  return preview(git, base ? ["diff"] : ["diff-tree", "--root", "--no-commit-id", "-r"], [
    ...base ? [base, target] : [target],
    "--",
    ...paths
  ]);
}
async function preview(git, command, target, allowDifference = false) {
  const args = [
    "--no-optional-locks",
    "--literal-pathspecs",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotePath=false",
    "-c",
    "diff.autoRefreshIndex=false",
    ...command,
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--find-renames",
    "--unified=100000"
  ];
  const run = async (format) => {
    const result = await git([...args, format, ...target]);
    if (result.code !== 0 && !(allowDifference && result.code === 1))
      throw new Error(result.stderr.trim() || `git diff exited with ${result.code}`);
    return result.stdout;
  };
  const stats = await run("--numstat");
  if (stats.startsWith("-\t-\t"))
    return { text: "", binary: true, truncated: false };
  const text = await run("--patch");
  return { text: text.slice(0, 200000), binary: false, truncated: text.length > 200000 };
}
var FULL_CONTEXT = "--unified=1000000";
async function readTargetDiff(git, target, path) {
  if (target.kind === "working-index") {
    const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z", "--", path]);
    if (untracked.code === 0 && untracked.stdout.split("\x00").includes(path)) {
      const result = await git([
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-color",
        FULL_CONTEXT,
        "--",
        "/dev/null",
        path
      ]);
      if (result.code === 0 || result.code === 1 && result.stdout)
        return result.stdout;
      throw new Error(result.stderr.trim() || `git diff exited with ${result.code}`);
    }
  }
  const args = ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--find-copies", FULL_CONTEXT];
  if (target.kind === "index-head")
    args.push("--cached");
  if (target.kind === "commit")
    args.push(target.parent ?? await emptyTree(git), target.commit);
  const result = await git([...args, "--", path]);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `git diff exited with ${result.code}`);
  return result.stdout;
}
function parseBlameRecord(record) {
  const lines = record.split(`
`);
  const [sha, , final] = (lines[0] ?? "").split(" ");
  const line = Number(final);
  if (!sha || !Number.isSafeInteger(line))
    throw new Error("Git returned incomplete blame output");
  const entry = { sha, author: "", authorEmail: "", authorTime: 0, summary: "", line };
  for (const field of lines.slice(1)) {
    if (field.startsWith("\t"))
      break;
    if (field.startsWith("author "))
      entry.author = field.slice(7);
    else if (field.startsWith("author-mail "))
      entry.authorEmail = field.slice(12).replace(/^<|>$/g, "");
    else if (field.startsWith("author-time "))
      entry.authorTime = Number(field.slice(12)) || 0;
    else if (field.startsWith("summary "))
      entry.summary = field.slice(8);
  }
  return entry;
}
async function readBlameRange(git, file, start, end, revision) {
  const args = ["blame", "--line-porcelain", "-L", `${start},${end}`];
  if (revision)
    args.push(revision);
  const result = await git([...args, "--", file]);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `git blame exited with ${result.code}`);
  const entries = [];
  let record = [];
  for (const line of result.stdout.split(`
`)) {
    record.push(line);
    if (!line.startsWith("\t"))
      continue;
    entries.push(parseBlameRecord(record.join(`
`)));
    record = [];
  }
  return entries;
}
function blameRevision(target) {
  return target.kind === "commit" ? target.commit : null;
}

// src/git/staging.ts
function stages(operation) {
  return operation.kind === "stage-all" || operation.kind === "stage";
}
function args(operation) {
  if (operation.kind === "stage-all")
    return ["add", "--all"];
  if (operation.kind === "unstage-all")
    return ["restore", "--staged", "--", "."];
  if (operation.kind === "stage")
    return ["add", "--all", "--", ...operation.paths];
  if (operation.kind === "unstage")
    return ["restore", "--staged", "--", ...operation.paths];
  return ["--literal-pathspecs", "restore", "--worktree", "--", ...operation.paths];
}
function unbornArgs(operation) {
  if (operation.kind === "unstage-all")
    return ["rm", "--cached", "-r", "--ignore-unmatch", "--", "."];
  if (operation.kind === "unstage")
    return ["rm", "--cached", "--ignore-unmatch", "--", ...operation.paths];
  return null;
}
function stagingPreview(operation) {
  return `git ${args(operation).join(" ")}`;
}
function stagingLabel(operation) {
  if (operation.kind === "discard")
    return "Discarding";
  return stages(operation) ? "Staging" : "Unstaging";
}
function stagingMessage(operation) {
  if (operation.kind === "stage-all")
    return "Staged all changes";
  if (operation.kind === "unstage-all")
    return "Unstaged all changes";
  if (operation.kind === "discard")
    return "Git index updated";
  const verb = operation.kind === "stage" ? "Staged" : "Unstaged";
  return operation.paths.length === 1 ? `${verb} ${operation.paths[0] ?? ""}` : `${verb} ${operation.paths.length} selected files`;
}
function output(result) {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout && stderr)
    return `${stdout}
${stderr}`;
  return stdout || stderr || "Git completed without output.";
}
async function listed(git, command, selected) {
  const result = await git([...command, "--", ...selected]);
  if (result.code !== 0)
    throw new Error(`Could not verify the index update: ${result.stderr.trim()}`);
  return result.stdout.split("\x00").filter(Boolean);
}
async function verifyStaging(git, operation) {
  const stage = stages(operation);
  const selected = operation.kind === "stage-all" || operation.kind === "unstage-all" ? [] : operation.paths;
  const remaining = await listed(git, ["diff", "--name-only", "-z", "--ignore-submodules=dirty", ...stage ? [] : ["--cached"]], selected);
  if (stage)
    remaining.push(...await listed(git, ["ls-files", "--others", "--exclude-standard", "-z"], selected));
  const unique = [...new Set(remaining)].sort();
  if (unique.length === 0)
    return;
  const lines = [
    `Git completed, but ${unique.length} requested paths remain ${stage ? "unstaged" : "staged"}:`,
    ...unique.slice(0, 20)
  ];
  if (unique.length > 20)
    lines.push(`... and ${unique.length - 20} more`);
  lines.push("The operation may have applied partially. Review the refreshed file list.");
  if (stage)
    lines.push("Check for concurrent file edits or filename case collisions. Case-colliding files require a case-sensitive filesystem.");
  throw new Error(lines.join(`
`));
}
async function verifyDiscard(git, selected) {
  const result = await git([
    "--literal-pathspecs",
    "diff",
    "--name-only",
    "--ignore-submodules=dirty",
    "--",
    ...selected
  ]);
  if (result.code !== 0)
    throw new Error("Could not verify the discard result. Review the refreshed file list.");
  if (result.stdout)
    throw new Error(`Discard incomplete. Changes remain. Check for filename case collisions or concurrent edits. Some files may already have been restored.

${result.stdout}`);
}
async function runStaging(git, operation) {
  if (operation.kind === "discard" && operation.paths.length === 0)
    throw new Error("No tracked unstaged files selected.");
  const unborn = (await git(["rev-parse", "--verify", "--quiet", "HEAD"])).code !== 0;
  const result = await git((unborn ? unbornArgs(operation) : null) ?? args(operation));
  if (result.code !== 0)
    throw new Error(output(result));
  if (operation.kind === "discard")
    await verifyDiscard(git, operation.paths);
  else
    await verifyStaging(git, operation);
  return output(result);
}

// src/ui/changes/compare.ts
import { h_flex as h_flex2, InputState, v_flex as v_flex2 } from "gpui-base";
import { div as div3 } from "gpui-kit";

// src/ui/theme.ts
import { settings, theme } from "herdr";
var THEME_STORAGE_KEY = "git-theme";
var FALLBACK_FONT = "JetBrains Mono";
var FALLBACK_SIZE = 14;
var CELL_RATIO = 0.6;
var ROW_RATIO = 1.3;
var LIGHT_LUMINANCE = 140;
var VOID = {
  surface0: "#04080f",
  background: "#08111d",
  panel: "#0d1a2b",
  panelFocus: "#10253a",
  hover: "#14263d",
  accent: "#35d6ff",
  accentStrong: "#7be4ff",
  accentText: "#5fdfff",
  accentSoft: "#35d6ff1f",
  accentEdge: "#35d6ff59",
  text: "#e8f4ff",
  textInverse: "#03121c",
  hint: "#7893ad",
  secondary: "#9db7cf",
  muted: "#7893ad",
  error: "#ff6b7d",
  success: "#3fe0c0",
  warning: "#ffb24a",
  info: "#6aa6ff",
  azure: "#3b8cff",
  ice: "#b9ecff",
  reference: "#5fdfff",
  typeChange: "#6aa6ff",
  unmerged: "#ffb24a",
  focus: "#35d6ff1f",
  selection: "#35d6ff2b",
  header: "#08111d",
  inert: "#08111d",
  rule: "#1f3a57",
  lineStrong: "#4a80ab",
  scrim: "#04080fc2",
  diffAdded: "#3fe0c024",
  diffRemoved: "#ff6b7d24",
  badgeHead: "#ff6b7d1f",
  badgeHeadBorder: "#ff6b7d8c",
  badgeLocal: "#3fe0c01f",
  badgeLocalBorder: "#3fe0c08c",
  badgeRemote: "#6aa6ff1f",
  badgeRemoteBorder: "#6aa6ff8c",
  badgeRemoteHead: "#3b8cff1f",
  badgeRemoteHeadBorder: "#3b8cff8c",
  badgeTag: "#ffb24a1f",
  badgeTagBorder: "#ffb24a8c",
  badgeOther: "#5fdfff1f",
  badgeOtherBorder: "#5fdfff8c",
  lanes: ["#35d6ff", "#3b8cff", "#3fe0c0", "#ffb24a", "#ff6b7d", "#b9ecff"]
};
var FROST = {
  surface0: "#e3edf7",
  background: "#f1f7fc",
  panel: "#ffffff",
  panelFocus: "#f0f7fa",
  hover: "#d9e7f3",
  accent: "#0a6f94",
  accentStrong: "#05587a",
  accentText: "#05638a",
  accentSoft: "#0a6f941a",
  accentEdge: "#0a6f9459",
  text: "#07192b",
  textInverse: "#ffffff",
  hint: "#486782",
  secondary: "#3a5671",
  muted: "#486782",
  error: "#b3182f",
  success: "#00735b",
  warning: "#8a5200",
  info: "#1f5fc4",
  azure: "#1f63d6",
  ice: "#8fd9f5",
  reference: "#05638a",
  typeChange: "#1f5fc4",
  unmerged: "#8a5200",
  focus: "#0a6f941a",
  selection: "#0a6f9429",
  header: "#f1f7fc",
  inert: "#f1f7fc",
  rule: "#b4cbe0",
  lineStrong: "#5b86a8",
  scrim: "#e3edf7c2",
  diffAdded: "#00735b1f",
  diffRemoved: "#b3182f1f",
  badgeHead: "#b3182f1f",
  badgeHeadBorder: "#b3182f8c",
  badgeLocal: "#00735b1f",
  badgeLocalBorder: "#00735b8c",
  badgeRemote: "#1f5fc41f",
  badgeRemoteBorder: "#1f5fc48c",
  badgeRemoteHead: "#1f63d61f",
  badgeRemoteHeadBorder: "#1f63d68c",
  badgeTag: "#8a52001f",
  badgeTagBorder: "#8a52008c",
  badgeOther: "#05638a1f",
  badgeOtherBorder: "#05638a8c",
  lanes: ["#0a6f94", "#1f63d6", "#00735b", "#8a5200", "#b3182f", "#5b86a8"]
};
var GLYPH = {
  marker: "▶ ",
  cursor: "▏",
  radioOn: "●",
  radioOff: "○",
  expanded: "▾",
  collapsed: "▸",
  separator: " · ",
  rule: "│"
};
var SPINNER = { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], ms: 100 };
var DIALOG = { narrow: 56, medium: 68, wide: 78, card: 82 };
var WIDE_COLUMNS = 90;
function themeMode() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === "void" || saved === "frost")
    return saved;
  return "auto";
}
function setThemeMode(mode) {
  localStorage.setItem(THEME_STORAGE_KEY, mode);
}
function isLightHex(value) {
  if (!value?.startsWith("#") || value.length < 7)
    return false;
  const r = Number.parseInt(value.slice(1, 3), 16);
  const g = Number.parseInt(value.slice(3, 5), 16);
  const b = Number.parseInt(value.slice(5, 7), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b))
    return false;
  return 0.299 * r + 0.587 * g + 0.114 * b > LIGHT_LUMINANCE;
}
function palette() {
  const mode = themeMode();
  if (mode === "void")
    return VOID;
  if (mode === "frost")
    return FROST;
  const names = theme();
  return isLightHex(names.background) ? FROST : VOID;
}
function setting(...keys) {
  const values = settings();
  for (const key of keys)
    if (values[key] !== undefined && values[key] !== null)
      return values[key];
  return;
}
function number(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
function look() {
  const font = setting("font_family", "font");
  const size = number(setting("font_size"), FALLBACK_SIZE);
  const zoom = number(setting("zoom"), 1);
  const cell = size * CELL_RATIO * number(setting("terminal_cell_width"), 1);
  const row = Math.round(size * ROW_RATIO * number(setting("terminal_line_height"), 1));
  return {
    t: palette(),
    font: typeof font === "string" && font ? font : FALLBACK_FONT,
    size,
    cell,
    row,
    screenCell: cell * zoom,
    screenRow: row * zoom
  };
}
function cols(look, count) {
  return count * look.cell;
}
function rows(look, count) {
  return count * look.row;
}
function lane(t, index) {
  return t.lanes[index % t.lanes.length] ?? t.accent;
}
function statusColor(t, status) {
  const letter = status.charAt(0);
  if (letter === "A" || letter === "?")
    return t.success;
  if (letter === "M")
    return t.warning;
  if (letter === "D")
    return t.error;
  if (letter === "R" || letter === "C")
    return t.accentText;
  if (letter === "T")
    return t.typeChange;
  if (letter === "U")
    return t.unmerged;
  return t.hint;
}

// src/ui/widgets.ts
import { Button, h_flex, Input, v_flex } from "gpui-base";
import { div as div2 } from "gpui-kit";

// src/ui/icons.ts
import { div, PathBuilder } from "gpui-kit";
var SVG_PATHS = {
  branch: "M 4 6 L 4 10 M 6 10 C 12 10 12 7 12 6 M 6 4 C 6 7 2 7 2 4 C 2 1 6 1 6 4 Z M 14 4 C 14 7 10 7 10 4 C 10 1 14 1 14 4 Z M 6 12 C 6 15 2 15 2 12 C 2 9 6 9 6 12 Z",
  remote: "M 14 8 C 14 16 2 16 2 8 C 2 0 14 0 14 8 Z M 8 2 C 4 5 4 11 8 14 C 12 11 12 5 8 2 Z M 2 8 L 14 8",
  tag: "M 2 2 L 8 2 L 14 8 L 8 14 L 2 8 Z M 5 5 L 6 5",
  github: "M 4 11 C 1 10 1 6 3 5 L 3 2 L 6 4 L 10 4 L 13 2 L 13 5 C 15 6 15 10 12 11 L 10 12 L 10 15 M 6 15 L 6 12 L 4 11 M 6 14 C 4 15 3 13 2 13",
  local: "M 2 3 L 14 3 L 14 11 L 2 11 Z M 8 11 L 8 14 M 5 14 L 11 14",
  worktree: "M 2 5 L 6 5 L 8 7 L 14 7 L 14 13 L 2 13 Z M 2 5 L 2 3 L 8 3 L 10 5 L 14 5 L 14 7",
  repository: "M 4 2 L 13 2 L 13 13 L 4 13 C 1 13 1 10 4 10 L 13 10 M 4 2 C 2 2 2 3 2 5 L 2 11 M 6 4 L 10 4",
  file: "M 3 2 L 9 2 L 13 6 L 13 14 L 3 14 Z M 9 2 L 9 6 L 13 6 M 6 10 L 10 10",
  fetch: "M 8 2 L 8 10 M 5 7 L 8 10 L 11 7 M 2 10 L 2 14 L 14 14 L 14 10",
  cherryPick: "M 5 9 C 5 5 8 3 12 2 M 11 8 L 12 2 M 7 11 C 7 14 2 14 2 11 C 2 8 7 8 7 11 Z M 14 10 C 14 13 9 13 9 10 C 9 7 14 7 14 10 Z",
  revert: "M 6 3 L 2 7 L 6 11 M 2 7 L 10 7 C 14 7 14 10 14 13",
  checkout: "M 3 14 L 3 8 C 3 5 5 4 8 4 L 14 4 M 10 1 L 14 4 L 10 7",
  rebase: "M 4 14 L 4 2 M 1 5 L 4 2 L 7 5 M 12 14 L 12 11 C 12 8 10 8 7 8 L 4 8",
  reset: "M 3 5 C 7 0 14 3 14 8 C 14 14 7 16 3 12 M 2 2 L 2 6 L 6 6",
  copy: "M 6 6 L 14 6 L 14 14 L 6 14 Z M 10 4 L 10 2 L 2 2 L 2 10 L 4 10"
};
var ICON_CELLS = 2;
var VIEW_BOX = 16;
var paths = new Map;
var pathSize = 0;
function iconPath(name, size) {
  if (size !== pathSize) {
    pathSize = size;
    paths.clear();
  }
  const previous = paths.get(name);
  if (previous)
    return previous;
  const scale = size / VIEW_BOX;
  const builder = PathBuilder.stroke(1.6 * scale);
  for (const command of SVG_PATHS[name].matchAll(/([MLCZ])([^MLCZ]*)/g)) {
    const [x = 0, y = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0] = (command[2] ?? "").trim().split(/\s+/).map(Number);
    switch (command[1]) {
      case "M":
        builder.move_to(x * scale, y * scale);
        break;
      case "L":
        builder.line_to(x * scale, y * scale);
        break;
      case "C":
        builder.cubic_bezier_to(x3 * scale, y3 * scale, x * scale, y * scale, x2 * scale, y2 * scale);
        break;
      case "Z":
        builder.close();
        break;
    }
  }
  const path = builder.build();
  paths.set(name, path);
  return path;
}
function iconCell(look, name, color = look.t.text) {
  const width = ICON_CELLS * look.cell;
  const size = Math.min(width * 0.875, look.row * 0.8);
  return div().flex_none().w(width).h(look.row).flex().items_center().justify_center().child(window.paint_path(iconPath(name, size), color).size(size));
}

// src/ui/widgets.ts
var WIDE_RANGES = [
  [4352, 4447],
  [11904, 12350],
  [12353, 13311],
  [13312, 19903],
  [19968, 40959],
  [40960, 42191],
  [44032, 55203],
  [63744, 64255],
  [65072, 65103],
  [65280, 65376],
  [65504, 65510],
  [127744, 128591],
  [129280, 129535],
  [131072, 262141]
];
function charWidth(character) {
  const code = character.codePointAt(0) ?? 0;
  if (code === 0 || code >= 768 && code <= 879 || code === 8205)
    return 0;
  return WIDE_RANGES.some(([start, end]) => code >= start && code <= end) ? 2 : 1;
}
function displayWidth(text) {
  let width = 0;
  for (const character of text)
    width += charWidth(character);
  return width;
}
function truncateToWidth(text, width) {
  if (displayWidth(text) <= width)
    return text;
  if (width <= 0)
    return "";
  let used = 1;
  let result = "";
  for (const character of text) {
    const next = charWidth(character);
    if (used + next > width)
      break;
    used += next;
    result += character;
  }
  return `${result}…`;
}
function spansWidth(spans) {
  return spans.reduce((total, span) => total + displayWidth(span.text) + (span.icon ? ICON_CELLS : 0), 0);
}
function spanElements(look, spans) {
  return spans.map(({ text, icon, color, bg, border, bold }) => {
    const span = h_flex().flex_none().items_center().when(!!color, (el) => el.text_color(color ?? look.t.text)).when(!!bg, (el) => el.bg(bg ?? look.t.panel)).when(!!border, (el) => el.border(1).border_color(border ?? look.t.rule).rounded(2)).when(!!bold, (el) => el.font_weight(700));
    if (icon)
      span.child(iconCell(look, icon, color));
    return span.child(text);
  });
}
function padToWidth(text, width) {
  const clipped = truncateToWidth(text, width);
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
}
function countedTitle(label, count) {
  return count === 0 ? label : `${label}${GLYPH.separator}${count}`;
}
function isChord(event) {
  return event.modifiers.alt || event.modifiers.control || event.modifiers.platform;
}
function spinner(look) {
  return div2().flex_none().text_color(look.t.accent).frames([...SPINNER.frames], SPINNER.ms);
}
function kbd(look, key, active = false) {
  const { t } = look;
  return h_flex().flex_none().items_center().justify_center().px(4).h(Math.max(16, look.row - 2)).bg(t.hover).border(1).border_b(2).border_color(active ? t.accent : t.lineStrong).rounded(2).text_size(Math.max(10, look.size - 3)).font_weight(600).text_color(active ? t.accentText : t.secondary).child(key);
}
function sectionLabel(look, text, options) {
  const { t } = look;
  const muted = options?.muted ?? false;
  return h_flex().flex_1().min_w(0).items_center().gap(8).whitespace_nowrap().child(div2().flex_none().w(6).h(6).rounded_full().bg(muted ? t.lineStrong : t.accent)).child(div2().flex_none().text_size(Math.max(10, look.size - 2)).font_weight(600).text_color(muted ? t.hint : t.secondary).child(text.toUpperCase())).when(!!options?.rule, (el) => el.child(div2().flex_1().h(1).bg(t.rule)));
}
function box(look, options, body) {
  const { t } = look;
  const focused = options.focused ?? false;
  const surface = options.surface ?? (focused ? t.panelFocus : t.panel);
  const outer = v_flex().id(options.id).relative().min_h(0).min_w(0).bg(surface).border(1).border_color(focused ? t.accentEdge : t.rule);
  if (options.title !== undefined) {
    const titleContent = typeof options.title === "string" ? div2().flex_1().min_w(0).truncate().text_size(Math.max(10, look.size - 2)).font_weight(600).text_color(t.text).child(options.title.toUpperCase()) : h_flex().flex_1().min_w(0).items_center().overflow_hidden().whitespace_nowrap().text_color(t.text).child(options.title);
    outer.child(h_flex().flex_none().h(look.row + 6).px(8).gap(8).items_center().border_b(1).border_color(t.rule).child(div2().flex_none().w(6).h(6).rounded_full().bg(t.accent)).child(titleContent));
  }
  outer.child(v_flex().flex_1().min_h(0).min_w(0).px(4).py(2).child(body));
  if (focused)
    outer.child(div2().absolute().bottom(0).left(0).right(0).h(2).bg(t.accent));
  return outer;
}
var ACTION_SLOTS = 6;
function actionContent(look, cell, hints, color) {
  if (cell.running)
    return [spinner(look), div2().text_color(color).ml(6).truncate().child(cell.running)];
  if (hints)
    return [
      kbd(look, cell.shortcut.toUpperCase(), cell.enabled),
      div2().text_color(color).ml(6).truncate().child(cell.label)
    ];
  const symbol = cell.symbol ? `${cell.symbol} ` : "";
  const label = div2().text_color(color).truncate().child(symbol + cell.label);
  return cell.icon ? [iconCell(look, cell.icon, color), div2().w(2), label] : [label];
}
function actionColors(look, cell) {
  const { t } = look;
  if (cell.selected)
    return {
      bg: t.accentSoft,
      border: t.accentEdge,
      text: t.accentText,
      hoverBg: t.accentSoft,
      hoverBorder: t.accent
    };
  if (cell.variant === "primary" && cell.enabled)
    return {
      bg: t.accent,
      border: t.accent,
      text: t.textInverse,
      hoverBg: t.accentStrong,
      hoverBorder: t.accentStrong
    };
  if (cell.variant === "danger" && cell.enabled)
    return {
      bg: t.panel,
      border: t.error,
      text: t.error,
      hoverBg: t.diffRemoved,
      hoverBorder: t.error
    };
  return {
    bg: t.panel,
    border: cell.enabled ? t.lineStrong : t.rule,
    text: cell.enabled ? t.text : t.muted,
    hoverBg: t.accentSoft,
    hoverBorder: t.accent
  };
}
function actionButton(look, cell, hints) {
  const { t } = look;
  const style = actionColors(look, cell);
  return Button.new(cell.id).accessibility_label(cell.label).relative().flex_1().min_w(0).h(look.row + 6).bg(style.bg).border(1).border_color(style.border).rounded(2).disabled(!cell.enabled).when(!cell.enabled, (el) => el.opacity(0.42)).when(!!cell.selected || cell.variant === "primary", (el) => el.font_weight(600)).when(cell.enabled, (el) => el.hover((hovered) => hovered.bg(style.hoverBg).border_color(style.hoverBorder))).child(h_flex().size_full().min_w(0).px(6).justify_center().items_center().overflow_hidden().whitespace_nowrap().children(actionContent(look, cell, hints, style.text))).when(!!cell.selected, (el) => el.child(div2().absolute().bottom(0).left(0).right(0).h(2).bg(t.accent))).on_click((_, cx) => {
    cx.stop_propagation();
    if (!cell.enabled)
      return;
    cell.onClick(cx);
    cx.notify();
  });
}
function actionBar(look, cells, hints) {
  const bar = h_flex().w_full().h(look.row + 6).flex_none().gap(6);
  for (const cell of cells.slice(0, ACTION_SLOTS))
    bar.child(actionButton(look, cell, hints));
  for (let slot = cells.length;slot < ACTION_SLOTS; slot++)
    bar.child(div2().flex_1().min_w(0));
  return bar;
}
function tabLabel(look, options, hints) {
  const { t } = look;
  const label = Button.new(options.id).accessibility_label(options.label).relative().flex_none().h(look.row + 10).px(10).items_center().text_size(Math.max(11, look.size - 1)).text_color(options.active ? t.accentText : t.secondary).when(options.active, (el) => el.bg(t.accentSoft).font_weight(600)).hover((style) => style.bg(t.accentSoft).text_color(options.active ? t.accentText : t.text)).when(options.active, (el) => el.child(div2().absolute().bottom(0).left(0).right(0).h(2).bg(t.accent))).on_click((_, cx) => {
    cx.stop_propagation();
    options.onClick(cx);
    cx.notify();
  });
  const text = options.label.toUpperCase();
  if (!hints)
    return label.child(text);
  return label.child(h_flex().items_center().gap(6).child(kbd(look, options.shortcut.toUpperCase(), options.active)).child(text));
}
function textInput(look, input, color) {
  return Input.new(input).flex_1().min_w(0).h(look.row).text_color(color ?? look.t.text);
}
function filterBar(look, options) {
  const { t } = look;
  const promptColor = options.active ? t.accentText : t.hint;
  return h_flex().id(options.id).relative().flex_none().h(look.row + 8).px(8).gap(6).items_center().bg(t.panel).border(1).border_color(options.active ? t.accent : t.lineStrong).rounded(2).child(div2().flex_none().text_color(promptColor).font_weight(600).child("/")).child(textInput(look, options.input, t.text)).when(options.active, (el) => el.child(div2().absolute().bottom(0).left(0).right(0).h(2).bg(t.accent)));
}
function dialogFrame(look, options, body) {
  return box(look, { id: options.id, title: options.title, surface: look.t.panel }, v_flex().min_w(0).min_h(0).flex_1().p(8).gap(6).child(body)).shadow_lg().w(cols(look, options.width)).max_w("100%").max_h("100%").on_mouse_down("left", (_, cx) => cx.stop_propagation());
}
function footerButton(look, button, primary) {
  const { t } = look;
  const enabled = button.enabled ?? true;
  const filled = primary && enabled;
  return Button.new(button.id).accessibility_label(button.label).flex_1().min_w(0).h(look.row + 10).disabled(!enabled).when(!enabled, (el) => el.opacity(0.42)).child(h_flex().size_full().justify_center().items_center().border(1).rounded(2).when(filled, (el) => el.bg(t.accent).border_color(t.accent).text_color(t.textInverse).font_weight(600).hover((style) => style.bg(t.accentStrong).border_color(t.accentStrong))).when(!filled, (el) => el.bg(button.focused ? t.accentSoft : t.panel).border_color(button.focused ? t.accent : enabled ? t.lineStrong : t.rule).text_color(enabled ? t.text : t.muted).when(!!button.focused, (el) => el.font_weight(600)).when(enabled, (el) => el.hover((style) => style.bg(t.accentSoft).border_color(t.accent)))).child(button.label)).on_click((_, cx) => {
    cx.stop_propagation();
    if (!enabled)
      return;
    button.onClick(cx);
    cx.notify();
  });
}
function dialogFooter(look, primary, secondary) {
  return h_flex().flex_none().w_full().pt(6).gap(8).child(footerButton(look, primary, true)).child(footerButton(look, secondary, false));
}
function footerHint(look, text) {
  return div2().flex_none().h(look.row).text_color(look.t.hint).truncate().child(text);
}
function scrollbar(look, options) {
  if (options.total <= options.visible || options.total <= 0)
    return null;
  const { t } = look;
  const size = Math.max(6, options.visible / options.total * 100);
  const start = Math.min(100 - size, options.offset / options.total * 100);
  if (options.axis === "vertical")
    return div2().relative().flex_none().w(6).h_full().bg(t.hover).child(div2().absolute().top(`${start}%`).h(`${size}%`).left(1).right(1).bg(t.lineStrong).rounded(1));
  return div2().relative().flex_none().h(6).w_full().bg(t.hover).child(div2().absolute().left(`${start}%`).w(`${size}%`).top(1).bottom(1).bg(t.lineStrong).rounded(1));
}
function viewportOffset(offset, selected, length, height) {
  const clamped = Math.max(0, Math.min(offset, length - 1));
  if (length === 0 || height === 0)
    return clamped;
  const target = Math.max(0, Math.min(selected, length - 1));
  if (target < clamped)
    return target;
  if (target >= clamped + height)
    return target + 1 - height;
  return clamped;
}

class ListViewport {
  id;
  selected = 0;
  scroll = 0;
  height = 0;
  wheel = 0;
  constructor(id) {
    this.id = id;
  }
  pageRows() {
    return Math.max(1, this.height);
  }
  reset() {
    this.selected = 0;
    this.scroll = 0;
  }
  clamp(length) {
    const last = Math.max(0, length - 1);
    this.selected = Math.min(this.selected, last);
    this.scroll = Math.min(this.scroll, last);
  }
  moveBy(delta, length) {
    const before = this.selected;
    this.selected = length === 0 ? 0 : Math.max(0, Math.min(length - 1, this.selected + delta));
    return before !== this.selected;
  }
  key(event, length, vim = true) {
    if (event.modifiers.alt || event.modifiers.control || event.modifiers.platform)
      return null;
    const steps = {
      up: -1,
      down: 1,
      pageup: -this.pageRows(),
      pagedown: this.pageRows(),
      home: -length,
      end: length
    };
    if (vim)
      Object.assign(steps, { k: -1, j: 1 });
    if (event.keystroke === "enter")
      return "activate";
    if (event.keystroke === "escape")
      return "cancel";
    const step = steps[event.keystroke];
    if (step === undefined)
      return null;
    this.moveBy(step, length);
    return "moved";
  }
  scrollWheel(event, look, options, cx) {
    this.wheel += event.delta_lines ? event.delta_lines.y * look.row : event.delta.y;
    const steps = Math.trunc(this.wheel / look.row);
    if (steps === 0)
      return;
    this.wheel -= steps * look.row;
    cx.stop_propagation();
    if (this.moveBy(-steps, options.length)) {
      options.onSelect?.(this.selected, cx);
      cx.notify();
    }
  }
  render(look, options) {
    const { t } = look;
    this.clamp(options.length);
    this.scroll = viewportOffset(this.scroll, this.selected, options.length, this.height);
    const end = Math.min(options.length, this.scroll + Math.max(1, this.height));
    const list = v_flex().flex_1().min_w(0).min_h(0).overflow_hidden();
    for (let index = this.scroll;index < end; index++) {
      const selected = index === this.selected;
      const active = selected && options.focused;
      const row = h_flex().id(`${this.id}-row-${index}`).flex_none().h(look.row).min_w(0).items_center().whitespace_nowrap().overflow_hidden().border_l(2).border_color(active ? t.accent : "#00000000").when(active, (el) => el.bg(t.accentSoft).font_weight(600)).hover((style) => style.bg(active ? t.accentSoft : t.hover)).on_click((_, cx) => {
        cx.stop_propagation();
        this.selected = index;
        options.onSelect?.(index, cx);
        options.onActivate?.(index, cx);
        cx.notify();
      });
      if (options.marker ?? true)
        row.child(div2().flex_none().w(cols(look, 2)).text_color(active ? t.accentText : t.hint).child(selected ? GLYPH.marker : ""));
      list.child(row.child(options.row({ index, selected, focused: options.focused })));
    }
    const bar = scrollbar(look, {
      axis: "vertical",
      total: options.length,
      visible: this.height,
      offset: this.scroll
    });
    return h_flex().id(this.id).flex_1().min_h(0).min_w(0).items_stretch().on_size_change((size, cx) => {
      const height = Math.max(1, Math.floor(size.height / look.screenRow));
      if (height === this.height)
        return;
      this.height = height;
      cx.notify();
    }).on_scroll_wheel((event, cx) => this.scrollWheel(event, look, options, cx)).child(list).when(!!bar, (el) => el.child(bar ?? div2()));
  }
}

// src/ui/changes/compare.ts
var HEIGHT = 18;
var FIXED_ROWS = 3 + 3 + 1 + 3;

class CompareDialog {
  services;
  onApply;
  inputs;
  focused = 1;
  targets = [];
  selected = null;
  scroll = 0;
  loading = true;
  error = null;
  constructor(services, base, compare, onApply) {
    this.services = services;
    this.onApply = onApply;
    this.inputs = [InputState.new({ value: base }), InputState.new({ value: compare })];
    for (const input of this.inputs)
      input.on("change", (_, cx) => {
        this.selected = null;
        this.scroll = 0;
        this.error = null;
        cx.notify();
      });
  }
  load(cx) {
    const git = this.services.git();
    const context = this.services.context();
    if (!git) {
      this.loading = false;
      this.error = "Not a Git repository";
      return;
    }
    cx.spawn(async (cx) => {
      try {
        const targets = await readBranchTargets(git);
        if (context === this.services.context())
          this.targets = targets;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }
  focus() {
    this.inputs[this.focused]?.focus();
  }
  release() {
    for (const input of this.inputs)
      input.release();
  }
  filtered() {
    const query = (this.inputs[this.focused]?.value() ?? "").toLowerCase();
    return this.targets.filter((target) => target.name.toLowerCase().includes(query) || target.reference.toLowerCase().includes(query));
  }
  switchField(index) {
    this.focused = index;
    this.selected = null;
    this.scroll = 0;
    this.focus();
  }
  choose(index) {
    const target = this.filtered()[index];
    if (!target)
      return;
    this.inputs[this.focused]?.set_value(target.reference);
    this.switchField(1 - this.focused);
  }
  apply(cx) {
    const [base, compare] = this.inputs.map((input) => input.value().trim());
    if (!base || !compare) {
      this.error = "Choose a branch or commit.";
      return;
    }
    this.release();
    this.services.overlay.close(cx);
    this.onApply(base, compare, cx);
  }
  move(key, length) {
    if (length === 0)
      return ["up", "down", "pageup", "pagedown", "home", "end"].includes(key);
    const page = Math.max(1, this.listRows());
    const current = this.selected ?? 0;
    const next = {
      down: this.selected === null ? 0 : current + 1,
      up: current - 1,
      pagedown: current + page,
      pageup: current - page,
      home: 0,
      end: length - 1
    };
    const target = next[key];
    if (target === undefined)
      return false;
    this.selected = Math.max(0, Math.min(length - 1, target));
    return true;
  }
  key(event, cx) {
    const key = event.keystroke;
    if (key === "tab" || key === "shift-tab")
      this.switchField(1 - this.focused);
    else if (key === "enter") {
      if (this.selected === null)
        this.apply(cx);
      else
        this.choose(this.selected);
    } else if (!this.move(key, this.filtered().length))
      return false;
    cx.stop_propagation();
    cx.notify();
    return true;
  }
  listRows() {
    return HEIGHT - FIXED_ROWS;
  }
  field(look, index) {
    const input = this.inputs[index];
    return box(look, { id: `git-compare-field-${index}`, title: index === 0 ? "Base" : "Compare", focused: this.focused === index }, h_flex2().h(look.row).child(input ? textInput(look, input) : div3())).h(rows(look, 3)).flex_none().on_mouse_down("left", () => {
      this.focused = index;
      this.selected = null;
      this.scroll = 0;
    });
  }
  render(look) {
    const { t } = look;
    const targets = this.filtered();
    const height = this.listRows();
    this.scroll = viewportOffset(this.scroll, this.selected ?? 0, targets.length, height);
    const list = v_flex2().h(rows(look, height)).flex_none().overflow_hidden();
    for (const [offset, target] of targets.slice(this.scroll, this.scroll + height).entries()) {
      const index = this.scroll + offset;
      const selected = this.selected === index;
      list.child(div3().id(`git-compare-target-${index}`).h(look.row).whitespace_nowrap().overflow_hidden().text_color(selected ? t.accent : t.hint).when(selected, (el) => el.font_weight(700)).hover((style) => style.bg(t.hover)).child(`${selected ? GLYPH.marker.trim() : " "} ${target.name}`).on_click((_, cx) => {
        cx.stop_propagation();
        this.choose(index);
        cx.notify();
      }));
    }
    const status = this.error ? div3().h(look.row).text_color(t.error).truncate().child(this.error) : div3().h(look.row).text_color(t.hint).child(this.loading ? "Loading branches" : "");
    return v_flex2().min_w(0).child(this.field(look, 0)).child(this.field(look, 1)).child(list).child(status).child(dialogFooter(look, { id: "git-compare-apply", label: "[Enter] Compare", onClick: (cx) => this.apply(cx) }, {
      id: "git-compare-cancel",
      label: "[Esc] Cancel",
      onClick: (cx) => {
        this.release();
        this.services.overlay.close(cx);
      }
    }));
  }
}
function openCompareDialog(services, base, compare, onApply, cx) {
  const dialog = new CompareDialog(services, base, compare, onApply);
  services.overlay.open({
    kind: "custom",
    title: "Compare",
    width: DIALOG.medium,
    height: HEIGHT,
    render: (look) => dialog.render(look),
    key: (event, cx) => dialog.key(event, cx),
    onCancel: () => dialog.release()
  });
  dialog.focus();
  dialog.load(cx);
}

// src/ui/changes/files-pane.ts
import { h_flex as h_flex3, v_flex as v_flex3 } from "gpui-base";
import {
  div as div4
} from "gpui-kit";

// src/ui/changes/tree.ts
var SECTIONS = ["working", "commit", "staged", "unstaged"];
var SECTION_LABELS = {
  working: "Working changes",
  commit: "Commit changes",
  staged: "Staged",
  unstaged: "Unstaged"
};
function node() {
  return { directories: new Map, files: new Map };
}
function compareNames(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a !== b)
    return a < b ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}
function insert(root, path, index) {
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
function emit(tree, depth, prefix, collapsed, rows) {
  for (const name of [...tree.directories.keys()].sort(compareNames)) {
    const key = `${prefix}${name}`;
    const expanded = !collapsed.has(key);
    rows.push({ kind: "directory", depth, label: name, key, expanded, section: null });
    const child = tree.directories.get(name);
    if (expanded && child)
      emit(child, depth + 1, `${key}/`, collapsed, rows);
  }
  for (const name of [...tree.files.keys()].sort(compareNames))
    rows.push({ kind: "file", depth, label: name, change: tree.files.get(name) ?? 0 });
}
function treeRows(changes, collapsed) {
  const rows = [];
  for (const section of SECTIONS) {
    const tree = node();
    let members = 0;
    for (const [index, change] of changes.entries())
      if (change.section === section) {
        insert(tree, change.path, index);
        members++;
      }
    if (members === 0)
      continue;
    const key = `${section}:`;
    const expanded = !collapsed.has(key);
    rows.push({ kind: "directory", depth: 0, label: SECTION_LABELS[section], key, expanded, section });
    if (expanded)
      emit(tree, 1, key, collapsed, rows);
  }
  return rows;
}

// src/ui/changes/files-pane.ts
var OVERLAY = 3;
function changeKey(change) {
  return `${change.section}\x00${change.path}`;
}
function rowKey(row, changes) {
  if (row.kind === "directory")
    return row.key;
  const change = changes[row.change];
  return change ? changeKey(change) : "";
}
function stagingOperation(row, changes) {
  if (row.kind === "directory") {
    if (row.section === "staged")
      return { kind: "unstage-all" };
    if (row.section === "unstaged" || row.section === "working")
      return { kind: "stage-all" };
    return null;
  }
  const change = changes[row.change];
  if (!change || change.section === "commit")
    return null;
  return change.section === "staged" ? { kind: "unstage", paths: [change.path] } : { kind: "stage", paths: [change.path] };
}
function discardPaths(row, changes) {
  if (row.kind === "directory") {
    if (row.section !== "unstaged")
      return null;
    const paths = changes.filter((change) => change.section === "unstaged" && change.status !== "??").map((change) => change.path);
    return paths.length ? paths : null;
  }
  const change = changes[row.change];
  if (change?.section !== "unstaged" || change.status === "??")
    return null;
  return [change.path];
}
function summarySpans(t, files, summary) {
  const spans = [{ text: ` ${files}f`, color: t.hint }];
  if (summary?.additions)
    spans.push({ text: ` +${summary.additions}`, color: t.success });
  if (summary?.deletions)
    spans.push({ text: ` -${summary.deletions}`, color: t.error });
  return spans;
}
function sliceSpans(spans, offset, width) {
  const output = [];
  let skipped = 0;
  let used = 0;
  for (const span of spans) {
    let text = "";
    for (const character of span.text) {
      const size = displayWidth(character);
      if (skipped < offset) {
        skipped += size;
        continue;
      }
      if (used + size > width)
        break;
      text += character;
      used += size;
    }
    if (text)
      output.push({ ...span, text });
  }
  return output;
}

class FilesPane {
  host;
  handle;
  rows = [];
  selected = 0;
  scroll = 0;
  horizontal = 0;
  collapsed = new Set;
  selection = new Set;
  anchor = null;
  keyboard = false;
  dragAnchor = null;
  dragging = false;
  pressed = false;
  hovered = null;
  height = 0;
  width = 0;
  wheelX = 0;
  wheelY = 0;
  constructor(host, handle) {
    this.host = host;
    this.handle = handle;
  }
  reset() {
    this.collapsed.clear();
    this.clearSelection();
    this.selected = 0;
    this.scroll = 0;
    this.horizontal = 0;
  }
  rebuild(selectedChange) {
    const changes = this.host.changes();
    this.rows = treeRows(changes, this.collapsed);
    const index = selectedChange === null ? -1 : this.rows.findIndex((row) => row.kind === "file" && row.change === selectedChange);
    this.selected = index >= 0 ? index : Math.min(this.selected, Math.max(0, this.rows.length - 1));
    const available = new Set(changes.map(changeKey));
    for (const key of this.selection)
      if (!available.has(key))
        this.selection.delete(key);
    if (this.anchor !== null && this.rows[this.anchor]?.kind !== "file") {
      this.anchor = null;
      this.keyboard = false;
      this.dragging = false;
    }
  }
  replaced() {
    this.collapsed.clear();
    this.clearSelection();
  }
  fileKey(index) {
    const row = this.rows[index];
    if (row?.kind !== "file")
      return null;
    const change = this.host.changes()[row.change];
    return change ? changeKey(change) : null;
  }
  view() {
    const keys = new Set(this.selection);
    if (this.anchor === null)
      return keys;
    for (let index = Math.min(this.anchor, this.selected);index <= Math.max(this.anchor, this.selected); index++) {
      const key = this.fileKey(index);
      if (key)
        keys.add(key);
    }
    return keys;
  }
  selecting() {
    return this.anchor !== null || this.keyboard || this.dragAnchor !== null || this.dragging;
  }
  begin(index, keyboard) {
    if (!this.fileKey(index)) {
      this.host.error("Focus a file before starting selection.");
      return;
    }
    this.host.focus();
    this.selected = index;
    this.anchor = index;
    this.keyboard = keyboard;
    this.dragging = !keyboard;
  }
  finish() {
    this.selection = this.view();
    this.anchor = null;
    this.keyboard = false;
    this.dragging = false;
    this.dragAnchor = null;
  }
  clearSelection() {
    this.selection.clear();
    this.anchor = null;
    this.keyboard = false;
    this.dragging = false;
    this.dragAnchor = null;
  }
  escape() {
    if (this.keyboard)
      this.finish();
    else if (this.selection.size > 0)
      this.clearSelection();
    else
      return false;
    return true;
  }
  choose(index, cx) {
    if (this.rows.length === 0)
      return;
    this.selected = Math.max(0, Math.min(index, this.rows.length - 1));
    const row = this.rows[this.selected];
    if (row?.kind === "file")
      this.host.select(row.change, cx);
  }
  toggleDirectory() {
    const row = this.rows[this.selected];
    if (row?.kind !== "directory")
      return;
    if (!this.collapsed.delete(row.key))
      this.collapsed.add(row.key);
    const selected = this.rows[this.selected];
    this.rows = treeRows(this.host.changes(), this.collapsed);
    if (selected)
      this.selected = Math.min(this.selected, Math.max(0, this.rows.length - 1));
  }
  activate(cx) {
    const row = this.rows[this.selected];
    if (row?.kind === "directory")
      this.toggleDirectory();
    else if (row)
      this.host.activate(row.change, cx);
  }
  stageSelection(stage, cx) {
    const section = stage ? "unstaged" : "staged";
    const keys = this.view();
    this.finish();
    const paths = [
      ...new Set(this.host.changes().filter((change) => keys.has(changeKey(change)) && (change.section === section || change.section === "working")).map((change) => change.path))
    ].sort();
    if (paths.length === 0) {
      this.host.error(stage ? "Select an Unstaged file to stage." : "Select a Staged file to unstage.");
      return;
    }
    this.run({ kind: stage ? "stage" : "unstage", paths }, cx);
  }
  stageFocused(stage, cx) {
    if (this.view().size > 0) {
      this.stageSelection(stage, cx);
      return;
    }
    const row = this.rows[this.selected];
    const operation = row ? stagingOperation(row, this.host.changes()) : null;
    if (!operation)
      return;
    const stages = operation.kind === "stage" || operation.kind === "stage-all";
    if (stages === stage)
      this.run(operation, cx);
  }
  run(operation, cx) {
    const row = this.rows[this.selected];
    this.host.stage(operation, row ? rowKey(row, this.host.changes()) : "", cx);
  }
  key(event, cx) {
    if (isChord(event))
      return false;
    const key = event.keystroke;
    const page = Math.max(1, this.height);
    const moves = { down: 1, j: 1, up: -1, k: -1, pagedown: page, pageup: -page };
    if (key === "enter")
      this.activate(cx);
    else if (key === "space")
      this.toggleDirectory();
    else if (key === "s" || key === "shift-s")
      this.stageFocused(true, cx);
    else if (key === "u" || key === "shift-u")
      this.stageFocused(false, cx);
    else if (key === "v" && !this.keyboard)
      this.begin(this.selected, true);
    else if (key === "home")
      this.choose(0, cx);
    else if (key === "end")
      this.choose(this.rows.length - 1, cx);
    else if (moves[key] !== undefined)
      this.choose(this.selected + (moves[key] ?? 0), cx);
    else
      return false;
    return true;
  }
  overlayHit(index, column) {
    const visible = index - this.scroll;
    if (this.width < OVERLAY || visible < 0 || visible >= this.height)
      return null;
    const start = this.width - OVERLAY;
    if (column >= start)
      return "stage";
    if (start >= OVERLAY && column >= start - OVERLAY)
      return "discard";
    return null;
  }
  rowAt(y) {
    if (y === undefined)
      return null;
    const index = this.scroll + Math.floor(y / this.rowHeight);
    return index < this.rows.length ? index : null;
  }
  rowHeight = 1;
  cellWidth = 1;
  mouseDown(event, left, cx) {
    cx.stop_propagation();
    this.pressed = left;
    const index = this.rowAt(event.local_position?.y) ?? 0;
    this.host.focus();
    this.host.clearDiffSelection();
    const column = Math.floor((event.local_position?.x ?? 0) / this.cellWidth);
    const row = this.rows[index];
    const changes = this.host.changes();
    const hit = left ? this.overlayHit(index, column) : null;
    const discard = hit === "discard" && row ? discardPaths(row, changes) : null;
    const operation = hit === "stage" && row ? stagingOperation(row, changes) : null;
    this.choose(index, cx);
    if (discard) {
      this.dragAnchor = null;
      this.host.discard(discard, cx);
    } else if (operation) {
      this.dragAnchor = null;
      this.run(operation, cx);
    } else if (left) {
      this.dragAnchor = this.fileKey(this.selected) ? this.selected : null;
      this.activate(cx);
    }
    cx.notify();
  }
  mouseMove(y, cx) {
    const index = this.rowAt(y);
    if (index !== this.hovered) {
      this.hovered = index;
      cx.notify();
    }
    if (!this.pressed || this.dragAnchor === null)
      return;
    const target = index ?? this.rows.length - 1;
    if (!this.dragging)
      this.begin(this.dragAnchor, false);
    if (this.dragging && target !== this.selected) {
      this.choose(target, cx);
      cx.notify();
    }
  }
  pointerUp(cx) {
    this.pressed = false;
    if (this.dragging) {
      this.finish();
      cx.notify();
    } else
      this.dragAnchor = null;
  }
  wheel(event, look, cx) {
    const lines = event.delta_lines;
    this.wheelX += lines ? lines.x * look.cell : event.delta.x;
    this.wheelY += lines ? lines.y * look.row : event.delta.y;
    const x = Math.trunc(this.wheelX / look.cell);
    const y = Math.trunc(this.wheelY / look.row);
    this.wheelX -= x * look.cell;
    this.wheelY -= y * look.row;
    if (x === 0 && y === 0)
      return;
    cx.stop_propagation();
    if (x !== 0)
      this.horizontal = Math.max(0, Math.min(this.horizontal - x, this.maxHorizontal()));
    if (y !== 0) {
      this.host.focus();
      this.choose(this.selected - y, cx);
    }
    cx.notify();
  }
  line(look, row) {
    const { t } = look;
    const indent = "  ".repeat(row.depth);
    if (row.kind === "directory") {
      const label = `${indent}${row.expanded ? GLYPH.expanded : GLYPH.collapsed} ${row.label}`;
      if (!row.section)
        return [{ text: label, color: t.text }];
      const section = row.section;
      const files = this.host.changes().filter((change) => change.section === section).length;
      return [{ text: label, color: t.accent, bold: true }, ...summarySpans(t, files, this.host.summaries()[section])];
    }
    const change = this.host.changes()[row.change];
    const status = change?.status ?? "";
    return [
      { text: indent, color: t.text },
      { text: status.slice(0, 1).padEnd(4), color: statusColor(t, status), bold: true },
      { text: ` ${row.label}`, color: t.text }
    ];
  }
  widest(look) {
    return this.rows.reduce((width, row) => Math.max(width, this.line(look, row).reduce((total, span) => total + displayWidth(span.text), 0)), 0);
  }
  maxHorizontal() {
    return Math.max(0, this.widestCache - Math.max(0, this.width - 2));
  }
  widestCache = 0;
  overlayCell(look, operation, discard) {
    const { t } = look;
    const stages = operation.kind === "stage" || operation.kind === "stage-all";
    const cells = [];
    if (discard)
      cells.push(div4().flex_none().w(cols(look, OVERLAY)).bg(t.warning).text_color(t.textInverse).rounded(2).font_weight(700).child(" ↶ "));
    cells.push(div4().flex_none().w(cols(look, OVERLAY)).bg(stages ? t.success : t.warning).text_color(t.textInverse).rounded(2).font_weight(700).child(stages ? " + " : " - "));
    return cells;
  }
  rowBackground(t, focusedRow, hovered, selectedRow) {
    if (focusedRow)
      return t.accentSoft;
    if (hovered)
      return t.hover;
    return selectedRow ? t.selection : null;
  }
  rowElement(look, index, selection, owner) {
    const { t } = look;
    const row = this.rows[index];
    if (!row)
      return div4();
    const changes = this.host.changes();
    const key = rowKey(row, changes);
    const focusedRow = index === this.selected;
    const selectedRow = row.kind === "file" && selection.has(key);
    const hovered = index === this.hovered;
    const background = this.rowBackground(t, focusedRow, hovered, selectedRow);
    const spans = sliceSpans(this.line(look, row), this.horizontal, Math.max(1, this.width - 2));
    const element = h_flex3().flex_none().h(look.row).min_w(0).overflow_hidden().whitespace_nowrap().border_l(2).border_color(focusedRow ? t.accent : "#00000000").when(!!background, (el) => el.bg(background ?? t.background)).when(focusedRow || selectedRow, (el) => el.font_weight(600)).child(div4().flex_none().w(cols(look, 2)).text_color(focusedRow ? t.accentText : t.hint).child(focusedRow ? GLYPH.marker : "")).child(h_flex3().flex_1().min_w(0).overflow_hidden().children(spans.map((span) => div4().flex_none().text_color(span.color).when(!!span.bold, (el) => el.font_weight(700)).child(span.text))));
    if (owner !== null && owner === key)
      return element.child(div4().flex_none().w(cols(look, OVERLAY)).bg(t.hover).flex().justify_center().child(spinner(look)));
    const operation = hovered ? stagingOperation(row, changes) : null;
    if (operation)
      element.children(this.overlayCell(look, operation, !!discardPaths(row, changes)));
    return element;
  }
  render(look, options) {
    const { t } = look;
    this.rowHeight = look.screenRow;
    this.cellWidth = look.screenCell;
    this.widestCache = this.widest(look);
    this.horizontal = Math.min(this.horizontal, this.maxHorizontal());
    this.scroll = viewportOffset(this.scroll, this.selected, this.rows.length, this.height);
    const selection = this.view();
    const counted = countedTitle("Files", this.host.changes().length);
    const text = selection.size ? `${counted} · Selected ${selection.size}` : counted;
    const title = options.hints ? h_flex3().items_center().gap(6).child(kbd(look, "O", true)).child(div4().text_size(Math.max(10, look.size - 2)).font_weight(600).child(`FIND FILES${text.slice("Files".length).toUpperCase()}`)) : text;
    const list = v_flex3().flex_1().min_w(0).min_h(0).overflow_hidden();
    const end = Math.min(this.rows.length, this.scroll + Math.max(1, this.height));
    for (let index = this.scroll;index < end; index++)
      list.child(this.rowElement(look, index, selection, options.owner));
    if (!options.repository)
      list.child(div4().text_color(t.warning).whitespace_normal().child("Not a Git repository"));
    const bar = scrollbar(look, {
      axis: "vertical",
      total: this.rows.length,
      visible: this.height,
      offset: this.scroll
    });
    const body = h_flex3().id("git-changes-tree").flex_1().min_h(0).min_w(0).items_stretch().track_focus(this.handle).on_size_change((size, cx) => {
      const height = Math.max(1, Math.floor(size.height / look.screenRow));
      const width = Math.floor(size.width / look.screenCell);
      if (height === this.height && width === this.width)
        return;
      this.height = height;
      this.width = width;
      cx.notify();
    }).on_scroll_wheel((event, cx) => this.wheel(event, look, cx)).on_mouse_down("left", (event, cx) => this.mouseDown(event, true, cx)).on_mouse_down("right", (event, cx) => this.mouseDown(event, false, cx)).on_mouse_up("left", (_, cx) => this.pointerUp(cx)).on_mouse_move((event, cx) => this.mouseMove(event.local_position.y, cx)).on_hover((hovered, cx) => {
      if (hovered || this.hovered === null)
        return;
      this.hovered = null;
      cx.notify();
    }).child(list).when(!!bar, (el) => el.child(bar ?? div4()));
    return box(look, { id: "git-changes-files", title, focused: options.focused }, body);
  }
}

// src/ui/changes/review.ts
import { h_flex as h_flex5, v_flex as v_flex5 } from "gpui-base";
import { div as div6 } from "gpui-kit";

// src/ui/commands/result.ts
import { Button as Button2, h_flex as h_flex4, v_flex as v_flex4 } from "gpui-base";
import { div as div5 } from "gpui-kit";
var VISIBLE_MS = 2000;
var CHROME = 6;
function color(look, tone) {
  const { t } = look;
  if (tone === "accent")
    return t.accent;
  if (tone === "success")
    return t.success;
  if (tone === "error")
    return t.error;
  if (tone === "warning")
    return t.warning;
  if (tone === "hint")
    return t.hint;
  return t.text;
}
function closeButton(look, overlay) {
  const { t } = look;
  return Button2.new("git-result-close").accessibility_label("Close").w_full().h(look.row + 10).child(h_flex4().size_full().justify_center().items_center().bg(t.accent).border(1).border_color(t.accent).rounded(2).text_color(t.textInverse).font_weight(600).hover((style) => style.bg(t.accentStrong).border_color(t.accentStrong)).child("[Enter] Close")).on_click((_, cx) => {
    cx.stop_propagation();
    overlay.close(cx);
    cx.notify();
  });
}
function showResultLines(overlay, title, success, content, cx) {
  const height = Math.max(9, Math.min(20, content.length + CHROME));
  const spec = {
    kind: "custom",
    title: { text: title, tone: success ? "success" : "error" },
    width: DIALOG.card,
    height: height - 2,
    render: (look) => v_flex4().size_full().min_h(0).child(v_flex4().flex_1().min_h(0).overflow_hidden().children(content.map((line) => div5().flex_none().min_h(look.row).whitespace_normal().text_color(color(look, line.tone ?? (success ? "text" : "error"))).when(!!line.bold, (el) => el.font_weight(700)).child(line.text)))).child(div5().flex_none().h(look.row)).child(closeButton(look, overlay)),
    key: (event, cx) => {
      if (event.keystroke === "escape")
        return true;
      if (event.keystroke !== "enter")
        return false;
      overlay.close(cx);
      return true;
    }
  };
  overlay.open(spec);
  if (success && cx)
    cx.timer.after(VISIBLE_MS, (cx) => {
      if (overlay.current() !== spec)
        return;
      overlay.close(cx);
      cx.notify();
    });
}
function showResult(overlay, name, success, message, preview, cx) {
  const body = message.split(`
`).map((text) => ({ text, tone: success ? "text" : "error" }));
  const content = preview ? [{ text: preview, tone: "accent", bold: true }, { text: "" }, ...body] : body;
  showResultLines(overlay, `${name} ${success ? "complete" : "failed"}`, success, content, cx);
}

// src/ui/changes/review.ts
var OPTIONS = ["Code", "Line"];
function lineNumbersText(lines) {
  const ranges = [];
  let start = null;
  let end = 0;
  for (const line of lines) {
    if (start !== null && line === end + 1) {
      end = line;
      continue;
    }
    if (start !== null)
      ranges.push(start === end ? String(start) : `${start}–${end}`);
    start = line;
    end = line;
  }
  if (start !== null)
    ranges.push(start === end ? String(start) : `${start}–${end}`);
  return ranges.join(", ");
}
function copyText(code, line, request) {
  const side = request.side ? `
Side: ${request.side}` : "";
  const context = `File: ${request.path}${side}
Lines: ${lineNumbersText(request.lines)}`;
  if (code && line)
    return `${context}

${request.code.join(`
`)}`;
  return code ? request.code.join(`
`) : context;
}

class CopyDialog {
  services;
  request;
  onCopied;
  focused = 0;
  checked = [true, true];
  constructor(services, request, onCopied) {
    this.services = services;
    this.request = request;
    this.onCopied = onCopied;
  }
  toggle(index) {
    this.focused = index;
    this.checked[index] = !this.checked[index];
  }
  copy(cx) {
    const [code = false, line = false] = this.checked;
    if (!code && !line) {
      this.services.reportError("Check Code or Line to copy.");
      return;
    }
    if (this.request.lines.length === 0) {
      this.services.reportError("Select at least one code line.");
      return;
    }
    cx.write_to_clipboard(copyText(code, line, this.request));
    this.services.overlay.close(cx);
    this.onCopied?.(cx);
    showResult(this.services.overlay, "Copy Selection", true, "Selection copied to the clipboard.", undefined, cx);
  }
  key(event, cx) {
    const key = event.keystroke;
    if (key === "up" || key === "k")
      this.focused = 0;
    else if (key === "down" || key === "j")
      this.focused = 1;
    else if (key === "tab" || key === "shift-tab")
      this.focused = 1 - this.focused;
    else if (key === "space")
      this.toggle(this.focused);
    else if (key === "1" || key === "2")
      this.toggle(Number(key) - 1);
    else if (key === "enter" || key === "y")
      this.copy(cx);
    else
      return false;
    cx.notify();
    return true;
  }
  render(look) {
    const { t } = look;
    const { path, side, lines } = this.request;
    const body = v_flex5().min_w(0).px(look.cell).child(div6().h(look.row * 2).whitespace_normal().text_color(t.hint).child(`${path} · ${side ?? "After"} lines ${lineNumbersText(lines)}`));
    for (const [index, label] of OPTIONS.entries())
      body.child(h_flex5().id(`git-copy-option-${index}`).h(look.row).when(index === this.focused, (el) => el.bg(t.selection).font_weight(700)).text_color(index === this.focused ? t.text : t.hint).child(`  [${this.checked[index] ? "x" : " "}] ${label}`).on_click((_, cx) => {
        cx.stop_propagation();
        this.toggle(index);
        cx.notify();
      }));
    return body.child(footerHint(look, "Space toggle · y copy · Esc close"));
  }
}
function openCopySelection(services, request, onCopied) {
  const dialog = new CopyDialog(services, request, onCopied);
  services.overlay.open({
    kind: "custom",
    title: "Copy Selection",
    width: 52,
    render: (look) => dialog.render(look),
    key: (event, cx) => dialog.key(event, cx)
  });
}
function sameTarget(left, right) {
  if (!left || !right)
    return left === right;
  return left.file === right.file && left.revision === right.revision && left.lines.join(",") === right.lines.join(",");
}
function entryText(entry) {
  if (/^0+$/.test(entry.sha))
    return "Uncommitted";
  return `${entry.sha.slice(0, 7)} · ${entry.author} · ${entry.summary}`;
}

class SelectionBlame {
  target = null;
  reading = false;
  entries = [];
  request = 0;
  sync(services, target, cx) {
    if (sameTarget(this.target, target))
      return;
    this.reset();
    this.target = target;
    const git = services.git();
    const first = target?.lines[0];
    const last = target?.lines[target.lines.length - 1];
    if (!target || !git || first === undefined || last === undefined)
      return;
    const request = this.request;
    const context = services.context();
    this.reading = true;
    cx.spawn(async (cx) => {
      try {
        const entries = await readBlameRange(git, target.file, first, last, target.revision);
        if (request !== this.request || context !== services.context())
          return;
        const wanted = new Set(target.lines);
        this.entries = entries.filter((entry) => wanted.has(entry.line));
      } catch {
        if (request !== this.request)
          return;
        this.entries = [];
      } finally {
        if (request === this.request) {
          this.reading = false;
          cx.notify();
        }
      }
    });
  }
  reset() {
    this.request++;
    this.target = null;
    this.reading = false;
    this.entries = [];
  }
  status() {
    if (!this.target)
      return null;
    if (this.reading)
      return "Blame…";
    const last = this.entries.reduce((best, entry) => best && best.line >= entry.line ? best : entry, null);
    if (!last)
      return null;
    const others = new Set(this.entries.map((entry) => entry.author).filter((author) => author !== last.author)).size;
    const suffix = others === 0 ? "" : others === 1 ? " +1 author" : ` +${others} authors`;
    return `Blame ${entryText(last)}${suffix}`;
  }
}

// src/ui/code-view.ts
import { h_flex as h_flex6, v_flex as v_flex6 } from "gpui-base";
import { div as div7 } from "gpui-kit";

// src/ui/syntax.ts
var KEYWORDS = new Set("abstract as async await break case catch class const continue def default defer delete do else enum export extends false finally fn for from func function if impl import in interface let match mod mut namespace new nil null package private protected pub public raise return self static struct super switch this throw trait true try type typeof undefined use var void while with yield".split(" "));

class CodeHighlighter {
  language;
  block = false;
  constructor(language) {
    this.language = language;
  }
  line(source) {
    if (this.language === "text")
      return [{ text: source, kind: "plain" }];
    const tokens = [];
    let offset = 0;
    while (offset < source.length) {
      if (this.block) {
        const end = source.indexOf("*/", offset);
        const next = end < 0 ? source.length : end + 2;
        tokens.push({ text: source.slice(offset, next), kind: "comment" });
        this.block = end < 0;
        offset = next;
        continue;
      }
      const rest = source.slice(offset);
      const token = this.next(rest);
      tokens.push(token);
      offset += token.text.length;
    }
    return tokens;
  }
  next(rest) {
    if (rest.startsWith("/*")) {
      this.block = true;
      return { text: "/*", kind: "comment" };
    }
    if (rest.startsWith("//") || rest.startsWith("#") && ["python", "bash", "yaml", "toml"].includes(this.language))
      return { text: rest, kind: "comment" };
    const string = /^(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)/.exec(rest);
    if (string)
      return { text: string[0], kind: "string" };
    const number = /^(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?)/.exec(rest);
    if (number)
      return { text: number[0], kind: "number" };
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word)
      return { text: word[0], kind: this.wordKind(word[0], rest.slice(word[0].length)) };
    const plain = /^\s+/.exec(rest)?.[0] ?? rest.slice(0, 1);
    return { text: plain, kind: "plain" };
  }
  wordKind(word, after) {
    if (KEYWORDS.has(word))
      return "keyword";
    if (/^\s*\(/.test(after))
      return "function";
    return /^[A-Z]/.test(word) ? "type" : "plain";
  }
}
var LANGUAGES = {
  ts: ["typescript", "TypeScript"],
  mts: ["typescript", "TypeScript"],
  cts: ["typescript", "TypeScript"],
  tsx: ["typescript", "TypeScriptReact"],
  js: ["javascript", "JavaScript"],
  mjs: ["javascript", "JavaScript"],
  cjs: ["javascript", "JavaScript"],
  jsx: ["javascript", "JavaScript (Babel)"],
  rs: ["rust", "Rust"],
  py: ["python", "Python"],
  go: ["go", "Go"],
  json: ["json", "JSON"],
  md: ["markdown", "Markdown"],
  css: ["css", "CSS"],
  scss: ["css", "SCSS"],
  html: ["html", "HTML"],
  sh: ["bash", "Bourne Again Shell (bash)"],
  bash: ["bash", "Bourne Again Shell (bash)"],
  zsh: ["bash", "Bourne Again Shell (bash)"],
  toml: ["toml", "TOML"],
  yaml: ["yaml", "YAML"],
  yml: ["yaml", "YAML"],
  c: ["c", "C"],
  h: ["c", "C"],
  cpp: ["cpp", "C++"],
  cc: ["cpp", "C++"],
  hpp: ["cpp", "C++"],
  java: ["java", "Java"],
  kt: ["kotlin", "Kotlin"],
  swift: ["swift", "Swift"],
  sql: ["sql", "SQL"],
  rb: ["ruby", "Ruby"],
  php: ["php", "PHP"],
  cs: ["csharp", "C#"],
  lua: ["lua", "Lua"],
  xml: ["xml", "XML"]
};
var PLAIN = ["text", "Plain text"];
function language(path) {
  const name = path.split("/").pop() ?? path;
  if (name === "Dockerfile")
    return ["bash", "Dockerfile"];
  if (name === "Makefile")
    return ["bash", "Makefile"];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? PLAIN : PLAIN;
}
function languageName(path) {
  return language(path)[1];
}
function highlighter(path) {
  return new CodeHighlighter(language(path)[0]);
}
function tokenColor(look, kind) {
  const { t } = look;
  const colors = {
    plain: t.text,
    keyword: t.info,
    string: t.success,
    comment: t.hint,
    number: t.ice,
    function: t.accentText,
    type: t.warning
  };
  return colors[kind];
}

// src/ui/changes/document.ts
var GUTTER = 5;
var TAB = 8;
function foldId(key) {
  return `${key.kind}:${key.oldStart}:${key.oldEnd}:${key.newStart}:${key.newEnd}`;
}
function expandTabs(tokens) {
  let column = 0;
  return tokens.map((token) => {
    let text = "";
    for (const character of token.text) {
      if (character === "\t") {
        const spaces = TAB - column % TAB;
        text += " ".repeat(spaces);
        column += spaces;
      } else {
        text += character;
        column += 1;
      }
    }
    return { text, kind: token.kind };
  });
}
function codeCell(number, source, tokens, tone, gutter = true) {
  return { number, source, gutter, tokens: expandTabs(tokens), tone, meta: "hint" };
}
function metaTone(line) {
  if (line.startsWith("@@"))
    return "hunk";
  if (line.startsWith("---") || line.startsWith("+++"))
    return "file";
  return "hint";
}
function textCell(text, tone = "meta") {
  return {
    number: null,
    source: null,
    gutter: false,
    tokens: expandTabs([{ text, kind: "plain" }]),
    tone,
    meta: metaTone(text)
  };
}
var BLANK = {
  number: null,
  source: null,
  gutter: false,
  tokens: [{ text: " ", kind: "plain" }],
  tone: "blank",
  meta: "hint"
};
function hunkStarts(line) {
  if (!line.startsWith("@@"))
    return null;
  const parts = line.split(/\s+/);
  const old = Number.parseInt((parts[1] ?? "").replace(/^-/, "").split(",")[0] ?? "", 10);
  const next = Number.parseInt((parts[2] ?? "").replace(/^\+/, "").split(",")[0] ?? "", 10);
  return Number.isNaN(old) || Number.isNaN(next) ? null : [old, next];
}
function foldLabel(kind, count, expanded) {
  return `  ⋯ ${count} ${kind === "context" ? "unchanged" : "changed"} lines · ${expanded ? "collapse" : "expand"}`;
}
function contextRun(lines, start, position, toggles, output) {
  let end = start;
  while (end < lines.length && (lines[end] ?? "").startsWith(" "))
    end++;
  const count = end - start;
  const run = lines.slice(start, end).map((text) => ({ kind: "line", text }));
  if (count <= 8) {
    output.push(...run);
    return end;
  }
  const [oldLine, newLine] = position;
  const key = {
    kind: "context",
    oldStart: oldLine + 3,
    oldEnd: oldLine + count - 3,
    newStart: newLine + 3,
    newEnd: newLine + count - 3
  };
  const expanded = toggles.has(foldId(key));
  output.push(...run.slice(0, 3), { kind: "fold", key, expanded });
  if (expanded)
    output.push(...run.slice(3, count - 3));
  output.push(...run.slice(count - 3));
  return end;
}
function collapseContext(lines, toggles) {
  const output = [];
  let oldLine = 0;
  let newLine = 0;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const hunk = hunkStarts(line);
    if (line.startsWith(" ") && !hunk) {
      const end = contextRun(lines, index, [oldLine, newLine], toggles, output);
      oldLine += end - index;
      newLine += end - index;
      index = end;
      continue;
    }
    if (hunk)
      [oldLine, newLine] = hunk;
    else if (line.startsWith("-") && !line.startsWith("---"))
      oldLine++;
    else if (line.startsWith("+") && !line.startsWith("+++"))
      newLine++;
    output.push({ kind: "line", text: line });
    index++;
  }
  return output;
}

class Builder {
  toggles;
  rows = [];
  oldLine = 0;
  newLine = 0;
  removed = [];
  added = [];
  before;
  after;
  constructor(path, toggles) {
    this.toggles = toggles;
    this.before = highlighter(path);
    this.after = highlighter(path);
  }
  shared(text, fold = null) {
    this.rows.push({
      before: textCell(text, fold ? "fold" : "meta"),
      after: textCell(text, fold ? "fold" : "meta"),
      fold
    });
  }
  flush() {
    const count = Math.max(this.removed.length, this.added.length);
    if (count === 0)
      return;
    const key = {
      kind: "change",
      oldStart: this.oldLine,
      oldEnd: this.oldLine + this.removed.length,
      newStart: this.newLine,
      newEnd: this.newLine + this.added.length
    };
    const expanded = !this.toggles.has(foldId(key));
    this.shared(foldLabel("change", count, expanded), key);
    if (expanded)
      for (let row = 0;row < count; row++) {
        const removed = this.removed[row];
        const added = this.added[row];
        this.rows.push({
          before: removed === undefined ? BLANK : codeCell(this.oldLine++, removed, this.before.line(removed), "removed"),
          after: added === undefined ? BLANK : codeCell(this.newLine++, added, this.after.line(added), "added"),
          fold: null
        });
      }
    this.oldLine = key.oldEnd;
    this.newLine = key.newEnd;
    this.removed = [];
    this.added = [];
  }
  line(line) {
    if (line.kind === "fold") {
      this.flush();
      const { key, expanded } = line;
      this.shared(foldLabel("context", key.oldEnd - key.oldStart, expanded), key);
      if (!expanded) {
        this.oldLine = key.oldEnd;
        this.newLine = key.newEnd;
      }
      return;
    }
    const text = line.text;
    if (text.startsWith("-") && !text.startsWith("---"))
      this.removed.push(text.slice(1));
    else if (text.startsWith("+") && !text.startsWith("+++"))
      this.added.push(text.slice(1));
    else
      this.other(text);
  }
  other(text) {
    this.flush();
    const hunk = hunkStarts(text);
    if (hunk)
      [this.oldLine, this.newLine] = hunk;
    if (hunk || !text.startsWith(" ")) {
      this.shared(text);
      return;
    }
    const code = text.slice(1);
    this.rows.push({
      before: codeCell(this.oldLine++, code, this.before.line(code), "plain"),
      after: codeCell(this.newLine++, code, this.after.line(code), "plain"),
      fold: null
    });
  }
}
function buildDiff(patch, path, toggles) {
  const lines = patch.replace(/\n$/, "").split(`
`);
  const builder = new Builder(path, toggles);
  for (const line of collapseContext(lines, toggles))
    builder.line(line);
  builder.flush();
  return builder.rows;
}

// src/ui/code-view.ts
var HINT_KEYS = [
  ["y", "Yank"],
  ["h", "History"],
  ["Esc", "Cancel"]
];
function highlight(text, path) {
  return highlighter(path).line(text);
}
function sourceLines(text, path) {
  const code = highlighter(path);
  const lines = text ? text.replace(/\n$/, "").split(`
`) : [];
  return lines.map((line, index) => ({ number: index + 1, text: line, tokens: code.line(line), tone: "plain" }));
}
function cellWidth(cell) {
  return (cell.gutter ? GUTTER : 0) + cell.tokens.reduce((width, token) => width + displayWidth(token.text), 0);
}
function toneBackground(look, tone) {
  const { t } = look;
  if (tone === "added")
    return t.diffAdded;
  if (tone === "removed")
    return t.diffRemoved;
  if (tone === "blank")
    return t.inert;
  if (tone === "fold")
    return t.header;
  return null;
}
function gutterSegment(look, cell, emphasized) {
  const { t } = look;
  const code = cell.number !== null;
  const text = cell.number === null ? " ".repeat(GUTTER) : `${String(cell.number).padStart(GUTTER - 1)} `;
  const strong = code && !!emphasized;
  return { text, fg: strong ? t.text : t.hint, bg: strong ? emphasized : null, bold: strong };
}
function tokenForeground(look, cell, token) {
  const { t } = look;
  if (cell.tone === "fold")
    return t.accent;
  if (cell.tone !== "meta")
    return tokenColor(look, token.kind);
  if (cell.meta === "hunk")
    return t.warning;
  return cell.meta === "file" ? t.accent : t.hint;
}
function cellSegments(look, cell, emphasis) {
  const { t } = look;
  const emphasized = emphasis === "focus" ? t.focus : emphasis === "selection" ? t.selection : null;
  const code = cell.number !== null;
  const bold = !code && !!emphasized;
  const segments = cell.gutter ? [gutterSegment(look, cell, emphasized)] : [];
  for (const token of cell.tokens)
    segments.push({ text: token.text, fg: tokenForeground(look, cell, token), bg: null, bold });
  return { segments, background: !code && emphasized ? emphasized : toneBackground(look, cell.tone) };
}
function splitAt(segments, column) {
  const output = [];
  let used = 0;
  for (const segment of segments) {
    const width = displayWidth(segment.text);
    if (used >= column || used + width <= column) {
      output.push(segment);
      used += width;
      continue;
    }
    let head = "";
    let headWidth = 0;
    for (const character of segment.text) {
      if (used + headWidth >= column)
        break;
      head += character;
      headWidth += displayWidth(character);
    }
    output.push({ ...segment, text: head }, { ...segment, text: segment.text.slice(head.length) });
    used += width;
  }
  return output;
}
function paint(segments, from, to, fg, bg) {
  let used = 0;
  return splitAt(splitAt(segments, from), to).map((segment) => {
    const start = used;
    used += displayWidth(segment.text);
    return start >= from && start < to ? { ...segment, fg, bg } : segment;
  });
}
function sliceSegments(segments, offset, width) {
  const output = [];
  let skipped = 0;
  let rendered = 0;
  for (const segment of segments) {
    let text = "";
    for (const character of segment.text) {
      const size = displayWidth(character);
      if (skipped < offset) {
        skipped += size;
        continue;
      }
      if (rendered + size > width)
        break;
      text += character;
      rendered += size;
    }
    if (text)
      output.push({ ...segment, text });
    if (rendered >= width)
      break;
  }
  return output;
}
function matchColumns(cell, match) {
  const source = cell.source ?? "";
  const gutter = cell.gutter ? GUTTER : 0;
  const width = (end) => expandTabs([{ text: source.slice(0, end), kind: "plain" }]).reduce((total, token) => total + displayWidth(token.text), 0);
  return [gutter + width(match.start), gutter + width(match.end)];
}
function rowElement(look, segments, background) {
  const row = h_flex6().flex_none().h(look.row).w_full().overflow_hidden().whitespace_nowrap().when(!!background, (el) => el.bg(background ?? look.t.background));
  for (const segment of segments)
    row.child(div7().flex_none().text_color(segment.fg).when(!!segment.bg, (el) => el.bg(segment.bg ?? look.t.background)).when(segment.bold, (el) => el.font_weight(700)).child(segment.text));
  return row;
}
function rowAt(look, spec, y) {
  if (y === undefined)
    return null;
  const row = spec.scroll + Math.floor(y / look.screenRow);
  return row >= 0 && row < spec.length ? row : null;
}
function selectionHint(look, id, spec) {
  const hint = spec.hint;
  if (!hint)
    return null;
  const visibleFirst = Math.max(hint.first, spec.scroll);
  const visibleLast = Math.min(hint.last, spec.scroll + spec.measure.rows - 1);
  if (visibleFirst > visibleLast)
    return null;
  const below = visibleLast - spec.scroll + 1;
  const top = below + 2 <= spec.measure.rows ? below : Math.max(0, visibleFirst - spec.scroll - 2);
  const { t } = look;
  const keys = h_flex6().id(`${id}-hint`).absolute().top(rows(look, top)).left(cols(look, 6)).h(look.row + 10).px(8).gap(8).items_center().bg(t.panel).border(1).border_color(t.lineStrong).rounded(2).shadow_md().whitespace_nowrap();
  for (const [key, label] of HINT_KEYS)
    keys.child(h_flex6().items_center().gap(4).child(kbd(look, key, true)).child(div7().text_color(t.secondary).child(label)));
  return keys;
}
function scrollTrack(look, id, bar, vertical, onPosition) {
  let dragging = false;
  const position = (event) => {
    const local = event.local_position;
    const bounds = event.bounds;
    if (!local || !bounds)
      return null;
    const size = vertical ? bounds.height - look.screenRow : bounds.width - look.screenCell;
    return size <= 0 ? 0 : Math.max(0, Math.min(1, (vertical ? local.y : local.x) / size));
  };
  return div7().id(id).flex_none().when(vertical, (el) => el.h_full()).when(!vertical, (el) => el.w_full()).child(bar).on_mouse_down("left", (event, cx) => {
    cx.stop_propagation();
    dragging = true;
    const fraction = position(event);
    if (fraction !== null)
      onPosition(fraction, cx);
  }).on_mouse_up("left", () => {
    dragging = false;
  }).on_mouse_move((event, cx) => {
    if (!dragging)
      return;
    const fraction = position(event);
    if (fraction !== null)
      onPosition(fraction, cx);
  }).on_hover((hovered) => {
    if (!hovered)
      dragging = false;
  });
}
function renderColumn(look, spec) {
  const { measure, paint: options } = spec;
  const width = measure.cols > 0 ? measure.cols : 400;
  const list = v_flex6().flex_1().min_w(0).min_h(0).overflow_hidden();
  const end = Math.min(spec.length, spec.scroll + Math.max(1, measure.rows));
  for (let row = spec.scroll;row < end; row++) {
    const cell = spec.cells(row);
    if (!cell)
      continue;
    const emphasis = options.selected(row) ? "selection" : row === options.focusRow ? "focus" : null;
    let { segments, background } = cellSegments(look, cell, emphasis);
    if (options.match?.row === row) {
      const [from, to] = matchColumns(cell, options.match);
      segments = paint(segments, from, to, look.t.textInverse, look.t.warning);
    }
    list.child(rowElement(look, sliceSegments(segments, spec.horizontal, width), background));
  }
  const area = v_flex6().id(`${spec.id}-rows`).relative().flex_1().min_w(0).min_h(0).overflow_hidden().on_size_change((size, cx) => spec.onSize({ rows: Math.max(1, Math.floor(size.height / look.screenRow)), cols: Math.floor(size.width / look.screenCell) }, cx)).on_scroll_wheel((event, cx) => spec.onWheel(event, cx)).on_mouse_down("left", (event, cx) => spec.onDown(rowAt(look, spec, event.local_position?.y), event, cx)).on_mouse_up("left", (_, cx) => spec.onUp(cx)).on_mouse_move((event, cx) => spec.onMove(rowAt(look, spec, event.local_position.y), cx)).child(list);
  const hint = selectionHint(look, spec.id, spec);
  if (hint)
    area.child(hint);
  const vertical = scrollbar(look, {
    axis: "vertical",
    total: spec.length,
    visible: measure.rows,
    offset: spec.scroll
  });
  const horizontal = scrollbar(look, {
    axis: "horizontal",
    total: spec.maxWidth,
    visible: measure.cols,
    offset: spec.horizontal
  });
  const top = h_flex6().flex_1().min_h(0).min_w(0).items_stretch().child(area).when(!!vertical, (el) => el.child(scrollTrack(look, `${spec.id}-vbar`, vertical ?? div7(), true, spec.onVertical)));
  return v_flex6().id(spec.id).flex_1().min_h(0).min_w(0).child(top).when(!!horizontal, (el) => el.child(scrollTrack(look, `${spec.id}-hbar`, horizontal ?? div7(), false, spec.onHorizontal)));
}

class Wheel {
  x = 0;
  y = 0;
  steps(event, look) {
    const lines = event.delta_lines;
    const dx = lines ? lines.x * look.cell : event.delta.x;
    const dy = lines ? lines.y * look.row : event.delta.y;
    if (event.modifiers.shift && Math.abs(dx) < Math.abs(dy))
      this.x += dy;
    else {
      this.x += dx;
      this.y += dy;
    }
    const x = Math.trunc(this.x / look.cell);
    const y = Math.trunc(this.y / look.row);
    this.x -= x * look.cell;
    this.y -= y * look.row;
    return { x: -x, y: -y };
  }
}

class Selection {
  rows = new Set;
  anchor = null;
  keyboard = false;
  dragging = false;
  clear() {
    this.rows.clear();
    this.anchor = null;
    this.keyboard = false;
    this.dragging = false;
  }
  active() {
    return this.anchor !== null || this.rows.size > 0;
  }
  effective(cursor, selectable) {
    const result = new Set(this.rows);
    if (this.anchor !== null) {
      for (let row = Math.min(this.anchor, cursor);row <= Math.max(this.anchor, cursor); row++)
        if (selectable(row))
          result.add(row);
    }
    return [...result].sort((left, right) => left - right);
  }
  finish(cursor, selectable) {
    this.rows = new Set(this.effective(cursor, selectable));
    this.anchor = null;
    this.keyboard = false;
    this.dragging = false;
  }
}
function moveKey(key, page) {
  const steps = { up: -1, k: -1, down: 1, j: 1, pageup: -page, pagedown: page };
  if (key === "home")
    return "home";
  if (key === "end")
    return "end";
  return steps[key] ?? null;
}
function clamp(value, length) {
  return Math.max(0, Math.min(value, Math.max(0, length - 1)));
}

class CodeView {
  id;
  cursor = 0;
  items = [];
  cells = [];
  widest = 0;
  scroll = 0;
  horizontal = 0;
  measure = { rows: 0, cols: 0 };
  selectionState = new Selection;
  wheel = new Wheel;
  constructor(id) {
    this.id = id;
  }
  set(lines, _language) {
    const same = lines === this.items || lines.length === this.items.length && lines.every((line, index) => line.text === this.items[index]?.text && line.number === this.items[index]?.number);
    this.items = lines;
    this.cells = lines.map((line) => line.tone === "fold" ? textCell(line.text, "fold") : codeCell(line.number, line.number === null ? null : line.text, line.tokens, line.tone));
    this.widest = this.cells.reduce((width, cell) => Math.max(width, cellWidth(cell)), 0);
    if (same) {
      this.cursor = clamp(this.cursor, lines.length);
      return;
    }
    this.cursor = 0;
    this.scroll = 0;
    this.horizontal = 0;
    this.selectionState.clear();
  }
  lines() {
    return this.items;
  }
  selection() {
    const rows = this.selectionState.effective(this.cursor, (row) => this.selectable(row));
    const first = rows[0];
    const last = rows[rows.length - 1];
    return first === undefined || last === undefined ? null : { start: first, end: last };
  }
  clearSelection() {
    this.selectionState.clear();
  }
  reveal(row) {
    this.cursor = clamp(row, this.cells.length);
    this.follow();
  }
  release() {
    this.selectionState.clear();
  }
  selectable(row) {
    return this.cells[row]?.number !== null && this.cells[row] !== undefined;
  }
  follow() {
    const height = Math.max(1, this.measure.rows);
    if (this.cursor < this.scroll)
      this.scroll = this.cursor;
    else if (this.cursor >= this.scroll + height)
      this.scroll = this.cursor - height + 1;
  }
  scrollBy(rows) {
    this.scroll = Math.max(0, Math.min(this.scroll + rows, Math.max(0, this.cells.length - this.measure.rows)));
  }
  scrollHorizontal(columns) {
    this.horizontal = Math.max(0, Math.min(this.horizontal + columns, Math.max(0, this.widest - this.measure.cols)));
  }
  toggleKeyboardSelection() {
    if (this.selectionState.keyboard)
      this.selectionState.finish(this.cursor, (row) => this.selectable(row));
    else if (this.selectable(this.cursor)) {
      this.selectionState.clear();
      this.selectionState.anchor = this.cursor;
      this.selectionState.keyboard = true;
    }
  }
  command(key) {
    if (key === "left" || key === "right")
      this.scrollHorizontal(key === "left" ? -1 : 1);
    else if (key === "v")
      this.toggleKeyboardSelection();
    else if (key === "escape" && this.selectionState.active())
      this.selectionState.clear();
    else {
      const step = moveKey(key, Math.max(1, this.measure.rows));
      if (step === null)
        return false;
      this.reveal(step === "home" ? 0 : step === "end" ? this.cells.length - 1 : this.cursor + step);
    }
    return true;
  }
  key(event, cx) {
    if (isChord(event) || !this.command(event.keystroke))
      return false;
    cx.stop_propagation();
    cx.notify();
    return true;
  }
  render(look, options) {
    this.scroll = Math.min(this.scroll, Math.max(0, this.cells.length - 1));
    const selected = new Set(this.selectionState.effective(this.cursor, (row) => this.selectable(row)));
    const first = Math.min(...selected);
    const last = Math.max(...selected);
    return renderColumn(look, {
      id: this.id,
      cells: (row) => this.cells[row] ?? null,
      length: this.cells.length,
      maxWidth: this.widest,
      scroll: this.scroll,
      horizontal: this.horizontal,
      measure: this.measure,
      paint: {
        focusRow: options.focused ? this.cursor : -1,
        selected: (row) => selected.has(row),
        match: options.match
      },
      hint: options.hint && selected.size > 0 && !this.selectionState.dragging ? { first, last } : null,
      onSize: (measure, cx) => {
        if (measure.rows === this.measure.rows && measure.cols === this.measure.cols)
          return;
        this.measure = measure;
        cx.notify();
      },
      onWheel: (event, cx) => {
        const steps = this.wheel.steps(event, look);
        if (steps.x === 0 && steps.y === 0)
          return;
        cx.stop_propagation();
        this.scrollBy(steps.y);
        this.scrollHorizontal(steps.x);
        cx.notify();
      },
      onDown: (row, _, cx) => {
        if (row === null)
          return;
        this.cursor = row;
        options.onCursor?.(row, cx);
        if (this.selectionState.keyboard)
          this.selectionState.finish(this.cursor, (index) => this.selectable(index));
        else if (this.selectable(row)) {
          this.selectionState.clear();
          this.selectionState.anchor = row;
          this.selectionState.dragging = true;
        }
        cx.notify();
      },
      onMove: (row, cx) => {
        if (row === null || !this.selectionState.dragging || row === this.cursor)
          return;
        this.cursor = row;
        options.onCursor?.(row, cx);
        cx.notify();
      },
      onUp: (cx) => {
        if (!this.selectionState.dragging)
          return;
        this.selectionState.finish(this.cursor, (row) => this.selectable(row));
        cx.notify();
      },
      onVertical: (fraction, cx) => {
        this.scroll = Math.round(fraction * Math.max(0, this.cells.length - this.measure.rows));
        cx.notify();
      },
      onHorizontal: (fraction, cx) => {
        this.horizontal = Math.round(fraction * Math.max(0, this.widest - this.measure.cols));
        cx.notify();
      }
    });
  }
}
function sideCell(row, side) {
  if (!row)
    return null;
  return side === "Before" ? row.before : row.after;
}

class SplitDiff {
  id;
  side = "After";
  cursor = 0;
  patch = "";
  path = "";
  rows = [];
  toggles = new Set;
  widths = { Before: 0, After: 0 };
  scroll = 0;
  horizontal = 0;
  measures = { Before: { rows: 0, cols: 0 }, After: { rows: 0, cols: 0 } };
  selectionState = new Selection;
  selectionSide = "After";
  wheel = new Wheel;
  constructor(id) {
    this.id = id;
  }
  set(patch, path) {
    if (patch === this.patch && path === this.path && this.rows.length > 0)
      return;
    const sameFile = path === this.path && this.rows.length > 0;
    const saved = sameFile ? this.selectedLines() : null;
    this.patch = patch;
    this.path = path;
    if (!sameFile) {
      this.toggles.clear();
      this.scroll = 0;
      this.horizontal = 0;
      this.cursor = 0;
      this.side = "After";
      this.selectionState.clear();
    }
    this.rebuild();
    this.restore(saved);
  }
  plain(text) {
    this.patch = "";
    this.path = "";
    this.toggles.clear();
    this.rows = text.split(`
`).map((line) => ({ before: textCell(line), after: textCell(line), fold: null }));
    this.widths = { Before: 0, After: 0 };
    this.scroll = 0;
    this.horizontal = 0;
    this.cursor = 0;
    this.selectionState.clear();
  }
  clear() {
    this.plain("");
    this.rows = [];
  }
  detach() {
    this.patch = "";
    this.path = "";
  }
  language() {
    return this.path ? languageName(this.path) : "Plain text";
  }
  length() {
    return this.rows.length;
  }
  release() {
    this.selectionState.clear();
  }
  rebuild() {
    this.rows = buildDiff(this.patch, this.path, this.toggles);
    this.widths = {
      Before: this.rows.reduce((width, row) => Math.max(width, cellWidth(row.before)), 0),
      After: this.rows.reduce((width, row) => Math.max(width, cellWidth(row.after)), 0)
    };
    this.cursor = clamp(this.cursor, this.rows.length);
    this.scroll = Math.min(this.scroll, this.maxScroll());
  }
  viewRows() {
    return Math.max(1, Math.min(this.measures.Before.rows || Infinity, this.measures.After.rows || Infinity, 1e4));
  }
  maxScroll() {
    return Math.max(0, this.rows.length - this.viewRows());
  }
  maxHorizontal() {
    return Math.max(0, this.widths.Before - this.measures.Before.cols, this.widths.After - this.measures.After.cols);
  }
  lineNumber(side, row) {
    return sideCell(this.rows[row], side)?.number ?? null;
  }
  rowForLine(side, line) {
    const index = this.rows.findIndex((row) => sideCell(row, side)?.number === line);
    return index < 0 ? null : index;
  }
  selectable(side, row) {
    return sideCell(this.rows[row], side)?.source !== null && this.rows[row] !== undefined;
  }
  selecting() {
    return this.selectionState.anchor !== null || this.selectionState.keyboard || this.selectionState.dragging;
  }
  hasSelection() {
    return this.selectionState.active();
  }
  keyboardSelecting() {
    return this.selectionState.keyboard;
  }
  dragging() {
    return this.selectionState.dragging;
  }
  effectiveRows() {
    if (this.selectionState.anchor !== null && this.selectionSide !== this.side)
      return [...this.selectionState.rows];
    return this.selectionState.effective(this.cursor, (row) => this.selectable(this.selectionSide, row));
  }
  selection() {
    const lines = [];
    const code = [];
    for (const row of this.effectiveRows()) {
      const cell = sideCell(this.rows[row], this.selectionSide);
      if (cell?.number === null || cell?.number === undefined || cell.source === null)
        continue;
      lines.push(cell.number);
      code.push(cell.source);
    }
    return lines.length ? { side: this.selectionSide, lines, code } : null;
  }
  linesOn(side) {
    const lines = [];
    for (const row of this.effectiveRows()) {
      const line = sideCell(this.rows[row], side)?.number;
      if (line !== null && line !== undefined)
        lines.push(line);
    }
    return lines;
  }
  selectedLines() {
    return this.selectionState.active() ? this.selection() : null;
  }
  restore(saved) {
    this.selectionState.clear();
    if (!saved)
      return;
    for (const line of saved.lines) {
      const row = this.rowForLine(saved.side, line);
      if (row !== null)
        this.selectionState.rows.add(row);
    }
    this.selectionSide = saved.side;
  }
  beginSelection(side, row, keyboard) {
    if (!this.selectable(side, row))
      return false;
    this.side = side;
    this.cursor = row;
    this.selectionState.clear();
    this.selectionSide = side;
    this.selectionState.anchor = row;
    this.selectionState.keyboard = keyboard;
    this.selectionState.dragging = !keyboard;
    return true;
  }
  finishSelection() {
    this.selectionState.finish(this.cursor, (row) => this.selectable(this.selectionSide, row));
  }
  clearSelection() {
    this.selectionState.clear();
  }
  toggleFold(row) {
    const key = this.rows[row]?.fold ?? null;
    if (!key)
      return false;
    this.finishSelection();
    const id = foldId(key);
    if (!this.toggles.delete(id))
      this.toggles.add(id);
    this.rebuild();
    const index = this.rows.findIndex((entry) => entry.fold && foldId(entry.fold) === id);
    if (index >= 0)
      this.cursor = index;
    return true;
  }
  revealLine(side, line) {
    let row = this.rowForLine(side, line);
    if (row === null) {
      const fold = this.rows.find((entry) => {
        if (!entry.fold)
          return false;
        const [start, end] = side === "Before" ? [entry.fold.oldStart, entry.fold.oldEnd] : [entry.fold.newStart, entry.fold.newEnd];
        return line >= start && line < end;
      })?.fold;
      if (!fold)
        return false;
      const id = foldId(fold);
      if (fold.kind === "context")
        this.toggles.add(id);
      else
        this.toggles.delete(id);
      this.rebuild();
      row = this.rowForLine(side, line);
      if (row === null)
        return false;
    }
    this.side = side;
    this.focusRow(row);
    return true;
  }
  focusFirstChange() {
    this.side = "After";
    this.scroll = 0;
    this.horizontal = 0;
    this.selectionState.clear();
    const changed = this.rows.findIndex((row) => row.after.source !== null && row.before.source !== row.after.source);
    this.cursor = changed >= 0 ? changed : Math.max(0, this.rows.findIndex((row) => row.after.source !== null));
    this.follow();
  }
  focusRow(row) {
    this.cursor = clamp(row, this.rows.length);
    this.follow();
  }
  follow() {
    const height = this.viewRows();
    if (this.cursor < this.scroll)
      this.scroll = this.cursor;
    else if (this.cursor >= this.scroll + height)
      this.scroll = this.cursor - height + 1;
  }
  scrollBy(rows) {
    this.scroll = Math.max(0, Math.min(this.scroll + rows, this.maxScroll()));
  }
  page() {
    return this.viewRows();
  }
  scrollHorizontal(columns) {
    this.horizontal = Math.max(0, Math.min(this.horizontal + columns, this.maxHorizontal()));
  }
  command(key) {
    const actions = {
      pagedown: () => this.scrollBy(this.page()),
      pageup: () => this.scrollBy(-this.page()),
      enter: () => this.toggleFold(this.cursor),
      space: () => this.toggleFold(this.cursor),
      right: () => this.scrollHorizontal(1),
      left: () => this.scrollHorizontal(-1),
      home: () => this.focusRow(0),
      end: () => this.focusRow(this.rows.length - 1),
      down: () => this.focusRow(this.cursor + 1),
      j: () => this.focusRow(this.cursor + 1),
      up: () => this.focusRow(this.cursor - 1),
      k: () => this.focusRow(this.cursor - 1)
    };
    if (key === "v" && !this.selectionState.keyboard)
      this.beginSelection(this.side, this.cursor, true);
    else if (key === "escape" && this.selectionState.active())
      this.selectionState.clear();
    else {
      const action = actions[key];
      if (!action)
        return false;
      action();
    }
    return true;
  }
  key(event, cx) {
    if (isChord(event) || !this.command(event.keystroke))
      return false;
    cx.stop_propagation();
    cx.notify();
    return true;
  }
  onDown(side, row, options, cx) {
    if (row === null)
      return;
    this.side = side;
    this.cursor = row;
    if (options.onClick)
      options.onClick(side, row, cx);
    else if (!this.toggleFold(row)) {
      if (this.selectionState.keyboard)
        this.finishSelection();
      else
        this.beginSelection(side, row, false);
    }
    cx.notify();
  }
  onMove(side, row, options, cx) {
    if (row === null)
      return;
    if (this.selectionState.dragging) {
      if (side !== this.selectionSide || row === this.cursor)
        return;
      this.cursor = row;
      cx.notify();
      return;
    }
    if (side === this.side && row === this.cursor)
      return;
    this.side = side;
    this.cursor = row;
    options.onPointer?.(side, row, cx);
    cx.notify();
  }
  pointerUp(cx) {
    if (!this.selectionState.dragging)
      return;
    this.finishSelection();
    cx.notify();
  }
  column(look, side, options) {
    const selected = new Set(this.selectionSide === side ? this.effectiveRows() : []);
    const showHint = !!options.hint && selected.size > 0 && !this.selectionState.dragging && this.selectionSide === side;
    return renderColumn(look, {
      id: `${this.id}-${side.toLowerCase()}`,
      cells: (row) => sideCell(this.rows[row], side),
      length: this.rows.length,
      maxWidth: this.widths[side],
      scroll: this.scroll,
      horizontal: this.horizontal,
      measure: this.measures[side],
      paint: {
        focusRow: options.focused && this.side === side ? this.cursor : -1,
        selected: (row) => selected.has(row)
      },
      hint: showHint ? { first: Math.min(...selected), last: Math.max(...selected) } : null,
      onSize: (measure, cx) => {
        const current = this.measures[side];
        if (measure.rows === current.rows && measure.cols === current.cols)
          return;
        this.measures[side] = measure;
        cx.notify();
      },
      onWheel: (event, cx) => {
        const steps = this.wheel.steps(event, look);
        if (steps.x === 0 && steps.y === 0)
          return;
        cx.stop_propagation();
        this.scrollBy(steps.y);
        this.scrollHorizontal(steps.x);
        cx.notify();
      },
      onDown: (row, _, cx) => this.onDown(side, row, options, cx),
      onMove: (row, cx) => this.onMove(side, row, options, cx),
      onUp: (cx) => this.pointerUp(cx),
      onVertical: (fraction, cx) => {
        this.scroll = Math.round(fraction * this.maxScroll());
        cx.notify();
      },
      onHorizontal: (fraction, cx) => {
        this.horizontal = Math.round(fraction * this.maxHorizontal());
        cx.notify();
      }
    });
  }
  render(look, options) {
    this.scroll = Math.min(this.scroll, this.maxScroll());
    this.horizontal = Math.min(this.horizontal, this.maxHorizontal());
    return { before: this.column(look, "Before", options), after: this.column(look, "After", options) };
  }
}

// src/ui/explorer/line-history.ts
import { h_flex as h_flex7, v_flex as v_flex7 } from "gpui-base";
import { div as div8 } from "gpui-kit";

// src/git/files.ts
var CONTENT_RESULT_LIMIT = 1000;
async function readFiles(git) {
  const results = await Promise.all([
    git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
    git(["diff", "--cached", "--name-only", "-z", "--diff-filter=D", "--find-renames", "--no-ext-diff"])
  ]);
  for (const result of results)
    if (result.code !== 0)
      throw new Error(result.stderr || "Cannot list repository files");
  return [...new Set(results.flatMap((result) => result.stdout.split("\x00").filter(Boolean)))].sort();
}
function hunkRange(range) {
  const [start, count] = range.split(",");
  return [Number(start) || 0, count === undefined ? 1 : Number(count) || 0];
}
function parseLineChanges(output) {
  const changes = [];
  for (const line of output.split(`
`)) {
    if (line.startsWith("@@ ")) {
      const [old = "", next = ""] = line.slice(3).split(" ");
      const [oldStart, oldCount] = hunkRange(old.replace(/^-/, ""));
      const [newStart, newCount] = hunkRange(next.replace(/^\+/, ""));
      changes.push({
        oldStart: oldCount === 0 ? oldStart + 1 : oldStart,
        removed: [],
        newStart: newCount === 0 ? newStart + 1 : newStart,
        added: newCount
      });
    } else if (line.startsWith("-")) {
      changes.at(-1)?.removed.push(line.slice(1).replace(/\r$/, ""));
    }
  }
  return changes;
}
async function readLineChanges(git, path) {
  const result = await git(["diff", "--no-ext-diff", "--no-color", "--no-renames", "--unified=0", "HEAD", "--", path]);
  return result.code === 0 ? parseLineChanges(result.stdout) : [];
}
async function readLineHistory(git, file, ranges, revision) {
  const args = [
    "log",
    "--no-color",
    "--max-count=100",
    "--format=%x1e%H%x1f%an%x1f%at%x1f%s",
    ...ranges.map(([start, end]) => `-L${start},${end}:${file}`)
  ];
  if (revision)
    args.push(revision);
  const result = await git(args);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || "Line history failed");
  return result.stdout.split("\x1E").filter((record) => record.trim()).map((record) => {
    const newline = record.indexOf(`
`);
    const header = newline < 0 ? record : record.slice(0, newline);
    const [sha = "", author = "", time = "", ...summary] = header.split("\x1F");
    return {
      sha,
      author,
      authorTime: Number(time) || 0,
      summary: summary.join("\x1F"),
      patch: newline < 0 ? "" : record.slice(newline + 1).replace(/^\n+/, "")
    };
  });
}
function matchRange(text, query, ignoreCase) {
  const index = ignoreCase ? text.toLowerCase().indexOf(query.toLowerCase()) : text.indexOf(query);
  return index < 0 ? [0, 0] : [index, index + query.length];
}
async function searchContents(git, query) {
  if (!query.trim())
    return [];
  const paths = await readFiles(git);
  const matches = [];
  for (let offset = 0;offset < paths.length && matches.length < CONTENT_RESULT_LIMIT; offset += 512) {
    matches.push(...await searchBatch(git, query, paths.slice(offset, offset + 512), CONTENT_RESULT_LIMIT - matches.length));
  }
  return matches;
}
async function searchBatch(git, query, paths, limit) {
  const ignoreCase = query === query.toLowerCase();
  const result = await git([
    "--literal-pathspecs",
    "grep",
    "--threads=2",
    `--max-count=${limit}`,
    "--no-color",
    "--no-ext-grep",
    "--no-textconv",
    "--no-column",
    "--no-heading",
    "--no-break",
    "--full-name",
    "-H",
    ignoreCase ? "--ignore-case" : "--no-ignore-case",
    "--untracked",
    "--exclude-standard",
    "-I",
    "-n",
    "-z",
    "-F",
    "-e",
    query,
    "--",
    ...paths
  ]);
  if (result.code === 1)
    return [];
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || "Content search failed");
  const matches = [];
  const output = result.stdout;
  let offset = 0;
  while (offset < output.length && matches.length < limit) {
    const pathEnd = output.indexOf("\x00", offset);
    const lineEnd = output.indexOf("\x00", pathEnd + 1);
    if (pathEnd < 0 || lineEnd < 0)
      break;
    const newline = output.indexOf(`
`, lineEnd + 1);
    const end = newline < 0 ? output.length : newline;
    const [start, stop] = matchRange(output.slice(lineEnd + 1, end).replace(/\r$/, ""), query, ignoreCase);
    matches.push({
      path: output.slice(offset, pathEnd),
      line: Number(output.slice(pathEnd + 1, lineEnd)),
      start,
      end: stop
    });
    offset = end + 1;
  }
  return matches.sort((left, right) => left.path === right.path ? left.line - right.line : left.path < right.path ? -1 : 1);
}
function fileLanguage(path) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const languages = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    rs: "rust",
    py: "python",
    go: "go",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    sh: "bash",
    toml: "toml",
    yaml: "yaml",
    yml: "yaml",
    c: "c",
    h: "c",
    cpp: "cpp",
    java: "java",
    swift: "swift",
    sql: "sql"
  };
  return languages[extension] ?? "text";
}

// src/git/history.ts
var HISTORY_PAGE_SIZE = 100;
var READ3 = [
  "--no-optional-locks",
  "--literal-pathspecs",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "diff.autoRefreshIndex=false"
];
var FIELDS = "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1f%b";
var RECORD = "\x1E";
var FIELD = "\x1F";
async function run3(git, args) {
  const result = await git([...READ3, ...args]);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `git ${args[0]} exited with ${result.code}`);
  return result.stdout;
}
async function optional(git, args) {
  const result = await git([...READ3, ...args]);
  return result.code === 0 ? result.stdout.trim() : "";
}
function objectId(value) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))
    throw new Error("Invalid commit identity");
  return value;
}
function lines(output) {
  return output.split(`
`).map((line) => line.trim()).filter(Boolean);
}
async function historyCursor(git, start) {
  const revisions = (start ? [(await run3(git, ["rev-parse", "--verify", "--end-of-options", `${start}^{commit}`])).trim()] : lines(await run3(git, ["rev-list", "--all", "--no-walk=unsorted"]))).map(objectId);
  if (revisions.length < 2)
    return { start, revisions, traversalRevisions: revisions };
  const independent = new Set(lines(await run3(git, ["merge-base", "--independent", ...revisions])).map(objectId));
  const traversalRevisions = revisions.filter((sha) => independent.has(sha));
  return { start, revisions, traversalRevisions };
}
async function readHistoryPage(git, request, cursor) {
  const snapshot = cursor && cursor.start === request.start ? cursor : await historyCursor(git, request.start);
  const count = Math.max(1, Math.floor(request.count));
  if (!snapshot.revisions.length)
    return { commits: [], offset: request.offset, hasMore: false, cursor: snapshot };
  const output = await run3(git, [
    "log",
    "--topo-order",
    "--date-order",
    "--decorate=full",
    "--no-color",
    "--no-show-signature",
    FIELDS,
    `--skip=${request.offset}`,
    `--max-count=${count + 1}`,
    ...snapshot.traversalRevisions,
    "--"
  ]);
  const commits = parseHistory(output);
  return {
    commits: commits.slice(0, count),
    offset: request.offset,
    hasMore: commits.length > count,
    cursor: snapshot
  };
}
function splitFields(record, limit) {
  const fields = [];
  let rest = record;
  while (fields.length < limit - 1) {
    const index = rest.indexOf(FIELD);
    if (index < 0)
      break;
    fields.push(rest.slice(0, index));
    rest = rest.slice(index + 1);
  }
  fields.push(rest);
  return fields;
}
function required(fields, index, name) {
  const value = fields[index];
  if (value === undefined)
    throw new Error(`Git returned a commit without ${name}`);
  return value;
}
function parseHistory(output) {
  return output.split(RECORD).filter((record) => record.trim() !== "").map((record) => {
    const fields = splitFields(record.replace(/^\n+|\n+$/g, ""), 8);
    return {
      sha: objectId(required(fields, 0, "SHA")),
      parents: required(fields, 1, "parents").split(/\s+/).filter(Boolean).map(objectId),
      authorName: required(fields, 2, "author name"),
      authorEmail: required(fields, 3, "author email"),
      authorTime: required(fields, 4, "author time"),
      refs: required(fields, 5, "refs").split(", ").filter((value) => value !== "").flatMap(parseRefs),
      subject: required(fields, 6, "subject"),
      body: (fields[7] ?? "").trimEnd()
    };
  });
}
function parseRefs(value) {
  const trimmed = value.trim();
  const head = "HEAD -> refs/heads/";
  if (trimmed.startsWith(head))
    return [
      { name: "HEAD", kind: "head" },
      { name: trimmed.slice(head.length), kind: "local" }
    ];
  return [parseRef(trimmed)];
}
var REF_PREFIXES = [
  ["refs/heads/", "local"],
  ["refs/remotes/", "remote"],
  ["tag: refs/tags/", "tag"],
  ["refs/tags/", "tag"]
];
function parseRef(value) {
  for (const [prefix, kind] of REF_PREFIXES) {
    if (!value.startsWith(prefix))
      continue;
    const name = value.slice(prefix.length);
    return { name, kind: kind === "remote" && name.endsWith("/HEAD") ? "remote-head" : kind };
  }
  return { name: value, kind: value === "HEAD" ? "head" : "other" };
}
function isHead(commit) {
  return commit.refs.some((reference) => reference.kind === "head");
}
function filteredCommitIndices(commits, query) {
  const needle = query.toLowerCase();
  const indices = [];
  commits.forEach((commit, index) => {
    if (commitMatches(commit, needle))
      indices.push(index);
  });
  return indices;
}
function commitMatches(commit, needle) {
  return needle === "" || commit.sha.toLowerCase().startsWith(needle) || commit.authorName.toLowerCase().includes(needle) || commit.authorEmail.toLowerCase().includes(needle) || commit.subject.toLowerCase().includes(needle) || commit.body.toLowerCase().includes(needle) || commit.refs.some((reference) => reference.name.toLowerCase().includes(needle));
}
async function readCommitChanges(git, sha) {
  const output = await run3(git, [
    "diff-tree",
    "--root",
    "--no-commit-id",
    "--name-status",
    "-r",
    "-M",
    "-C",
    "-z",
    objectId(sha),
    "--"
  ]);
  return parseChanges(output);
}
function parseChanges(output) {
  const fields = output.split("\x00");
  const changes = [];
  let index = 0;
  while (index < fields.length - 1) {
    const status = fields[index++] ?? "";
    const first = fields[index++];
    if (!status || first === undefined)
      throw new Error("Incomplete commit file response");
    if (status.startsWith("R") || status.startsWith("C")) {
      const path = fields[index++];
      if (path === undefined)
        throw new Error("Incomplete rename response");
      changes.push({ status, path, from: first });
    } else
      changes.push({ status, path: first });
  }
  return changes;
}
async function readRefsFingerprint(git) {
  const [refs, head, branch] = await Promise.all([
    run3(git, ["for-each-ref", "--format=%(objectname) %(refname)"]),
    optional(git, ["rev-parse", "--verify", "--quiet", "HEAD"]),
    optional(git, ["symbolic-ref", "--quiet", "HEAD"])
  ]);
  return `${branch}
${head}
${refs}`;
}
var STATUS_LETTERS = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  type: "T",
  conflict: "U",
  untracked: "?"
};
function statusLetter(kind) {
  return STATUS_LETTERS[kind];
}
function parseIsoTime(value) {
  const match = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)(?:\.\d+)?(Z|z|[+-]\d{2}:?\d{2})$/.exec(value.trim());
  if (!match)
    return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60)
    return null;
  return daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second - utcOffset(match[7] ?? "Z");
}
function utcOffset(offset) {
  if (offset === "Z" || offset === "z")
    return 0;
  const digits = offset.slice(1).replace(":", "");
  const seconds = Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2)) * 60;
  return offset.startsWith("-") ? -seconds : seconds;
}
function daysFromCivil(year, month, day) {
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const monthIndex = (month + 9) % 12;
  const dayOfYear = Math.floor((153 * monthIndex + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}
function count(value, unit) {
  return value === 1 ? `1 ${unit} ago` : `${value} ${unit}s ago`;
}
function plural(value, unit) {
  return value === 1 ? `1 ${unit}` : `${value} ${unit}s`;
}
function relativeTime(secondsAgo) {
  if (secondsAgo < 0)
    return "in the future";
  if (secondsAgo < 90)
    return count(secondsAgo, "second");
  const minutes = Math.floor((secondsAgo + 30) / 60);
  if (minutes < 90)
    return count(minutes, "minute");
  const hours = Math.floor((minutes + 30) / 60);
  if (hours < 36)
    return count(hours, "hour");
  const days = Math.floor((hours + 12) / 24);
  if (days < 14)
    return count(days, "day");
  if (days < 70)
    return count(Math.floor((days + 3) / 7), "week");
  if (days < 365)
    return count(Math.floor((days + 15) / 30), "month");
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365 + 15) / 30);
  return months === 0 ? count(years, "year") : `${plural(years, "year")}, ${plural(months, "month")} ago`;
}
function authorRelative(commit, nowSeconds) {
  const time = parseIsoTime(commit.authorTime);
  return time === null ? "" : relativeTime(Math.floor(nowSeconds) - time);
}

// src/ui/explorer/line-history.ts
var SPLIT_COLUMNS = 72;
var FOOTER = "j/k commit · PgUp/PgDn scroll · Enter open in Graph · Esc close";
var BLANK2 = { number: null, text: "", tokens: [], tone: "plain" };
function splitPatch(patch, path) {
  const at = patch.indexOf(`
@@`);
  const hunks = patch.startsWith("@@") ? patch : at < 0 ? "" : patch.slice(at + 1);
  const rows = { before: [], after: [] };
  let removed = [];
  let added = [];
  const flush = () => {
    for (let index = 0;index < Math.max(removed.length, added.length); index++) {
      rows.before.push(removed[index] ?? BLANK2);
      rows.after.push(added[index] ?? BLANK2);
    }
    removed = [];
    added = [];
  };
  let oldLine = 0;
  let newLine = 0;
  for (const line of hunks.split(`
`)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flush();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    const text = line.slice(1);
    const tokens = highlight(text, path);
    if (line.startsWith("-"))
      removed.push({ number: oldLine++, text, tokens, tone: "removed" });
    else if (line.startsWith("+"))
      added.push({ number: newLine++, text, tokens, tone: "added" });
    else if (line.startsWith(" ")) {
      flush();
      rows.before.push({ number: oldLine++, text, tokens, tone: "plain" });
      rows.after.push({ number: newLine++, text, tokens, tone: "plain" });
    }
  }
  flush();
  return rows;
}

class LineHistoryDialog {
  services;
  target;
  reading = true;
  entries = [];
  error = null;
  selected = 0;
  scroll = 0;
  height = 1;
  shown = -1;
  before = new CodeView("git-line-history-before");
  after = new CodeView("git-line-history-after");
  closed = false;
  constructor(services, target) {
    this.services = services;
    this.target = target;
  }
  read(cx) {
    const git = this.services.git();
    const context = this.services.context();
    if (!git) {
      this.reading = false;
      this.error = "Not a Git repository";
      return;
    }
    cx.spawn(async (cx) => {
      try {
        const entries = await readLineHistory(git, this.target.file, this.target.ranges, this.target.revision);
        if (this.closed || context !== this.services.context())
          return;
        this.entries = entries;
      } catch (error) {
        if (this.closed)
          return;
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.reading = false;
        cx.notify();
      }
    });
  }
  release() {
    this.closed = true;
    this.before.release();
    this.after.release();
  }
  select(index) {
    this.selected = Math.max(0, Math.min(index, this.entries.length - 1));
    this.scroll = viewportOffset(this.scroll, this.selected, this.entries.length, this.height);
  }
  open(cx) {
    const entry = this.entries[this.selected];
    if (!entry)
      return;
    this.services.overlay.close(cx);
    this.release();
    this.services.revealCommit(entry.sha, cx);
  }
  key(event, cx) {
    const moves = {
      down: this.selected + 1,
      j: this.selected + 1,
      up: this.selected - 1,
      k: this.selected - 1,
      home: 0,
      end: this.entries.length - 1
    };
    const move = moves[event.keystroke];
    if (event.keystroke === "enter")
      this.open(cx);
    else if (move !== undefined)
      this.select(move);
    else if (event.keystroke === "pageup" || event.keystroke === "pagedown") {
      this.before.key(event, cx);
      this.after.key(event, cx);
    } else
      return false;
    return true;
  }
  wheel(event, look, cx) {
    const steps = Math.trunc((event.delta_lines ? event.delta_lines.y * look.row : event.delta.y) / look.row);
    if (!steps)
      return;
    cx.stop_propagation();
    this.select(this.selected - steps);
    cx.notify();
  }
  row(look, index, width) {
    const { t } = look;
    const entry = this.entries[index];
    const selected = index === this.selected;
    const now = Math.floor(Date.now() / 1000);
    const text = entry ? `${selected ? "▶" : " "} ${entry.sha.slice(0, 7)}  ${padToWidth(entry.author, 18)}  ${padToWidth(relativeTime(now - entry.authorTime), 14)}  ${entry.summary}` : "";
    return div8().id(`git-line-history-${index}`).flex_none().h(look.row).whitespace_nowrap().overflow_hidden().text_color(selected ? t.text : t.hint).when(selected, (el) => el.bg(t.selection).font_weight(700)).hover((style) => style.bg(t.hover)).child(truncateToWidth(text, width)).on_click((_, cx) => {
      cx.stop_propagation();
      if (selected)
        this.open(cx);
      else
        this.select(index);
      cx.notify();
    });
  }
  list(look, width) {
    const { t } = look;
    const area = v_flex7().id("git-line-history-list").flex_1().min_h(0).overflow_hidden().on_size_change((size, cx) => {
      const height = Math.max(1, Math.floor(size.height / look.screenRow));
      if (height === this.height)
        return;
      this.height = height;
      this.select(this.selected);
      cx.notify();
    }).on_scroll_wheel((event, cx) => this.wheel(event, look, cx));
    if (this.reading)
      return area.child(h_flex7().h(look.row).child(spinner(look)).child(" Reading line history"));
    if (this.error)
      return area.child(div8().text_color(t.error).child(this.error.split(`
`)[0] ?? ""));
    if (!this.entries.length)
      return area.child(div8().text_color(t.hint).child("No commits touched these lines."));
    const end = Math.min(this.entries.length, this.scroll + this.height);
    for (let index = this.scroll;index < end; index++)
      area.child(this.row(look, index, width));
    return area;
  }
  diff(look, width) {
    const entry = this.entries[this.selected];
    if (this.reading || this.error || !entry)
      return null;
    if (this.shown !== this.selected) {
      this.shown = this.selected;
      const rows = splitPatch(entry.patch, this.target.file);
      const language = fileLanguage(this.target.file);
      this.before.set(rows.before, language);
      this.after.set(rows.after, language);
    }
    const previous = this.entries[this.selected + 1];
    const short = entry.sha.slice(0, 7);
    const from = previous ? previous.sha.slice(0, 7) : entry.patch.includes(`
--- /dev/null`) ? "none" : `${short}^`;
    const panel = (id, title, view) => box(look, { id, title }, view.render(look, { focused: false })).flex_1();
    const split = width >= SPLIT_COLUMNS ? h_flex7() : v_flex7();
    return split.flex_1().min_h(0).min_w(0).items_stretch().child(panel("git-line-history-before-box", `Before · ${from}`, this.before)).child(panel("git-line-history-after-box", `After · ${short}`, this.after));
  }
  render(look, size) {
    const width = Math.max(1, size.cols - 4);
    const diff = this.diff(look, width);
    return v_flex7().size_full().min_h(0).px(cols(look, 1)).child(this.list(look, width)).when(!!diff, (el) => el.child(diff ?? div8())).when(!diff, (el) => el.child(div8().flex_1())).child(footerHint(look, FOOTER));
  }
}
function openLineHistory(services, title, target, size, cx) {
  const dialog = new LineHistoryDialog(services, target);
  const width = Math.max(20, size.cols - Math.floor(size.cols / 10));
  const height = Math.max(8, size.rows - 2);
  const label = `Line History · ${title}`;
  services.overlay.open({
    kind: "custom",
    title: truncateToWidth(label, Math.max(1, width - 8)),
    width,
    height,
    render: (look) => dialog.render(look, { cols: width, rows: height }),
    key: (event, cx) => dialog.key(event, cx),
    onCancel: () => dialog.release()
  });
  dialog.read(cx);
}

// src/ui/changes.ts
var SPLIT_SCALE = 1000;
var MIN_FILES = 20;
var MIN_DIFF = 24;
var HOVER_BLAME_MS = 100;
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function changesPaneWidths(total, splits) {
  if (total < MIN_FILES + MIN_DIFF * 2) {
    const files = Math.floor(total / 5);
    const before = Math.floor(total * 2 / 5);
    return [files, before, total - files - before];
  }
  const scaled = (split) => Math.floor(total * split / SPLIT_SCALE);
  const first = Math.max(MIN_FILES, Math.min(scaled(splits[0]), total - MIN_DIFF * 2));
  const second = Math.max(first + MIN_DIFF, Math.min(scaled(splits[1]), total - MIN_DIFF));
  return [first, second - first, total - second];
}
function filterTree(all, changes, query) {
  if (!query)
    return all;
  const keep = new Set;
  for (const [index, row] of all.entries()) {
    if (row.kind !== "file" || !changes[row.change]?.path.toLowerCase().includes(query))
      continue;
    keep.add(index);
    let depth = row.depth;
    for (let ancestor = index - 1;ancestor >= 0 && depth > 0; ancestor--) {
      const parent = all[ancestor];
      if (!parent || parent.depth >= depth)
        continue;
      depth = parent.depth;
      keep.add(ancestor);
    }
  }
  return all.filter((_, index) => keep.has(index));
}
function blameText(line, sha, author, summary) {
  if (/^0+$/.test(sha))
    return `Line ${line} · Uncommitted · ${author} · Working tree change`;
  return `Line ${line} · ${sha.slice(0, 8)} · ${author} · ${summary}`;
}

class ChangesTab {
  services;
  workspaces;
  id = "changes";
  active = false;
  seen = null;
  mode = { kind: "last" };
  compareBase = "HEAD";
  compareTarget = "";
  changes = [];
  summaries = {};
  titles = {};
  comparison = null;
  target = { kind: "working-index" };
  selectedChange = 0;
  progress = null;
  pendingResult = null;
  changesRequest = 0;
  diffRequest = 0;
  focusAfterLoad = false;
  error = null;
  focused = "files";
  diff = new SplitDiff("git-changes-diff");
  files;
  diffHandle;
  selectionBlame = new SelectionBlame;
  blame = null;
  blameLoading = false;
  blameRequest = 0;
  hoverRequest = 0;
  splits = [200, 600];
  divider = null;
  hoveredDivider = null;
  size = { width: 0, height: 0, cols: 0, rows: 0, wide: true };
  hints = false;
  stagingOwner = null;
  constructor(services, workspaces, cx) {
    this.services = services;
    this.workspaces = workspaces;
    this.diffHandle = cx.focus_handle();
    this.files = new FilesPane({
      changes: () => this.changes,
      summaries: () => this.summaries,
      select: (change, cx) => this.selectChange(change, cx),
      activate: (change, cx) => this.activateChange(change, cx),
      focus: () => this.setFocus("files"),
      stage: (operation, owner, cx) => this.stage(operation, owner, cx),
      discard: (paths, cx) => this.confirmDiscard(paths, cx),
      error: (message) => this.services.reportError(message),
      clearDiffSelection: () => this.diff.clearSelection()
    }, cx.focus_handle());
  }
  activate(cx) {
    this.active = true;
    this.focused = "files";
    this.loadChanges(cx);
  }
  deactivate() {
    this.active = false;
  }
  focus() {
    this.setFocus(this.focused);
  }
  focusCommit() {
    this.setFocus("files");
  }
  release() {
    this.active = false;
    this.changesRequest++;
    this.diffRequest++;
    this.blameRequest++;
    this.selectionBlame.reset();
    this.diff.release();
    this.diffHandle.release();
    this.files.handle.release();
  }
  setFocus(focus) {
    this.focused = focus;
    if (focus === "files")
      this.files.handle.focus();
    else
      this.diffHandle.focus();
  }
  showCommit(sha, cx) {
    this.mode = { kind: "commit", sha };
    this.resetView();
    this.progress = "Loading commit diff";
    this.loadChanges(cx);
  }
  resetView() {
    this.files.replaced();
    this.diff.detach();
    this.diff.clearSelection();
    this.selectedChange = 0;
    this.blame = null;
  }
  escape() {
    if (this.workspaces.isFocused() || this.focused === "diff") {
      this.setFocus("files");
      return true;
    }
    return this.files.escape();
  }
  shortcut(shortcut, cx) {
    if (shortcut !== "files-search")
      return false;
    this.openFilesSearch(cx);
    return true;
  }
  toolbar(_look, hints) {
    this.hints = hints;
    const between = this.mode.kind === "between";
    const compact = this.size.cols > 0 && Math.floor(this.size.cols / 6) < "Diff Last".length + 4;
    return [
      {
        id: "git-diff-last",
        label: compact ? "Last" : "Diff Last",
        shortcut: "d",
        symbol: between ? GLYPH.radioOff : GLYPH.radioOn,
        enabled: true,
        selected: !between,
        onClick: (cx) => this.selectComparison(0, cx)
      },
      {
        id: "git-compare",
        label: "Compare",
        shortcut: "m",
        symbol: between ? GLYPH.radioOn : GLYPH.radioOff,
        enabled: true,
        selected: between,
        onClick: (cx) => this.selectComparison(1, cx)
      }
    ];
  }
  selectComparison(index, cx) {
    if (this.services.repository()?.state !== "ready")
      return;
    if (index === 1) {
      openCompareDialog(this.services, this.compareBase, this.compareTarget, (base, compare, cx) => {
        this.compareBase = base;
        this.compareTarget = compare;
        this.mode = { kind: "between", base, compare };
        this.refreshComparison(cx);
      }, cx);
      return;
    }
    this.mode = { kind: "last" };
    this.refreshComparison(cx);
  }
  refreshComparison(cx) {
    this.diff.clearSelection();
    this.diff.detach();
    this.diffRequest++;
    this.progress = "Loading changes";
    this.loadChanges(cx);
  }
  hasChanges() {
    const repository = this.services.repository();
    return repository?.state === "ready" && repository.files.length > 0;
  }
  endpoint(sha) {
    return [sha.slice(0, 7), this.titles[sha] ?? ""];
  }
  endpoints() {
    const target = this.target;
    if (target.kind === "commit")
      return [target.parent ? target.parent.slice(0, 7) : "Empty", this.endpoint(target.commit)];
    if (target.kind === "working-index")
      return ["Index", ["Working Tree", ""]];
    const head = this.services.facts().head;
    return [head ? head.slice(0, 7) : "Empty", ["Index", ""]];
  }
  info(look) {
    const { t } = look;
    if (this.target.kind === "working-index" && !this.hasChanges())
      return div9().text_color(t.hint).child("—");
    const [before, [after, title]] = this.endpoints();
    const suffix = this.target.kind !== "commit" ? " (Uncommitted)" : this.hasChanges() ? " · Uncommitted" : "";
    return h_flex8().whitespace_nowrap().overflow_hidden().child(div9().text_color(t.secondary).child(`${before} → ${after}`)).when(!!title, (el) => el.child(div9().text_color(t.text).child(` ${title}`))).child(div9().text_color(t.warning).child(suffix));
  }
  focusedBlameText() {
    if (this.focused !== "diff")
      return null;
    if (this.blameLoading)
      return "Blame…";
    if (this.blame?.text)
      return `Blame: ${this.blame.text}`;
    if (this.blame?.error)
      return `Blame unavailable · ${this.blame.error}`;
    return null;
  }
  status() {
    return {
      blame: this.selectionBlame.status() ?? this.focusedBlameText(),
      progress: this.progress,
      error: this.error
    };
  }
  refresh(scope, cx) {
    if (scope === "history" || scope === "workspaces")
      return;
    const context = this.services.context();
    if (context !== this.seen) {
      this.seen = context;
      this.mode = { kind: "last" };
      this.changes = [];
      this.comparison = null;
      this.target = { kind: "working-index" };
      this.error = null;
      this.resetView();
      this.files.reset();
      this.selectionBlame.reset();
    }
    if (!this.services.busy())
      this.stagingOwner = null;
    const result = this.pendingResult;
    if (result && !this.services.busy()) {
      this.pendingResult = null;
      showResult(this.services.overlay, result.name, result.success, result.message, result.preview, cx);
    }
    if (this.active)
      this.loadChanges(cx);
  }
  loadChanges(cx) {
    const git = this.services.git();
    const request = ++this.changesRequest;
    if (!git) {
      this.progress = null;
      this.changes = [];
      this.files.rebuild(null);
      this.diff.plain(this.services.repository()?.state === "none" ? "Not a Git repository" : "");
      return;
    }
    const context = this.services.context();
    const repository = this.services.repository();
    const files = repository?.state === "ready" ? repository.files : undefined;
    const mode = this.mode;
    cx.spawn(async (cx) => {
      try {
        const snapshot = await readChanges(git, mode, files);
        if (request !== this.changesRequest || context !== this.services.context())
          return;
        this.error = null;
        const previous = this.changes[this.selectedChange];
        this.changes = snapshot.changes;
        this.comparison = snapshot.comparison;
        this.summaries = snapshot.summaries;
        this.titles = snapshot.titles;
        const index = previous ? this.changes.findIndex((change) => change.section === previous.section && change.path === previous.path) : -1;
        this.selectedChange = Math.max(0, index);
        this.files.rebuild(this.changes.length ? this.selectedChange : null);
        this.updateTarget();
        this.loadDiff(cx);
      } catch (error) {
        if (request === this.changesRequest)
          this.error = errorMessage(error);
      } finally {
        if (request === this.changesRequest) {
          this.progress = null;
          cx.notify();
        }
      }
    });
  }
  updateTarget() {
    const change = this.changes[this.selectedChange];
    this.target = this.comparison ?? (change ? sectionTarget(change.section) : null) ?? this.target;
  }
  selectChange(index, cx) {
    this.focusAfterLoad = false;
    if (this.changes.length === 0)
      return;
    const next = Math.min(index, this.changes.length - 1);
    if (next !== this.selectedChange) {
      this.diff.detach();
      this.diff.clearSelection();
    }
    this.selectedChange = next;
    this.updateTarget();
    this.loadDiff(cx);
  }
  activateChange(index, cx) {
    this.selectChange(index, cx);
    this.setFocus("diff");
    this.diff.side = "After";
    this.focusAfterLoad = true;
  }
  loadDiff(cx) {
    const git = this.services.git();
    const change = this.changes[this.selectedChange];
    const request = ++this.diffRequest;
    this.blameRequest++;
    this.blame = null;
    this.blameLoading = false;
    if (!git || !change) {
      this.diff.plain(git ? "No changes." : "Not a Git repository");
      return;
    }
    const target = this.target;
    const context = this.services.context();
    cx.spawn(async (cx) => {
      let text;
      let patch = false;
      try {
        text = await readTargetDiff(git, target, change.path);
        patch = text.length > 0;
        if (!patch)
          text = "No diff for this file and target.";
      } catch (error) {
        text = `Error: ${errorMessage(error)}`;
      }
      if (request !== this.diffRequest || context !== this.services.context())
        return;
      if (patch)
        this.diff.set(text, change.path);
      else
        this.diff.plain(text);
      if (this.focusAfterLoad) {
        this.focusAfterLoad = false;
        this.diff.focusFirstChange();
        this.loadBlame(this.diff.cursor, cx);
      }
      cx.notify();
    });
  }
  loadBlame(row, cx) {
    const line = this.diff.lineNumber("After", row);
    const change = this.changes[this.selectedChange];
    const git = this.services.git();
    if (line === null || !change || !git) {
      this.blameRequest++;
      this.blameLoading = false;
      this.blame = { line: 0, text: null, error: "select a context or added line" };
      return;
    }
    if (this.blame?.line === line && this.blame.text)
      return;
    const request = ++this.blameRequest;
    const revision = blameRevision(this.target);
    this.blameLoading = true;
    cx.spawn(async (cx) => {
      let blame;
      try {
        const [entry] = await readBlameRange(git, change.path, line, line, revision);
        blame = entry?.line === line ? { line, text: blameText(line, entry.sha, entry.author, entry.summary), error: null } : { line, text: null, error: "Blame result did not match the line" };
      } catch (error) {
        blame = { line, text: null, error: errorMessage(error) };
      }
      if (request !== this.blameRequest)
        return;
      this.blame = blame;
      this.blameLoading = false;
      cx.notify();
    });
  }
  hoverBlame(row, cx) {
    const request = ++this.hoverRequest;
    cx.spawn(async (cx) => {
      await cx.sleep(HOVER_BLAME_MS);
      if (request !== this.hoverRequest || this.focused !== "diff" || this.diff.cursor !== row)
        return;
      this.loadBlame(row, cx);
      cx.notify();
    });
  }
  stage(operation, owner, cx) {
    if (this.services.busy()) {
      this.services.reportError("Wait for the current Git operation.");
      return;
    }
    if (this.services.repository()?.state !== "ready") {
      this.services.reportError("Not a Git repository");
      return;
    }
    this.stagingOwner = owner;
    this.services.mutate(this.services.context(), stagingLabel(operation), async (git) => {
      try {
        await runStaging(git, operation);
        this.pendingResult = { name: "Staging", success: true, message: stagingMessage(operation) };
      } catch (error) {
        const message = `${stagingPreview(operation)} failed: ${errorMessage(error)}`;
        this.pendingResult = { name: "Staging", success: false, message };
        throw error;
      }
    }, cx);
  }
  confirmDiscard(paths, cx) {
    if (this.services.busy()) {
      this.services.reportError("Wait for the current Git operation.");
      return;
    }
    const context = this.services.context();
    const operation = { kind: "discard", paths };
    const more = paths.length > 5 ? `
... and ${paths.length - 5} more` : "";
    this.services.overlay.open({
      kind: "confirm",
      title: "Confirm Git operation",
      lines: [
        `Discard unstaged changes in ${paths.length} tracked files?
Restore from: index (staged content)
Staged changes and untracked files are kept.

Unstaged edits will be permanently lost.

${paths.slice(0, 5).join(`
`)}${more}`
      ],
      hint: "Discard all tracked changes…",
      onConfirm: (cx) => {
        const preview = stagingPreview(operation);
        this.services.mutate(context, stagingLabel(operation), async (git) => {
          const output = await runStaging(git, operation).catch((error) => {
            this.pendingResult = { name: "Discard", success: false, message: errorMessage(error), preview };
            throw error;
          });
          this.pendingResult = { name: "Discard", success: true, message: output, preview };
        }, cx);
      }
    });
    cx.notify();
  }
  openFilesSearch(cx) {
    this.setFocus("files");
    const changes = this.changes;
    const all = treeRows(changes, new Set);
    const filtered = (query) => filterTree(all, changes, query);
    const pickerRows = (query) => filtered(query).map((row) => {
      const indent = "  ".repeat(row.depth);
      if (row.kind === "directory")
        return {
          id: `dir:${row.key}`,
          label: `${indent}${row.expanded ? GLYPH.expanded : GLYPH.collapsed} ${row.label}`
        };
      const status = changes[row.change]?.status.slice(0, 1) ?? "";
      return { id: `file:${row.change}`, label: `${indent}${status.padEnd(4)} ${row.label}` };
    });
    const first = all.find((row) => row.kind === "file");
    this.services.overlay.open({
      kind: "picker",
      title: "Find Files",
      width: DIALOG.medium,
      maxRows: 15,
      rows: pickerRows,
      selected: first?.kind === "file" ? `file:${first.change}` : undefined,
      footer: (query) => {
        if (!query)
          return "";
        const count = filtered(query).filter((row) => row.kind === "file").length;
        return count === 0 ? "No matching files" : count === 1 ? "1 matching file" : `${count} matching files`;
      },
      primary: "[Enter] Open",
      secondary: "[Esc] Close",
      onChoose: (row, cx) => {
        if (!row.id.startsWith("file:"))
          return;
        const change = Number(row.id.slice(5));
        this.files.rebuild(change);
        this.activateChange(change, cx);
      }
    });
    cx.notify();
  }
  openLineJump() {
    const side = this.diff.side;
    this.services.overlay.open({
      kind: "form",
      title: `Go to ${side} line`,
      width: DIALOG.narrow,
      fields: [{ label: "Line" }],
      hint: "Enter a positive line number",
      primary: "[Enter] Go",
      onSubmit: ([value = ""], cx) => {
        if (!/^\d+$/.test(value.trim()))
          return "Error: Enter a positive line number.";
        const line = Number(value.trim());
        if (line === 0)
          return "Error: Line numbers start at 1.";
        if (!this.diff.revealLine(side, line))
          return `Error: Line ${line} is unavailable on ${side}.`;
        this.loadBlame(this.diff.cursor, cx);
        return null;
      }
    });
  }
  copySelection() {
    if (this.diff.keyboardSelecting())
      this.diff.finishSelection();
    const selection = this.diff.selection();
    const change = this.changes[this.selectedChange];
    if (!selection || !change)
      return false;
    openCopySelection(this.services, { path: change.path, side: selection.side, lines: selection.lines, code: selection.code }, () => this.diff.clearSelection());
    return true;
  }
  lineHistory(cx) {
    const selection = this.diff.selection();
    const change = this.changes[this.selectedChange];
    if (!selection || !change)
      return;
    const target = this.target;
    let side = "Before";
    let revision = null;
    if (target.kind === "commit" && selection.side === "After") {
      side = "After";
      revision = target.commit;
    } else if (target.kind === "commit") {
      if (!target.parent)
        return;
      revision = target.parent;
    }
    const ranges = [];
    for (const line of this.diff.linesOn(side)) {
      const last = ranges[ranges.length - 1];
      if (last && last[1] + 1 === line)
        last[1] = line;
      else
        ranges.push([line, line]);
    }
    if (ranges.length === 0)
      return;
    const name = change.path.split("/").pop() ?? change.path;
    openLineHistory(this.services, `${name}:${lineNumbersText(selection.lines)}`, { file: change.path, ranges, revision }, { cols: this.size.cols, rows: this.size.rows }, cx);
  }
  reviewKey(key, cx) {
    if (key === "y")
      return this.copySelection();
    if (key === "h" && this.diff.selection()) {
      this.lineHistory(cx);
      return true;
    }
    if (key === "escape" && this.diff.hasSelection()) {
      this.diff.clearSelection();
      return true;
    }
    return false;
  }
  diffKey(event, cx) {
    if (isChord(event))
      return;
    const key = event.keystroke;
    let handled = true;
    if (key === "b")
      this.loadBlame(this.diff.cursor, cx);
    else if (key === "g" && !this.diff.keyboardSelecting())
      this.openLineJump();
    else if (this.reviewKey(key, cx))
      handled = true;
    else if (this.diff.key(event, cx)) {
      if (["up", "down", "j", "k", "home", "end"].includes(key))
        this.hoverRequest++;
      return;
    } else
      handled = false;
    if (!handled)
      return;
    cx.stop_propagation();
    cx.notify();
  }
  filesKey(event, cx) {
    if (this.files.key(event, cx) || event.keystroke === "b" && !isChord(event)) {
      if (event.keystroke === "b")
        this.loadBlame(this.diff.cursor, cx);
      cx.stop_propagation();
      cx.notify();
    }
  }
  comparisonKey(event, cx) {
    const key = event.key.toLowerCase();
    const index = event.modifiers.alt && key === "d" ? 0 : event.modifiers.alt && key === "m" ? 1 : null;
    const composed = event.key_char === "∂" ? 0 : event.key_char === "µ" ? 1 : null;
    const choice = index ?? composed;
    if (choice === null)
      return;
    cx.stop_propagation();
    this.selectComparison(choice, cx);
    cx.notify();
  }
  resize(column) {
    const divider = this.divider;
    const total = this.size.cols;
    if (divider === null || total < MIN_FILES + MIN_DIFF * 2)
      return;
    const [first, second] = changesPaneWidths(total, this.splits);
    const edge = first + second;
    const pointer = Math.max(0, Math.min(column, total));
    const target = divider === 0 ? Math.max(MIN_FILES, Math.min(pointer, edge - MIN_DIFF)) : Math.max(first + MIN_DIFF, Math.min(pointer, total - MIN_DIFF));
    this.splits[divider] = Math.floor(target * SPLIT_SCALE / total);
  }
  dividerElement(look, index, boundary) {
    const { t } = look;
    const shown = this.divider === index || this.hoveredDivider === index;
    return div9().id(`git-changes-divider-${index}`).absolute().top(0).bottom(0).left(cols(look, boundary - 1)).w(cols(look, 3)).cursor_col_resize().on_hover((hovered, cx) => {
      const next = hovered ? index : this.hoveredDivider === index ? null : this.hoveredDivider;
      if (next === this.hoveredDivider)
        return;
      this.hoveredDivider = next;
      cx.notify();
    }).on_mouse_down("left", (_, cx) => {
      cx.stop_propagation();
      this.divider = index;
      cx.notify();
    }).when(shown, (el) => el.child(div9().absolute().top(0).bottom(0).left(look.cell).w(look.cell).bg(t.accentSoft).child(div9().absolute().top(0).bottom(0).left(look.cell / 2 - 1).w(2).bg(t.accent))));
  }
  selectionTitle(look, side) {
    const selection = this.diff.selection();
    const change = this.changes[this.selectedChange];
    if (!selection || selection.side !== side || !change)
      return null;
    const name = change.path.split("/").pop() ?? change.path;
    return h_flex8().text_size(Math.max(10, look.size - 2)).font_weight(600).child(`${side.toUpperCase()} · `).child(div9().text_color(look.t.accentText).font_weight(600).child(`${name}:${lineNumbersText(selection.lines)}`));
  }
  diffBoxes(look) {
    const focused = this.focused === "diff" && !this.workspaces.isFocused();
    const panes = this.diff.render(look, {
      focused,
      hint: !this.services.overlay.isOpen(),
      onPointer: (_, row, cx) => {
        if (this.focused !== "diff")
          this.setFocus("diff");
        this.blameRequest++;
        this.blameLoading = false;
        this.blame = this.blame?.line === this.diff.lineNumber("After", row) ? this.blame : null;
        this.hoverBlame(row, cx);
      },
      onClick: (side, row, cx) => {
        this.setFocus("diff");
        this.hoverRequest++;
        if (this.diff.toggleFold(row))
          return;
        if (this.diff.keyboardSelecting()) {
          this.diff.finishSelection();
          return;
        }
        this.diff.beginSelection(side, row, false);
        this.loadBlame(row, cx);
      }
    });
    const before = box(look, {
      id: "git-changes-before",
      title: this.selectionTitle(look, "Before") ?? `Before · ${this.diff.language()}`,
      focused: focused && this.diff.side === "Before"
    }, panes.before).on_mouse_down("left", () => this.setFocus("diff"));
    const after = box(look, {
      id: "git-changes-after",
      title: this.selectionTitle(look, "After") ?? "After",
      focused: focused && this.diff.side === "After"
    }, panes.after).track_focus(this.diffHandle).on_key_down((event, cx) => this.diffKey(event, cx)).on_mouse_down("left", () => this.setFocus("diff"));
    return { before, after };
  }
  syncSelectionBlame(cx) {
    if (this.diff.dragging())
      return;
    const selection = this.diff.selection();
    const change = this.changes[this.selectedChange];
    this.selectionBlame.sync(this.services, selection && change && selection.side === "After" ? { file: change.path, lines: selection.lines, revision: blameRevision(this.target) } : null, cx);
  }
  render(look, size, cx) {
    this.size = size;
    if (!size.wide)
      this.divider = null;
    this.syncSelectionBlame(cx);
    const repository = this.services.repository();
    const filesBox = v_flex8().flex_1().min_h(0).min_w(0).on_key_down((event, cx) => this.filesKey(event, cx)).child(this.files.render(look, {
      focused: this.focused === "files" && !this.workspaces.isFocused(),
      hints: this.hints,
      repository: !repository || repository.state === "ready",
      owner: this.services.busy() ? this.stagingOwner : null
    }).flex_1());
    const left = v_flex8().min_h(0).min_w(0).gap(6).child(filesBox).child(v_flex8().flex_1().min_h(0).min_w(0).child(this.workspaces.render(look).flex_1()));
    const { before, after } = this.diffBoxes(look);
    const root = (size.wide ? h_flex8() : v_flex8()).id("git-changes").relative().size_full().min_h(0).min_w(0).gap(6).on_key_down((event, cx) => this.comparisonKey(event, cx)).on_mouse_up("left", (_, cx) => {
      this.divider = null;
      this.diff.pointerUp(cx);
      this.files.pointerUp(cx);
    }).on_mouse_move((event, cx) => {
      if (this.divider === null)
        return;
      this.resize(Math.round(event.local_position.x / look.screenCell));
      cx.notify();
    });
    if (!size.wide) {
      const first = Math.floor(size.rows * 25 / 100);
      const second = Math.floor(size.rows * 37 / 100);
      return root.child(left.h(rows(look, first)).flex_none()).child(before.h(rows(look, second)).flex_none()).child(after.flex_1());
    }
    const [first, second] = changesPaneWidths(size.cols, this.splits);
    return root.child(left.w(cols(look, first)).h_full().flex_none()).child(before.w(cols(look, second)).h_full().flex_none()).child(after.flex_1().h_full()).child(this.dividerElement(look, 0, first)).child(this.dividerElement(look, 1, first + second));
  }
}

// src/git/workflows.ts
function local(reference) {
  return reference.startsWith("refs/heads/") ? reference.slice("refs/heads/".length) : reference;
}
var FIXED = {
  fetch: ["fetch", "--all", "--prune"],
  pull: ["pull", "--ff-only"],
  stash: ["stash", "push", "--include-untracked"],
  "stash-pop": ["stash", "pop"]
};
function refArgs(operation) {
  switch (operation.kind) {
    case "create-branch":
      return ["branch", "--", operation.name, operation.commit];
    case "rename-branch":
      return ["branch", "-m", "--", local(operation.reference), operation.name];
    case "delete-branch":
      return ["branch", "-d", "--", local(operation.reference)];
    case "create-tag":
      return ["tag", "--", operation.name, operation.commit];
    case "checkout-commit":
      return ["checkout", "--detach", operation.target];
    case "checkout-branch":
      return ["switch", "--", operation.name];
    default:
      return null;
  }
}
function historyArgs(operation) {
  switch (operation.kind) {
    case "rebase":
      return ["rebase", operation.target];
    case "cherry-pick":
      return ["cherry-pick", operation.target];
    case "revert":
      return ["revert", "--no-edit", operation.target];
    case "reset":
      return ["reset", `--${operation.mode}`, operation.target];
    case "discard-tracked":
      return ["restore", `--source=${operation.head}`, "--staged", "--worktree", "--", "."];
    default:
      return null;
  }
}
function remoteArgs(operation) {
  switch (operation.kind) {
    case "commit":
      return ["commit", ...operation.amend ? ["--amend"] : [], "-m", operation.message];
    case "push":
      return [
        "push",
        ...operation.force ? ["--force-with-lease"] : [],
        "--set-upstream",
        "--",
        operation.remote,
        `HEAD:refs/heads/${operation.branch}`
      ];
    case "add-remote":
      return ["remote", "add", "--", operation.name, operation.url];
    case "remove-remote":
      return ["remote", "remove", "--", operation.name];
    default:
      return null;
  }
}
function operationArgs(operation) {
  return FIXED[operation.kind] ?? refArgs(operation) ?? historyArgs(operation) ?? remoteArgs(operation) ?? [];
}
function operationPreview(operation) {
  return `git ${operationArgs(operation).join(" ")}`;
}
function recoveryCommands(operation) {
  if (operation.kind === "rebase")
    return "git rebase --continue | --skip | --abort";
  if (operation.kind === "cherry-pick")
    return "git cherry-pick --continue | --skip | --abort";
  if (operation.kind === "revert")
    return "git revert --continue | --skip | --abort";
  return null;
}
async function read(git, args) {
  const result = await git(args);
  return result.code === 0 ? result.stdout.trim() : null;
}
async function must(git, args) {
  const result = await git(args);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `git ${args[0]} exited with ${result.code}`);
  return result.stdout.trim();
}
async function remoteNames(git) {
  return (await must(git, ["remote"])).split(`
`).filter(Boolean);
}
async function untrackedContent(git) {
  const paths = (await must(git, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\x00").filter(Boolean);
  const hashes = [];
  for (let index = 0;index < paths.length; index += 100)
    hashes.push(await must(git, ["hash-object", "--no-filters", "--", ...paths.slice(index, index + 100)]));
  return hashes;
}
async function fingerprint(git) {
  return JSON.stringify([
    await read(git, ["rev-parse", "--verify", "HEAD"]),
    await read(git, ["symbolic-ref", "--quiet", "HEAD"]),
    await must(git, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    await must(git, ["diff", "--binary", "--no-ext-diff"]),
    await must(git, ["diff", "--cached", "--binary", "--no-ext-diff"]),
    await untrackedContent(git)
  ]);
}
async function branchGuard(git, operation) {
  if (operation.kind !== "rename-branch" && operation.kind !== "delete-branch")
    return;
  if (!operation.reference.startsWith("refs/heads/"))
    throw new Error("Only local branches can be changed.");
  const record = await read(git, [
    "for-each-ref",
    "--format=%(objectname)%00%(HEAD)%00%(worktreepath)",
    operation.reference
  ]);
  const [commit = "", head = "", worktree = ""] = (record ?? "").split("\x00");
  if (commit !== operation.expected)
    throw new Error("Branch changed or no longer exists. Refresh and try again.");
  const current = head === "*";
  if (operation.kind === "delete-branch") {
    if (current || worktree)
      throw new Error("Cannot delete a branch checked out in a worktree.");
    return;
  }
  if (!current && worktree)
    throw new Error("Cannot rename a branch checked out in another worktree.");
  if (operation.name === local(operation.reference))
    throw new Error("Enter a different branch name.");
  await must(git, ["check-ref-format", `refs/heads/${operation.name}`]);
}
async function guard(git, operation) {
  if (operation.kind === "discard-tracked" && await read(git, ["rev-parse", "HEAD"]) !== operation.head)
    throw new Error("Discard stopped because HEAD changed. Refresh and try again.");
  if (operation.kind === "push") {
    if (await read(git, ["symbolic-ref", "--quiet", "--short", "HEAD"]) !== operation.branch)
      throw new Error("Push stopped because the current branch changed. Try again.");
    if (!(await remoteNames(git)).includes(operation.remote))
      throw new Error("The selected remote no longer exists. Try again.");
  }
  if (operation.kind === "reset" && (await read(git, ["symbolic-ref", "--quiet", "--short", "HEAD"]) !== operation.branch || await read(git, ["rev-parse", "--verify", "HEAD"]) !== operation.head))
    throw new Error("Reset stopped because the current branch or HEAD changed. Refresh and try again.");
  await branchGuard(git, operation);
}
async function verifyDiscard2(git, head) {
  const remaining = await must(git, ["diff", "--name-only", "--ignore-submodules=dirty", head, "--"]);
  const staged = await must(git, ["diff", "--cached", "--name-only", head, "--"]);
  if (remaining || staged)
    throw new Error(`Discard incomplete. Tracked changes remain. Filename case collisions require a case-sensitive filesystem; concurrent edits can also leave changes.
Some files may already have been restored. Review the file list.

${remaining}
${staged}`.trimEnd());
}

class ReviewedOperation {
  operation;
  snapshot;
  constructor(operation, snapshot) {
    this.operation = operation;
    this.snapshot = snapshot;
  }
  static async review(git, operation) {
    return new ReviewedOperation(operation, operation.kind === "reset" || operation.kind === "discard-tracked" ? await fingerprint(git) : null);
  }
  get preview() {
    return operationPreview(this.operation);
  }
  async run(git) {
    if (this.snapshot !== null && await fingerprint(git) !== this.snapshot)
      throw new Error("Repository changed after review; review the operation again.");
    await guard(git, this.operation);
    const result = await git(["-c", "core.editor=true", ...operationArgs(this.operation)]);
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    const message = [stdout, stderr].filter(Boolean).join(`
`) || "Git completed without output.";
    if (result.code !== 0)
      throw new Error(message);
    if (this.operation.kind === "discard-tracked")
      await verifyDiscard2(git, this.operation.head);
    return message;
  }
}
async function validateName(git, kind, name) {
  const result = await git(kind === "branch" ? ["check-ref-format", "--branch", name] : ["check-ref-format", `refs/tags/${name}`]);
  if (result.code === 0)
    return null;
  return result.stderr.trim() || `'${name}' is not a valid ${kind} name`;
}
async function headMessage(git) {
  return (await must(git, ["log", "-1", "--format=%B"])).trimEnd();
}
async function commitSubject(git, sha) {
  return read(git, ["show", "-s", "--format=%s", "--end-of-options", sha]);
}

// src/ui/commands/branch.ts
import { h_flex as h_flex10, v_flex as v_flex10 } from "gpui-base";
import { div as div11 } from "gpui-kit";

// src/git/ref-operations.ts
async function must2(git, args) {
  const result = await git(args);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `git ${args[0]} exited with ${result.code}`);
  return result.stdout;
}
function branchName(reference) {
  for (const prefix of ["refs/heads/", "refs/remotes/"])
    if (reference.startsWith(prefix))
      return reference.slice(prefix.length);
  return reference;
}
async function readBranches(git) {
  const output = await must2(git, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(symref)%00%(worktreepath)",
    "refs/heads/",
    "refs/remotes/"
  ]);
  const branches = [];
  for (const line of output.split(`
`)) {
    const [reference = "", commit = "", head = "", symref = "", worktree = ""] = line.split("\x00");
    if (!reference || !commit || symref)
      continue;
    branches.push({ reference, commit, current: head === "*", worktree: worktree || null });
  }
  return branches.sort((left, right) => Number(!left.current) - Number(!right.current) || Number(!left.reference.startsWith("refs/heads/")) - Number(!right.reference.startsWith("refs/heads/")) || branchName(left.reference).localeCompare(branchName(right.reference)));
}
async function readBranchTargets2(git) {
  const output = await must2(git, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%00%(refname:short)%00%(objectname)",
    "refs/heads",
    "refs/remotes"
  ]);
  const targets = [];
  for (const line of output.split(`
`)) {
    const [reference = "", name = "", commit = ""] = line.split("\x00");
    if (!reference || !name || !commit)
      continue;
    if (reference.startsWith("refs/remotes/") && name.endsWith("/HEAD"))
      continue;
    targets.push({ name, reference, commit });
  }
  return targets;
}

// src/ui/commands/catalog.ts
var COMMANDS = [
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
  "update"
];
var TITLES = {
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
  "copy-sha": "Copy SHA…"
};
var RESULT_NAMES = {
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
  "switch-repository": "Git operation"
};
var PROGRESS = {
  fetch: "Fetching",
  pull: "Pulling",
  commit: "Committing",
  push: "Pushing",
  "stash-changes": "Stashing",
  branches: "Managing branches",
  "branch-at-head": "Creating",
  reset: "Resetting"
};
function progressLabel(id) {
  return PROGRESS[id] ?? "Running";
}
var STATUS2 = {
  "no remotes configured": "No remote",
  "detached HEAD": "Detached HEAD",
  "no upstream configured": "No upstream",
  "working tree is clean": "Clean",
  "stash is empty": "No stash",
  "no commit selected": "No commit",
  "working tree has changes; stash or commit first": "Changes present"
};
function statusLabel(reason) {
  if (reason === null)
    return "";
  return STATUS2[reason] ?? "Unavailable";
}
var ALWAYS = ["refresh", "update", "switch-repository"];
var OPEN = [
  "branches",
  "add-remote",
  "show-remotes",
  "remove-remote",
  "commit",
  "interactive-rebase",
  "stash"
];
var CLEAN = ["checkout", "rebase", "cherry-pick", "revert"];
var REASONS = {
  "discard-all": (context) => {
    if (!context.head)
      return "no HEAD commit to restore";
    return context.changes ? null : "working tree is clean";
  },
  reset: (context) => {
    if (!context.branch)
      return "checkout a branch before resetting";
    return context.head ? null : "no commits to reset";
  },
  "branch-at-head": (context) => context.head ? null : "no commits available",
  fetch: (context) => context.remotes.length ? null : "no remotes configured",
  pull: (context) => {
    if (!context.branch)
      return "detached HEAD";
    return context.upstream ? null : "no upstream configured";
  },
  push: (context) => {
    if (!context.branch)
      return "detached HEAD";
    return context.remotes.length ? null : "no remotes configured";
  },
  "stash-changes": (context) => context.changes ? null : "working tree is clean",
  "stash-pop": (context) => context.stash ? null : "stash is empty"
};
function unavailable(id, context) {
  if (ALWAYS.includes(id))
    return null;
  if (!context.repository)
    return "not a Git repository";
  const reason = REASONS[id];
  if (reason)
    return reason(context);
  if (OPEN.includes(id))
    return null;
  if (!context.selected)
    return "no commit selected";
  return CLEAN.includes(id) && context.changes ? "working tree has changes; stash or commit first" : null;
}
var RESET_MODES = [
  { mode: "soft", label: "Soft", summary: "Keep index and working tree" },
  { mode: "mixed", label: "Mixed", summary: "Reset index; keep working tree" },
  { mode: "hard", label: "Hard", summary: "Reset index and tracked working tree" }
];

// src/ui/commands/dialog.ts
import { h_flex as h_flex9, InputState as InputState2, v_flex as v_flex9 } from "gpui-base";
import { div as div10 } from "gpui-kit";
class Dialog {
  overlay;
  handle;
  inputs = [];
  spec = null;
  released = false;
  constructor(overlay, cx) {
    this.overlay = overlay;
    this.handle = cx.focus_handle();
  }
  input(placeholder = "", value = "") {
    const input = InputState2.new({ placeholder, value });
    input.on("change", (_, cx) => {
      this.changed();
      cx.notify();
    });
    this.inputs.push(input);
    return input;
  }
  changed() {}
  show() {
    const options = this.options();
    const current = () => this.options();
    const spec = {
      kind: "custom",
      title: options.title,
      width: options.width,
      get height() {
        return current().height;
      },
      render: (look) => this.body(look).track_focus(this.handle),
      key: (event, cx) => this.key(event, cx),
      onCancel: () => this.release()
    };
    this.spec = spec;
    this.overlay.open(spec);
    this.handle.focus();
  }
  isOpen() {
    return this.spec !== null && this.overlay.current() === this.spec;
  }
  close(cx) {
    if (this.isOpen())
      this.overlay.close(cx);
    this.release();
  }
  release() {
    this.spec = null;
    if (this.released)
      return;
    this.released = true;
    for (const input of this.inputs)
      input.release();
    this.inputs = [];
    this.handle.release();
  }
}
function inputBox(look, id, title, input, focused = false) {
  const { t } = look;
  return v_flex9().id(id).flex_none().gap(4).child(div10().text_size(Math.max(10, look.size - 2)).font_weight(600).text_color(focused ? t.accentText : t.secondary).child(title.toUpperCase())).child(h_flex9().h(look.row + 8).px(8).items_center().bg(t.background).border(1).border_color(focused ? t.accent : t.lineStrong).rounded(2).child(textInput(look, input)));
}

// src/ui/commands/host.ts
function errorMessage2(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/ui/commands/branch.ts
function openNamePrompt(host, command, value = "", error) {
  const overlay = host.services.overlay;
  overlay.open({
    kind: "form",
    title: TITLES[command],
    width: DIALOG.medium,
    fields: [{ label: "Name", value }],
    primary: "[Enter] Continue",
    onSubmit: (fields, cx) => {
      const name = (fields[0] ?? "").trim();
      const git = host.services.git();
      if (!git)
        return "Error: Not a Git repository";
      const context = host.context();
      const commit = command === "branch-at-head" ? context.head : context.selected;
      if (!commit)
        return `Error: ${command === "branch-at-head" ? "no commits available" : "no commit selected"}`;
      const repository = host.services.context();
      cx.spawn(async (cx) => {
        const invalid = await validateName(git, command === "tag" ? "tag" : "branch", name);
        if (repository !== host.services.context())
          return;
        if (invalid)
          openNamePrompt(host, command, name, `Invalid name: ${invalid}`);
        else
          host.confirm(command, command === "tag" ? { kind: "create-tag", name, commit } : { kind: "create-branch", name, commit }, cx);
        cx.notify();
      });
      return null;
    }
  });
  if (error)
    overlay.setError(`Error: ${error}`);
}
var ACTIONS = [
  { id: "new", label: "[Ctrl+N] New" },
  { id: "rename", label: "[F2] Rename" },
  { id: "delete", label: "[Del] Delete" },
  { id: "refresh", label: "[F5] Refresh" },
  { id: "close", label: "[Esc] Close" }
];
var isLocal = (branch) => branch.reference.startsWith("refs/heads/");

class BranchManager extends Dialog {
  host;
  entries = [];
  loading = true;
  readError = null;
  message = null;
  renameError = null;
  preferred = null;
  state = { kind: "list" };
  query;
  list = new ListViewport("git-branches");
  request = 0;
  constructor(host, cx) {
    super(host.services.overlay, cx);
    this.host = host;
    this.query = this.input();
  }
  open(cx) {
    this.show();
    this.query.focus();
    this.load(cx);
  }
  options() {
    return { title: "Branches", width: DIALOG.wide, height: 20 };
  }
  changed() {
    this.renameError = null;
    if (this.state.kind === "list")
      this.list.reset();
  }
  load(cx) {
    const git = this.host.services.git();
    if (!git)
      return;
    const request = ++this.request;
    this.loading = true;
    this.readError = null;
    cx.spawn(async (cx) => {
      try {
        const entries = await readBranches(git);
        if (request !== this.request)
          return;
        this.entries = entries;
        const index = this.rows().findIndex((branch) => branch.reference === this.preferred);
        if (index >= 0)
          this.list.selected = index;
        this.preferred = null;
      } catch (error) {
        if (request !== this.request)
          return;
        this.readError = `F5 to retry. ${errorMessage2(error)}`;
      }
      this.loading = false;
      this.list.clamp(this.rows().length);
      cx.notify();
    });
  }
  rows() {
    const query = this.query.value().toLowerCase();
    return this.entries.filter((branch) => branch.reference.toLowerCase().includes(query));
  }
  selected() {
    return this.rows()[this.list.selected] ?? null;
  }
  mutating() {
    return this.host.services.busy() === "Managing branches";
  }
  allowed(action) {
    if (action === "close")
      return null;
    if (this.loading)
      return "Loading branches. Please wait.";
    if (action === "new")
      return unavailable("branch-at-head", this.host.context());
    if (action === "refresh")
      return null;
    const branch = this.selected();
    if (!branch)
      return "Select a local branch.";
    if (!isLocal(branch))
      return "Only local branches can be renamed or deleted.";
    if (action === "delete" && (branch.current || branch.worktree))
      return "Cannot delete a branch checked out in a worktree.";
    if (action === "rename" && !branch.current && branch.worktree)
      return "Cannot rename a branch checked out in another worktree.";
    return null;
  }
  act(action, cx) {
    if (this.mutating())
      return;
    const reason = this.allowed(action);
    if (reason) {
      this.message = { success: false, text: reason };
      return;
    }
    const branch = this.selected();
    if (action === "close")
      this.close(cx);
    else if (action === "refresh") {
      this.state = { kind: "list" };
      this.load(cx);
    } else if (action === "new") {
      this.close(cx);
      this.host.dispatch("branch-at-head", cx);
    } else if (branch && action === "rename") {
      const input = this.input("", branchName(branch.reference));
      this.message = null;
      this.state = { kind: "rename", branch, input };
      input.focus();
    } else if (branch) {
      this.message = null;
      this.state = { kind: "delete", branch };
      this.handle.focus();
    }
  }
  operation() {
    const state = this.state;
    if (state.kind === "rename")
      return {
        kind: "rename-branch",
        reference: state.branch.reference,
        name: state.input.value(),
        expected: state.branch.commit
      };
    if (state.kind === "delete")
      return { kind: "delete-branch", reference: state.branch.reference, expected: state.branch.commit };
    return null;
  }
  submit(cx) {
    if (this.mutating() || this.loading)
      return;
    const state = this.state;
    if (state.kind === "rename") {
      const name = state.input.value();
      if (!name)
        this.renameError = "Enter a branch name.";
      else if (name === branchName(state.branch.reference))
        this.renameError = "Enter a different branch name.";
      if (this.renameError)
        return;
    }
    const operation = this.operation();
    if (!operation)
      return;
    this.host.run("branches", operation, cx, (success, output, cx) => this.finish(operation, success, output, cx));
  }
  finish(operation, success, output, cx) {
    if (!this.isOpen())
      return false;
    if (!success && operation.kind === "rename-branch" && this.state.kind === "rename") {
      this.renameError = output;
      return true;
    }
    this.state = { kind: "list" };
    this.query.focus();
    this.message = { success, text: output || (success ? "Branch updated." : "Branch change failed.") };
    this.preferred = operation.kind === "rename-branch" ? `refs/heads/${operation.name}` : null;
    this.load(cx);
    return true;
  }
  cancelForm() {
    this.state = { kind: "list" };
    this.renameError = null;
    this.query.focus();
  }
  key(event, cx) {
    const key = event.keystroke;
    if (this.state.kind !== "list") {
      if (key === "enter")
        this.submit(cx);
      else if (key === "escape")
        this.cancelForm();
      else if (key === "f5")
        this.act("refresh", cx);
      else
        return false;
      return true;
    }
    const shortcuts = {
      "ctrl-n": "new",
      f2: "rename",
      enter: "rename",
      delete: "delete",
      f5: "refresh",
      escape: "close"
    };
    const action = shortcuts[key];
    if (action)
      this.act(action, cx);
    else
      return this.list.key(event, this.rows().length, false) === "moved";
    return true;
  }
  selectionStatus() {
    const lines = [];
    const branch = this.selected();
    if (!this.rows().length)
      lines.push({ text: this.entries.length ? "No matching branches." : "No branches yet.", tone: "hint" });
    else if (branch)
      lines.push({ text: branch.reference, tone: "text" });
    const reason = this.message ? null : ["new", "rename", "delete"].map((action) => this.allowed(action)).find(Boolean);
    if (reason)
      lines.push({ text: reason, tone: "hint" });
    return lines;
  }
  statusLines(look) {
    const { t } = look;
    const lines = [];
    const line = (text, color) => lines.push(div11().whitespace_normal().text_color(color).child(text));
    if (this.loading)
      line("Loading branches", t.hint);
    if (this.readError)
      for (const text of this.readError.split(`
`))
        line(text, t.error);
    else if (!this.loading)
      for (const entry of this.selectionStatus())
        line(entry.text, t[entry.tone]);
    if (this.message)
      for (const text of this.message.text.split(`
`))
        line(text, this.message.success ? t.accent : t.error);
    line("Remote branches reflect the last fetch.", t.hint);
    return lines;
  }
  branchRow(look, branch, width) {
    const { t } = look;
    const local = isLocal(branch);
    const kind = local ? "Local" : "Remote";
    const flag = branch.current ? " *" : branch.worktree ? " Worktree" : "";
    const commit = branch.commit.slice(0, 8);
    const nameWidth = Math.max(1, width - 2 - (kind.length + commit.length + flag.length + 2));
    return h_flex10().child(div11().text_color(local ? t.accent : t.secondary).child(kind)).child(div11().child(" ")).child(div11().text_color(t.text).child(truncateToWidth(branchName(branch.reference), nameWidth))).child(div11().child(" ")).child(div11().text_color(t.hint).child(commit)).when(!!flag, (el) => el.child(div11().text_color(branch.current ? t.accent : t.warning).when(branch.current, (el) => el.font_weight(700)).child(flag)));
  }
  listBody(look) {
    const rowsList = this.rows();
    const buttons = h_flex10().flex_none().gap(look.cell);
    for (const action of ACTIONS) {
      const enabled = this.allowed(action.id) === null;
      buttons.child(div11().id(`git-branches-${action.id}`).flex_1().min_w(0).h(rows(look, 3)).flex().items_center().justify_center().border(1).border_color(look.t.rule).text_color(enabled ? look.t.text : look.t.muted).truncate().when(enabled, (el) => el.cursor_pointer().hover((style) => style.bg(look.t.hover))).child(action.label).on_click((_, cx) => {
        cx.stop_propagation();
        this.act(action.id, cx);
        cx.notify();
      }));
    }
    return v_flex10().size_full().child(inputBox(look, "git-branches-search", "Search", this.query, true)).child(v_flex10().flex_1().min_h(0).child(this.list.render(look, {
      length: rowsList.length,
      focused: true,
      marker: true,
      row: ({ index }) => {
        const branch = rowsList[index];
        return branch ? this.branchRow(look, branch, DIALOG.wide - 4) : div11();
      },
      onSelect: (index) => {
        this.list.selected = index;
      }
    }))).child(v_flex10().flex_none().max_h(rows(look, 6)).overflow_hidden().children(this.statusLines(look))).child(buttons);
  }
  formBody(look, state) {
    const { t } = look;
    const busy = this.mutating();
    const details = v_flex10().flex_1().min_h(0).overflow_hidden();
    const line = (text, color) => details.child(div11().whitespace_normal().text_color(color).child(text));
    if (busy)
      line("Applying branch change", t.hint);
    if (state.kind === "rename" && this.renameError) {
      for (const text of this.renameError.split(`
`))
        line(text, t.error);
      line("F5 refresh; Cancel to reselect.", t.hint);
    }
    if (state.kind === "delete") {
      line("Only deletes the local branch. Git refuses unmerged branches; remote branches are unchanged.", t.text);
      if (this.message)
        for (const text of this.message.text.split(`
`))
          line(text, t.error);
    }
    const operation = this.operation();
    line(operation ? operationPreview(operation) : "", t.accent);
    line(state.branch.reference, t.text);
    line(state.branch.commit, t.text);
    const repository = this.host.services.repository();
    line(repository?.state === "ready" ? repository.root : "", t.text);
    return v_flex10().size_full().when(state.kind === "rename", (el) => el.child(state.kind === "rename" ? inputBox(look, "git-branch-name", "New name", state.input, true) : div11())).child(details).child(dialogFooter(look, {
      id: "git-branch-submit",
      label: state.kind === "rename" ? "[Enter] Save" : "[Enter] Delete",
      enabled: !busy,
      onClick: (cx) => this.submit(cx)
    }, { id: "git-branch-cancel", label: "[Esc] Cancel", enabled: !busy, onClick: () => this.cancelForm() }));
  }
  body(look) {
    const state = this.state;
    return v_flex10().size_full().min_h(rows(look, 16)).child(state.kind === "list" ? this.listBody(look) : this.formBody(look, state));
  }
}

// src/ui/commands/commit.ts
import { h_flex as h_flex11, Textarea, TextareaState, v_flex as v_flex11 } from "gpui-base";
import { div as div12 } from "gpui-kit";
var CYCLE = ["subject", "description", "amend", "submit", "cancel"];
function splitMessage(message) {
  const index = message.indexOf(`
`);
  if (index < 0)
    return { subject: message.replace(/\r$/, ""), description: "" };
  return {
    subject: message.slice(0, index).replace(/\r$/, ""),
    description: message.slice(index + 1).replace(/^[\r\n]+|[\r\n]+$/g, "")
  };
}

class CommitDialog extends Dialog {
  host;
  focus = "subject";
  amend;
  error;
  progress = null;
  subject;
  description;
  constructor(host, cx, values) {
    super(host.services.overlay, cx);
    this.host = host;
    this.subject = this.input("Subject", values?.subject ?? "");
    this.description = TextareaState.new({ placeholder: "Description", value: values?.description ?? "", rows: 6 });
    this.description.on("change", (_, cx) => {
      this.error = null;
      cx.notify();
    });
    this.amend = values?.amend ?? false;
    this.error = values?.error ?? null;
  }
  open() {
    this.show();
    this.subject.focus();
  }
  options() {
    return { title: "Commit", width: DIALOG.wide, height: 18 };
  }
  changed() {
    this.error = null;
  }
  release() {
    super.release();
    this.description.release();
  }
  values() {
    return {
      subject: this.subject.value(),
      description: this.description.value(),
      amend: this.amend,
      error: this.error
    };
  }
  message() {
    const subject = this.subject.value().trim();
    const description = this.description.value().trim();
    return description ? `${subject}

${description}` : subject;
  }
  setFocus(focus) {
    this.focus = focus;
    if (focus === "subject")
      this.subject.focus();
    else if (focus === "description")
      this.description.focus();
    else
      this.handle.focus();
  }
  toggleAmend(cx) {
    this.amend = !this.amend;
    this.error = null;
    this.setFocus("subject");
    if (!this.amend)
      return;
    const git = this.host.services.git();
    if (!git) {
      this.error = "Not a Git repository";
      this.amend = false;
      return;
    }
    if (!this.host.context().head) {
      this.error = "No HEAD commit to amend.";
      this.amend = false;
      return;
    }
    this.progress = "Loading HEAD message";
    cx.spawn(async (cx) => {
      try {
        const { subject, description } = splitMessage(await headMessage(git));
        if (this.isOpen() && this.amend) {
          this.subject.set_value(subject);
          this.description.set_value(description);
        }
      } catch (error) {
        this.error = errorMessage2(error);
      }
      this.progress = null;
      cx.notify();
    });
  }
  submit(cx) {
    const context = this.host.context();
    if (!this.subject.value().trim())
      this.error = "Enter a commit subject.";
    else if (this.amend && !context.head)
      this.error = "No HEAD commit to amend.";
    else if (!this.amend && !context.staged)
      this.error = "Stage changes before committing.";
    if (this.error)
      return;
    const values = this.values();
    const message = this.message();
    this.close(cx);
    this.host.run("commit", { kind: "commit", message, amend: values.amend }, cx, (success, output, cx) => {
      if (success)
        return false;
      new CommitDialog(this.host, cx, { ...values, error: output }).open();
      return true;
    });
  }
  activate(cx) {
    if (this.focus === "cancel")
      this.close(cx);
    else
      this.submit(cx);
  }
  key(event, cx) {
    const key = event.keystroke;
    const index = CYCLE.indexOf(this.focus);
    if (key === "tab")
      this.setFocus(CYCLE[(index + 1) % CYCLE.length] ?? "subject");
    else if (key === "shift-tab")
      this.setFocus(CYCLE[(index + CYCLE.length - 1) % CYCLE.length] ?? "subject");
    else if (key === "shift-enter" && this.focus === "subject")
      this.setFocus("description");
    else if (key === "enter")
      this.activate(cx);
    else if (key === "space" && this.focus === "amend")
      this.toggleAmend(cx);
    else
      return false;
    return true;
  }
  check(look, id, label, on, focus, toggle) {
    const { t } = look;
    const focused = this.focus === focus;
    return h_flex11().id(id).flex_none().h(look.row + 6).px(6).gap(8).items_center().cursor_pointer().rounded(2).when(focused, (el) => el.bg(t.accentSoft).font_weight(600)).hover((style) => style.bg(focused ? t.accentSoft : t.hover)).child(h_flex11().flex_none().w(16).h(16).items_center().justify_center().rounded(2).border(1).border_color(on ? t.accent : t.lineStrong).bg(on ? t.accent : t.background).text_color(t.textInverse).font_weight(700).child(on ? "✓" : "")).child(div12().text_color(t.text).child(label)).on_click((_, cx) => {
      cx.stop_propagation();
      toggle(cx);
      cx.notify();
    });
  }
  status(look) {
    const { t } = look;
    if (this.error)
      return div12().h(look.row).truncate().text_color(t.error).child(`Error: ${this.error}`);
    if (this.progress)
      return footerHint(look, this.progress);
    return div12().h(look.row);
  }
  body(look) {
    const { t } = look;
    return v_flex11().size_full().min_h(rows(look, 14)).child(inputBox(look, "git-commit-subject", "Subject", this.subject, this.focus === "subject")).child(box(look, { id: "git-commit-description", title: "Description", focused: this.focus === "description" }, h_flex11().size_full().child(Textarea.new(this.description).size_full().text_color(t.text))).flex_1().min_h(rows(look, 5))).child(this.check(look, "git-commit-amend", "Amend", this.amend, "amend", (cx) => this.toggleAmend(cx))).child(this.status(look)).child(dialogFooter(look, {
      id: "git-commit-submit",
      label: "[Enter] Commit",
      focused: this.focus === "submit",
      onClick: (cx) => this.submit(cx)
    }, {
      id: "git-commit-cancel",
      label: "[Esc] Cancel",
      focused: this.focus === "cancel",
      onClick: (cx) => this.close(cx)
    }));
  }
}

// src/ui/commands/confirm.ts
import { v_flex as v_flex13 } from "gpui-base";
import { div as div14 } from "gpui-kit";

// src/ui/shell.ts
import { Button as Button3, h_flex as h_flex12, v_flex as v_flex12 } from "gpui-base";
import { div as div13 } from "gpui-kit";

// src/version.ts
var VERSION = "0.3.0";
var BUNDLE_ASSET = "main.js";
var BUNDLE_LIMIT = 1024 * 1024;
function bundleHeader(version) {
  return `// Herdr Git Mods v${version}
`;
}

// src/ui/shell.ts
var TAB_ORDER = ["changes", "graph", "files", "settings"];
var TAB_LABELS = {
  changes: { label: "Changes", shortcut: "1" },
  graph: { label: "Graph", shortcut: "2" },
  files: { label: "Files", shortcut: "3" },
  settings: { label: "Settings", shortcut: "," }
};
var QUICK_ACTIONS = [
  { id: "fetch", label: "Fetch", shortcut: "f", icon: "fetch" },
  { id: "pull", label: "Pull", shortcut: "l", symbol: "↓" },
  { id: "commit", label: "Commit", shortcut: "c", symbol: "●" },
  { id: "push", label: "Push", shortcut: "u", symbol: "↑" },
  { id: "branch", label: "Branch", shortcut: "b", icon: "branch" },
  { id: "stash", label: "Stash", shortcut: "s", symbol: "≡" }
];
var SHORTCUT_CODES = {
  "1": "changes",
  "2": "graph",
  "3": "files",
  ",": "settings",
  p: "commands",
  w: "workspace",
  o: "files-search",
  a: "actions",
  f: "fetch",
  l: "pull",
  c: "commit",
  u: "push",
  b: "branch",
  s: "stash",
  x: "checkout",
  r: "rebase",
  y: "cherry-pick",
  v: "revert",
  t: "reset",
  h: "copy-sha",
  "≤": "settings",
  π: "commands",
  "∑": "workspace",
  ø: "files-search",
  å: "actions",
  ƒ: "fetch",
  "¬": "pull",
  ç: "commit",
  "∫": "branch",
  ß: "stash",
  "≈": "checkout",
  "®": "rebase",
  "¥": "cherry-pick",
  "√": "revert",
  "†": "reset",
  "˙": "copy-sha"
};
var SHORT_SHA = 8;
var SELECTED_MIN_COLS = 80;
function shortCommit(sha) {
  return sha.slice(0, SHORT_SHA);
}
function appShortcut(event, hints) {
  const { alt, control, platform } = event.modifiers;
  if (control || platform || !alt && !hints)
    return null;
  for (const candidate of [event.key, event.key_char ?? ""]) {
    const shortcut = SHORTCUT_CODES[candidate.toLowerCase()];
    if (shortcut)
      return shortcut;
  }
  return null;
}
function identityText(facts) {
  return facts.identity ? `${facts.identity.name}(${facts.identity.email})` : "Local unavailable";
}

class Shell {
  host;
  hints = false;
  statusScroll = 0;
  statusCols = 0;
  constructor(host) {
    this.host = host;
  }
  modifiersChanged(alt, cx) {
    if (this.hints === alt)
      return;
    this.hints = alt;
    cx.notify();
  }
  keyDown(event, cx) {
    if (this.host.overlayOpen())
      return;
    const shortcut = appShortcut(event, this.hints);
    if (shortcut) {
      this.dispatch(shortcut, cx);
    } else if (event.keystroke === "tab") {
      const index = TAB_ORDER.indexOf(this.host.active().id);
      this.host.setTab(TAB_ORDER[(index + 1) % TAB_ORDER.length] ?? "changes", cx);
    } else if (event.keystroke !== "escape" || !this.host.active().escape?.(cx))
      return;
    cx.stop_propagation();
    cx.notify();
  }
  dispatch(shortcut, cx) {
    if (shortcut === "changes" || shortcut === "graph" || shortcut === "files" || shortcut === "settings")
      this.host.setTab(shortcut, cx);
    else if (shortcut === "commands")
      this.host.commands().openPalette(cx);
    else if (!this.host.active().shortcut?.(shortcut, cx))
      this.host.commands().shortcut(shortcut, cx);
  }
  tabsRow(look) {
    const { t } = look;
    const active = this.host.active().id;
    const row = h_flex12().flex_none().w_full().px(6).gap(2).items_center().bg(t.panel).border_b(1).border_color(t.rule).whitespace_nowrap();
    const entries = [
      ...TAB_ORDER.slice(0, 3).map((tab) => ({
        id: `git-tab-${tab}`,
        ...TAB_LABELS[tab],
        active: active === tab,
        onClick: (cx) => this.host.setTab(tab, cx)
      })),
      {
        id: "git-tab-commands",
        label: "Commands",
        shortcut: "P",
        active: false,
        onClick: (cx) => this.host.commands().openPalette(cx)
      },
      {
        id: "git-tab-settings",
        ...TAB_LABELS.settings,
        active: active === "settings",
        onClick: (cx) => this.host.setTab("settings", cx)
      }
    ];
    for (const entry of entries)
      row.child(tabLabel(look, entry, this.hints));
    return row.child(div13().flex_1()).child(Button3.new("git-version").accessibility_label(`Herdr Git Mods ${VERSION}`).flex_none().h(look.row + 2).px(8).items_center().bg(t.hover).border(1).border_color(t.rule).rounded(2).text_size(Math.max(10, look.size - 2)).text_color(t.hint).hover((style) => style.bg(t.accentSoft).border_color(t.accent).text_color(t.accentText)).child(`v${VERSION}`).on_click((_, cx) => {
      cx.stop_propagation();
      this.host.setTab("settings", cx);
      cx.notify();
    }));
  }
  quickActions(look) {
    const commands = this.host.commands();
    return actionBar(look, QUICK_ACTIONS.map((action) => {
      const state = commands.quickActionState(action.id);
      return {
        ...action,
        id: `git-quick-${action.id}`,
        variant: state.primary ? "primary" : "secondary",
        enabled: state.enabled,
        running: state.running,
        onClick: (cx) => commands.quickAction(action.id, cx)
      };
    }), this.hints);
  }
  header(look) {
    const tab = this.host.active();
    const controls = v_flex12().flex_none().w_full().px(6).pt(6).gap(6).child(this.quickActions(look));
    if (tab.toolbar)
      controls.child(actionBar(look, tab.toolbar(look, this.hints), this.hints));
    if (tab.info) {
      const info = tab.info(look);
      if (info)
        controls.child(h_flex12().flex_none().h(look.row + 2).px(8).items_center().bg(look.t.panel).border(1).border_color(look.t.rule).overflow_hidden().whitespace_nowrap().child(info));
    }
    return v_flex12().flex_none().w_full().child(this.tabsRow(look)).child(controls);
  }
  branchLine(look, line) {
    const { t } = look;
    const repository = line.repository;
    if (repository?.state !== "ready")
      return [div13().text_color(t.hint).child("No repository")];
    const head = line.facts.head;
    const selected = line.graph && this.statusCols >= SELECTED_MIN_COLS && line.status.selected && line.status.selected !== head ? ` · Selected: ${shortCommit(line.status.selected)}` : "";
    const branch = repository.branch.name;
    if (branch) {
      const suffix = `${head ? ` · HEAD ${shortCommit(head)}` : " · Uncommitted"}${selected}`;
      const budget = Math.max(0, Math.max(40, this.statusCols) - 2 - (8 + displayWidth(suffix)));
      return [
        div13().text_color(t.hint).child("Branch: "),
        div13().text_color(t.accentText).font_weight(600).child(truncateToWidth(branch, budget)),
        div13().text_color(t.hint).child(suffix)
      ];
    }
    if (head)
      return [
        div13().text_color(t.warning).child(`Detached HEAD: ${shortCommit(head)}`),
        div13().text_color(t.hint).child(selected)
      ];
    return [div13().text_color(t.hint).child("Uncommitted")];
  }
  scrollStatus(event, look, cx) {
    const horizontal = Math.abs(event.delta.x) > Math.abs(event.delta.y) ? event.delta.x : event.delta.y;
    if (!event.modifiers.shift && Math.abs(event.delta.x) <= Math.abs(event.delta.y))
      return;
    const next = Math.max(0, this.statusScroll - Math.sign(horizontal) * Math.max(1, Math.round(Math.abs(horizontal) / look.cell)));
    if (next === this.statusScroll)
      return;
    this.statusScroll = next;
    cx.stop_propagation();
    cx.notify();
  }
  statusBar(look, line) {
    const { t } = look;
    const separator = () => div13().flex_none().text_color(t.rule).child(` ${GLYPH.rule} `);
    const content = h_flex12().flex_none().h(look.row).items_center().whitespace_nowrap().ml(-this.statusScroll * look.cell).children(this.branchLine(look, line)).child(separator()).child(div13().text_color(t.secondary).child(line.path)).child(separator()).when(line.status.blame == null, (el) => el.child(iconCell(look, line.facts.github ? "github" : "local", t.hint)).child(" ")).child(div13().text_color(t.secondary).child(line.status.blame ?? identityText(line.facts)));
    const progress = line.progress ?? line.status.progress;
    if (progress)
      content.child(separator()).child(spinner(look)).child(div13().text_color(t.accentText).child(` ${progress}`));
    const error = line.status.error ?? line.error;
    if (error)
      content.child(separator()).child(div13().text_color(t.error).child(`Error: ${error}`));
    return h_flex12().id("git-status-bar").flex_none().w_full().h(look.row + 8).px(8).items_center().overflow_hidden().bg(t.panel).border_t(1).border_color(t.rule).text_color(t.text).on_size_change((size, cx) => {
      const columns = Math.floor(size.width / look.screenCell);
      if (columns === this.statusCols)
        return;
      this.statusCols = columns;
      cx.notify();
    }).on_scroll_wheel((event, cx) => this.scrollStatus(event, look, cx)).child(content);
  }
}

// src/ui/commands/confirm.ts
var RECOVERY = "The repository may change. Conflicts are left intact for recovery.";
var FORCE = "Overwrites the remote branch. The lease refuses the push when the remote moved since your last fetch.";
function commitTarget(operation) {
  switch (operation.kind) {
    case "checkout-commit":
    case "cherry-pick":
    case "revert":
    case "rebase":
      return operation.target;
    default:
      return null;
  }
}
function historyText(operation, facts, preview) {
  switch (operation.kind) {
    case "checkout-commit":
      return `Checkout target: ${facts.label}

${preview}

Checks out this commit with a detached HEAD.`;
    case "checkout-branch":
      return `Checkout branch: ${operation.name}

${preview}

Switches the working tree to this branch.`;
    case "cherry-pick":
    case "revert":
      return `Current branch: ${facts.branch}
${operation.kind === "cherry-pick" ? "Commit to apply" : "Commit to revert"}: ${facts.label}

${preview}

Conflicts are left intact for recovery.`;
    case "rebase":
      return `Branch: ${facts.branch}
Rebase onto: ${facts.label}

${preview}

Rewrites commit history.`;
    default:
      return null;
  }
}
function describe(operation, facts) {
  const preview = operationPreview(operation);
  if (operation.kind === "discard-tracked")
    return `Repository: ${facts.root}
Restore to HEAD: ${operation.head}

Discard ALL staged and unstaged changes to tracked files?
Untracked files are kept. Submodule working trees are not restored.

This permanently deletes uncommitted tracked-file changes.
Filename case collisions may prevent a clean working tree.

${preview}`;
  if (operation.kind === "pull" || operation.kind === "push")
    return `Branch: ${facts.branch}

${preview}

${operation.kind === "push" && operation.force ? FORCE : RECOVERY}`;
  if (operation.kind === "remove-remote")
    return `Remove remote ${operation.name}?

${preview}

Removes its local configuration and remote-tracking branches.`;
  return historyText(operation, facts, preview) ?? `Run this Git operation?

${preview}

${RECOVERY}`;
}
function stripRef(target) {
  if (target.startsWith("refs/heads/"))
    return target.slice("refs/heads/".length);
  if (target.startsWith("refs/remotes/"))
    return target.slice("refs/remotes/".length);
  return target;
}
async function facts(host, operation) {
  const repository = host.services.repository();
  const branch = host.context().branch ?? "detached HEAD";
  const root = repository?.state === "ready" ? repository.root : "";
  const target = commitTarget(operation);
  if (!target)
    return { branch, root, label: "" };
  const shown = stripRef(target);
  const git = host.services.git();
  const subject = git && /^[0-9a-f]{40,64}$/.test(target) ? await commitSubject(git, target) : null;
  return { branch, root, label: subject === null ? shown : `${shortCommit(target)} · ${subject}` };
}
function openConfirm(host, command, operation, cx) {
  const context = host.services.context();
  cx.spawn(async (cx) => {
    const details = await facts(host, operation);
    if (context !== host.services.context())
      return;
    if (operation.kind === "push") {
      new PushConfirm(host, operation, details).open();
      cx.notify();
      return;
    }
    host.services.overlay.open({
      kind: "confirm",
      title: "Confirm Git operation",
      width: DIALOG.medium,
      lines: [describe(operation, details)],
      hint: TITLES[command],
      onConfirm: (cx) => host.run(command, operation, cx)
    });
    cx.notify();
  });
}

class PushConfirm {
  host;
  details;
  operation;
  constructor(host, operation, details) {
    this.host = host;
    this.details = details;
    this.operation = { ...operation };
  }
  open() {
    this.host.services.overlay.open({
      kind: "custom",
      title: "Confirm Git operation",
      width: DIALOG.medium,
      render: (look) => this.render(look),
      key: (event, cx) => this.key(event, cx)
    });
  }
  cycle(delta) {
    const remotes = this.host.context().remotes;
    if (!remotes.length)
      return;
    const index = remotes.indexOf(this.operation.remote);
    const next = remotes[(index + delta + remotes.length) % remotes.length];
    if (next)
      this.operation.remote = next;
  }
  submit(cx) {
    this.host.services.overlay.close(cx);
    this.host.run("push", { ...this.operation }, cx);
  }
  key(event, cx) {
    if (event.keystroke === "enter")
      this.submit(cx);
    else if (event.keystroke === "left")
      this.cycle(-1);
    else if (event.keystroke === "right")
      this.cycle(1);
    else if (event.keystroke === "space")
      this.operation.force = !this.operation.force;
    else
      return false;
    return true;
  }
  render(look) {
    const { t } = look;
    const fallback = this.host.context().remotes[0] === this.operation.remote ? " (default)" : "";
    return v_flex13().min_w(0).child(div14().whitespace_normal().child(describe(this.operation, this.details))).child(div14().h(look.row)).child(div14().id("git-push-remote").h(look.row).text_color(t.hint).cursor_pointer().child(`Remote: ${this.operation.remote}${fallback}  [←/→] Change`).on_click((_, cx) => {
      this.cycle(1);
      cx.notify();
    })).child(div14().id("git-push-force").h(look.row).text_color(this.operation.force ? t.warning : t.hint).cursor_pointer().child(`[${this.operation.force ? "x" : " "}] Force with lease  [Space]`).on_click((_, cx) => {
      this.operation.force = !this.operation.force;
      cx.notify();
    })).child(footerHint(look, TITLES.push)).child(dialogFooter(look, { id: "git-push-run", label: "[Enter] Run", onClick: (cx) => this.submit(cx) }, { id: "git-push-cancel", label: "[Esc] Cancel", onClick: (cx) => this.host.services.overlay.close(cx) }));
  }
}

// src/ui/commands/rebase.ts
import { h_flex as h_flex13, Textarea as Textarea2, TextareaState as TextareaState2, v_flex as v_flex14 } from "gpui-base";
import { div as div15 } from "gpui-kit";

// src/git/rebase.ts
var REBASE_ACTIONS = ["pick", "edit", "reword", "squash", "fixup", "drop"];
var REBASE_LABELS = {
  pick: "Pick",
  edit: "Edit",
  reword: "Reword",
  squash: "Squash",
  fixup: "Fixup",
  drop: "Drop"
};
var REBASE_DESCRIPTIONS = {
  pick: "Use commit",
  edit: "Stop for amending",
  reword: "Edit commit message",
  squash: "Combine into the commit below; keep both messages",
  fixup: "Combine into the commit below; drop this message",
  drop: "Remove commit"
};
async function must3(git, args) {
  const result = await git(args);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Rebase failed");
  return result.stdout;
}
function quote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
async function shell(git, body) {
  return git(["-c", `alias.herdr-rebase-state=!f() { ${body}; }; f`, "herdr-rebase-state"]);
}
async function rebaseActive(git) {
  const result = await shell(git, 'test -d "$(git rev-parse --git-path rebase-merge)" || test -d "$(git rev-parse --git-path rebase-apply)"');
  return result.code === 0;
}
function validatePlan(plan) {
  if (!plan.entries.length)
    return "No commits to rebase.";
  let previous = false;
  const seen = new Set;
  for (const entry of [...plan.entries].reverse()) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(entry.sha) || seen.has(entry.sha))
      return "Invalid or duplicate commit in rebase plan.";
    seen.add(entry.sha);
    if ((entry.action === "squash" || entry.action === "fixup") && !previous)
      return "Squash and Fixup need a retained commit below them.";
    if (entry.action === "reword" && !entry.message.trim())
      return "Reword needs a non-empty message.";
    previous ||= entry.action !== "drop";
  }
  return null;
}
function todo(plan) {
  const lines = [];
  let markers = [];
  for (const entry of [...plan.entries].reverse()) {
    if (entry.action !== "squash" && entry.action !== "fixup" && entry.action !== "drop") {
      lines.push(...markers);
      markers = [];
    }
    lines.push(`${entry.action === "reword" ? "pick" : entry.action} ${entry.sha}`);
    if (entry.action === "reword")
      lines.push(`exec printf '%s\\n' ${entry.message.split(`
`).map(quote).join(" ")} | git -c core.editor=true commit --amend --allow-empty -F -`);
    markers.push(`# herdr-end ${entry.sha}`);
  }
  lines.push(...markers);
  return `${lines.join(`
`)}
`;
}
async function activePlan(git, head) {
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
        message: (await must3(git, ["log", "-1", "--format=%B"])).trimEnd(),
        action: "edit"
      }
    ],
    updateRefs: false,
    active: true
  };
}
async function readRebasePlan(git, target) {
  const head = (await must3(git, ["rev-parse", "HEAD"])).trim();
  if (await rebaseActive(git))
    return activePlan(git, head);
  const branchResult = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branchResult.code !== 0)
    throw new Error("Checkout a branch before rebasing.");
  const sha = (await must3(git, ["rev-parse", "--verify", "--end-of-options", `${target.target}^{commit}`])).trim();
  let upstream = sha;
  if (target.kind === "inclusive") {
    const parent = await git(["rev-parse", "--verify", "--end-of-options", `${sha}^`]);
    upstream = parent.code === 0 ? parent.stdout.trim() : null;
  }
  const output = await must3(git, [
    "log",
    "--topo-order",
    "--date-order",
    "--no-merges",
    "--format=%H%x00%an%x00%aI%x00%B%x00",
    upstream ? `${upstream}..${head}` : head
  ]);
  const fields = output.split("\x00");
  const entries = [];
  for (let index = 0;index + 3 < fields.length; index += 4)
    entries.push({
      sha: (fields[index] ?? "").trim(),
      author: fields[index + 1] ?? "",
      date: (fields[index + 2] ?? "").slice(0, 10),
      message: (fields[index + 3] ?? "").trimEnd(),
      action: "pick"
    });
  return {
    branch: branchResult.stdout.trim(),
    head,
    upstream,
    target: target.target,
    entries,
    updateRefs: false,
    active: false
  };
}
async function startArgs(git, plan) {
  const invalid = validatePlan(plan);
  if (invalid)
    throw new Error(invalid);
  if (await rebaseActive(git))
    throw new Error("A rebase is already in progress. Reopen Interactive rebase.");
  const head = (await must3(git, ["rev-parse", "HEAD"])).trim();
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head !== plan.head || branch.stdout.trim() !== plan.branch)
    throw new Error("Branch or HEAD changed. Close and reopen Interactive rebase.");
  if ((await must3(git, ["status", "--porcelain"])).trim())
    throw new Error("Commit or stash working changes before rebasing.");
  const merge = 'NR == FNR { if ($1 == "pick") key=$2; if ($1 == "update-ref") refs[key]=refs[key] $0 "\\n"; next } { print } $1 == "#" && $2 == "herdr-end" { printf "%s", refs[$3] }';
  const script = plan.updateRefs ? `temporary=$(mktemp "$1.herdr.XXXXXX") || exit 1; printf '%s' ${quote(todo(plan))} | awk ${quote(merge)} "$1" - > "$temporary" && cat "$temporary" > "$1"; result=$?; rm -f "$temporary"; exit "$result"` : `printf '%s' ${quote(todo(plan))} > "$1"`;
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
    plan.upstream ?? "--root"
  ];
}
async function recoveryArgs(git, task) {
  if (!await rebaseActive(git))
    throw new Error("No rebase is in progress. Close and refresh.");
  if (task.kind !== "amend")
    return ["rebase", `--${task.kind}`];
  const amend = await shell(git, 'test -e "$(git rev-parse --git-path rebase-merge/amend)"');
  if (amend.code !== 0)
    throw new Error("Amend is available only at an Edit stop. Resolve conflicts and use Continue.");
  if (!task.message.trim())
    throw new Error("Enter a commit message.");
  return ["commit", "--amend", "--allow-empty", "-m", task.message];
}
async function runRebase(git, task) {
  const args = task.kind === "start" ? await startArgs(git, task.plan) : await recoveryArgs(git, task);
  const result = await git(["-c", "core.editor=true", ...args]);
  const message = await git(["log", "-1", "--format=%B"]);
  return {
    active: await rebaseActive(git),
    success: result.code === 0,
    output: `${result.stdout}
${result.stderr}`.replace(/\r\n?/g, `
`).trim(),
    message: message.code === 0 ? message.stdout.trimEnd() : ""
  };
}

// src/ui/commands/rebase.ts
var KEYS = "persfd";
var WIDTH = 140;
var MENU_ROWS = 8;

class RebaseEditor extends Dialog {
  host;
  plan = null;
  busy = true;
  status = "Loading commits…";
  amendMessage = "";
  anchor = null;
  list = new ListViewport("git-rebase-entries");
  menu = null;
  message = null;
  confirmation = null;
  constructor(host, cx) {
    super(host.services.overlay, cx);
    this.host = host;
  }
  open(target, cx) {
    this.show();
    const git = this.host.services.git();
    const context = this.host.services.context();
    if (!git)
      return;
    cx.spawn(async (cx) => {
      try {
        const plan = await readRebasePlan(git, target);
        if (context !== this.host.services.context())
          return;
        this.plan = plan;
        this.status = plan.active ? "Rebase paused. Resolve and stage files in Changes, then Continue." : "";
        this.amendMessage = plan.entries[0]?.message ?? "";
      } catch (error) {
        this.status = errorMessage2(error);
      }
      this.busy = false;
      cx.notify();
    });
  }
  options() {
    return { title: "Interactive rebase", width: WIDTH, height: 28 };
  }
  release() {
    this.closeMessage();
    super.release();
  }
  closeMessage() {
    this.message?.state.release();
    this.message = null;
    this.handle.focus();
  }
  range() {
    const cursor = this.list.selected;
    return this.anchor === null ? [cursor, cursor] : [Math.min(this.anchor, cursor), Math.max(this.anchor, cursor)];
  }
  editMessage(index, text) {
    const state = TextareaState2.new({ value: text, rows: 10 });
    this.message = { index, state, error: null };
    state.focus();
  }
  setAction(action) {
    const [start, end] = this.range();
    const plan = this.plan;
    if (!plan)
      return;
    if (action === "reword") {
      if (start !== end) {
        this.status = "Reword edits one commit at a time.";
        return;
      }
      const entry = plan.entries[start];
      if (entry)
        this.editMessage(start, entry.message);
      return;
    }
    for (const entry of plan.entries.slice(start, end + 1))
      entry.action = action;
    this.anchor = null;
    this.status = "";
  }
  move(delta) {
    const [start, end] = this.range();
    const entries = this.plan?.entries;
    if (!entries)
      return;
    if (delta < 0 && start === 0)
      return;
    if (delta > 0 && end + 1 >= entries.length)
      return;
    const moved = entries.splice(delta < 0 ? start - 1 : end + 1, 1);
    entries.splice(delta < 0 ? end : start, 0, ...moved);
    this.list.selected += delta;
    if (this.anchor !== null)
      this.anchor += delta;
  }
  choose(index) {
    this.menu = null;
    if (index === 6)
      this.move(-1);
    else if (index === 7)
      this.move(1);
    else {
      const action = REBASE_ACTIONS[index];
      if (action)
        this.setAction(action);
    }
  }
  start() {
    const plan = this.plan;
    if (!plan)
      return;
    const invalid = validatePlan(plan);
    if (invalid)
      this.status = invalid;
    else
      this.confirmation = { kind: "start", plan: { ...plan, entries: plan.entries.map((entry) => ({ ...entry })) } };
  }
  submit(task, cx) {
    const services = this.host.services;
    this.busy = true;
    this.confirmation = null;
    this.status = "Running interactive rebase…";
    services.mutate(services.context(), "Running", async (git, cx) => {
      try {
        const result = await runRebase(git, task);
        if (!this.isOpen())
          return;
        if (!result.active) {
          this.close(cx);
          showResult(services.overlay, "Interactive rebase", result.success, result.output, undefined, cx);
          return;
        }
        this.busy = false;
        this.status = result.output;
        this.amendMessage = result.message;
        if (this.plan)
          this.plan.active = true;
      } catch (error) {
        this.busy = false;
        this.status = errorMessage2(error);
      }
    }, cx);
  }
  messageKey(key, cx) {
    const message = this.message;
    if (!message)
      return false;
    if (key === "escape")
      this.closeMessage();
    else if (key === "ctrl-u")
      message.state.set_value("");
    else if (key === "enter") {
      const text = message.state.value();
      if (!text.trim()) {
        message.error = "Enter a commit message.";
        return true;
      }
      const index = message.index;
      this.closeMessage();
      const entry = index === null ? null : this.plan?.entries[index];
      if (entry) {
        entry.message = text;
        entry.action = "reword";
      } else if (index === null)
        this.submit({ kind: "amend", message: text }, cx);
    } else
      return false;
    return true;
  }
  menuKey(event) {
    const menu = this.menu;
    if (!menu)
      return false;
    const index = KEYS.indexOf(event.key);
    if (event.keystroke === "escape")
      this.menu = null;
    else if (event.keystroke === "enter")
      this.choose(menu.selected);
    else if (index >= 0 && event.keystroke.length === 1)
      this.choose(index);
    else
      menu.key(event, MENU_ROWS, false);
    return true;
  }
  recover(key, cx) {
    if (key === "c")
      this.submit({ kind: "continue" }, cx);
    else if (key === "s")
      this.confirmation = { kind: "skip" };
    else if (key === "a")
      this.confirmation = { kind: "abort" };
    else if (key === "m")
      this.editMessage(null, this.amendMessage);
    else
      return false;
    return true;
  }
  listKey(event, plan) {
    const key = event.keystroke;
    const length = plan.entries.length;
    const index = KEYS.indexOf(key);
    if (key === "space")
      plan.updateRefs = !plan.updateRefs;
    else if (key === "enter")
      this.start();
    else if (key === "ctrl-up")
      this.choose(6);
    else if (key === "ctrl-down")
      this.choose(7);
    else if (key === "?" || key === "shift-/")
      this.menu = new ListViewport("git-rebase-menu");
    else if (key === "v" && this.anchor === null && length) {
      this.anchor = this.list.selected;
      this.status = "";
    } else if (key.length === 1 && index >= 0)
      this.choose(index);
    else
      return this.list.key(event, length, false) === "moved";
    return true;
  }
  modalKey(key, cx) {
    if (this.busy) {
      if (key === "escape" && !this.plan)
        this.close(cx);
      return true;
    }
    if (this.confirmation) {
      if (key === "escape")
        this.confirmation = null;
      else if (key === "enter")
        this.submit(this.confirmation, cx);
      return true;
    }
    return null;
  }
  key(event, cx) {
    const key = event.keystroke;
    const modal = this.modalKey(key, cx);
    if (modal !== null)
      return modal;
    if (this.message)
      return this.messageKey(key, cx);
    if (this.menu)
      return this.menuKey(event);
    if (key === "escape") {
      if (this.anchor === null)
        this.close(cx);
      this.anchor = null;
      this.status = "";
      return true;
    }
    const plan = this.plan;
    if (!plan)
      return false;
    if (plan.active)
      return this.recover(key, cx);
    return this.listKey(event, plan);
  }
  actionColor(look, action) {
    if (action === "drop")
      return look.t.error;
    if (action === "pick")
      return look.t.success;
    return look.t.warning;
  }
  table(look, plan) {
    const { t } = look;
    const [first, last] = this.range();
    const visual = this.anchor !== null;
    const cell = (width, text, color = t.text) => div15().flex_none().w(width * look.cell).truncate().text_color(color).child(text);
    const header = h_flex13().h(look.row).pl(2 * look.cell).text_color(t.accent).font_weight(700).child(cell(9, "Action", t.accent)).child(div15().flex_1().child("Commit")).child(cell(18, "Author", t.accent)).child(cell(8, "SHA", t.accent)).child(cell(10, "Date", t.accent));
    return v_flex14().flex_1().min_h(0).child(header).child(v_flex14().flex_1().min_h(0).child(this.list.render(look, {
      length: plan.entries.length,
      focused: !visual,
      marker: true,
      row: ({ index }) => {
        const entry = plan.entries[index];
        if (!entry)
          return div15();
        return h_flex13().flex_1().min_w(0).when(visual && index >= first && index <= last, (el) => el.bg(t.selection)).child(cell(9, REBASE_LABELS[entry.action], this.actionColor(look, entry.action))).child(div15().flex_1().min_w(0).truncate().child(entry.message.split(`
`)[0] ?? "")).child(cell(18, entry.author)).child(cell(8, entry.sha.slice(0, 8))).child(cell(10, entry.date));
      },
      onActivate: (index) => {
        this.list.selected = index;
        this.anchor = null;
        this.menu = new ListViewport("git-rebase-menu");
      }
    })));
  }
  actionKeys(look) {
    const row = h_flex13().h(look.row);
    REBASE_ACTIONS.forEach((action, index) => {
      if (index)
        row.child(div15().child("  "));
      row.child(div15().text_color(look.t.hint).child(`${KEYS[index]} `)).child(div15().text_color(this.actionColor(look, action)).child(REBASE_LABELS[action]));
    });
    return row;
  }
  guidance(look) {
    const { t } = look;
    const [first, last] = this.range();
    if (this.status)
      return div15().h(look.row).truncate().text_color(t.warning).child(this.status);
    if (this.anchor !== null)
      return div15().h(look.row).text_color(t.accent).child(`Visual: ${last - first + 1} commits · p/e/s/f/d set all · Ctrl+↑/↓ move the block · Esc clear`);
    return div15().h(look.row).text_color(t.hint).child("v select lines · Ctrl+↑/↓ move commit · ? what the keys do");
  }
  recovery(look) {
    const row = h_flex13().h(look.row);
    for (const [key, label] of [
      ["c", "[c] Continue"],
      ["s", "[s] Skip"],
      ["a", "[a] Abort"],
      ["m", "[m] Amend message"]
    ])
      row.child(div15().id(`git-rebase-${key}`).flex_1().text_color(look.t.accent).cursor_pointer().child(label).on_click((_, cx) => {
        this.recover(key, cx);
        cx.notify();
      }));
    return row;
  }
  overlayPanel(look) {
    const { t } = look;
    if (this.confirmation) {
      const task = this.confirmation;
      const text = task.kind === "start" ? `Rewrite ${task.plan.entries.length} commits on ${task.plan.branch}?
Target: ${task.plan.target}
Update dependent branches: ${task.plan.updateRefs}` : task.kind === "skip" ? "Skip the current commit and continue?" : "Abort rebase and restore the original branch?";
      return box(look, { id: "git-rebase-confirm", title: "Confirm interactive rebase" }, v_flex14().size_full().child(div15().flex_1().whitespace_normal().child(text)).child(dialogFooter(look, { id: "git-rebase-confirm-run", label: "[Enter] Confirm", onClick: (cx) => this.submit(task, cx) }, {
        id: "git-rebase-confirm-back",
        label: "[Esc] Back",
        onClick: () => {
          this.confirmation = null;
        }
      }))).h(rows(look, 10));
    }
    const message = this.message;
    if (message)
      return box(look, { id: "git-rebase-message", title: "Commit message", focused: true }, v_flex14().size_full().child(Textarea2.new(message.state).flex_1().text_color(t.text)).child(div15().h(rows(look, 2)).text_color(message.error ? t.error : t.hint).child(message.error ?? "Enter saves · Shift+Enter new line · Ctrl+U clears · paste supported")).child(dialogFooter(look, { id: "git-rebase-message-save", label: "[Enter] Save", onClick: (cx) => this.messageKey("enter", cx) }, { id: "git-rebase-message-cancel", label: "[Esc] Cancel", onClick: () => this.closeMessage() }))).h(rows(look, 20));
    return this.menuPanel(look);
  }
  menuPanel(look) {
    const menu = this.menu;
    if (!menu)
      return null;
    const { t } = look;
    const [first, last] = this.range();
    const title = last > first ? `Actions for ${last - first + 1} commits` : "Actions";
    return box(look, { id: "git-rebase-menu-box", title }, v_flex14().size_full().child(v_flex14().flex_1().min_h(0).child(menu.render(look, {
      length: MENU_ROWS,
      focused: true,
      marker: true,
      row: ({ index }) => {
        const action = REBASE_ACTIONS[index];
        if (!action)
          return h_flex13().child(div15().text_color(t.accent).child(index === 6 ? "Ctrl+↑  " : "Ctrl+↓  ")).child(div15().child(index === 6 ? "Move up" : "Move down"));
        return h_flex13().child(div15().text_color(t.accent).child(`${KEYS[index]}  `)).child(div15().text_color(this.actionColor(look, action)).child(padToWidth(REBASE_LABELS[action], 8))).child(div15().child(REBASE_DESCRIPTIONS[action]));
      },
      onActivate: (index) => this.choose(index)
    }))).child(div15().h(look.row).text_color(t.hint).child("Press the key itself on the list, or pick a row here · Esc closes"))).h(rows(look, 12));
  }
  body(look) {
    const { t } = look;
    const plan = this.plan;
    const content = v_flex14().flex_1().min_h(0);
    if (plan) {
      content.child(div15().h(look.row).child(`Rebase: ${plan.branch}`)).child(div15().h(look.row).child(`On: ${truncateToWidth(plan.target, WIDTH - 8)}`)).child(div15().id("git-rebase-update-refs").h(look.row).text_color(t.hint).cursor_pointer().child(`[${plan.updateRefs ? "x" : " "}] Update dependent branches  [Space]`).on_click((_, cx) => {
        plan.updateRefs = !plan.updateRefs;
        cx.notify();
      }));
      if (plan.active)
        content.child(div15().flex_1().min_h(0).whitespace_normal().overflow_hidden().child(this.status)).child(this.recovery(look));
      else
        content.child(this.table(look, plan));
    }
    const footer = v_flex14().flex_none().h(rows(look, 2));
    if (this.busy)
      footer.child(div15().h(look.row).text_color(t.hint).child(`⠋ ${this.status}`));
    else if (!plan)
      footer.child(div15().text_color(t.error).child(this.status));
    else if (!plan.active)
      footer.child(this.actionKeys(look)).child(this.guidance(look));
    const active = !!plan?.active;
    const layer = this.overlayPanel(look);
    return v_flex14().relative().size_full().min_h(rows(look, 24)).child(content).child(footer).child(dialogFooter(look, {
      id: "git-rebase-primary",
      label: active ? "Resolve / stage in Changes" : "[Enter] Rebase",
      enabled: !active,
      onClick: () => this.start()
    }, { id: "git-rebase-close", label: "[Esc] Close", onClick: (cx) => this.close(cx) })).when(layer !== null, (el) => el.child(v_flex14().absolute().inset_0().items_center().justify_center().child(div15().w(76 * look.cell).bg(t.background).child(layer ?? div15()))));
  }
}

// src/ui/commands/remote.ts
import { v_flex as v_flex15 } from "gpui-base";
import { div as div16 } from "gpui-kit";

// src/git/remotes.ts
async function must4(git, args) {
  const result = await git(args);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `git ${args[0]} exited with ${result.code}`);
  return result.stdout.trim();
}
async function readRemotes(git) {
  const config = await git(["config", "--null", "--get-regexp", "^remote\\..*\\.url$"]);
  if (config.code !== 0 && config.code !== 1)
    throw new Error(config.stderr.trim() || "Could not read remotes");
  const names = [];
  for (const entry of config.stdout.split("\x00")) {
    const key = entry.split(`
`)[0] ?? "";
    if (!entry.includes(`
`) || !key.startsWith("remote.") || !key.endsWith(".url"))
      continue;
    const name = key.slice("remote.".length, -".url".length);
    if (!names.includes(name))
      names.push(name);
  }
  const remotes = [];
  for (const name of names)
    remotes.push({
      name,
      url: await must4(git, ["remote", "get-url", "--", name]),
      pushUrl: await must4(git, ["remote", "get-url", "--push", "--", name])
    });
  return remotes;
}

// src/ui/commands/remote.ts
function openAddRemote(host, values) {
  const remotes = host.context().remotes;
  const overlay = host.services.overlay;
  overlay.open({
    kind: "form",
    title: "Add Remotes",
    width: DIALOG.medium,
    fields: [
      { label: "Name", value: values?.name ?? (remotes.length ? "" : "origin") },
      { label: "URL", value: values?.url ?? "" }
    ],
    primary: "[Enter] Add",
    onSubmit: (fields, cx) => {
      const name = (fields[0] ?? "").trim();
      const url = (fields[1] ?? "").trim();
      if (!name || name.startsWith("-") || /\s/.test(name))
        return "Error: Enter a remote name without spaces.";
      if (host.context().remotes.includes(name))
        return "Error: A remote with this name already exists.";
      if (!url || [...url].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
        return "Error: Enter a repository URL or path.";
      host.run("add-remote", { kind: "add-remote", name, url }, cx, (success, output, cx) => {
        if (success)
          new RemoteList(host, cx).open(cx);
        else
          openAddRemote(host, { name, url, error: output });
        return true;
      });
      return null;
    }
  });
  if (values)
    overlay.setError(`Error: ${values.error}`);
}

class RemoteList extends Dialog {
  host;
  remotes = [];
  loading = true;
  error = null;
  list = new ListViewport("git-remotes");
  constructor(host, cx) {
    super(host.services.overlay, cx);
    this.host = host;
  }
  open(cx) {
    this.show();
    const git = this.host.services.git();
    if (!git)
      return;
    cx.spawn(async (cx) => {
      try {
        this.remotes = await readRemotes(git);
      } catch (error) {
        this.error = errorMessage2(error);
      }
      this.loading = false;
      cx.notify();
    });
  }
  options() {
    return { title: "Show Remotes", width: DIALOG.wide, height: Math.max(10, this.remotes.length + 7) };
  }
  remove(cx) {
    const remote = this.remotes[this.list.selected];
    if (!remote)
      return;
    this.close(cx);
    this.host.confirm("remove-remote", { kind: "remove-remote", name: remote.name }, cx);
  }
  key(event, cx) {
    if (event.keystroke === "delete" || event.keystroke === "d")
      this.remove(cx);
    else
      return this.list.key(event, this.remotes.length) === "moved";
    return true;
  }
  content(look) {
    if (this.loading)
      return div16().text_color(look.t.hint).child("Loading remotes");
    if (this.error)
      return div16().text_color(look.t.error).child(`Error: ${this.error}`);
    if (!this.remotes.length)
      return div16().child("No remotes configured.");
    return this.list.render(look, {
      length: this.remotes.length,
      focused: true,
      marker: true,
      row: ({ index }) => {
        const remote = this.remotes[index];
        return div16().truncate().child(remote ? `${remote.name}${index === 0 ? " (default)" : ""}  ${remote.url}` : "");
      },
      onSelect: (index) => {
        this.list.selected = index;
      }
    });
  }
  body(look) {
    const selected = this.remotes[this.list.selected];
    return v_flex15().size_full().min_h(rows(look, 7)).child(v_flex15().flex_1().min_h(0).child(this.content(look))).child(v_flex15().flex_none().h(rows(look, 2)).text_color(look.t.hint).when(!!selected, (el) => el.child(div16().truncate().child(`Push URL: ${selected?.pushUrl ?? ""}`)).child(div16().child("[j/k] Select")))).child(dialogFooter(look, { id: "git-remotes-remove", label: "[Del] Remove", onClick: (cx) => this.remove(cx) }, { id: "git-remotes-close", label: "[Esc] Close", onClick: (cx) => this.close(cx) }));
  }
}

// src/ui/commands/reset.ts
import { h_flex as h_flex14, v_flex as v_flex16 } from "gpui-base";
import { div as div17 } from "gpui-kit";
var EFFECT = {
  soft: "The current branch moves to the target. The index and working tree are preserved.",
  mixed: "The current branch and index move to the target. The working tree is preserved.",
  hard: "The current branch, index, and tracked working tree move to the target."
};
var HARD_WARNING = "Tracked changes will be discarded. Obstructing untracked paths may be removed.";
var REMOTE_NOTE = "Remote refs are not changed. The target branch is not checked out.";
var NOTE_COLUMNS = DIALOG.wide - 6;
var CONFIRM_CHROME = 14;
function wrappedRows(text) {
  return Math.max(1, Math.ceil(displayWidth(text) / NOTE_COLUMNS));
}

class ResetFlow extends Dialog {
  host;
  request;
  step = "mode";
  modeList = new ListViewport("git-reset-modes");
  constructor(host, request, cx) {
    super(host.services.overlay, cx);
    this.host = host;
    this.request = request;
  }
  open() {
    this.show();
  }
  options() {
    return { title: "Reset", width: DIALOG.wide, height: this.step === "confirm" ? this.confirmHeight() : 11 };
  }
  confirmHeight() {
    const mode = this.mode().mode;
    const notes = [EFFECT[mode], REMOTE_NOTE, ...mode === "hard" ? [HARD_WARNING] : []];
    return CONFIRM_CHROME + notes.reduce((sum, note) => sum + wrappedRows(note), 0);
  }
  mode() {
    return RESET_MODES[Math.min(this.modeList.selected, RESET_MODES.length - 1)] ?? RESET_MODES[0];
  }
  advance(cx) {
    if (this.step === "mode")
      this.step = "confirm";
    else
      this.execute(cx);
  }
  back(cx) {
    if (this.step === "mode")
      this.close(cx);
    else
      this.step = "mode";
  }
  execute(cx) {
    const { target, branch, head } = this.request;
    const mode = this.mode().mode;
    this.close(cx);
    this.host.run("reset", {
      kind: "reset",
      mode,
      target: target.commit,
      targetName: target.name,
      branch,
      head
    }, cx);
  }
  key(event, cx) {
    if (event.keystroke === "enter")
      this.advance(cx);
    else if (event.keystroke === "escape")
      this.back(cx);
    else if (this.step === "mode")
      return this.modeList.key(event, RESET_MODES.length) === "moved";
    else
      return false;
    return true;
  }
  pair(look, label, ...values) {
    const { t } = look;
    const row = h_flex14().h(look.row).child(div17().text_color(t.hint).child(label));
    values.forEach((value, index) => {
      if (index > 0)
        row.child(div17().child(" · "));
      row.child(div17().text_color(t.accent).font_weight(700).child(value));
    });
    return row;
  }
  header(look) {
    const { t } = look;
    const header = v_flex16().flex_none().child(h_flex14().h(look.row).child(div17().text_color(t.hint).child("Current branch  ")).child(div17().text_color(t.accent).font_weight(700).child(this.request.branch)).child(div17().text_color(t.hint).child("    HEAD  ")).child(div17().text_color(t.accent).font_weight(700).child(shortCommit(this.request.head))));
    const { target } = this.request;
    if (this.step === "mode")
      header.child(this.pair(look, "Target  ", shortCommit(target.commit), target.name));
    return header;
  }
  modes(look) {
    return box(look, { id: "git-reset-mode-box", title: "Reset mode" }, this.modeList.render(look, {
      length: RESET_MODES.length,
      focused: true,
      marker: true,
      row: ({ index }) => {
        const mode = RESET_MODES[index];
        return div17().child(mode ? `${padToWidth(mode.label, 7)} ${mode.summary}` : "");
      },
      onActivate: (index, cx) => {
        this.modeList.selected = index;
        this.advance(cx);
      }
    })).flex_1();
  }
  confirmation(look) {
    const { t } = look;
    const mode = this.mode();
    const body = v_flex16().min_w(0).child(this.pair(look, "From    ", this.request.branch, shortCommit(this.request.head)));
    const { target } = this.request;
    body.child(this.pair(look, "Target  ", target.name, shortCommit(target.commit))).child(this.pair(look, "Mode    ", mode.label)).child(div17().h(look.row)).child(div17().text_color(t.accent).child(`git reset --${mode.mode} ${target.commit}`)).child(div17().h(look.row));
    body.child(div17().whitespace_normal().text_color(mode.mode === "mixed" ? t.warning : t.text).child(EFFECT[mode.mode]));
    if (mode.mode === "hard")
      body.child(div17().whitespace_normal().text_color(t.error).font_weight(700).child(HARD_WARNING));
    body.child(div17().h(look.row)).child(div17().whitespace_normal().text_color(t.hint).child(REMOTE_NOTE));
    return box(look, { id: "git-reset-confirm-box", title: "Confirm Reset" }, body).flex_1();
  }
  body(look) {
    const content = this.step === "mode" ? this.modes(look) : this.confirmation(look);
    const labels = this.step === "mode" ? ["[Enter] Continue", "[Esc] Cancel"] : ["[Enter] Reset", "[Esc] Back"];
    return v_flex16().size_full().min_h(rows(look, 10)).child(this.header(look)).child(v_flex16().flex_1().min_h(0).child(content)).child(dialogFooter(look, { id: "git-reset-primary", label: labels[0] ?? "", onClick: (cx) => this.advance(cx) }, { id: "git-reset-secondary", label: labels[1] ?? "", onClick: (cx) => this.back(cx) }));
  }
}

// src/ui/commands/target.ts
class TargetPicker {
  host;
  command;
  commit;
  flows;
  targets = [];
  loading = true;
  error = null;
  subject = "";
  choices = new Map;
  constructor(host, command, commit, flows) {
    this.host = host;
    this.command = command;
    this.commit = commit;
    this.flows = flows;
  }
  open(cx) {
    const services = this.host.services;
    this.subject = this.command === "interactive-rebase" && this.commit === this.host.context().head ? "HEAD" : "";
    services.overlay.open({
      kind: "picker",
      title: RESULT_NAMES[this.command],
      width: DIALOG.wide,
      rows: (query) => this.rows(query),
      footer: (query, count) => this.footer(query, count),
      primary: "[Enter] Continue",
      secondary: "[Esc] Cancel",
      onChoose: (row, cx) => this.choose(row, cx)
    });
    const git = services.git();
    const context = services.context();
    if (!git)
      return;
    cx.spawn(async (cx) => {
      try {
        const [targets, subject] = await Promise.all([readBranchTargets2(git), commitSubject(git, this.commit)]);
        this.targets = targets;
        if (!this.subject)
          this.subject = subject ?? "";
      } catch (error) {
        this.error = `${errorMessage2(error)}. Close and retry ${RESULT_NAMES[this.command]}.`;
      }
      if (context !== services.context())
        return;
      this.loading = false;
      cx.notify();
    });
  }
  commitChoice(commit, name) {
    switch (this.command) {
      case "rebase":
        return { operation: { kind: "rebase", target: commit } };
      case "interactive-rebase":
        return { rebase: { kind: "inclusive", target: commit } };
      case "cherry-pick":
      case "revert":
        return { operation: { kind: this.command, target: commit } };
      case "reset":
        return { reset: { name, reference: commit, commit } };
      default:
        return { operation: { kind: "checkout-commit", target: commit } };
    }
  }
  targetChoice(target) {
    const local = target.reference.startsWith("refs/heads/") ? target.reference.slice("refs/heads/".length) : null;
    const kind = local === null ? "remote branch" : "branch";
    switch (this.command) {
      case "rebase":
        return { kind, choice: { operation: { kind: "rebase", target: target.reference } } };
      case "interactive-rebase":
        return { kind, choice: { rebase: { kind: "onto", target: target.reference } } };
      case "cherry-pick":
      case "revert":
        return { kind, choice: { operation: { kind: this.command, target: target.commit } } };
      case "reset":
        return { kind, choice: { reset: target } };
      default:
        if (local !== null)
          return { kind: "branch", choice: { operation: { kind: "checkout-branch", name: local } } };
        return {
          kind: "remote, detached HEAD",
          choice: { operation: { kind: "checkout-commit", target: target.commit } }
        };
    }
  }
  rows(query) {
    const effect = this.command === "checkout" ? "detached HEAD" : "commit";
    const rows = [];
    this.choices.clear();
    const add = (id, label, choice) => {
      this.choices.set(id, choice);
      rows.push({ id, label });
    };
    if (/^[0-9a-f]{4,64}$/.test(query))
      add(`hash:${query}`, `${query} · ${effect}`, this.commitChoice(query, query));
    if (!query)
      add("commit", `${this.commit.slice(0, 8)} ${this.subject} · ${effect}`, this.commitChoice(this.commit, this.subject || this.commit.slice(0, 8)));
    for (const target of this.targets) {
      if (!target.name.toLowerCase().includes(query))
        continue;
      const { kind, choice } = this.targetChoice(target);
      add(`ref:${target.reference}`, `${target.name} · ${kind}`, choice);
    }
    return rows;
  }
  footer(_query, count) {
    if (this.loading)
      return "Loading branches";
    if (this.error)
      return `Error: ${this.error}`;
    return count ? "Choose a branch or type a commit hash" : "No matching branches or commit hash";
  }
  choose(row, cx) {
    const choice = this.choices.get(row.id);
    if (!choice)
      return;
    if ("rebase" in choice)
      this.flows.rebase(choice.rebase, cx);
    else if ("reset" in choice)
      this.flows.reset(choice.reset, cx);
    else
      this.host.confirm(this.command, choice.operation, cx);
  }
}

// src/ui/commands/update.ts
import { appHome as appHome2, checking, exec as exec2, notify as notify2, readTextFile, writeTextFile } from "herdr";

// src/runtime/mod-release.ts
import { createHash } from "crypto";
var REPO = "JeHwanYoo/herdr-git-mods";
var LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
var TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function object(value) {
  return typeof value === "object" && value !== null;
}
function newerVersion(candidate, current) {
  const parts = candidate.slice(1).split(".").map(BigInt);
  const installed = current.split(".").map(BigInt);
  for (const [index, part] of installed.entries()) {
    const next = parts[index];
    if (next !== undefined && next !== part)
      return next > part;
  }
  return false;
}
async function latestRelease(current, download) {
  const data = JSON.parse(await download(LATEST));
  if (!object(data) || typeof data.tag_name !== "string" || !TAG.test(data.tag_name) || data.draft !== false || data.prerelease !== false) {
    throw new Error("GitHub did not return a stable release.");
  }
  const tag = data.tag_name;
  if (!newerVersion(tag, current))
    return null;
  const asset = Array.isArray(data.assets) ? data.assets.find((entry) => object(entry) && entry.name === BUNDLE_ASSET) : null;
  if (!object(asset) || asset.state !== "uploaded" || typeof asset.size !== "number" || asset.size <= 0 || asset.size > BUNDLE_LIMIT || typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
    throw new Error(`${tag} has no verifiable ${BUNDLE_ASSET} release asset.`);
  }
  return { tag, sha256: asset.digest.slice("sha256:".length) };
}
async function installRelease(current, release, file, download) {
  if (!TAG.test(release.tag) || !newerVersion(release.tag, current)) {
    throw new Error("The release is no longer newer than this version.");
  }
  const installed = await file.read();
  if (installed === null || installed.split(/\r?\n/, 1)[0] !== bundleHeader(current).trimEnd()) {
    throw new Error("The installed bundle changed. Reopen Git before updating.");
  }
  const bundle = await download(`https://github.com/${REPO}/releases/download/${release.tag}/${BUNDLE_ASSET}`);
  const sha256 = createHash("sha256").update(bundle).digest("hex");
  if (sha256 !== release.sha256 || !bundle.startsWith(bundleHeader(release.tag.slice(1)))) {
    throw new Error(`The downloaded bundle failed verification for ${release.tag}.`);
  }
  await file.replace(bundle, installed);
}

// src/ui/commands/update.ts
var UPDATE_INTERVAL = 30 * 60 * 1000;
var UPDATE_TICK = 60 * 1000;
var LAST_CHECK = "git-release-check";
var LAST_NOTICE = "git-release-notice";
var TITLE = "Update Herdr Git Mods";
async function download(url) {
  const result = await exec2("curl", [
    "-q",
    "--silent",
    "--show-error",
    "--fail",
    "--location",
    "--max-redirs",
    "3",
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    "--connect-timeout",
    "10",
    "--max-time",
    "30",
    "--max-filesize",
    String(BUNDLE_LIMIT),
    url
  ], { cwd: appHome2(), timeout: 35000 });
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || "GitHub request failed.");
  return result.stdout;
}

class ModUpdate {
  overlay;
  pending = null;
  available = null;
  installing = false;
  active = true;
  constructor(overlay) {
    this.overlay = overlay;
  }
  release() {
    this.active = false;
  }
  status() {
    if (this.installing)
      return "Installing update…";
    if (this.pending)
      return "Checking GitHub…";
    return this.available ? `${this.available.tag} available` : null;
  }
  check() {
    if (this.pending)
      return this.pending;
    localStorage.setItem(LAST_CHECK, String(Date.now()));
    this.pending = latestRelease(VERSION, download).then((release) => {
      this.available = release;
      return release;
    }).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  watch(cx) {
    if (checking())
      return;
    this.background(cx);
    cx.timer.every(UPDATE_TICK, (cx) => this.background(cx));
  }
  background(cx) {
    if (!this.active || this.installing)
      return;
    cx.spawn(async (cx) => {
      const elapsed = Date.now() - Number(localStorage.getItem(LAST_CHECK));
      if (elapsed >= 0 && elapsed < UPDATE_INTERVAL)
        return;
      let release;
      try {
        release = await this.check();
      } catch {
        if (this.active)
          cx.notify();
        return;
      }
      if (!this.active)
        return;
      if (release && localStorage.getItem(LAST_NOTICE) !== release.tag) {
        localStorage.setItem(LAST_NOTICE, release.tag);
        notify2({ title: `Herdr Git Mods ${release.tag} is available`, body: "Open Git Settings to install it." });
      }
      cx.notify();
    });
  }
  open(cx) {
    if (this.installing)
      return;
    const dialog = this.progress("Checking GitHub Releases…");
    cx.spawn(async (cx) => {
      try {
        const release = await this.check();
        if (!this.active || this.overlay.current() !== dialog)
          return;
        if (release)
          this.confirm(release);
        else
          showResult(this.overlay, "Update check", true, `Herdr Git Mods v${VERSION} is up to date.`, undefined, cx);
      } catch (error) {
        if (!this.active || this.overlay.current() !== dialog)
          return;
        showResult(this.overlay, "Update check", false, errorMessage2(error));
      }
      cx.notify();
    });
  }
  progress(message) {
    const dialog = {
      kind: "confirm",
      title: TITLE,
      width: DIALOG.medium,
      lines: [message],
      primary: "",
      secondary: "[Esc] Close",
      enabled: () => false,
      onConfirm: () => {}
    };
    this.overlay.open(dialog);
    return dialog;
  }
  confirm(release) {
    this.overlay.open({
      kind: "confirm",
      title: TITLE,
      width: DIALOG.medium,
      lines: [`v${VERSION} → ${release.tag}`, "", "Install the GitHub release and reload Git?"],
      primary: "[Enter] Install",
      onConfirm: (cx) => this.install(release, cx)
    });
  }
  install(release, cx) {
    if (this.installing)
      return;
    this.installing = true;
    const dialog = this.progress(`Installing ${release.tag}…`);
    cx.spawn(async (cx) => {
      try {
        const path = `${appHome2()}/mods/git/${BUNDLE_ASSET}`;
        await installRelease(VERSION, release, { read: () => readTextFile(path), replace: (text, expected) => writeTextFile(path, text, expected) }, download);
        this.available = null;
        if (!this.active)
          return;
        notify2({ title: `Installed Herdr Git Mods ${release.tag}`, level: "success" });
        if (this.overlay.current() === dialog)
          this.overlay.close(cx);
      } catch (error) {
        if (!this.active)
          return;
        if (this.overlay.current() === dialog)
          showResult(this.overlay, TITLE, false, errorMessage2(error));
        else
          notify2({ title: "Herdr Git Mods update failed", body: errorMessage2(error), level: "error" });
      } finally {
        this.installing = false;
      }
      if (this.active)
        cx.notify();
    });
  }
}

// src/ui/commands.ts
var QUICK = {
  fetch: "fetch",
  pull: "pull",
  commit: "commit",
  push: "push",
  branch: "branches",
  stash: "stash-changes"
};
var GRAPH = {
  checkout: "checkout",
  rebase: "rebase",
  "cherry-pick": "cherry-pick",
  revert: "revert",
  reset: "reset",
  "copy-sha": "copy-sha"
};
var CONFIRMED = [
  "discard-all",
  "pull",
  "push",
  "cherry-pick",
  "revert",
  "stash-changes",
  "stash-pop"
];
function listStatus(query, count) {
  if (!query)
    return "";
  if (count === 0)
    return "No matching commands";
  return count === 1 ? "1 matching command" : `${count} matching commands`;
}
function pullLines(preview, output, success) {
  const lines = [{ text: preview, tone: "accent", bold: true }, { text: "" }];
  for (const line of output.split(`
`)) {
    if (!success)
      lines.push({ text: line, tone: "error" });
    else if (line.startsWith("Updating ") || line === "Fast-forward" || line === "Already up to date.")
      lines.push({ text: line, tone: "success", bold: true });
    else
      lines.push({ text: line });
  }
  return lines;
}

class Commands {
  services;
  targets;
  running = null;
  update;
  constructor(services, targets) {
    this.services = services;
    this.targets = targets;
    this.update = new ModUpdate(services.overlay);
  }
  release() {
    this.running = null;
    this.update.release();
  }
  context() {
    const repository = this.services.repository();
    const facts = this.services.facts();
    const ready = repository?.state === "ready" ? repository : null;
    return {
      repository: ready !== null,
      remotes: facts.remotes,
      branch: ready?.branch.name ?? null,
      upstream: ready?.branch.upstream ?? null,
      changes: (ready?.files.length ?? 0) > 0,
      staged: ready?.files.some((file) => file.staged !== null && file.staged !== "conflict") ?? false,
      stash: facts.stash,
      head: facts.head,
      selected: this.services.selectedCommit()
    };
  }
  fail(name, message, cx) {
    showResult(this.services.overlay, name, false, message, undefined, cx);
  }
  rows(query) {
    const context = this.context();
    return COMMANDS.filter((id) => TITLES[id].toLowerCase().includes(query)).map((id) => {
      const reason = unavailable(id, context);
      return {
        id,
        label: TITLES[id],
        status: (id === "update" ? this.update.status() : null) ?? statusLabel(reason),
        disabled: reason !== null
      };
    });
  }
  openPalette(cx) {
    this.services.overlay.open({
      kind: "picker",
      title: "Commands",
      width: DIALOG.wide,
      columns: { label: "Command", status: "Status", width: 42 },
      rows: (query) => this.rows(query),
      footer: (query, count) => listStatus(query, count),
      primary: "[Enter] Run",
      secondary: "[Esc] Close",
      onChoose: (row, cx) => this.dispatch(row.id, cx)
    });
    cx.notify();
  }
  quickAction(action, cx) {
    if (action === "stash")
      this.openStash(cx);
    else
      this.dispatch(QUICK[action], cx);
  }
  quickActionState(action) {
    const id = QUICK[action];
    const busy = this.services.busy();
    const context = this.context();
    return {
      enabled: action === "stash" ? this.services.repository()?.state === "ready" : unavailable(id, context) === null,
      running: busy && this.running === id ? progressLabel(id) : null,
      primary: action === "commit" && context.staged
    };
  }
  shortcut(shortcut, cx) {
    if (shortcut === "workspace")
      this.targets.workspaces.manage(cx);
    else if (shortcut === "files-search") {
      if (this.services.activeTab() === "files")
        this.targets.files.shortcut("files-search");
      else {
        this.services.setTab("changes", cx);
        this.targets.changes.openFilesSearch(cx);
      }
    } else if (shortcut in QUICK)
      this.quickAction(shortcut, cx);
    else if (this.services.activeTab() !== "graph")
      return false;
    else if (shortcut === "actions")
      this.openCommitActions();
    else if (shortcut in GRAPH)
      this.graphAction(shortcut, cx);
    else
      return false;
    return true;
  }
  graphAction(action, cx) {
    const context = this.context();
    const id = GRAPH[action];
    if (!context.selected) {
      this.fail(RESULT_NAMES[id], "no commit selected");
      return;
    }
    this.dispatch(id, cx);
  }
  openCommitActions() {
    const sha = this.services.selectedCommit();
    if (!sha)
      return;
    const context = this.context();
    const ids = [
      "branch-at-commit",
      "tag",
      "rebase",
      "interactive-rebase",
      "checkout",
      "cherry-pick",
      "revert",
      "reset",
      "copy-sha"
    ];
    this.services.overlay.open({
      kind: "picker",
      title: "Commit actions",
      search: false,
      rows: ids.map((id) => ({ id, label: TITLES[id], disabled: unavailable(id, context) !== null })),
      footer: sha.slice(0, 8),
      primary: "[Enter] Continue",
      onChoose: (row, cx) => this.dispatch(row.id, cx)
    });
  }
  openStash(cx) {
    if (this.services.repository()?.state !== "ready") {
      this.fail(RESULT_NAMES["stash-changes"], "not a Git repository", cx);
      return;
    }
    const context = this.context();
    this.services.overlay.open({
      kind: "picker",
      title: "Stash",
      width: DIALOG.medium,
      search: false,
      rows: ["stash-changes", "stash-pop"].map((id) => {
        const reason = unavailable(id, context);
        return { id, label: TITLES[id], status: statusLabel(reason), disabled: reason !== null };
      }),
      footer: "Choose a stash operation",
      primary: "[Enter] Continue",
      onChoose: (row, cx) => this.dispatch(row.id, cx)
    });
  }
  openResetFlow(target, cx) {
    const { branch, head } = this.context();
    if (!branch || !head) {
      this.fail(RESULT_NAMES.reset, "Checkout a branch before resetting", cx);
      return;
    }
    new ResetFlow(this, { branch, head, target }, cx).open();
  }
  openRebaseEditor(target, cx) {
    new RebaseEditor(this, cx).open(target, cx);
  }
  openTarget(id, cx) {
    const context = this.context();
    const commit = context.selected ?? (id === "interactive-rebase" || id === "reset" ? context.head : null);
    if (!commit || !context.repository)
      return;
    new TargetPicker(this, id, commit, {
      rebase: (target, cx) => this.openRebaseEditor(target, cx),
      reset: (target, cx) => this.openResetFlow(target, cx)
    }).open(cx);
  }
  confirm(command, operation, cx) {
    openConfirm(this, command, operation, cx);
  }
  run(command, operation, cx, done) {
    const services = this.services;
    if (services.busy()) {
      this.fail("Action", "Wait for the current Git operation.", cx);
      return;
    }
    const git = services.git();
    if (!git) {
      this.fail(RESULT_NAMES[command], "Not a Git repository", cx);
      return;
    }
    const context = services.context();
    this.running = command;
    cx.spawn(async (cx) => {
      let reviewed;
      try {
        reviewed = await ReviewedOperation.review(git, operation);
      } catch (error) {
        this.fail(RESULT_NAMES[command], errorMessage2(error), cx);
        cx.notify();
        return;
      }
      services.mutate(context, progressLabel(command), async (git, cx) => {
        let output;
        let success = true;
        try {
          output = await reviewed.run(git);
        } catch (error) {
          success = false;
          const recovery = recoveryCommands(operation);
          output = `${errorMessage2(error)}${recovery ? `

Resolve conflicts, then use: ${recovery}` : ""}`;
        }
        if (!done?.(success, output, cx))
          this.report(command, operation, success, output, cx);
        if (!success)
          throw new Error(output.split(`
`)[0] ?? output);
      }, cx);
      cx.notify();
    });
  }
  report(command, operation, success, output, cx) {
    const overlay = this.services.overlay;
    const preview = operationPreview(operation);
    if (success && operation.kind === "remove-remote") {
      new RemoteList(this, cx).open(cx);
      return;
    }
    if (operation.kind === "pull") {
      showResultLines(overlay, `Pull ${success ? "complete" : "failed"}`, success, pullLines(preview, output, success), cx);
      return;
    }
    const title = success && command === "commit" ? "✓ Committed" : `${RESULT_NAMES[command]} ${success ? "complete" : "failed"}`;
    const lines = [{ text: preview, tone: "accent", bold: true }, { text: "" }];
    for (const text of output.split(`
`))
      lines.push({ text, tone: success ? "text" : "error" });
    showResultLines(overlay, title, success, lines, cx);
  }
  operation(id) {
    const context = this.context();
    switch (id) {
      case "discard-all":
        return context.head ? { kind: "discard-tracked", head: context.head } : "no HEAD commit to restore";
      case "fetch":
        return { kind: "fetch" };
      case "pull":
        return { kind: "pull" };
      case "push": {
        const remote = context.remotes[0];
        if (!remote)
          return "no remotes configured";
        return context.branch ? { kind: "push", force: false, remote, branch: context.branch } : "detached HEAD";
      }
      case "stash-changes":
        return { kind: "stash" };
      case "stash-pop":
        return { kind: "stash-pop" };
      default:
        return "operation is unavailable";
    }
  }
  flows(id, cx) {
    const flows = {
      update: () => this.update.open(cx),
      refresh: () => this.services.refresh("repository", cx),
      "switch-repository": () => this.targets.workspaces.manage(cx),
      reset: () => this.openTarget("reset", cx),
      "copy-sha": () => this.targets.graph.copySha(cx),
      commit: () => new CommitDialog(this, cx).open(),
      stash: () => this.openStash(cx),
      "add-remote": () => openAddRemote(this),
      "show-remotes": () => new RemoteList(this, cx).open(cx),
      branches: () => new BranchManager(this, cx).open(cx),
      checkout: () => this.openTarget("checkout", cx),
      rebase: () => this.openTarget("rebase", cx),
      "interactive-rebase": () => this.openTarget("interactive-rebase", cx),
      "cherry-pick": () => this.openTarget("cherry-pick", cx),
      revert: () => this.openTarget("revert", cx),
      "branch-at-head": () => openNamePrompt(this, "branch-at-head"),
      "branch-at-commit": () => openNamePrompt(this, "branch-at-commit"),
      tag: () => openNamePrompt(this, "tag")
    };
    const flow = flows[id];
    flow?.();
    return flow !== undefined;
  }
  dispatch(id, cx) {
    if (this.services.busy() && id !== "switch-repository") {
      this.fail("Action", "Wait for the current Git operation.", cx);
      return;
    }
    const reason = unavailable(id, this.context());
    if (reason) {
      this.fail(RESULT_NAMES[id], reason, cx);
      return;
    }
    if (!this.flows(id, cx)) {
      const operation = this.operation(id);
      if (typeof operation === "string")
        this.fail(RESULT_NAMES[id], `${TITLES[id]}: ${operation}`, cx);
      else if (CONFIRMED.includes(id))
        this.confirm(id, operation, cx);
      else
        this.run(id, operation, cx);
    }
    cx.notify();
  }
}

// src/ui/explorer.ts
import { h_flex as h_flex15, InputState as InputState3, v_flex as v_flex17 } from "gpui-base";
import { div as div19 } from "gpui-kit";

// src/ui/explorer/image.ts
import { Buffer } from "buffer";
import { createHash as createHash2, randomUUID } from "crypto";
import { mkdir, unlink, writeFile } from "fs/promises";
import { platform } from "process";
import { div as div18, image } from "gpui-kit";
import { appHome as appHome3, exec as exec3 } from "herdr";
var ASSET_FOLDER = "data/git-image-previews";
var BYTE_LIMIT = 5 * 1024 * 1024;
var READ_LIMIT = BYTE_LIMIT + 1;
var EXEC_TIMEOUT = 5000;
var PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
var REDRAW_DELAYS = [150, 700];
async function readImage(path) {
  const result = await (platform === "win32" || platform === "windows" ? exec3("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", windowsReadImage(path)], {
    timeout: EXEC_TIMEOUT
  }) : exec3("sh", [
    "-c",
    'test ! -L "$1" || exit 3; test -f "$1" || exit 2; head -c "$2" "$1" | base64',
    "git-preview",
    path,
    String(READ_LIMIT)
  ], { timeout: EXEC_TIMEOUT }));
  if (result.code === 2)
    throw new Error("Image is unavailable in the working tree");
  if (result.code === 3)
    throw new Error("Image preview requires a regular file");
  if (result.code !== 0)
    throw new Error("Could not read the image");
  const bytes = Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
  if (bytes.length > BYTE_LIMIT)
    throw new Error("Image exceeds the 5 MiB preview limit");
  return bytes;
}
function windowsReadImage(path) {
  const source = Buffer.from(path).toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'))
$item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
if ($null -eq $item -or $item.PSIsContainer) { exit 2 }
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 3 }
$stream = [IO.File]::OpenRead($item.FullName)
try {
  $bytes = New-Object byte[] ${READ_LIMIT}
  $offset = 0
  while ($offset -lt $bytes.Length) {
    $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
    if ($count -eq 0) { break }
    $offset += $count
  }
  [Console]::Write([Convert]::ToBase64String($bytes, 0, $offset))
} finally {
  $stream.Dispose()
}
`;
  return Buffer.from(script, "utf16le").toString("base64");
}
function imageFormat(bytes) {
  if (bytes.length < 12)
    return null;
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte))
    return "png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "jpeg";
  if (Buffer.from(bytes.subarray(0, 12)).toString("ascii").match(/^RIFF....WEBP$/s))
    return "webp";
  return null;
}

class ImagePreview {
  asset = null;
  clear() {
    const previous = this.asset;
    this.asset = null;
    if (previous)
      unlink(previous.absolute).catch(() => {
        return;
      });
  }
  async load(source, current, cx) {
    const bytes = await readImage(source.path);
    if (!current())
      return;
    if (imageFormat(bytes) !== source.format)
      throw new Error("File does not contain a supported image");
    const digest = String(createHash2("sha256").update(bytes).digest("hex"));
    if (this.asset?.digest === digest)
      return;
    const directory = `${appHome3()}/${ASSET_FOLDER}`;
    const name = `${randomUUID()}.${source.format}`;
    const asset = { relative: `${ASSET_FOLDER}/${name}`, absolute: `${directory}/${name}`, digest };
    try {
      await mkdir(directory, { recursive: true });
      if (!current())
        return;
      await writeFile(asset.absolute, bytes);
      if (!current())
        return;
      this.clear();
      this.asset = asset;
      for (const delay of REDRAW_DELAYS) {
        cx.timer.after(delay, (cx) => {
          if (this.asset === asset)
            cx.notify();
        });
      }
    } finally {
      if (this.asset !== asset)
        await unlink(asset.absolute).catch(() => {
          return;
        });
    }
  }
  render() {
    const viewport = div18().flex().flex_1().w_full().min_w(0).min_h(0).overflow_hidden();
    if (this.asset)
      viewport.child(image(this.asset.relative).size_full());
    return viewport;
  }
}

// src/ui/explorer/preview.ts
import { exec as exec4, readTextFile as readTextFile2 } from "herdr";
var images = new Map([
  ["png", "png"],
  ["jpg", "jpeg"],
  ["jpeg", "jpeg"],
  ["webp", "webp"]
]);
var BYTE_LIMIT2 = 1024 * 1024;
function previewNotice(notice) {
  return { lines: [], before: [], notice };
}
function mergeChanges(source, changes, path) {
  const lines = [];
  const before = [];
  const pushRemoved = (change) => change.removed.forEach((text, offset) => {
    lines.push({ number: null, text, tokens: highlight(text, path), tone: "removed" });
    before.push(change.oldStart + offset);
  });
  let pending = 0;
  let oldLine = 1;
  let addedUntil = 0;
  source.forEach((line, index) => {
    const number = index + 1;
    for (let change = changes[pending];change && change.newStart <= number; change = changes[++pending]) {
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
  for (const change of changes.slice(pending))
    pushRemoved(change);
  return { lines, before, notice: null };
}
async function readPreview(git, root, on, file, newFile) {
  const absolute = `${root}/${file}`;
  const format = images.get(file.match(/\.([^./]+)$/)?.[1]?.toLowerCase() ?? "");
  if (format)
    return on ? previewNotice("Image preview requires a local working tree") : { lines: [], before: [], notice: null, image: { path: absolute, format } };
  try {
    const link = await exec4("readlink", [absolute], { on });
    if (link.code === 0 && link.stdout.trim())
      return previewNotice(`Symbolic link to ${link.stdout.trim()}`);
    const text = await readTextFile2(absolute, { on });
    if (text === null)
      return previewNotice("Deleted in the working tree");
    if (text.length > BYTE_LIMIT2)
      return previewNotice("File is larger than 1 MiB and is not previewed");
    if (text.includes("\x00"))
      return previewNotice("Binary file");
    const source = sourceLines(text, file);
    const changes = newFile ? [{ oldStart: 1, removed: [], newStart: 1, added: source.length }] : await readLineChanges(git, file);
    return mergeChanges(source, changes, file);
  } catch (error) {
    return previewNotice(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// src/ui/explorer/search.ts
var PATH_RESULT_LIMIT = 200;
function visible(path) {
  return !path.split("/").some((part) => part.startsWith("."));
}
function fuzzySpread(haystack, needle) {
  const wanted = [...needle];
  let next = 0;
  let first = -1;
  let index = 0;
  for (const character of haystack) {
    if (character === wanted[next]) {
      if (first < 0)
        first = index;
      next++;
      if (next === wanted.length)
        return index - first;
    }
    index++;
  }
  return wanted.length === 0 ? 0 : null;
}
function rankPath(path, needle) {
  const lower = path.toLowerCase();
  const nameStart = lower.lastIndexOf("/") + 1;
  const name = lower.slice(nameStart);
  const span = (start) => [start, start + needle.length];
  let rank;
  let spread = 0;
  let type = "filename";
  let range = null;
  const inName = name.indexOf(needle);
  const nameSpread = inName < 0 ? fuzzySpread(name, needle) : null;
  const inPath = lower.indexOf(needle);
  if (name === needle)
    [rank, range] = [0, [nameStart, lower.length]];
  else if (inName === 0)
    [rank, range] = [1, span(nameStart)];
  else if (inName > 0)
    [rank, range] = [2, span(nameStart + inName)];
  else if (nameSpread !== null)
    [rank, spread] = [3, nameSpread];
  else if (inPath >= 0)
    [rank, type, range] = [4, "path", span(inPath)];
  else {
    const pathSpread = fuzzySpread(lower, needle);
    if (pathSpread === null)
      return null;
    [rank, spread, type] = [4, pathSpread + 1, "path"];
  }
  if (lower.length !== path.length)
    range = null;
  return { key: [rank, spread, path.length], result: { path, line: null, range, type } };
}
function rankPaths(paths, query) {
  const needle = query.toLowerCase();
  const ranked = [];
  for (const path of paths) {
    if (!visible(path))
      continue;
    const entry = rankPath(path, needle);
    if (entry)
      ranked.push(entry);
  }
  ranked.sort((left, right) => {
    for (let index = 0;index < 3; index++) {
      const difference = (left.key[index] ?? 0) - (right.key[index] ?? 0);
      if (difference)
        return difference;
    }
    return left.result.path < right.result.path ? -1 : left.result.path > right.result.path ? 1 : 0;
  });
  return ranked.slice(0, PATH_RESULT_LIMIT).map((entry) => entry.result);
}
async function searchLines(git, query) {
  const matches = await searchContents(git, query);
  return matches.filter((match) => visible(match.path)).map((match) => ({ path: match.path, line: match.line, range: [match.start, match.end], type: "content" }));
}
function resultRows(results) {
  const found = results.findIndex((result) => result.type === "content");
  const lines = found < 0 ? results.length : found;
  const rows = [];
  const groups = [
    ["Files", 0, lines],
    ["Lines", lines, results.length]
  ];
  for (const [label, start, end] of groups) {
    if (start === end)
      continue;
    rows.push({ kind: "group", label, count: end - start });
    for (let index = start;index < end; index++)
      rows.push({ kind: "result", index });
  }
  return rows;
}
function sameResult(left, right) {
  return left.path === right.path && left.line === right.line && left.type === right.type;
}

// src/ui/explorer/tree.ts
function node2() {
  return { directories: new Map, files: new Map };
}
function compareNames2(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a !== b)
    return a < b ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

class PathTree {
  root = node2();
  constructor(paths) {
    for (const path of paths) {
      const parts = path.split("/");
      const name = parts.pop() ?? path;
      let current = this.root;
      for (const part of parts) {
        let child = current.directories.get(part);
        if (!child) {
          child = node2();
          current.directories.set(part, child);
        }
        current = child;
      }
      current.files.set(name, path);
    }
  }
  rows(expanded) {
    const rows = [];
    const emit = (current, depth, prefix) => {
      for (const name of [...current.directories.keys()].sort(compareNames2)) {
        const path = `${prefix}${name}`;
        const open = expanded.has(path);
        rows.push({ depth, label: name, path, directory: true, expanded: open });
        const child = current.directories.get(name);
        if (open && child)
          emit(child, depth + 1, `${path}/`);
      }
      for (const name of [...current.files.keys()].sort(compareNames2))
        rows.push({ depth, label: name, path: current.files.get(name) ?? name, directory: false, expanded: false });
    };
    emit(this.root, 0, "");
    return rows;
  }
}
var LETTERS = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  type: "T",
  conflict: "U",
  untracked: "?"
};
function workingStatus(file) {
  if (file.staged === "conflict" || file.unstaged === "conflict")
    return "U";
  if (file.unstaged === "untracked")
    return "?";
  if (file.unstaged === "deleted")
    return "D";
  const kind = file.staged ?? file.unstaged;
  return kind ? LETTERS[kind] : "M";
}
function pathStatuses(files) {
  const statuses = new Map;
  for (const file of files) {
    const status = workingStatus(file);
    if (!statuses.has(file.path))
      statuses.set(file.path, status);
    for (let end = file.path.indexOf("/");end >= 0; end = file.path.indexOf("/", end + 1)) {
      const folder = file.path.slice(0, end);
      const existing = statuses.get(folder);
      if (existing === undefined)
        statuses.set(folder, status);
      else if (existing !== status)
        statuses.set(folder, "M");
    }
  }
  return statuses;
}

// src/ui/explorer.ts
var SEARCH_DEBOUNCE_MS = 120;
var LIST_HORIZONTAL_STEP = 1;
function emptyFilter() {
  return { results: [], cursor: 0, scroll: 0, height: 1, searching: false, error: null };
}

class FilesTab {
  services;
  workspaces;
  id = "files";
  active = false;
  pane = "explorer";
  root = null;
  files = null;
  tree = null;
  rows = [];
  expanded = new Set;
  error = null;
  listRequest = 0;
  list = new ListViewport("git-files-tree");
  horizontal = 0;
  treeColumns = 0;
  previewFile = null;
  loadingFile = null;
  preview = previewNotice("");
  previewRequest = 0;
  image = new ImagePreview;
  reveal = false;
  code = new CodeView("git-files-preview");
  query;
  filtering = false;
  filter = emptyFilter();
  searchRequest = 0;
  blame = new SelectionBlame;
  treeHandle;
  previewHandle;
  size = { width: 0, height: 0, cols: 120, rows: 40, wide: true };
  constructor(services, workspaces, cx) {
    this.services = services;
    this.workspaces = workspaces;
    this.treeHandle = cx.focus_handle();
    this.previewHandle = cx.focus_handle();
    this.query = InputState3.new({ placeholder: "" });
    this.query.on("focus", (_, cx) => {
      this.filtering = true;
      cx.notify();
    });
    this.query.on("blur", (_, cx) => {
      this.filtering = false;
      cx.notify();
    });
    this.query.on("change", (_, cx) => this.editFilter(cx));
    this.query.on("submit", (_, cx) => {
      this.closeFilter();
      cx.notify();
    });
  }
  activate(cx) {
    this.active = true;
    this.requestFiles(cx);
  }
  deactivate(_cx) {
    this.active = false;
    this.listRequest++;
    this.previewRequest++;
    this.loadingFile = null;
    if (this.preview.image)
      this.clearPreview();
    if (this.filtering)
      this.closeFilter();
  }
  focus() {
    this.setPane(this.pane);
  }
  release() {
    this.image.clear();
    this.active = false;
    this.listRequest++;
    this.previewRequest++;
    this.searchRequest++;
    this.query.release();
    this.treeHandle.release();
    this.previewHandle.release();
    this.code.release();
    this.blame.reset();
  }
  shortcut(shortcut) {
    if (shortcut !== "files-search")
      return false;
    this.openFilter();
    return true;
  }
  escape(cx) {
    if (this.workspaces.isFocused() || this.pane === "preview") {
      this.setPane("explorer");
      return true;
    }
    if (!this.applied())
      return false;
    this.clearFilter(cx);
    return true;
  }
  status() {
    return { blame: this.blame.status() };
  }
  refresh(scope, cx) {
    if (scope === "repository" && this.root !== this.repositoryRoot())
      this.reset(cx);
    if (this.active && (scope === "changes" || scope === "repository"))
      this.requestFiles(cx);
  }
  repositoryRoot() {
    const repository = this.services.repository();
    return repository?.state === "ready" ? repository.root : null;
  }
  paneFocused(pane) {
    return this.pane === pane && !this.filtering && !this.workspaces.isFocused();
  }
  reset(cx) {
    this.image.clear();
    this.listRequest++;
    this.previewRequest++;
    this.searchRequest++;
    this.root = this.repositoryRoot();
    this.files = null;
    this.tree = null;
    this.rows = [];
    this.expanded.clear();
    this.error = null;
    this.list.reset();
    this.horizontal = 0;
    this.previewFile = null;
    this.loadingFile = null;
    this.preview = previewNotice("");
    this.code.set([], "text");
    this.code.clearSelection();
    this.filter = emptyFilter();
    this.query.set_value("");
    this.blame.sync(this.services, null, cx);
  }
  setPane(pane) {
    this.pane = pane;
    (pane === "explorer" ? this.treeHandle : this.previewHandle).focus();
  }
  applied() {
    return this.query.value().trim() !== "";
  }
  selectedRow() {
    return this.rows[this.list.selected] ?? null;
  }
  selectedFile() {
    const row = this.selectedRow();
    return row && !row.directory ? row.path : null;
  }
  activeResult() {
    return this.applied() ? this.filter.results[this.filter.cursor] ?? null : null;
  }
  activeFile() {
    return this.applied() ? this.activeResult()?.path ?? null : this.selectedFile();
  }
  previewPath() {
    const file = this.previewFile;
    return file !== null && file === this.activeFile() ? file : null;
  }
  requestFiles(cx) {
    if (this.root !== this.repositoryRoot())
      this.reset(cx);
    const git = this.services.git();
    const root = this.root;
    if (!git || !root)
      return;
    const request = ++this.listRequest;
    cx.spawn(async (cx) => {
      try {
        const files = await readFiles(git);
        if (request !== this.listRequest || root !== this.root)
          return;
        this.files = files;
        this.tree = new PathTree(files);
        this.error = null;
        this.rebuildRows();
        this.reloadSelectedPreview(cx);
      } catch (error) {
        if (request === this.listRequest)
          this.error = error instanceof Error ? error.message : String(error);
      } finally {
        cx.notify();
      }
    });
  }
  rebuildRows() {
    const selected = this.selectedRow()?.path;
    this.rows = this.tree?.rows(this.expanded) ?? [];
    const position = this.rows.findIndex((row) => row.path === selected);
    this.list.selected = position >= 0 ? position : Math.min(this.list.selected, Math.max(0, this.rows.length - 1));
  }
  reloadSelectedPreview(cx) {
    const file = this.applied() ? this.activeFile() : this.selectedFile();
    if (file)
      this.requestPreview(file, cx);
    else
      this.clearPreview();
  }
  clearPreview() {
    this.image.clear();
    this.previewRequest++;
    this.loadingFile = null;
    this.previewFile = null;
    this.preview = previewNotice("");
    this.code.clearSelection();
  }
  newFile(file) {
    const repository = this.services.repository();
    if (repository?.state !== "ready")
      return false;
    const change = repository.files.find((entry) => entry.path === file);
    if (!change)
      return false;
    const status = workingStatus(change);
    return status === "?" || status === "A";
  }
  requestPreview(file, cx) {
    const git = this.services.git();
    const root = this.root;
    if (!this.active || !git || !root)
      return;
    if (this.previewFile !== file) {
      this.image.clear();
      this.previewFile = null;
      this.preview = previewNotice("");
      this.code.clearSelection();
    }
    const request = ++this.previewRequest;
    this.loadingFile = file;
    const context = this.services.context();
    const on = this.services.location()?.on ?? null;
    const newFile = this.newFile(file);
    cx.spawn(async (cx) => {
      const current = () => this.active && request === this.previewRequest && context === this.services.context() && this.activeFile() === file;
      let preview = await readPreview(git, root, on, file, newFile);
      if (!current())
        return;
      if (preview.image) {
        try {
          await this.image.load(preview.image, current, cx);
        } catch (error) {
          preview = previewNotice(error instanceof Error ? error.message : String(error));
        }
      }
      if (!current())
        return;
      if (!preview.image)
        this.image.clear();
      this.loadingFile = null;
      this.previewFile = file;
      this.preview = preview;
      this.code.set(preview.lines, fileLanguage(file));
      cx.notify();
    });
  }
  showPreview(file, cx) {
    if (this.previewFile === file || this.loadingFile === file)
      return;
    this.requestPreview(file, cx);
  }
  selectRow(index, cx) {
    if (!this.rows.length)
      return;
    this.list.selected = Math.max(0, Math.min(index, this.rows.length - 1));
    const file = this.selectedFile();
    if (file)
      this.showPreview(file, cx);
    else
      this.clearPreview();
  }
  setDirectory(path, expanded) {
    if (expanded)
      this.expanded.add(path);
    else
      this.expanded.delete(path);
    this.rebuildRows();
  }
  expandOrEnter(cx) {
    const row = this.selectedRow();
    if (!row)
      return;
    if (!row.directory)
      this.setPane("preview");
    else if (!row.expanded)
      this.setDirectory(row.path, true);
    else
      this.selectRow(this.list.selected + 1, cx);
  }
  collapseOrLeave(cx) {
    const row = this.selectedRow();
    if (!row)
      return;
    if (row.directory && row.expanded) {
      this.setDirectory(row.path, false);
      return;
    }
    for (let index = this.list.selected - 1;index >= 0; index--)
      if (this.rows[index]?.depth === row.depth - 1) {
        this.selectRow(index, cx);
        return;
      }
  }
  activateRow() {
    const row = this.selectedRow();
    if (row?.directory)
      this.setDirectory(row.path, !row.expanded);
    else if (row)
      this.setPane("preview");
  }
  openFilter() {
    if (!this.repositoryRoot())
      return;
    this.query.focus();
  }
  closeFilter() {
    this.filtering = false;
    this.setPane("explorer");
  }
  clearFilter(cx) {
    this.searchRequest++;
    this.filter = emptyFilter();
    this.reveal = false;
    if (this.query.value())
      this.query.set_value("");
    this.closeFilter();
    const file = this.selectedFile();
    if (file)
      this.showPreview(file, cx);
    else
      this.clearPreview();
  }
  editFilter(cx) {
    if (!this.applied()) {
      this.searchRequest++;
      this.filter = emptyFilter();
      this.reveal = false;
      const file = this.selectedFile();
      if (file)
        this.showPreview(file, cx);
      else
        this.clearPreview();
      cx.notify();
      return;
    }
    const request = ++this.searchRequest;
    this.filter.cursor = 0;
    this.filter.searching = true;
    this.showSelectedResult(cx);
    cx.timer.after(SEARCH_DEBOUNCE_MS, (cx) => {
      if (request === this.searchRequest)
        this.search(request, cx);
    });
    cx.notify();
  }
  applyResults(results, done, cx) {
    const selected = this.filter.results[this.filter.cursor];
    const position = selected ? results.findIndex((result) => sameResult(result, selected)) : -1;
    this.filter.results = results;
    this.filter.searching = !done;
    this.filter.cursor = position >= 0 ? position : Math.min(this.filter.cursor, Math.max(0, results.length - 1));
    this.showSelectedResult(cx);
  }
  search(request, cx) {
    const git = this.services.git();
    const query = this.query.value();
    if (!git || !this.root) {
      this.filter.searching = false;
      return;
    }
    const root = this.root;
    const current = () => request === this.searchRequest && root === this.root;
    cx.spawn(async (cx) => {
      try {
        const paths = rankPaths(this.files ?? await readFiles(git), query);
        if (!current())
          return;
        this.applyResults(paths, false, cx);
        cx.notify();
        const lines = await searchLines(git, query);
        if (!current())
          return;
        this.filter.error = null;
        this.applyResults([...paths, ...lines], true, cx);
      } catch (error) {
        if (!current())
          return;
        this.filter.error = error instanceof Error ? error.message : String(error);
        this.filter.searching = false;
      } finally {
        cx.notify();
      }
    });
  }
  showSelectedResult(cx) {
    const result = this.filter.results[this.filter.cursor];
    if (!result) {
      this.clearPreview();
      return;
    }
    this.reveal = result.line !== null;
    this.showPreview(result.path, cx);
  }
  moveResult(delta, cx) {
    const last = Math.max(0, this.filter.results.length - 1);
    this.filter.cursor = Math.max(0, Math.min(last, this.filter.cursor + delta));
    this.showSelectedResult(cx);
  }
  resultStep(keystroke) {
    const page = Math.max(1, this.filter.height);
    const steps = {
      down: 1,
      j: 1,
      up: -1,
      k: -1,
      pagedown: page,
      pageup: -page,
      home: -Number.MAX_SAFE_INTEGER,
      end: Number.MAX_SAFE_INTEGER
    };
    return steps[keystroke] ?? null;
  }
  filterInputKey(event, cx) {
    if (isChord(event))
      return;
    const step = ["down", "up", "pagedown", "pageup"].includes(event.keystroke) ? this.resultStep(event.keystroke) : null;
    if (event.keystroke === "escape")
      this.clearFilter(cx);
    else if (event.keystroke === "enter")
      this.closeFilter();
    else if (step !== null)
      this.moveResult(step, cx);
    else
      return;
    cx.stop_propagation();
    cx.notify();
  }
  resultsKey(event, cx) {
    const step = this.resultStep(event.keystroke);
    if (step !== null)
      this.moveResult(step, cx);
    else if (event.keystroke === "enter" && this.activeFile())
      this.setPane("preview");
    else if (event.keystroke === "escape")
      this.clearFilter(cx);
    else
      return false;
    return true;
  }
  treeAction(event, cx) {
    const row = this.selectedRow();
    switch (event.keystroke) {
      case "right":
        this.expandOrEnter(cx);
        return true;
      case "left":
        this.collapseOrLeave(cx);
        return true;
      case "space":
        if (row?.directory)
          this.setDirectory(row.path, !row.expanded);
        return true;
      default:
        return false;
    }
  }
  explorerKey(event, cx) {
    if (isChord(event))
      return;
    let handled;
    if (event.keystroke === "/") {
      this.openFilter();
      handled = true;
    } else if (this.applied())
      handled = this.resultsKey(event, cx);
    else if (this.treeAction(event, cx))
      handled = true;
    else {
      const outcome = event.keystroke === "escape" ? null : this.list.key(event, this.rows.length);
      if (outcome === "moved")
        this.selectRow(this.list.selected, cx);
      else if (outcome === "activate")
        this.activateRow();
      handled = outcome !== null;
    }
    if (!handled)
      return;
    cx.stop_propagation();
    cx.notify();
  }
  selectionLines() {
    const range = this.code.selection();
    if (!range || !this.previewPath())
      return null;
    const lines = this.code.lines();
    const rows = [];
    for (let row = range.start;row <= range.end; row++)
      if (lines[row]?.number != null)
        rows.push(row);
    const numbers = rows.map((row) => lines[row]?.number ?? 0);
    return numbers.length ? { rows, lines: numbers } : null;
  }
  copySelection() {
    const path = this.previewPath();
    const selection = this.selectionLines();
    if (!path || !selection)
      return false;
    const lines = this.code.lines();
    openCopySelection(this.services, {
      path,
      side: null,
      lines: selection.lines,
      code: selection.rows.map((row) => lines[row]?.text ?? "")
    }, () => this.code.clearSelection());
    return true;
  }
  lineHistory(cx) {
    const path = this.previewPath();
    const selection = this.selectionLines();
    const range = this.code.selection();
    if (!path || !selection || !range)
      return;
    const ranges = [];
    for (let row = range.start;row <= range.end; row++) {
      const line = this.preview.before[row];
      if (line == null)
        continue;
      const last = ranges.at(-1);
      if (last && last[1] + 1 === line)
        last[1] = line;
      else
        ranges.push([line, line]);
    }
    if (!ranges.length) {
      showResult(this.services.overlay, "Action", false, "Select committed lines to see their history.", undefined, cx);
      return;
    }
    const name = path.split("/").pop() ?? path;
    openLineHistory(this.services, `${name}:${lineNumbersText(selection.lines)}`, { file: path, ranges, revision: null }, { cols: this.size.cols, rows: this.size.rows + 10 }, cx);
  }
  previewKey(event, cx) {
    if (isChord(event))
      return;
    let handled = true;
    if (event.keystroke === "/")
      this.openFilter();
    else if (event.keystroke === "y")
      handled = this.copySelection();
    else if (event.keystroke === "h" && this.code.selection())
      this.lineHistory(cx);
    else
      handled = this.code.key(event, cx);
    if (!handled)
      return;
    cx.stop_propagation();
    cx.notify();
  }
  syncBlame(cx) {
    const path = this.previewPath();
    const selection = this.selectionLines();
    this.blame.sync(this.services, path && selection ? { file: path, lines: selection.lines, revision: null } : null, cx);
  }
  message(text, color) {
    return div19().flex_1().min_h(0).text_color(color).whitespace_normal().child(text);
  }
  treeMessage(look) {
    const { t } = look;
    if (!this.repositoryRoot())
      return this.message("Not a Git repository", t.warning);
    if (this.error)
      return this.message(this.error, t.error);
    if (!this.files)
      return this.message("Loading files…", t.hint);
    if (!this.rows.length)
      return this.message("No files", t.hint);
    return null;
  }
  treeLine(look, row, status) {
    const { t } = look;
    const indent = "  ".repeat(row.depth);
    const marker = row.directory ? div19().text_color(t.hint).child(`${indent}${row.expanded ? GLYPH.expanded : GLYPH.collapsed} `) : status ? div19().text_color(statusColor(t, status)).font_weight(700).child(`${indent}${status[0]} `) : div19().child(`${indent}  `);
    return h_flex15().flex_none().ml(-cols(look, this.horizontal)).child(marker).child(div19().text_color(status ? statusColor(t, status) : t.text).child(row.label));
  }
  maxHorizontal() {
    const width = this.applied() ? Math.max(0, ...this.filter.results.map((result) => displayWidth(resultText(result)))) : Math.max(0, ...this.rows.map((row) => row.depth * 2 + 2 + displayWidth(row.label)));
    return Math.max(0, width - Math.max(0, this.treeColumns - 2));
  }
  scrollHorizontal(delta) {
    this.horizontal = Math.max(0, Math.min(this.maxHorizontal(), this.horizontal + delta));
  }
  treeFrame(look, id, title, body) {
    return box(look, { id, title, focused: this.paneFocused("explorer") }, v_flex17().id(`${id}-body`).flex_1().min_h(0).min_w(0).track_focus(this.treeHandle).on_key_down((event, cx) => this.explorerKey(event, cx)).on_mouse_down("left", (_, cx) => {
      this.setPane("explorer");
      cx.notify();
    }).on_size_change((size, cx) => {
      const columns = Math.floor(size.width / look.screenCell);
      if (columns === this.treeColumns)
        return;
      this.treeColumns = columns;
      cx.notify();
    }).on_scroll_wheel((event, cx) => {
      const delta = event.delta_lines ? event.delta_lines.x : event.delta.x / look.cell;
      const steps = Math.trunc(delta);
      if (!steps)
        return;
      cx.stop_propagation();
      this.scrollHorizontal(-steps * LIST_HORIZONTAL_STEP);
      cx.notify();
    }).child(body)).flex_1();
  }
  treeBox(look) {
    this.horizontal = Math.min(this.horizontal, this.maxHorizontal());
    const title = countedTitle("Files", this.files?.length ?? 0);
    const message = this.treeMessage(look);
    if (message)
      return this.treeFrame(look, "git-files-tree-box", title, message);
    const repository = this.services.repository();
    const statuses = pathStatuses(repository?.state === "ready" ? repository.files : []);
    const list = this.list.render(look, {
      length: this.rows.length,
      focused: true,
      row: ({ index }) => {
        const row = this.rows[index];
        return row ? this.treeLine(look, row, statuses.get(row.path)) : div19();
      },
      onSelect: (index, cx) => {
        this.setPane("explorer");
        this.selectRow(index, cx);
      },
      onActivate: () => {
        const row = this.selectedRow();
        if (row?.directory)
          this.setDirectory(row.path, !row.expanded);
      }
    });
    return this.treeFrame(look, "git-files-tree-box", title, list);
  }
  resultsMessage(look) {
    const { t } = look;
    if (this.filter.error)
      return this.message(this.filter.error, t.error);
    if (!this.filter.results.length && this.filter.searching)
      return this.message("Searching…", t.hint);
    if (!this.filter.results.length)
      return this.message("No matches", t.hint);
    return null;
  }
  resultRow(look, row, offset) {
    const { t } = look;
    const element = h_flex15().id(`git-files-match-${offset}`).flex_none().h(look.row).min_w(0).whitespace_nowrap().overflow_hidden();
    if (row.kind === "group")
      return element.px(4).child(sectionLabel(look, countedTitle(row.label, row.count), { rule: true }));
    const result = this.filter.results[row.index];
    const selected = row.index === this.filter.cursor;
    return element.border_l(2).border_color(selected ? t.accent : "#00000000").when(selected, (el) => el.bg(t.accentSoft).font_weight(600)).hover((style) => style.bg(selected ? t.accentSoft : t.hover)).child(div19().flex_none().w(cols(look, 2)).text_color(selected ? t.accentText : t.hint).child(selected ? GLYPH.marker : "")).child(h_flex15().ml(-cols(look, this.horizontal)).child(div19().text_color(t.text).child(`  ${result?.path ?? ""}`)).when(result?.line != null, (el) => el.child(div19().text_color(t.hint).child(`:${result?.line}`)))).on_click((_, cx) => {
      cx.stop_propagation();
      this.setPane("explorer");
      this.filter.cursor = row.index;
      this.showSelectedResult(cx);
      cx.notify();
    });
  }
  resultsBody(look) {
    const filter = this.filter;
    const all = resultRows(filter.results);
    const selectedRow = Math.max(0, all.findIndex((row) => row.kind === "result" && row.index === filter.cursor));
    let offset = viewportOffset(filter.scroll, selectedRow, all.length, filter.height);
    if (offset === selectedRow && offset > 0 && all[offset - 1]?.kind === "group")
      offset--;
    filter.scroll = offset;
    const visible = v_flex17().flex_1().min_w(0).min_h(0).overflow_hidden();
    all.slice(offset, offset + filter.height).forEach((row, index) => {
      visible.child(this.resultRow(look, row, offset + index));
    });
    const bar = scrollbar(look, { axis: "vertical", total: all.length, visible: filter.height, offset });
    return h_flex15().id("git-files-matches").flex_1().min_h(0).min_w(0).items_stretch().on_size_change((size, cx) => {
      const height = Math.max(1, Math.floor(size.height / look.screenRow));
      if (height === filter.height)
        return;
      filter.height = height;
      cx.notify();
    }).on_scroll_wheel((event, cx) => {
      const steps = Math.trunc(event.delta_lines ? event.delta_lines.y : event.delta.y / look.row);
      if (!steps)
        return;
      cx.stop_propagation();
      this.setPane("explorer");
      this.moveResult(-steps, cx);
      cx.notify();
    }).child(visible).when(!!bar, (el) => el.child(bar ?? div19()));
  }
  resultsBox(look) {
    this.horizontal = Math.min(this.horizontal, this.maxHorizontal());
    let title = countedTitle("Matches", this.filter.results.length);
    if (this.filter.searching)
      title += `${GLYPH.separator}Searching…`;
    return this.treeFrame(look, "git-files-matches-box", title, this.resultsMessage(look) ?? this.resultsBody(look));
  }
  previewTitle(look) {
    const selection = this.selectionLines();
    const path = this.previewPath();
    if (selection && path) {
      const name = path.split("/").pop() ?? path;
      return div19().text_color(look.t.accent).font_weight(700).child(`${name}:${lineNumbersText(selection.lines)}`);
    }
    return this.activeFile() ?? "Preview";
  }
  matchTarget() {
    const result = this.activeResult();
    if (result?.type !== "content" || result.line === null || !result.range)
      return null;
    const row = this.code.lines().findIndex((line) => line.number === result.line);
    return row < 0 ? null : { row, start: result.range[0], end: result.range[1] };
  }
  previewBody(look) {
    const { t } = look;
    if (!this.previewPath())
      return this.message(this.activeFile() ? "Loading…" : "Select a file to preview it", t.hint);
    if (this.preview.image)
      return this.image.render();
    if (this.preview.notice)
      return this.message(this.preview.notice, t.hint);
    const match = this.matchTarget();
    if (this.reveal && match) {
      this.reveal = false;
      this.code.reveal(match.row);
    }
    return this.code.render(look, {
      focused: this.paneFocused("preview"),
      match: match ?? undefined,
      hint: !this.services.overlay.isOpen()
    });
  }
  previewBox(look) {
    return box(look, { id: "git-files-preview-box", title: this.previewTitle(look), focused: this.paneFocused("preview") }, v_flex17().id("git-files-preview-body").flex_1().min_h(0).min_w(0).track_focus(this.previewHandle).on_key_down((event, cx) => this.previewKey(event, cx)).on_mouse_down("left", (_, cx) => {
      this.setPane("preview");
      cx.notify();
    }).child(this.previewBody(look))).flex_1();
  }
  render(look, size, cx) {
    this.size = size;
    if (this.active && this.root !== this.repositoryRoot())
      this.requestFiles(cx);
    this.syncBlame(cx);
    const left = v_flex17().flex_1().min_h(0).min_w(0).gap(6).child(v_flex17().flex_1().min_h(0).child(this.applied() ? this.resultsBox(look) : this.treeBox(look))).child(v_flex17().flex_1().min_h(0).child(this.workspaces.render(look).flex_1()));
    const preview = v_flex17().min_h(0).min_w(0).child(this.previewBox(look));
    const panes = size.wide ? h_flex15().flex_1().min_h(0).gap(6).items_stretch().child(left.flex_none().w(`${35}%`)).child(preview.flex_1().h_full()) : v_flex17().flex_1().min_h(0).gap(6).child(left.h(`${50}%`).flex_none()).child(preview.flex_1());
    return v_flex17().size_full().min_h(0).min_w(0).gap(6).child(div19().flex_none().on_key_down((event, cx) => this.filterInputKey(event, cx)).on_mouse_down("left", (_, cx) => {
      this.openFilter();
      cx.notify();
    }).child(filterBar(look, { id: "git-files-filter", input: this.query, active: this.filtering }))).child(panes);
  }
}
function resultText(result) {
  return `  ${result.path}${result.line === null ? "" : `:${result.line}`}`;
}

// src/ui/graph.ts
import { h_flex as h_flex19, InputState as InputState4, v_flex as v_flex20 } from "gpui-base";
import {
  div as div23
} from "gpui-kit";

// src/git/history-maintenance.ts
function checked(result, command) {
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `git ${command} exited with ${result.code}`);
  return result.stdout.trim();
}
async function config(git, type, key) {
  const result = await git(["config", type, "--get", key]);
  return result.code === 1 ? null : checked(result, "config");
}
async function prepareHistory(git) {
  const [enabled, auto] = await Promise.all([
    config(git, "--bool", "core.commitGraph"),
    config(git, "--int", "maintenance.commit-graph.auto")
  ]);
  if (enabled === "false")
    return { state: "skipped", reason: "core.commitGraph=false" };
  if (auto === "0")
    return { state: "skipped", reason: "maintenance.commit-graph.auto=0" };
  const [shallow, replacements, refs] = await Promise.all([
    git(["rev-parse", "--is-shallow-repository"]),
    git(["for-each-ref", "--format=%(refname)", "refs/replace/"]),
    git(["show-ref", "--head", "--quiet"])
  ]);
  const isShallow = checked(shallow, "rev-parse") === "true";
  const hasReplacements = checked(replacements, "for-each-ref") !== "";
  if (refs.code !== 1)
    checked(refs, "show-ref");
  if (isShallow)
    return { state: "skipped", reason: "Shallow repository" };
  if (hasReplacements)
    return { state: "skipped", reason: "Replacement refs" };
  if (refs.code === 1)
    return { state: "skipped", reason: "No commits" };
  checked(await git([
    "-c",
    "maintenance.autoDetach=false",
    "-c",
    "gc.autoDetach=false",
    "commit-graph",
    "write",
    "--split",
    "--reachable",
    "--no-progress"
  ]), "commit-graph");
  return { state: "ready" };
}

// src/ui/graph/inspect.ts
import { h_flex as h_flex16, v_flex as v_flex18 } from "gpui-base";
import { div as div20 } from "gpui-kit";
var DETAILS_CACHE_CAP = 64;
var PREVIEW_CACHE_CAP = 8;
var PREVIEW_TITLE_RESERVE = 6;
function message(error) {
  return error instanceof Error ? error.message : String(error);
}
function firstLine(text) {
  return (text.split(`
`)[0] ?? "unknown error").trim() || "unknown error";
}
function workingChanges2(files) {
  const staged = files.flatMap((file) => file.staged ? [{ side: "staged", status: statusLetter(file.staged), path: file.path, file }] : []);
  const unstaged = files.flatMap((file) => file.unstaged ? [{ side: "unstaged", status: statusLetter(file.unstaged), path: file.path, file }] : []);
  return [...staged, ...unstaged];
}
function changeLine(status, path, index, t) {
  return {
    change: index,
    path,
    spans: [
      { text: status.charAt(0) || status, color: statusColor(t, status), bold: true },
      { text: " " },
      { text: " ", icon: "file", color: t.hint }
    ]
  };
}
function field(label, value, t) {
  return { spans: [{ text: `${label}: `, color: t.hint }, { text: value }] };
}
function commitLines(commit, changes, t) {
  const lines = [
    { spans: [{ text: commit.subject, bold: true }] },
    { spans: [] },
    field("Author", `${commit.authorName} <${commit.authorEmail}>`, t),
    field("Date", commit.authorTime, t),
    field("SHA", commit.sha, t),
    field("Parents", commit.parents.length ? commit.parents.join(" ") : "(root)", t),
    field("Refs", commit.refs.length ? commit.refs.map((reference) => reference.name).join(", ") : "—", t),
    { spans: [] }
  ];
  for (const line of commit.body ? commit.body.split(`
`) : [])
    lines.push({ spans: [{ text: line }] });
  if (commit.body)
    lines.push({ spans: [] });
  return [
    ...lines,
    ...changeSection(changes.map((change) => [change.status, change.path]), t)
  ];
}
function changeSection(changes, t) {
  const lines = [
    { spans: [{ text: countedTitle("Changes", changes.length), color: t.accent, bold: true }] }
  ];
  if (!changes.length)
    lines.push({ spans: [{ text: "(none)" }] });
  changes.forEach(([status, path], index) => {
    lines.push(changeLine(status, path, index, t));
  });
  return lines;
}
function workingLines(changes, t) {
  return [
    { spans: [{ text: "Uncommitted", bold: true }] },
    { spans: [] },
    ...changeSection(changes.map((change) => [change.status, change.path]), t)
  ];
}

class Inspect {
  services;
  focus = null;
  commit = null;
  working = null;
  changes = null;
  shown = null;
  cache = new Map;
  pending = false;
  error = null;
  request = 0;
  selected = 0;
  scroll = 0;
  follow = true;
  height = 0;
  wheel = 0;
  previewPath = null;
  loadedPath = null;
  previewKey = null;
  previewPending = false;
  previewError = null;
  previewRequest = 0;
  previewCache = new Map;
  preview = null;
  diff = new SplitDiff("git-commit-preview");
  constructor(services) {
    this.services = services;
  }
  release() {
    this.diff.release();
  }
  clearCaches() {
    this.shown = null;
    this.cache.clear();
    this.previewCache.clear();
  }
  previewOpen() {
    return this.previewPath !== null;
  }
  loading() {
    return this.pending;
  }
  showCommit(commit, cx) {
    const same = commit && this.commit?.sha === commit.sha && !this.working;
    this.commit = commit;
    this.working = null;
    if (same && commit)
      return;
    this.reset();
    if (!commit) {
      this.changes = null;
      return;
    }
    const cached = this.cache.get(commit.sha);
    if (cached) {
      this.changes = cached;
      this.shown = { commit, changes: cached };
      return;
    }
    this.changes = null;
    this.load(commit, cx);
  }
  showWorking(changes) {
    const was = this.working !== null;
    this.commit = null;
    this.changes = null;
    this.working = changes;
    if (!was)
      this.reset();
    this.selected = Math.min(this.selected, Math.max(0, changes.length - 1));
  }
  reset() {
    this.request++;
    this.pending = false;
    this.closePreview();
    if (this.focus)
      this.focus = null;
    this.scroll = 0;
    this.follow = true;
    this.error = null;
    this.selected = 0;
  }
  load(commit, cx) {
    const git = this.services.git();
    if (!git)
      return;
    const context = this.services.context();
    const request = ++this.request;
    this.pending = true;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        const changes = await readCommitChanges(git, commit.sha);
        if (request !== this.request || context !== this.services.context())
          return;
        if (this.cache.size >= DETAILS_CACHE_CAP)
          this.cache.delete(this.cache.keys().next().value ?? "");
        this.cache.set(commit.sha, changes);
        this.changes = changes;
        this.shown = { commit, changes };
        this.selected = 0;
        this.scroll = 0;
        this.follow = true;
      } catch (error) {
        if (request === this.request && context === this.services.context())
          this.error = message(error);
      } finally {
        if (request === this.request) {
          this.pending = false;
          cx.notify();
        }
      }
    });
  }
  count() {
    if (this.working)
      return this.working.length;
    return this.changes?.length ?? null;
  }
  pathAt(index) {
    if (this.pending)
      return null;
    if (this.working)
      return this.working[index]?.path ?? null;
    return this.changes?.[index]?.path ?? null;
  }
  target(index) {
    const working = this.working?.[index];
    if (working)
      return {
        key: `${working.side}\x00${working.path}`,
        path: working.path,
        read: (git) => readDiff(git, working.file, working.side)
      };
    const commit = this.commit;
    const change = this.changes?.[index];
    if (!commit || !change)
      return null;
    const parent = commit.parents[0] ?? null;
    return {
      key: `${commit.sha}\x00${change.path}`,
      path: change.path,
      read: (git) => readComparison(git, parent, commit.sha, { path: change.path, from: change.from })
    };
  }
  focusChanges() {
    const count = this.count();
    if (this.pending || !count)
      return false;
    this.focus = "details";
    this.selected = Math.min(this.selected, count - 1);
    this.follow = true;
    return true;
  }
  select(index) {
    const count = this.count();
    if (this.pending || !count)
      return;
    this.selected = Math.max(0, Math.min(index, count - 1));
    this.follow = true;
  }
  toggle(index, cx) {
    const path = this.pathAt(index);
    if (path === null)
      return;
    this.selected = index;
    this.follow = true;
    this.focus = "details";
    if (this.previewPath === path)
      this.closePreview();
    else
      this.openPreview(index, cx);
  }
  activate(index, cx) {
    const path = this.pathAt(index);
    if (path === null)
      return;
    if (this.previewPath === path)
      this.focus = "preview";
    else
      this.openPreview(index, cx);
  }
  openPreview(index, cx) {
    const target = this.target(index);
    if (!target)
      return;
    this.selected = index;
    this.follow = true;
    this.focus = "details";
    this.previewPath = target.path;
    this.previewError = null;
    const cached = this.previewCache.get(target.key);
    this.previewRequest++;
    if (cached) {
      this.show(target, cached);
      return;
    }
    this.readPreview(target, cx);
  }
  readPreview(target, cx) {
    const git = this.services.git();
    if (!git)
      return;
    const context = this.services.context();
    const request = this.previewRequest;
    this.previewPending = true;
    cx.spawn(async (cx) => {
      try {
        const document = await target.read(git);
        if (request !== this.previewRequest || context !== this.services.context())
          return;
        this.show(target, document);
      } catch (error) {
        if (request === this.previewRequest && context === this.services.context())
          this.previewError = message(error);
      } finally {
        if (request === this.previewRequest) {
          this.previewPending = false;
          cx.notify();
        }
      }
    });
  }
  show(target, document) {
    this.stash();
    this.previewKey = target.key;
    this.preview = document;
    this.loadedPath = target.path;
    this.previewError = null;
    this.diff.set(document.text, target.path);
  }
  stash() {
    if (!this.previewKey || !this.preview)
      return;
    this.previewCache.delete(this.previewKey);
    if (this.previewCache.size >= PREVIEW_CACHE_CAP)
      this.previewCache.delete(this.previewCache.keys().next().value ?? "");
    this.previewCache.set(this.previewKey, this.preview);
  }
  closePreview() {
    this.previewRequest++;
    this.previewPending = false;
    this.stash();
    this.previewKey = null;
    this.preview = null;
    this.previewPath = null;
    this.loadedPath = null;
    this.previewError = null;
    if (this.focus === "preview")
      this.focus = "details";
  }
  escape() {
    if (this.focus === "preview")
      this.focus = "details";
    else if (this.focus === "details")
      this.focus = null;
    else
      return false;
    return true;
  }
  key(event, cx) {
    if (this.focus === "preview")
      return this.previewKeyDown(event, cx);
    if (this.focus === "details")
      return this.detailsKey(event.keystroke, cx);
    return false;
  }
  detailsKey(key, cx) {
    const page = Math.max(1, this.height - 1);
    const moves = { down: 1, j: 1, up: -1, k: -1, pagedown: page, pageup: -page };
    const move = moves[key];
    if (move !== undefined)
      this.select(this.selected + move);
    else if (key === "home")
      this.select(0);
    else if (key === "end")
      this.select(Number.MAX_SAFE_INTEGER);
    else if (key === "enter")
      this.activate(this.selected, cx);
    else if (key === "space")
      this.toggle(this.selected, cx);
    else if (key === "right" && this.previewPath)
      this.focus = "preview";
    else if (key === "left")
      this.focus = null;
    else
      return false;
    return true;
  }
  previewKeyDown(event, cx) {
    const handled = this.diff.key(event, cx);
    if (handled || event.keystroke !== "left")
      return handled;
    this.focus = "details";
    return true;
  }
  lines(t) {
    if (this.working)
      return workingLines(this.working, t);
    if (this.commit && this.changes)
      return commitLines(this.commit, this.changes, t);
    if (this.commit && this.shown)
      return commitLines(this.shown.commit, this.shown.changes, t);
    return [{ spans: [{ text: "No commits" }] }];
  }
  title(look) {
    if (this.pending)
      return h_flex16().child(spinner(look)).child(" Commit details");
    if (this.working)
      return "Uncommitted";
    if (this.error)
      return div20().text_color(look.t.error).font_weight(700).child(`Commit details failed · ${firstLine(this.error)} · move selection to retry`);
    return "Commit details";
  }
  followSelection(lines) {
    if (this.focus !== "details" || !this.follow)
      return;
    const row = lines.findIndex((line) => line.change === this.selected);
    if (row >= 0 && row < this.scroll)
      this.scroll = row;
    else if (row >= 0 && row >= this.scroll + this.height)
      this.scroll = row + 1 - this.height;
    this.follow = false;
  }
  wheelDetails(event, look, cx) {
    this.wheel += event.delta_lines ? event.delta_lines.y * look.row : event.delta.y;
    const steps = Math.trunc(this.wheel / look.row);
    if (steps === 0)
      return;
    this.wheel -= steps * look.row;
    this.follow = false;
    this.scroll = Math.max(0, this.scroll - steps);
    cx.stop_propagation();
    cx.notify();
  }
  renderDetails(look, onFocus) {
    const { t } = look;
    const lines = this.lines(t);
    this.scroll = Math.max(0, Math.min(this.scroll, lines.length - this.height));
    this.followSelection(lines);
    const body = v_flex18().flex_1().min_h(0).min_w(0).overflow_hidden();
    for (const [offset, line] of lines.slice(this.scroll, this.scroll + Math.max(1, this.height)).entries())
      body.child(this.detailRow(look, line, this.scroll + offset, onFocus));
    return box(look, { id: "git-commit-details", title: this.title(look), focused: this.focus === "details" }, h_flex16().id("git-commit-details-body").flex_1().min_h(0).min_w(0).items_stretch().on_size_change((size, cx) => {
      const height = Math.max(1, Math.floor(size.height / look.screenRow));
      if (height === this.height)
        return;
      this.height = height;
      cx.notify();
    }).on_scroll_wheel((event, cx) => this.wheelDetails(event, look, cx)).child(body));
  }
  detailRow(look, line, index, onFocus) {
    const row = h_flex16().id(`git-commit-detail-${index}`).flex_none().h(look.row).min_w(0).overflow_hidden().whitespace_nowrap().children(spanElements(look, line.spans)).when(line.path !== undefined, (el) => el.child(div20().min_w(0).truncate().child(line.path ?? "")));
    const change = line.change;
    if (change === undefined)
      return row;
    const active = this.focus === "details" && this.selected === change;
    return row.border_l(2).border_color(active ? look.t.accent : "#00000000").when(active, (el) => el.bg(look.t.accentSoft).font_weight(600)).hover((style) => style.bg(active ? look.t.accentSoft : look.t.hover)).on_click((_, cx) => {
      cx.stop_propagation();
      this.toggle(change, cx);
      onFocus(cx);
      cx.notify();
    });
  }
  previewTitle(look, width) {
    const titleWidth = Math.max(0, width - PREVIEW_TITLE_RESERVE);
    if (this.previewError)
      return div20().text_color(look.t.error).font_weight(700).child(truncateToWidth(`Preview failed · ${firstLine(this.previewError)} · close and reopen to retry`, titleWidth));
    const shown = this.loadedPath ?? this.previewPath ?? "File";
    const language = this.preview ? this.diff.language() : "";
    const label = language ? `Preview · ${shown} · ${language}` : `Preview · ${shown}`;
    if (this.previewPending)
      return h_flex16().child(spinner(look)).child(` ${truncateToWidth(label, Math.max(0, titleWidth - 2))}`);
    return truncateToWidth(label, titleWidth);
  }
  previewBody(look, width, height) {
    const { t } = look;
    const vertical = !(width - 2 >= 72 || height - 2 < 8);
    const panes = this.diff.render(look, { focused: this.focus === "preview" });
    const pane = (id, title, inner) => box(look, { id, title }, inner).flex_1().min_h(0).min_w(0);
    const binary = this.preview?.binary;
    if (binary)
      return div20().flex_1().text_color(t.muted).child("Binary file — no text diff");
    return (vertical ? v_flex18() : h_flex16()).flex_1().min_h(0).min_w(0).items_stretch().child(pane("git-commit-preview-before", "Before", panes.before)).child(pane("git-commit-preview-after", "After", panes.after));
  }
  renderPreview(look, size, onFocus) {
    const { t } = look;
    const close = h_flex16().id("git-commit-preview-close").absolute().top(4).right(8).h(look.row).px(6).items_center().rounded(2).text_color(t.hint).hover((style) => style.bg(t.accentSoft).text_color(t.text)).child("×").on_click((_, cx) => {
      cx.stop_propagation();
      this.closePreview();
      cx.notify();
    });
    return box(look, { id: "git-commit-preview", title: this.previewTitle(look, size.cols), focused: this.focus === "preview" }, v_flex18().flex_1().min_h(0).min_w(0).on_mouse_down("left", (_, cx) => {
      this.focus = "preview";
      onFocus(cx);
      cx.notify();
    }).child(this.previewBody(look, size.cols, size.rows))).child(close);
  }
}

// src/ui/graph/lanes.ts
import { h_flex as h_flex17, v_flex as v_flex19 } from "gpui-base";
import { div as div21, PathBuilder as PathBuilder2 } from "gpui-kit";

// src/ui/graph/layout.ts
var LANE_CELLS = 2;
var ROW_HEIGHT = 2;
function vacant(lanes) {
  const index = lanes.indexOf(null);
  if (index >= 0)
    return index;
  lanes.push(null);
  return lanes.length - 1;
}
function laneOf(lanes, sha) {
  return lanes.findIndex((lane) => lane?.sha === sha);
}

class Builder2 {
  lanes = [];
  nextColor = 0;
  row(node) {
    const lanes = this.lanes;
    const found = laneOf(lanes, node.sha);
    const column = found >= 0 ? found : vacant(lanes);
    const color = lanes[column]?.color ?? this.nextColor++;
    const above = lanes.map((lane) => lane?.color ?? null);
    const edges = [];
    lanes.forEach((lane, index) => {
      if (lane && index !== column)
        edges.push({ from: index, to: index, color: lane.color });
    });
    lanes[column] = null;
    node.parents.forEach((parent, index) => {
      if (node.parents.indexOf(parent) !== index)
        return;
      const to = this.parentLane(parent, index, column, color, edges);
      edges.push({ from: column, to, color: lanes[to]?.color ?? color });
    });
    while (lanes.length && lanes[lanes.length - 1] === null)
      lanes.pop();
    return { column, color, uncommitted: node.sha === "", above, edges };
  }
  parentLane(parent, index, column, color, edges) {
    const lanes = this.lanes;
    const existing = laneOf(lanes, parent);
    if (existing >= 0 && index === 0 && existing > column) {
      const moved = lanes[existing];
      lanes[existing] = null;
      lanes[column] = moved ? { sha: moved.sha, color } : null;
      const edge = edges.find((entry) => entry.from === existing);
      if (edge)
        edge.to = column;
      return column;
    }
    if (existing >= 0)
      return existing;
    const to = index === 0 && lanes[column] === null ? column : vacant(lanes);
    lanes[to] = { sha: parent, color: index === 0 ? color : this.nextColor++ };
    return to;
  }
}
function buildLayout(nodes) {
  const builder = new Builder2;
  const rows = [];
  for (const node of nodes)
    rows.push(builder.row(node));
  return rows;
}
function layoutWidth(rows, first, count) {
  let lanes = 1;
  for (const row of rows.slice(first, first + count)) {
    lanes = Math.max(lanes, row.above.length, row.column + 1);
    for (const edge of row.edges)
      lanes = Math.max(lanes, edge.from + 1, edge.to + 1);
  }
  return lanes * LANE_CELLS + 1;
}
function laneCell(column) {
  return column * LANE_CELLS + 1;
}

// src/ui/graph/lanes.ts
var UP = 1;
var DOWN = 2;
var LEFT = 4;
var RIGHT = 8;
var JOIN_SYMBOLS = {
  [UP | DOWN | LEFT | RIGHT]: "┼",
  [UP | DOWN | RIGHT]: "├",
  [UP | DOWN | LEFT]: "┤",
  [LEFT | RIGHT | DOWN]: "┬",
  [LEFT | RIGHT | UP]: "┴",
  [DOWN | RIGHT]: "╭",
  [DOWN | LEFT]: "╮",
  [UP | RIGHT]: "╰",
  [UP | LEFT]: "╯"
};
function symbol(cell) {
  if (cell.node)
    return cell.node;
  if (cell.joins === 0)
    return " ";
  const exact = JOIN_SYMBOLS[cell.joins];
  if (exact)
    return exact;
  return cell.joins & (LEFT | RIGHT) && !(cell.joins & (UP | DOWN)) ? "─" : "│";
}
function join(cells, index, joins, color) {
  const cell = cells[index];
  if (!cell)
    return;
  if ((cell.joins & (UP | DOWN)) === 0 || (joins & (UP | DOWN)) !== 0)
    cell.color = color;
  cell.joins |= joins;
}
function blank(width) {
  return Array.from({ length: width }, () => ({ joins: 0, color: 0, node: null }));
}
function glyphCells(row, width) {
  const nodeLine = blank(width);
  const linkLine = blank(width);
  row.above.forEach((color, column) => {
    if (color !== null && column !== row.column)
      join(nodeLine, laneCell(column), UP | DOWN, color);
  });
  const node = nodeLine[laneCell(row.column)];
  if (node) {
    node.node = row.uncommitted ? "○" : "●";
    node.color = row.color;
  }
  for (const edge of row.edges) {
    const from = laneCell(edge.from);
    const to = laneCell(edge.to);
    if (from === to) {
      join(linkLine, from, UP | DOWN, edge.color);
      continue;
    }
    const [start, end] = from < to ? [RIGHT, LEFT] : [LEFT, RIGHT];
    join(linkLine, from, UP | start, edge.color);
    for (let cell = Math.min(from, to) + 1;cell < Math.max(from, to); cell++)
      join(linkLine, cell, LEFT | RIGHT, edge.color);
    join(linkLine, to, DOWN | end, edge.color);
  }
  return [nodeLine, linkLine];
}
function glyphLine(look, cells, view, marks) {
  const line = h_flex17().h(look.row).flex_none().overflow_hidden();
  const visible = cells.slice(view.scroll, view.scroll + view.width);
  visible.forEach((cell, index) => {
    const mark = index === 0 ? marks[0] : index === visible.length - 1 ? marks[1] : "";
    line.child(div21().flex_none().w(look.cell).text_color(mark ? look.t.hint : lane(look.t, cell.color)).child(mark || symbol(cell)));
  });
  return line;
}
function clipMarks(view) {
  if (!view.first)
    return ["", ""];
  return [view.scroll > 0 ? "‹" : "", view.total > view.scroll + view.width ? "›" : ""];
}
function glyphLanes(look, row, view) {
  const [nodeLine, linkLine] = glyphCells(row, view.total);
  return v_flex19().flex_none().w(cols(look, view.width)).overflow_hidden().child(glyphLine(look, nodeLine, view, clipMarks(view))).child(glyphLine(look, linkLine, view, ["", ""]));
}
function strokes(look, row, x) {
  const top = 0;
  const center = 0.5 * look.row;
  const bottom = ROW_HEIGHT * look.row;
  const width = Math.max(look.cell * 0.18, 1.4);
  const paths = new Map;
  const path = (color) => {
    const existing = paths.get(color);
    if (existing)
      return existing;
    const created = PathBuilder2.stroke(width);
    paths.set(color, created);
    return created;
  };
  row.above.forEach((color, column) => {
    if (color !== null)
      path(color).move_to(x(column), top).line_to(x(column), center);
  });
  for (const edge of row.edges) {
    const builder = path(edge.color).move_to(x(edge.from), center);
    if (edge.from === edge.to)
      builder.line_to(x(edge.to), bottom);
    else
      builder.cubic_bezier_to(x(edge.to), bottom, x(edge.from), 1.5 * look.row, x(edge.to), look.row);
  }
  return [...paths].map(([color, builder]) => div21().absolute().inset_0().child(window.paint_path(builder.build(), lane(look.t, color)).size_full()));
}
function dot(x, y, radius, color) {
  return div21().absolute().left(x - radius).top(y - radius).w(radius * 2).h(radius * 2).rounded_full().bg(color);
}
function curveLanes(look, row, view) {
  const x = (column) => (laneCell(column) + 0.5 - view.scroll) * look.cell;
  const radius = Math.max(look.cell * 0.5, 3.5);
  const stroke = Math.max(look.cell * 0.18, 1.4);
  const color = lane(look.t, row.color);
  const center = 0.5 * look.row;
  const node = x(row.column);
  const element = div21().relative().flex_none().w(cols(look, view.width)).h(ROW_HEIGHT * look.row).overflow_hidden().children(strokes(look, row, x));
  if (view.selected)
    element.child(dot(node, center, radius * 1.6, `${color.slice(0, 7)}46`));
  element.child(dot(node, center, radius, color));
  if (row.uncommitted)
    element.child(dot(node, center, Math.max(0, radius - stroke), view.background));
  const [left, right] = clipMarks(view);
  if (left)
    element.child(div21().absolute().top(0).left(0).text_color(look.t.hint).child(left));
  if (right)
    element.child(div21().absolute().top(0).left(cols(look, view.width - 1)).text_color(look.t.hint).child(right));
  return element;
}

// src/ui/graph/rows.ts
import { h_flex as h_flex18 } from "gpui-base";
import { div as div22 } from "gpui-kit";
var TIME_MIN_WIDTH = 56;
var TIME_WIDTH = 14;
var MIN_GRAPH_WIDTH = 3;
var MIN_SUBJECT_WIDTH = 12;
function graphViewWidth(width) {
  return Math.min(Math.max(Math.floor(width * 2 / 5), MIN_GRAPH_WIDTH), Math.max(0, width - 1));
}
function badgeStyle(kind, t) {
  const styles = {
    head: { symbol: "●", bg: t.badgeHead, border: t.badgeHeadBorder, color: t.error },
    local: { icon: "branch", bg: t.badgeLocal, border: t.badgeLocalBorder, color: t.success },
    remote: { icon: "remote", bg: t.badgeRemote, border: t.badgeRemoteBorder, color: t.info },
    "remote-head": { icon: "remote", bg: t.badgeRemoteHead, border: t.badgeRemoteHeadBorder, color: t.azure },
    tag: { icon: "tag", bg: t.badgeTag, border: t.badgeTagBorder, color: t.warning },
    other: { symbol: "◆", bg: t.badgeOther, border: t.badgeOtherBorder, color: t.accentText }
  };
  return styles[kind];
}
function badgeSpans(references, width, t) {
  const spans = [];
  let remaining = width - 1;
  for (const reference of references) {
    const separator = spans.length ? 1 : 0;
    const available = remaining - separator;
    const { icon, symbol, bg, border, color } = badgeStyle(reference.kind, t);
    const fixed = (icon ? ICON_CELLS : 1) + 3;
    if (available <= fixed)
      break;
    const name = truncateToWidth(reference.name, available - fixed);
    const badgeWidth = fixed + displayWidth(name);
    if (separator) {
      spans.push({ text: " " });
      remaining -= 1;
    }
    if (icon)
      spans.push({ text: ` ${name} `, icon, bg, border, color });
    else
      spans.push({ text: ` ${symbol} ${name} `, bg, border, color });
    remaining -= badgeWidth;
  }
  if (spans.length)
    spans.push({ text: " " });
  return spans;
}
function subjectSpans(prose, t) {
  const spans = [];
  let cursor = 0;
  for (const match of prose.matchAll(/#\d+/g)) {
    const start = match.index ?? 0;
    if (cursor < start)
      spans.push({ text: prose.slice(cursor, start) });
    spans.push({ text: match[0], color: t.reference, bold: true });
    cursor = start + match[0].length;
  }
  if (cursor < prose.length)
    spans.push({ text: prose.slice(cursor) });
  return spans;
}
function titleSpans(look, commit, subjectWidth) {
  const { t } = look;
  if (!commit.sha)
    return [{ text: truncateToWidth("Uncommitted changes", subjectWidth), color: t.hint, bold: true }];
  const badges = badgeSpans(commit.refs, Math.min(Math.max(0, subjectWidth - MIN_SUBJECT_WIDTH), Math.floor(subjectWidth / 2)), t);
  return [
    ...badges,
    ...subjectSpans(truncateToWidth(commit.subject, Math.max(0, subjectWidth - spansWidth(badges))), t)
  ];
}
function line(look, left, right, bold) {
  return h_flex18().h(look.row).min_w(0).flex_1().overflow_hidden().whitespace_nowrap().when(bold, (el) => el.font_weight(700)).child(h_flex18().flex_1().min_w(0).overflow_hidden().children(spanElements(look, left))).when(!!right, (el) => el.children(spanElements(look, right ? [right] : [])).child(div22().flex_none().w(look.cell)));
}
function commitTitle(look, commit, text) {
  const textWidth = Math.max(0, text.width - text.gutter);
  const time = commit.sha && text.width >= TIME_MIN_WIDTH ? truncateToWidth(authorRelative(commit, text.nowSeconds), TIME_WIDTH) : "";
  const timeWidth = time ? displayWidth(time) + 2 : 0;
  const spans = titleSpans(look, commit, Math.max(0, textWidth - timeWidth));
  return line(look, spans, time ? { text: time, color: look.t.hint } : null, text.bold);
}
function commitDetail(look, commit, text) {
  const textWidth = Math.max(0, text.width - text.gutter);
  if (!commit.sha)
    return line(look, [{ text: truncateToWidth("Working tree", textWidth), color: look.t.muted }], null, false);
  const sha = truncateToWidth(shortCommit(commit.sha), textWidth);
  const author = truncateToWidth(commit.authorName, Math.max(0, textWidth - displayWidth(sha) - 2));
  return line(look, [{ text: sha, color: look.t.accentText }], author ? { text: author, color: look.t.secondary } : null, false);
}

// src/ui/graph.ts
var GRAPH_ACTIONS = [
  { id: "checkout", label: "Checkout", shortcut: "x", icon: "checkout" },
  { id: "rebase", label: "Rebase", shortcut: "r", icon: "rebase" },
  { id: "cherry-pick", label: "Cherry-pick", shortcut: "y", icon: "cherryPick" },
  { id: "revert", label: "Revert", shortcut: "v", icon: "revert", variant: "danger" },
  { id: "reset", label: "Reset", shortcut: "t", icon: "reset", variant: "danger" },
  { id: "copy-sha", label: "Copy SHA", shortcut: "h", icon: "copy" }
];
var REVEAL_LIMIT = 1e4;
var SPLIT_SCALE2 = 1000;
var DEFAULT_SPLITS = [200, 600];
var MIN_FILES_WIDTH = 20;
var MIN_DIFF_WIDTH = 24;
var WIDE_LOWER = 90;
function emptyState() {
  return {
    commits: [],
    visible: [],
    uncommitted: null,
    layout: [],
    loaded: false,
    hasMore: false,
    cursor: null,
    selected: 0,
    scroll: 0,
    graphScroll: 0,
    query: "",
    anchor: null,
    stashed: null
  };
}
function message2(error) {
  return error instanceof Error ? error.message : String(error);
}
function paneWidths(total) {
  if (total < MIN_FILES_WIDTH + MIN_DIFF_WIDTH * 2) {
    const files = Math.floor(total / 5);
    const before = Math.floor(total * 2 / 5);
    return [files, before, total - files - before];
  }
  const scaled = (split) => Math.floor(total * split / SPLIT_SCALE2);
  const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
  const first = clamp(scaled(DEFAULT_SPLITS[0]), MIN_FILES_WIDTH, total - MIN_DIFF_WIDTH * 2);
  const second = clamp(scaled(DEFAULT_SPLITS[1]), first + MIN_DIFF_WIDTH, total - MIN_DIFF_WIDTH);
  return [first, second - first, total - second];
}
async function readPages(git, request, cursor, followHead) {
  let page = await readHistoryPage(git, request, cursor);
  const commits = [...page.commits];
  let found = commits.some(isHead);
  while (followHead && !found && page.hasMore) {
    page = await readHistoryPage(git, { start: request.start, offset: request.offset + commits.length, count: HISTORY_PAGE_SIZE }, page.cursor);
    commits.push(...page.commits);
    found = page.commits.some(isHead);
  }
  return { ...page, commits, offset: request.offset };
}

class GraphTab {
  services;
  showGraph;
  workspaces;
  id = "graph";
  state = emptyState();
  inspect;
  filter;
  handle;
  active = false;
  filtering = false;
  context = null;
  request = 0;
  pending = null;
  historyError = null;
  preparations = new Map;
  lastLoad = null;
  fingerprint = null;
  fingerprintRequest = 0;
  reveal_ = null;
  followHead_ = false;
  height = 0;
  width = 0;
  graphWidth = 0;
  graphVisible = 0;
  wheel = 0;
  constructor(services, cx, showGraph, workspaces) {
    this.services = services;
    this.showGraph = showGraph;
    this.workspaces = workspaces;
    this.inspect = new Inspect(services);
    this.handle = cx.focus_handle();
    this.filter = InputState4.new({});
    this.filter.on("change", (_, cx) => {
      if (this.filter.value() === this.state.query)
        return;
      this.state.query = this.filter.value();
      this.applyFilter(cx);
      cx.notify();
    });
    this.filter.on("focus", (_, cx) => {
      this.filtering = true;
      cx.notify();
    });
    this.filter.on("blur", (_, cx) => {
      this.filtering = false;
      cx.notify();
    });
    this.filter.on("submit", (_, cx) => {
      this.handle.focus();
      cx.notify();
    });
  }
  activate(cx) {
    this.active = true;
    this.syncContext();
    this.syncUncommitted(cx);
    if (!this.state.loaded && !this.pending)
      this.requestHistory(cx);
    this.handle.focus();
  }
  deactivate() {
    this.active = false;
    this.reveal_ = null;
  }
  focus() {
    this.handle.focus();
  }
  release() {
    this.request++;
    this.inspect.release();
    this.filter.release();
    this.handle.release();
  }
  selectedCommit() {
    return this.context === this.services.context() ? this.selected()?.sha ?? null : null;
  }
  selectedCommitInfo() {
    const commit = this.context === this.services.context() ? this.selected() : null;
    return commit ? { sha: commit.sha, subject: commit.subject, parents: [...commit.parents] } : null;
  }
  followHead() {
    this.followHead_ = true;
  }
  reveal(sha, cx) {
    this.reveal_ = sha;
    if (!this.state.loaded && !this.pending)
      this.requestHistory(cx);
    this.revealPending(cx);
    cx.notify();
  }
  copySha(cx) {
    const commit = this.selected();
    if (!commit)
      return;
    const short = shortCommit(commit.sha);
    this.services.overlay.open({
      kind: "confirm",
      title: "Copy commit SHA",
      width: DIALOG.medium,
      lines: ["Copy this commit SHA?", "", { text: commit.sha, tone: "accent", bold: true }, commit.subject],
      hint: `${short} selected`,
      primary: "[Enter] Copy",
      secondary: "[Esc] Cancel",
      onConfirm: (cx) => {
        cx.write_to_clipboard(commit.sha);
        showResult(this.services.overlay, "Copy SHA", true, `${short} copied to the clipboard.`, undefined, cx);
      }
    });
    cx.notify();
  }
  toolbar() {
    const enabled = this.services.repository()?.state === "ready" && !!this.selectedCommit();
    return GRAPH_ACTIONS.map((action) => ({
      ...action,
      id: `git-graph-${action.id}`,
      enabled,
      onClick: (cx) => this.services.commands().shortcut(action.id, cx)
    }));
  }
  status() {
    return {
      selected: this.selectedCommit(),
      progress: this.progress(),
      error: this.historyError ?? this.preparations.get(this.services.context())?.warning ?? null
    };
  }
  progress() {
    const pending = this.pending;
    if (!pending)
      return null;
    if (this.preparations.get(this.services.context())?.pending)
      return "Preparing history";
    if (!pending.replace && this.reveal_)
      return "Finding the commit in Graph";
    if (!pending.replace)
      return "Loading more commits";
    return this.state.loaded ? "Refreshing commits" : "Loading Graph";
  }
  escape(cx) {
    if (this.workspaces.isFocused()) {
      this.handle.focus();
      return true;
    }
    if (this.inspect.escape()) {
      this.handle.focus();
      return true;
    }
    return this.leaveAnchor(cx);
  }
  refresh(scope, cx) {
    this.syncContext();
    if (scope === "workspaces")
      return;
    this.syncUncommitted(cx);
    if (scope === "changes") {
      if (this.state.loaded)
        this.checkRefs(cx);
      return;
    }
    if (this.state.loaded || this.active)
      this.requestHistory(cx);
  }
  syncContext() {
    const context = this.services.context();
    if (context === this.context)
      return;
    this.context = context;
    this.state = emptyState();
    this.request++;
    this.pending = null;
    this.historyError = null;
    this.lastLoad = null;
    this.fingerprint = null;
    this.reveal_ = null;
    this.inspect.reset();
    this.inspect.clearCaches();
    this.filter.set_value("");
  }
  checkRefs(cx) {
    const git = this.services.git();
    if (!git || this.pending)
      return;
    const context = this.services.context();
    const request = ++this.fingerprintRequest;
    cx.spawn(async (cx) => {
      try {
        const fingerprint = await readRefsFingerprint(git);
        if (request !== this.fingerprintRequest || context !== this.services.context())
          return;
        if (this.fingerprint !== null && fingerprint !== this.fingerprint) {
          this.requestHistory(cx);
          cx.notify();
        }
      } catch {
        return;
      }
    });
  }
  displayOffset() {
    const commit = this.state.uncommitted;
    return commit?.subject.toLowerCase().includes(this.state.query.toLowerCase()) ? 1 : 0;
  }
  displayLen() {
    return this.state.visible.length + this.displayOffset();
  }
  uncommittedSelected() {
    return this.displayOffset() === 1 && this.state.selected === 0;
  }
  rowCommit(row) {
    const offset = this.displayOffset();
    if (offset === 1 && row === 0)
      return this.state.uncommitted;
    const index = this.state.visible[row - offset];
    return index === undefined ? null : this.state.commits[index] ?? null;
  }
  selected() {
    const commit = this.rowCommit(this.state.selected);
    return commit?.sha ? commit : null;
  }
  pageRows() {
    return Math.max(this.height > 0 ? 1 : 0, Math.floor(this.height / ROW_HEIGHT));
  }
  rebuildLayout() {
    const filtered = this.state.query !== "";
    const nodes = [
      ...this.displayOffset() && this.state.uncommitted ? [this.state.uncommitted] : [],
      ...this.state.visible.flatMap((index) => this.state.commits[index] ?? [])
    ].map((commit) => ({ sha: commit.sha, parents: filtered ? [] : commit.parents }));
    this.state.layout = buildLayout(nodes);
  }
  clampSelection() {
    this.state.selected = Math.max(0, Math.min(this.state.selected, this.displayLen() - 1));
  }
  selectVisible(position) {
    this.state.selected = this.displayOffset() + Math.max(0, position);
    this.clampSelection();
  }
  selectSha(sha) {
    const position = sha ? this.state.visible.findIndex((index) => this.state.commits[index]?.sha === sha) : -1;
    this.selectVisible(Math.max(0, position));
  }
  ensureVisible() {
    const viewport = this.pageRows();
    const length = this.displayLen();
    if (viewport === 0 || length === 0) {
      this.state.scroll = 0;
      return;
    }
    if (this.state.selected < this.state.scroll)
      this.state.scroll = this.state.selected;
    else if (this.state.selected >= this.state.scroll + viewport)
      this.state.scroll = this.state.selected + 1 - viewport;
    this.state.scroll = Math.max(0, Math.min(this.state.scroll, length - viewport));
  }
  syncInspect(cx) {
    if (this.uncommittedSelected()) {
      const repository = this.services.repository();
      this.inspect.showWorking(workingChanges2(repository?.state === "ready" ? repository.files : []));
    } else
      this.inspect.showCommit(this.selected(), cx);
  }
  applyFilter(cx) {
    const onUncommitted = this.uncommittedSelected();
    const sha = this.selected()?.sha ?? null;
    this.state.visible = filteredCommitIndices(this.state.commits, this.state.query);
    this.rebuildLayout();
    if (onUncommitted && this.displayOffset())
      this.state.selected = 0;
    else
      this.selectSha(sha);
    this.ensureVisible();
    this.syncInspect(cx);
  }
  select(index, cx) {
    this.reveal_ = null;
    const length = this.displayLen();
    if (length === 0)
      return;
    const selected = Math.max(0, Math.min(index, length - 1));
    if (selected !== this.state.selected) {
      this.state.selected = selected;
      this.syncInspect(cx);
    }
    this.ensureVisible();
  }
  moveSelection(delta, cx) {
    if (this.displayLen() === 0)
      return;
    this.select(this.state.selected + delta, cx);
    if (delta > 0)
      this.requestMore(false, cx);
  }
  refreshUncommitted() {
    const repository = this.services.repository();
    const dirty = repository?.state === "ready" && repository.files.length > 0;
    const show = !this.state.anchor && this.state.loaded && (this.state.commits.length === 0 || dirty);
    const parent = this.state.commits.find(isHead) ?? this.state.commits[0];
    this.state.uncommitted = show ? {
      sha: "",
      parents: parent ? [parent.sha] : [],
      authorName: "",
      authorEmail: "",
      authorTime: "",
      refs: [],
      subject: "Uncommitted",
      body: ""
    } : null;
    this.rebuildLayout();
    this.clampSelection();
  }
  syncUncommitted(cx) {
    const onUncommitted = this.uncommittedSelected();
    const position = onUncommitted ? null : this.state.selected - this.displayOffset();
    this.refreshUncommitted();
    if (onUncommitted && this.displayOffset())
      this.state.selected = 0;
    else
      this.selectVisible(position ?? 0);
    this.ensureVisible();
    if (this.state.loaded)
      this.syncInspect(cx);
  }
  requestHistory(cx) {
    this.load(true, 0, Math.max(this.state.commits.length, HISTORY_PAGE_SIZE), cx);
  }
  requestMore(explicit, cx) {
    if (!this.active || !this.state.hasMore || !this.state.loaded)
      return;
    const near = this.state.scroll + 2 * this.pageRows() >= this.displayLen();
    if (!explicit && (this.state.query !== "" || !near))
      return;
    this.load(false, this.state.commits.length, HISTORY_PAGE_SIZE, cx);
  }
  prepare(context, git) {
    const existing = this.preparations.get(context);
    if (existing)
      return existing;
    const preparation = { pending: true, warning: null, done: Promise.resolve() };
    preparation.done = prepareHistory(git).then(() => {
      preparation.pending = false;
    }, (error) => {
      preparation.pending = false;
      preparation.warning = `History acceleration unavailable: ${message2(error)}. History remains available.`;
    });
    this.preparations.set(context, preparation);
    return preparation;
  }
  load(replace, offset, count, cx) {
    const git = this.services.git();
    const maintenanceGit = this.services.historyGit();
    if (!git || !maintenanceGit)
      return;
    if (replace) {
      this.request++;
      this.pending = null;
      this.historyError = null;
    }
    if (this.pending || this.historyError)
      return;
    const id = ++this.request;
    const context = this.services.context();
    const start = this.state.anchor;
    const cursor = replace ? null : this.state.cursor;
    const follow = this.followHead_ && !start;
    this.pending = { id, replace, offset };
    const current = () => id === this.request && context === this.services.context();
    cx.spawn(async (cx) => {
      const preparation = this.prepare(context, maintenanceGit);
      cx.notify();
      await preparation.done;
      if (!current())
        return;
      cx.notify();
      try {
        const began = Date.now();
        const [page, fingerprint] = await Promise.all([
          readPages(git, { start, offset, count }, cursor, follow),
          replace ? readRefsFingerprint(git) : Promise.resolve(null)
        ]);
        if (!current())
          return;
        this.pending = null;
        this.applyPage(page, replace, follow, fingerprint, began, cx);
      } catch (error) {
        if (!current())
          return;
        this.pending = null;
        this.historyError = `${message2(error)}. Refresh to retry`;
      } finally {
        cx.notify();
      }
    });
  }
  applyPage(page, replace, follow, fingerprint, began, cx) {
    if (!replace && page.offset !== this.state.commits.length)
      return;
    this.lastLoad = (Date.now() - began) / 1000;
    this.fingerprint = fingerprint ?? this.fingerprint;
    const state = this.state;
    const selected = this.selected()?.sha ?? null;
    const onUncommitted = this.uncommittedSelected();
    state.hasMore = page.hasMore;
    state.loaded = true;
    state.cursor = page.cursor;
    if (replace) {
      state.commits = page.commits;
      state.visible = filteredCommitIndices(state.commits, state.query);
    } else {
      const offset = state.commits.length;
      state.visible.push(...filteredCommitIndices(page.commits, state.query).map((index) => offset + index));
      state.commits.push(...page.commits);
    }
    const head = state.commits.findIndex(isHead);
    if (follow)
      this.followHeadRow(head);
    this.refreshUncommitted();
    if (follow)
      this.selectVisible(Math.max(0, state.visible.indexOf(head)));
    else if (onUncommitted && this.displayOffset())
      state.selected = 0;
    else
      this.selectSha(selected);
    this.ensureVisible();
    this.syncInspect(cx);
    this.revealPending(cx);
  }
  followHeadRow(head) {
    if (head >= 0 && !this.state.visible.includes(head)) {
      this.state.query = "";
      this.filter.set_value("");
      this.state.visible = this.state.commits.map((_, index) => index);
    }
    this.followHead_ = false;
  }
  revealPending(cx) {
    const sha = this.reveal_;
    if (!sha)
      return false;
    if (!this.active) {
      this.reveal_ = null;
      return false;
    }
    for (let row = 0;row < this.displayLen(); row++)
      if (this.rowCommit(row)?.sha === sha) {
        this.reveal_ = null;
        this.inspect.focus = null;
        this.handle.focus();
        this.select(row, cx);
        return true;
      }
    if (this.pending || !this.state.loaded)
      return false;
    this.revealMissing(sha, cx);
    return true;
  }
  revealMissing(sha, cx) {
    const short = sha.slice(0, 7);
    if (this.state.commits.some((commit) => commit.sha === sha)) {
      this.reveal_ = null;
      this.services.reportError(`Clear the Graph filter to see ${short}.`);
    } else if (this.state.hasMore && this.state.commits.length < REVEAL_LIMIT) {
      this.requestMore(true, cx);
    } else if (this.state.hasMore && !this.state.anchor) {
      this.openAnchor(sha, cx);
    } else {
      this.reveal_ = null;
      this.services.reportError(`${short} is not within the newest ${this.state.commits.length} commits in Graph.`);
    }
  }
  resetHistory() {
    this.request++;
    this.pending = null;
    this.historyError = null;
    this.lastLoad = null;
  }
  openAnchor(sha, cx) {
    const saved = this.state;
    const stashed = saved.anchor ? saved.stashed : saved;
    this.state = { ...emptyState(), stashed, anchor: sha };
    this.reveal_ = sha;
    this.filter.set_value("");
    this.resetHistory();
    this.inspect.reset();
    this.handle.focus();
    this.requestHistory(cx);
  }
  leaveAnchor(cx) {
    const saved = this.state.stashed;
    if (!saved)
      return false;
    this.state = saved;
    this.filter.set_value(saved.query);
    this.resetHistory();
    this.inspect.reset();
    this.handle.focus();
    this.syncInspect(cx);
    this.requestHistory(cx);
    return true;
  }
  scrollGraph(delta) {
    const max = Math.max(0, this.graphWidth - this.graphVisible);
    this.state.graphScroll = Math.max(0, Math.min(this.state.graphScroll + delta, max));
  }
  openFilter() {
    this.filter.focus();
    this.filtering = true;
  }
  filterKey(event, cx) {
    if (event.keystroke === "escape") {
      this.filter.set_value("");
      this.state.query = "";
      this.applyFilter(cx);
      this.handle.focus();
    } else if (event.keystroke === "enter")
      this.handle.focus();
    else if (event.keystroke === "pagedown")
      this.requestMore(true, cx);
    else
      return false;
    return true;
  }
  commitsKey(event, cx) {
    const page = Math.max(1, this.pageRows());
    const moves = { down: 1, j: 1, up: -1, k: -1, pageup: -page };
    const move = moves[event.keystroke];
    if (move !== undefined)
      this.moveSelection(move, cx);
    else if (event.keystroke === "h")
      this.scrollGraph(-2);
    else if (event.keystroke === "l")
      this.scrollGraph(2);
    else if (event.keystroke === "enter")
      this.openCommitDiff(cx);
    else if (event.keystroke === "right")
      this.inspect.focusChanges();
    else if (event.keystroke === "pagedown") {
      this.moveSelection(page, cx);
      this.requestMore(this.state.query !== "" || this.state.visible.length === 0, cx);
    } else if (event.keystroke === "home")
      this.select(0, cx);
    else if (event.keystroke === "end") {
      this.select(this.displayLen() - 1, cx);
      this.requestMore(false, cx);
    } else
      return false;
    return true;
  }
  openCommitDiff(cx) {
    const commit = this.selected();
    if (commit)
      this.services.openCommitDiff(commit.sha, cx);
  }
  key(event, cx) {
    if (isChord(event) || this.workspaces.isFocused())
      return;
    let handled;
    if (this.filtering)
      handled = this.filterKey(event, cx);
    else if (event.key_char === "/" || event.keystroke === "/") {
      this.openFilter();
      handled = true;
    } else if (this.inspect.focus)
      handled = this.inspect.key(event, cx);
    else
      handled = this.commitsKey(event, cx);
    if (!handled)
      return;
    cx.stop_propagation();
    cx.notify();
  }
  listWheel(event, look, cx) {
    const lines = event.delta_lines;
    const horizontal = lines ? lines.x : event.delta.x / look.cell;
    if (Math.abs(horizontal) >= 1 || event.modifiers.shift) {
      const amount = Math.abs(horizontal) >= 1 ? -horizontal : -(lines ? lines.y : event.delta.y / look.row);
      if (Math.abs(amount) >= 1)
        this.scrollGraph(amount > 0 ? 2 : -2);
      cx.stop_propagation();
      cx.notify();
      return;
    }
    this.wheel += lines ? lines.y * look.row : event.delta.y;
    const steps = Math.trunc(this.wheel / look.row);
    if (steps === 0)
      return;
    this.wheel -= steps * look.row;
    this.inspect.focus = null;
    this.moveSelection(-steps, cx);
    cx.stop_propagation();
    cx.notify();
  }
  commitsTitle(look) {
    if (this.pending) {
      return h_flex19().child(spinner(look)).child(` ${this.progress()}`);
    }
    const anchor = this.state.anchor;
    if (anchor)
      return h_flex19().child(`Commits from ${shortCommit(anchor)} · `).child(div23().id("git-graph-back").text_color(look.t.accent).font_weight(700).child("[Esc] Back to HEAD").on_click((_, cx) => {
        cx.stop_propagation();
        this.leaveAnchor(cx);
        cx.notify();
      }));
    let title = "Commits";
    if (this.state.query)
      title += ` · ${this.displayLen()} matches`;
    if (this.lastLoad !== null)
      title += ` · Loaded in ${this.lastLoad.toFixed(2)} s`;
    return title;
  }
  footer(look) {
    const { t } = look;
    const text = this.historyError ? "Refresh to retry" : this.state.hasMore ? "[PgDn] Load more" : "";
    if (!text)
      return null;
    return h_flex19().id("git-graph-load-more").absolute().bottom(4).right(12).h(look.row + 2).px(8).items_center().bg(t.hover).border(1).border_color(t.lineStrong).rounded(2).text_size(Math.max(10, look.size - 2)).text_color(this.historyError ? t.error : t.accentText).hover((style) => style.bg(t.accentSoft).border_color(t.accent)).whitespace_nowrap().child(text).on_click((_, cx) => {
      cx.stop_propagation();
      if (this.historyError)
        return;
      this.requestMore(true, cx);
      cx.notify();
    });
  }
  lanes(look, row, view) {
    if (!row || view.width <= 0)
      return div23().flex_none().w(cols(look, view.width));
    return this.showGraph() ? curveLanes(look, row, view) : glyphLanes(look, row, view);
  }
  commitRow(look, row, first) {
    const { t } = look;
    const commit = this.rowCommit(row);
    const selected = row === this.state.selected;
    const text = {
      width: this.width,
      gutter: Math.min(this.graphVisible + 1, this.width),
      nowSeconds: Date.now() / 1000,
      bold: selected
    };
    const view = {
      width: this.graphVisible,
      scroll: this.state.graphScroll,
      total: this.graphWidth,
      first,
      selected,
      background: selected ? t.panelFocus : t.panel
    };
    const element = h_flex19().id(`git-commit-row-${row}`).flex_none().h(rows(look, ROW_HEIGHT)).min_w(0).overflow_hidden().border_l(2).border_color(selected ? t.accent : "#00000000").when(selected, (el) => el.bg(t.accentSoft)).when(!selected, (el) => el.hover((style) => style.bg(t.hover))).on_click((_, cx) => {
      cx.stop_propagation();
      this.clickRow(row, cx);
    }).on_mouse_down("right", (_, cx) => {
      cx.stop_propagation();
      this.clickRow(row, cx);
      if (this.selected())
        this.services.commands().shortcut("actions", cx);
    }).child(this.lanes(look, this.state.layout[row], view)).child(div23().flex_none().w(look.cell));
    if (!commit)
      return element;
    return element.child(v_flex20().flex_1().min_w(0).child(commitTitle(look, commit, text)).child(commitDetail(look, commit, text)));
  }
  clickRow(row, cx) {
    this.inspect.focus = null;
    this.handle.focus();
    this.select(row, cx);
    cx.notify();
  }
  measureLayout() {
    const length = this.displayLen();
    const overflow = this.width > 1 && length * ROW_HEIGHT > this.height;
    const width = this.width - (overflow ? 1 : 0);
    const visibleRows = Math.min(Math.ceil(this.height / ROW_HEIGHT), Math.max(0, length - this.state.scroll));
    this.graphWidth = layoutWidth(this.state.layout, this.state.scroll, visibleRows);
    this.graphVisible = Math.min(graphViewWidth(width), this.graphWidth);
    this.state.graphScroll = Math.min(this.state.graphScroll, Math.max(0, this.graphWidth - this.graphVisible));
  }
  commitList(look) {
    this.ensureVisible();
    this.measureLayout();
    const length = this.displayLen();
    const end = Math.min(length, this.state.scroll + Math.max(1, Math.ceil(this.height / ROW_HEIGHT)));
    const list = v_flex20().flex_1().min_w(0).min_h(0).overflow_hidden();
    for (let row = this.state.scroll;row < end; row++)
      list.child(this.commitRow(look, row, row === this.state.scroll));
    const bar = scrollbar(look, {
      axis: "vertical",
      total: length,
      visible: this.pageRows(),
      offset: this.state.scroll
    });
    return h_flex19().id("git-commits").flex_1().min_h(0).min_w(0).items_stretch().on_size_change((size, cx) => {
      const height = Math.max(0, Math.floor(size.height / look.screenRow));
      const width = Math.max(0, Math.floor(size.width / look.screenCell));
      if (height === this.height && width === this.width)
        return;
      this.height = height;
      this.width = width;
      cx.notify();
    }).on_scroll_wheel((event, cx) => this.listWheel(event, look, cx)).child(list).when(!!bar, (el) => el.child(bar ?? div23()));
  }
  commitsBox(look) {
    const focused = !this.inspect.focus && !this.filtering && !this.workspaces.isFocused();
    const element = box(look, { id: "git-commits-box", title: this.commitsTitle(look), focused }, this.commitList(look));
    const footer = this.footer(look);
    return footer ? element.child(footer) : element;
  }
  lower(look, size) {
    const preview = this.inspect.previewOpen();
    const onFocus = () => this.handle.focus();
    const height = size.rows;
    if (size.cols < WIDE_LOWER) {
      const pane = preview ? this.inspect.renderPreview(look, size, onFocus) : this.inspect.renderDetails(look, onFocus);
      return h_flex19().h(rows(look, height)).flex_none().items_stretch().child(pane.flex_1());
    }
    const [first, second, third] = paneWidths(size.cols);
    const row = h_flex19().h(rows(look, height)).flex_none().gap(6).child(this.workspaces.render(look).w(cols(look, first)).flex_none().h_full());
    if (!preview)
      return row.child(this.inspect.renderDetails(look, onFocus).flex_1().h_full());
    return row.child(this.inspect.renderDetails(look, onFocus).w(cols(look, second)).flex_none().h_full()).child(this.inspect.renderPreview(look, { cols: third, rows: height }, onFocus).flex_1().h_full());
  }
  render(look, size) {
    const available = Math.max(0, size.rows - 2);
    const listRows = Math.round(available * 58 / 100);
    return v_flex20().id("git-graph").size_full().min_h(0).min_w(0).gap(6).track_focus(this.handle).on_key_down((event, cx) => this.key(event, cx)).child(filterBar(look, { id: "git-graph-filter", input: this.filter, active: this.filtering })).child(this.commitsBox(look).h(rows(look, listRows)).flex_none()).child(this.lower(look, { cols: size.cols, rows: available - listRows }).flex_1());
  }
}

// src/ui/overlay.ts
import { h_flex as h_flex20, InputState as InputState5, v_flex as v_flex21 } from "gpui-base";
import { div as div24 } from "gpui-kit";
var PICKER_ROWS = 20;
function toneColor(look, tone) {
  const { t } = look;
  const colors = {
    text: t.text,
    hint: t.hint,
    secondary: t.secondary,
    muted: t.muted,
    accent: t.accent,
    warning: t.warning,
    error: t.error,
    success: t.success
  };
  return colors[tone];
}
function lineElement(look, line) {
  const value = typeof line === "string" ? { text: line, tone: "text" } : line;
  return div24().flex_none().min_h(look.row).whitespace_normal().text_color(toneColor(look, value.tone)).when(!!value.bold, (el) => el.font_weight(700)).child(value.text);
}
function lines2(look, content) {
  const split = [];
  for (const line of content) {
    if (typeof line === "string")
      split.push(...line.split(`
`));
    else
      split.push(line);
  }
  return v_flex21().min_w(0).children(split.map((line) => lineElement(look, line)));
}

class Overlay {
  restoreFocus;
  spec = null;
  inputs = [];
  list = new ListViewport("git-dialog-list");
  error = null;
  handle;
  constructor(cx, restoreFocus) {
    this.restoreFocus = restoreFocus;
    this.handle = cx.focus_handle();
  }
  isOpen() {
    return this.spec !== null;
  }
  current() {
    return this.spec;
  }
  open(spec) {
    this.releaseInputs();
    this.spec = spec;
    this.error = null;
    this.list.reset();
    if (spec.kind === "picker" && (spec.search ?? true))
      this.inputs = [InputState5.new({ placeholder: spec.placeholder ?? "" })];
    if (spec.kind === "form")
      this.inputs = spec.fields.map((field) => InputState5.new({ placeholder: field.placeholder ?? "", value: field.value ?? "" }));
    for (const input of this.inputs)
      input.on("change", (_, cx) => {
        this.error = null;
        if (this.spec?.kind === "picker")
          this.list.reset();
        cx.notify();
      });
    if (spec.kind === "picker" && spec.selected !== undefined) {
      const index = this.pickerRows(spec).findIndex((row) => row.id === spec.selected);
      if (index >= 0)
        this.list.selected = index;
    }
    const [first] = this.inputs;
    if (first)
      first.focus();
    else
      this.handle.focus();
  }
  setError(message) {
    this.error = message;
  }
  close(cx) {
    if (!this.spec)
      return;
    this.spec = null;
    this.error = null;
    this.releaseInputs();
    this.restoreFocus(cx);
  }
  release() {
    this.spec = null;
    this.releaseInputs();
    this.handle.release();
  }
  releaseInputs() {
    for (const input of this.inputs)
      input.release();
    this.inputs = [];
  }
  query() {
    return this.inputs[0]?.value().trim().toLowerCase() ?? "";
  }
  pickerRows(spec) {
    const query = this.query();
    if (typeof spec.rows === "function")
      return spec.rows(query);
    return spec.rows.filter((row) => `${row.label} ${row.status ?? ""}`.toLowerCase().includes(query));
  }
  cancel(cx) {
    const spec = this.spec;
    this.close(cx);
    spec?.onCancel?.(cx);
  }
  choose(spec, cx) {
    const row = this.pickerRows(spec)[this.list.selected];
    if (!row)
      return;
    this.close(cx);
    spec.onChoose(row, cx);
  }
  confirm(spec, cx) {
    if (spec.enabled && !spec.enabled())
      return;
    this.close(cx);
    spec.onConfirm(cx);
  }
  submit(spec, cx) {
    const error = spec.onSubmit(this.inputs.map((input) => input.value()), cx);
    if (error !== null)
      this.error = error;
    else if (this.spec === spec)
      this.close(cx);
  }
  primary(cx) {
    const spec = this.spec;
    if (spec?.kind === "picker")
      this.choose(spec, cx);
    else if (spec?.kind === "confirm")
      this.confirm(spec, cx);
    else if (spec?.kind === "form")
      this.submit(spec, cx);
  }
  key(event, cx) {
    const spec = this.spec;
    if (!spec)
      return;
    let handled = true;
    if (spec.kind === "custom" && spec.key?.(event, cx))
      handled = true;
    else if (event.keystroke === "escape")
      this.cancel(cx);
    else if (event.keystroke === "enter" && spec.kind !== "custom")
      this.primary(cx);
    else if (spec.kind === "picker") {
      const outcome = this.list.key(event, this.pickerRows(spec).length, !(spec.search ?? true));
      handled = outcome === "moved";
    } else
      handled = false;
    if (!handled)
      return;
    cx.stop_propagation();
    cx.notify();
  }
  footer(look, primary, secondary) {
    return dialogFooter(look, { id: "git-dialog-primary", label: primary, onClick: (cx) => this.primary(cx) }, { id: "git-dialog-secondary", label: secondary, onClick: (cx) => this.cancel(cx) });
  }
  hint(look, text) {
    if (this.error)
      return footerHint(look, this.error).text_color(look.t.error);
    return footerHint(look, text);
  }
  searchBox(look) {
    const [input] = this.inputs;
    if (!input)
      return null;
    const { t } = look;
    return h_flex20().id("git-dialog-search").flex_none().h(look.row + 8).px(8).gap(6).items_center().bg(t.background).border(1).border_color(t.accent).rounded(2).child(div24().flex_none().text_color(t.accentText).font_weight(600).child("/")).child(textInput(look, input));
  }
  picker(look, spec) {
    const { t } = look;
    const all = this.pickerRows(spec);
    const visible = Math.max(1, Math.min(all.length, spec.maxRows ?? PICKER_ROWS));
    const columns = spec.columns;
    const query = this.query();
    const footer = typeof spec.footer === "function" ? spec.footer(query, all.length) : spec.footer ?? "";
    const body = v_flex21().min_w(0).gap(6);
    const search = this.searchBox(look);
    if (search)
      body.child(search);
    if (columns)
      body.child(h_flex20().flex_none().h(look.row + 4).pl(2).items_center().bg(t.background).border_b(1).border_color(t.rule).text_size(Math.max(10, look.size - 2)).text_color(t.hint).font_weight(600).whitespace_nowrap().child(`  ${padToWidth(columns.label.toUpperCase(), columns.width)}${columns.status.toUpperCase()}`));
    body.child(v_flex21().h(rows(look, visible)).flex_none().child(this.list.render(look, {
      length: all.length,
      focused: true,
      row: ({ index }) => {
        const row = all[index];
        if (!row)
          return div24();
        const width = columns?.width ?? 0;
        return h_flex20().flex_1().min_w(0).child(div24().flex_none().when(width > 0, (el) => el.w(cols(look, width))).when(width === 0, (el) => el.flex_1()).truncate().text_color(row.disabled ? t.muted : t.text).child(row.label)).when(!!row.status, (el) => el.child(div24().flex_none().text_color(row.disabled ? t.warning : t.secondary).child(row.status ?? "")));
      },
      onActivate: (_, cx) => this.choose(spec, cx)
    })));
    return body.child(this.hint(look, footer)).child(this.footer(look, spec.primary ?? "[Enter] Run", spec.secondary ?? "[Esc] Cancel"));
  }
  confirmBody(look, spec) {
    return v_flex21().min_w(0).gap(6).child(lines2(look, spec.lines)).child(this.hint(look, spec.hint ?? "")).child(this.footer(look, spec.primary ?? "[Enter] Run", spec.secondary ?? "[Esc] Cancel"));
  }
  form(look, spec) {
    const { t } = look;
    const body = v_flex21().min_w(0).gap(6).child(lines2(look, spec.lines ?? []));
    for (const [index, field] of spec.fields.entries()) {
      const input = this.inputs[index];
      if (input)
        body.child(v_flex21().id(`git-dialog-field-${index}`).flex_none().gap(4).child(div24().text_size(Math.max(10, look.size - 2)).font_weight(600).text_color(t.secondary).child(field.label.toUpperCase())).child(h_flex20().h(look.row + 8).px(8).items_center().bg(t.background).border(1).border_color(t.lineStrong).rounded(2).child(textInput(look, input))));
    }
    return body.child(this.hint(look, spec.hint ?? "")).child(this.footer(look, spec.primary ?? "[Enter] Save", spec.secondary ?? "[Esc] Cancel"));
  }
  body(look, spec) {
    if (spec.kind === "picker")
      return this.picker(look, spec);
    if (spec.kind === "confirm")
      return this.confirmBody(look, spec);
    if (spec.kind === "form")
      return this.form(look, spec);
    return v_flex21().min_w(0).min_h(0).flex_1().when(spec.height !== undefined, (el) => el.h(rows(look, spec.height ?? 0))).child(spec.render(look));
  }
  render(look) {
    const spec = this.spec;
    if (!spec)
      return null;
    const title = typeof spec.title === "string" ? spec.title : div24().text_size(Math.max(10, look.size - 2)).text_color(toneColor(look, spec.title.tone)).font_weight(600).child(spec.title.text.toUpperCase());
    const width = spec.width ?? (spec.kind === "picker" ? DIALOG.wide : DIALOG.medium);
    const frame = dialogFrame(look, { id: "git-dialog", title, width }, this.body(look, spec)).track_focus(this.handle).on_key_down((event, cx) => this.key(event, cx));
    return v_flex21().id("git-dialog-layer").absolute().inset_0().p(16).bg(look.t.scrim).items_center().justify_center().on_mouse_down("left", (_, cx) => cx.stop_propagation()).child(frame);
  }
}

// src/ui/settings.ts
import { h_flex as h_flex21, v_flex as v_flex22 } from "gpui-base";
import { div as div25 } from "gpui-kit";
var LABEL_WIDTH = 24;
var THEME_OPTIONS = [
  { mode: "auto", label: "Auto", description: "Follows Herdr dark or light theme" },
  { mode: "void", label: "Void", description: "Deepfield dark cockpit palette" },
  { mode: "frost", label: "Frost", description: "Deepfield daylight palette" }
];
function themeOption(mode) {
  return THEME_OPTIONS.find((option) => option.mode === mode) ?? THEME_OPTIONS[0];
}
function switchControl(look, on) {
  const { t } = look;
  return h_flex21().flex_none().items_center().gap(8).child(div25().relative().flex_none().w(36).h(18).rounded_full().bg(on ? t.accent : t.background).border(1).border_color(on ? t.accent : t.lineStrong).child(div25().absolute().top(2).left(on ? 20 : 2).w(12).h(12).rounded_full().bg(on ? t.textInverse : t.secondary))).child(div25().flex_none().w(28).text_size(Math.max(10, look.size - 2)).font_weight(600).text_color(on ? t.accentText : t.hint).child(on ? "ON" : "OFF"));
}
function selectControl(look, text, open) {
  const { t } = look;
  return h_flex21().flex_none().h(look.row + 4).px(8).gap(8).items_center().bg(open ? t.accentSoft : t.background).border(1).border_color(open ? t.accent : t.lineStrong).rounded(2).text_size(Math.max(10, look.size - 2)).font_weight(600).text_color(t.text).child(text.toUpperCase()).child(div25().text_color(open ? t.accentText : t.hint).child(open ? "▴" : "▾"));
}
function actionControl(look, text) {
  const { t } = look;
  return h_flex21().flex_none().h(look.row + 4).px(8).items_center().bg(t.background).border(1).border_color(t.lineStrong).rounded(2).text_size(Math.max(10, look.size - 2)).font_weight(600).text_color(t.accentText).child(text);
}

class SettingsTab {
  checkUpdates;
  updateStatus;
  id = "settings";
  graph;
  autoRefresh;
  selected = 0;
  themeOpen = false;
  themeCursor = 0;
  handle;
  constructor(cx, checkUpdates, updateStatus) {
    this.checkUpdates = checkUpdates;
    this.updateStatus = updateStatus;
    this.handle = cx.focus_handle();
    this.graph = localStorage.getItem("git-graph") !== "off";
    this.autoRefresh = localStorage.getItem("git-auto-refresh") !== "off";
  }
  activate() {
    this.handle.focus();
  }
  deactivate() {
    this.themeOpen = false;
  }
  focus() {
    this.handle.focus();
  }
  escape() {
    if (!this.themeOpen)
      return false;
    this.themeOpen = false;
    return true;
  }
  release() {
    this.handle.release();
  }
  toggleThemeMenu() {
    this.themeOpen = !this.themeOpen;
    if (this.themeOpen) {
      const index = THEME_OPTIONS.findIndex((option) => option.mode === themeMode());
      this.themeCursor = Math.max(0, index);
    }
  }
  chooseTheme(mode) {
    setThemeMode(mode);
    this.themeOpen = false;
  }
  rows() {
    const current = themeOption(themeMode());
    return [
      {
        id: "graph",
        label: "Native graph",
        kind: "switch",
        control: this.graph ? "ON" : "OFF",
        on: this.graph,
        status: this.graph ? "Native curves in Graph" : "Box-drawing characters in use",
        description: "Antialiased graph curves and commit rules drawn natively; off draws lanes with box-drawing characters",
        activate: () => {
          this.themeOpen = false;
          this.graph = !this.graph;
          localStorage.setItem("git-graph", this.graph ? "on" : "off");
        }
      },
      {
        id: "refresh",
        label: "Background refresh",
        kind: "switch",
        control: this.autoRefresh ? "ON" : "OFF",
        on: this.autoRefresh,
        status: this.autoRefresh ? "Watching the repository" : "Refresh from Commands",
        description: "Reloads status when files change and every 10 seconds",
        activate: () => {
          this.themeOpen = false;
          this.autoRefresh = !this.autoRefresh;
          localStorage.setItem("git-auto-refresh", this.autoRefresh ? "on" : "off");
        }
      },
      {
        id: "theme",
        label: "Theme",
        kind: "select",
        control: current?.label ?? "Auto",
        on: this.themeOpen,
        status: current?.description ?? "",
        description: "Select Auto (follows Herdr), Void (dark), or Frost (light)",
        activate: () => this.toggleThemeMenu()
      },
      {
        id: "versions",
        label: "Versions",
        kind: "action",
        control: "[Enter] Check",
        on: false,
        status: this.updateStatus() ?? `Current version v${VERSION}`,
        description: "Check GitHub Releases for a Git mod update",
        activate: (cx) => {
          this.themeOpen = false;
          this.checkUpdates(cx);
        }
      }
    ];
  }
  themeKey(keystroke) {
    const last = THEME_OPTIONS.length - 1;
    const moves = { up: -1, k: -1, down: 1, j: 1, home: -last, end: last };
    const move = moves[keystroke];
    if (move !== undefined)
      this.themeCursor = Math.max(0, Math.min(last, this.themeCursor + move));
    else if (keystroke === "enter" || keystroke === "space") {
      const option = THEME_OPTIONS[this.themeCursor];
      if (option)
        this.chooseTheme(option.mode);
    } else if (keystroke === "escape")
      this.themeOpen = false;
    else
      return false;
    return true;
  }
  key(event, cx) {
    if (this.themeOpen) {
      if (!this.themeKey(event.keystroke))
        return;
      cx.stop_propagation();
      cx.notify();
      return;
    }
    const rows = this.rows();
    const last = rows.length - 1;
    const moves = { up: -1, k: -1, down: 1, j: 1, home: -last, end: last };
    const move = moves[event.keystroke];
    if (move !== undefined)
      this.selected = Math.max(0, Math.min(last, this.selected + move));
    else if (event.keystroke === "enter" || event.keystroke === "space")
      rows[this.selected]?.activate(cx);
    else
      return;
    cx.stop_propagation();
    cx.notify();
  }
  themeDropdown(look) {
    const { t } = look;
    const current = themeMode();
    const menu = v_flex22().id("git-theme-dropdown").mt(4).bg(t.panel).border(1).border_color(t.lineStrong).rounded(2).shadow_md().overflow_hidden();
    for (const [index, option] of THEME_OPTIONS.entries()) {
      const focused = index === this.themeCursor;
      const chosen = option.mode === current;
      menu.child(h_flex21().id(`git-theme-option-${option.mode}`).h(look.row + 8).px(10).gap(10).items_center().cursor_pointer().border_l(2).border_color(focused ? t.accent : "#00000000").when(index > 0, (el) => el.border_t(1).border_color(t.rule)).when(focused, (el) => el.bg(t.accentSoft)).when(!focused, (el) => el.hover((style) => style.bg(t.hover))).child(div25().flex_none().w(14).text_color(t.accentText).font_weight(700).child(chosen ? "✓" : "")).child(div25().flex_none().w(64).text_size(Math.max(10, look.size - 1)).font_weight(chosen || focused ? 600 : 400).text_color(chosen || focused ? t.accentText : t.text).child(option.label.toUpperCase())).child(div25().flex_1().truncate().text_color(t.secondary).child(option.description)).on_click((_, cx) => {
        cx.stop_propagation();
        this.themeCursor = index;
        this.handle.focus();
        this.chooseTheme(option.mode);
        cx.notify();
      }));
    }
    return menu;
  }
  rowControl(look, row) {
    if (row.kind === "switch")
      return switchControl(look, row.on);
    if (row.kind === "select")
      return selectControl(look, row.control, row.on);
    return actionControl(look, row.control);
  }
  render(look) {
    const { t } = look;
    const body = v_flex22().p(8).gap(8);
    for (const [index, row] of this.rows().entries()) {
      const active = index === this.selected;
      const card = v_flex22().id(`git-setting-${row.id}`).p(8).gap(4).border(1).border_l(2).border_color(active ? t.accent : t.rule).when(active, (el) => el.bg(t.accentSoft)).when(!active, (el) => el.bg(t.background).hover((style) => style.bg(t.hover))).on_click((_, cx) => {
        this.selected = index;
        this.handle.focus();
        row.activate(cx);
        cx.notify();
      }).child(h_flex21().h(look.row + 4).items_center().gap(8).whitespace_nowrap().child(div25().font_weight(600).text_color(t.text).child(padToWidth(row.label, LABEL_WIDTH))).child(this.rowControl(look, row)).child(div25().text_color(t.secondary).child(row.status))).child(div25().h(look.row).truncate().text_color(t.hint).child(`${" ".repeat(LABEL_WIDTH)}${row.description}`));
      if (row.kind === "select" && this.themeOpen)
        card.child(this.themeDropdown(look));
      body.child(card);
    }
    return box(look, { id: "git-settings", title: "Settings", focused: this.handle.is_focused() }, body).size_full().track_focus(this.handle).on_key_down((event, cx) => this.key(event, cx));
  }
}

// src/ui/workspaces.ts
import { Button as Button4, h_flex as h_flex23 } from "gpui-base";
import {
  div as div27
} from "gpui-kit";
import { exec as exec5, pickFolder } from "herdr";

// src/git/workspaces.ts
var READ4 = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
var CLEAN2 = { changedPaths: 0, additions: 0, deletions: 0 };
async function run4(git, args) {
  const result = await git([...READ4, ...args]);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `git ${args[0]} exited with ${result.code}`);
  return result.stdout;
}
async function worktreePaths(git) {
  const output = await run4(git, ["worktree", "list", "--porcelain", "-z"]);
  return output.split("\x00").filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9));
}
async function projectRoot(git) {
  const top = await git([...READ4, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0)
    throw new Error("Choose a directory inside a Git repository.");
  const [root] = await worktreePaths(git);
  if (!root)
    throw new Error("Git returned no worktrees");
  return root;
}
function aheadBehind(value) {
  const [ahead, behind] = value.split(" ");
  const parse = (count, sign, label) => {
    const number = count?.startsWith(sign) ? Number(count.slice(1)) : Number.NaN;
    if (!Number.isInteger(number))
      throw new Error(`Git returned an invalid ${label} count`);
    return number;
  };
  return [parse(ahead, "+", "ahead"), parse(behind, "-", "behind")];
}
function branchStatus(headers) {
  const head = headers.get("branch.head");
  if (head === undefined)
    throw new Error("Git returned a status without a branch head");
  const oid = headers.get("branch.oid");
  if (head === "(detached)" && oid === undefined)
    throw new Error("Git returned a detached status without a commit");
  const counts = headers.get("branch.ab");
  const [ahead, behind] = counts === undefined ? [0, 0] : aheadBehind(counts);
  return {
    checkedOut: head === "(detached)" ? `Detached ${(oid ?? "").slice(0, 8)}` : head,
    upstream: counts === undefined ? null : headers.get("branch.upstream") ?? null,
    ahead,
    behind
  };
}
function parseWorktreeReport(output, files) {
  const headers = new Map;
  const records = output.split("\x00");
  for (let index = 0;index < records.length; index++) {
    const record = records[index] ?? "";
    if (record.startsWith("# ")) {
      const [key = "", ...value] = record.slice(2).split(" ");
      headers.set(key, value.join(" "));
    } else if (record.startsWith("2 ")) {
      index++;
    }
  }
  return { branch: branchStatus(headers), files: files ?? parseRepositoryStatus(output).files, fingerprint: output };
}
async function changeOverview(git, report) {
  if (report.files.length === 0)
    return CLEAN2;
  const summaries = await readWorkingSummaries(git, report.files);
  return {
    changedPaths: report.files.length,
    additions: (summaries.staged?.additions ?? 0) + (summaries.unstaged?.additions ?? 0),
    deletions: (summaries.staged?.deletions ?? 0) + (summaries.unstaged?.deletions ?? 0)
  };
}
async function readReport(git) {
  return parseWorktreeReport(await run4(git, [
    "-c",
    "status.relativePaths=false",
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=all"
  ]));
}
async function inspectWorktree(gitAt, path, previous, discover = true, repository) {
  const supplied = repository?.root === path ? repository : null;
  const report = supplied ? parseWorktreeReport(supplied.porcelain, supplied.files) : await readReport(gitAt(path));
  const root = supplied?.root ?? (discover ? (await run4(gitAt(path), ["rev-parse", "--show-toplevel"])).replace(/\n$/, "") : path);
  const unchanged = previous?.path === root && previous.fingerprint === report.fingerprint ? previous : null;
  if (unchanged && report.files.length === 0)
    return unchanged;
  return {
    path: root,
    overview: await changeOverview(gitAt(root), report),
    branch: report.branch,
    fingerprint: report.fingerprint
  };
}
async function inspectProject(gitAt, root, previous, fresh, repository) {
  const paths = await worktreePaths(gitAt(root));
  const statuses = await mapGit(paths, (path) => fresh?.path === path ? Promise.resolve(fresh) : inspectWorktree(gitAt, path, previous.find((status) => status.path === path) ?? null, false, repository));
  const [primary, ...worktrees] = statuses;
  if (!primary)
    throw new Error("Git returned no worktrees");
  return { root: primary.path, primary, worktrees };
}

// src/ui/workspaces/picker.ts
import { h_flex as h_flex22, v_flex as v_flex23 } from "gpui-base";
import { div as div26 } from "gpui-kit";

// src/ui/workspaces/rows.ts
function rowKey2(row) {
  const owner = row.kind.type === "project" ? row.kind.root : row.kind.type === "worktree" ? row.kind.project : "";
  return `${row.kind.type}\x00${owner}\x00${row.path}`;
}
function currentRow(cwd, status) {
  return status ? {
    kind: { type: "current" },
    path: status.path,
    overview: status.overview,
    branch: status.branch,
    worktrees: 0,
    error: null
  } : {
    kind: { type: "current" },
    path: cwd ?? "",
    overview: null,
    branch: null,
    worktrees: 0,
    error: "Not a Git repository"
  };
}
function worktreeRow(project, status) {
  return {
    kind: { type: "worktree", project },
    path: status.path,
    overview: status.overview,
    branch: status.branch,
    worktrees: 0,
    error: null
  };
}
function buildRows(current, roots, statuses, expanded) {
  const rows = [current];
  for (const root of roots) {
    const result = statuses.get(root);
    if (!result)
      continue;
    if (!result.ok) {
      rows.push({
        kind: { type: "project", root },
        path: root,
        overview: null,
        branch: null,
        worktrees: 0,
        error: "Unavailable"
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
      error: null
    });
    if (expanded(root))
      rows.push(...worktrees.map((status) => worktreeRow(root, status)));
  }
  return rows;
}
function pathLabel(path) {
  return path.split("/").filter(Boolean).pop() ?? path;
}
function worktreeLabel(path, project) {
  if (pathLabel(path) !== pathLabel(project))
    return pathLabel(path);
  const parent = path.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  return parent ? pathLabel(parent) : pathLabel(path);
}
function rowHeight(row) {
  return row.branch?.upstream ? 3 : 2;
}

// src/ui/workspaces/picker.ts
var CHROME2 = 6;
var FRAME = 2;
function rowElement2(look, row, index) {
  const { t } = look;
  const line = h_flex22().flex_1().min_w(0).overflow_hidden();
  if (index < 9)
    line.child(div26().text_color(t.hint).child("[")).child(div26().text_color(t.accent).font_weight(700).child(String(index + 1))).child(div26().text_color(t.hint).child("] "));
  else
    line.child(div26().child("    "));
  if (!row)
    return line;
  const name = pathLabel(row.path);
  if (row.kind.type === "current")
    return line.child(div26().truncate().child(`Current · ${name}`));
  if (row.kind.type === "worktree")
    line.child("  ");
  return line.items_center().child(iconCell(look, row.kind.type === "project" ? "repository" : "worktree")).child(div26().truncate().child(` ${name}`));
}
function openWorkspacePicker(overlay, options) {
  const list = new ListViewport("git-workspace-picker");
  list.selected = options.selected;
  const height = Math.min(24, Math.max(8, options.rows().length + CHROME2)) - FRAME;
  const choose = (index, cx) => {
    const row = options.rows()[index];
    if (!row)
      return;
    overlay.close(cx);
    options.choose(row, cx);
  };
  const key = (event, cx) => {
    if (isChord(event))
      return false;
    const rows = options.rows();
    const digit = /^[1-9]$/.test(event.keystroke) ? Number(event.keystroke) - 1 : -1;
    if (digit >= 0) {
      if (digit < rows.length) {
        list.selected = digit;
        choose(digit, cx);
      }
      return true;
    }
    const outcome = list.key(event, rows.length);
    if (outcome === "activate")
      choose(list.selected, cx);
    else if (outcome === "cancel")
      overlay.close(cx);
    return outcome !== null;
  };
  overlay.open({
    kind: "custom",
    title: "Select Workspace",
    width: DIALOG.medium,
    height,
    key,
    render: (look) => {
      const rows = options.rows();
      return v_flex23().size_full().min_h(0).child(v_flex23().flex_1().min_h(0).child(list.render(look, {
        length: rows.length,
        focused: true,
        row: ({ index }) => rowElement2(look, rows[index], index),
        onActivate: (index, cx) => choose(index, cx)
      }))).child(footerHint(look, "1–9 Switch · ↑/↓ j/k Move")).child(dialogFooter(look, { id: "git-workspace-switch", label: "[Enter] Switch", onClick: (cx) => choose(list.selected, cx) }, { id: "git-workspace-close", label: "[Esc] Close", onClick: (cx) => overlay.close(cx) }));
    }
  });
}

// src/ui/workspaces/projects.ts
import { setShared, shared } from "herdr";
var KEY = "git.projects";
function parse(value) {
  const projects = typeof value === "object" && value !== null && "projects" in value ? value.projects : [];
  if (!Array.isArray(projects))
    return [];
  return [...new Set(projects.filter((root) => typeof root === "string"))];
}

class ProjectRegistry {
  list = [];
  seen = "[]";
  constructor() {
    this.changed();
  }
  roots() {
    return this.list;
  }
  changed() {
    const list = parse(shared(KEY));
    const seen = JSON.stringify(list);
    if (seen === this.seen)
      return false;
    this.list = list;
    this.seen = seen;
    return true;
  }
  add(root) {
    this.changed();
    if (this.list.includes(root))
      return false;
    this.save([...this.list, root]);
    return true;
  }
  remove(root) {
    this.changed();
    if (!this.list.includes(root))
      return false;
    this.save(this.list.filter((entry) => entry !== root));
    return true;
  }
  save(list) {
    try {
      setShared(KEY, { projects: list });
    } catch (error) {
      throw new Error(`Could not save registered projects: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.list = list;
    this.seen = JSON.stringify(list);
  }
}

// src/ui/workspaces.ts
var CURRENT_TOP = 1.4;
var SEPARATOR = 5.3;
var PROJECTS_HEADER = 6;
var PROJECTS_TOP = 8.4;
var CARD_PAD = 0.5;
var ITEM_GAP = 0.3;
var GROUP_GAP = 0.55;
var ADD_WIDE = 34;
var DEFAULT_WIDTH = 40;
var BUSY = "Wait for the current Git operation.";
function message3(error) {
  return error instanceof Error ? error.message : String(error);
}
function gitAt(on) {
  return (cwd) => (args) => exec5("git", args, { cwd, on });
}
function line2(look, spans) {
  return h_flex23().flex_none().h(look.row).min_w(0).whitespace_nowrap().overflow_hidden().children(spanElements(look, spans));
}
function fitted(width, prefix, suffix) {
  return Math.max(1, Math.min(Math.max(1, width - prefix - suffix), Math.max(1, width - prefix)));
}

class WorkspacesBox {
  services;
  registry = new ProjectRegistry;
  current = currentRow(null, null);
  currentStatus = null;
  currentCwd = null;
  currentOn = null;
  statuses = new Map;
  rows = [this.current];
  expanded = new Set;
  selected = 0;
  scroll = 0;
  height = 0;
  width = DEFAULT_WIDTH;
  page = 1;
  wheel = 0;
  hovered = null;
  switching = null;
  refreshing = false;
  queued = false;
  queuedRepository;
  announced = false;
  loaded = false;
  adding = false;
  request = 0;
  alive = true;
  handle;
  constructor(services, cx) {
    this.services = services;
    this.handle = cx.focus_handle();
  }
  release() {
    this.alive = false;
    this.request++;
    this.handle.release();
  }
  focus() {
    this.handle.focus();
  }
  isFocused() {
    return this.handle.is_focused();
  }
  progress() {
    return this.adding ? "Choosing Project" : null;
  }
  syncProjects(cx) {
    if (!this.registry.changed())
      return;
    this.rebuild();
    this.refresh(cx);
  }
  canRemoveProject() {
    return this.rows[this.selected]?.kind.type === "project";
  }
  refresh(cx, repository) {
    if (!this.alive)
      return;
    const request = ++this.request;
    if (this.refreshing) {
      this.queued = true;
      this.queuedRepository = repository;
      return;
    }
    const location = this.services.source.followed();
    const context = this.services.context();
    const roots = [...this.registry.roots()];
    this.refreshing = true;
    cx.spawn(async (cx) => {
      try {
        const inspection = await this.inspect(location, roots, repository);
        if (this.alive && request === this.request && context === this.services.context() && JSON.stringify(location) === JSON.stringify(this.services.source.followed()))
          this.apply(inspection);
      } finally {
        if (this.alive) {
          this.refreshing = false;
          if (this.queued) {
            const next = this.queuedRepository;
            this.queued = false;
            this.queuedRepository = undefined;
            this.refresh(cx, next === this.services.repository() ? next : undefined);
          } else {
            this.announced = false;
          }
          cx.notify();
        }
      }
    });
  }
  async inspect(location, roots, repository) {
    const cwd = location?.cwd ?? null;
    const on = location?.on ?? null;
    const activeLocation = this.services.location();
    const activeOn = activeLocation?.on ?? null;
    const activeGit = repository === this.services.repository() ? this.services.git() : null;
    const at = (machine) => (path) => activeGit && machine === activeOn && path === repository?.root ? activeGit : gitAt(machine)(path);
    const supplied = activeGit && activeOn === on && (cwd === activeLocation?.cwd || cwd === repository?.root) ? repository : undefined;
    const previousCurrent = cwd === this.currentCwd && on === this.currentOn ? this.currentStatus : null;
    const currentRead = cwd ? inspectWorktree(at(on), supplied?.root ?? cwd, previousCurrent, !supplied, supplied).catch(() => null) : Promise.resolve(null);
    const previous = [...this.statuses.values()].flatMap((result) => result.ok ? [result.status.primary, ...result.status.worktrees] : []);
    const [current, results] = await Promise.all([
      currentRead,
      Promise.all(roots.map(async (root) => inspectProject(at(null), root, previous, on === null ? await currentRead : null, activeOn === null && activeGit ? repository : undefined).then((status) => ({ ok: true, status }), (error) => ({ ok: false, error: message3(error) }))))
    ]);
    return {
      cwd,
      on,
      current,
      statuses: new Map(roots.map((root, index) => [root, results[index] ?? { ok: false, error: "" }]))
    };
  }
  apply(inspection) {
    this.currentCwd = inspection.cwd;
    this.currentOn = inspection.on;
    this.currentStatus = inspection.current;
    this.current = currentRow(inspection.cwd, inspection.current);
    this.statuses = inspection.statuses;
    this.loaded = true;
    this.rebuild();
  }
  allRows() {
    return buildRows(this.current, this.registry.roots(), this.statuses, () => true);
  }
  rebuild() {
    const selected = this.rows[this.selected];
    const key = selected ? rowKey2(selected) : null;
    this.rows = buildRows(this.current, this.registry.roots(), this.statuses, (root) => this.expanded.has(root));
    const index = this.rows.findIndex((row) => rowKey2(row) === key);
    this.selected = index >= 0 ? index : Math.min(this.selected, this.rows.length - 1);
  }
  active(row) {
    const repository = this.services.repository();
    const on = row.kind.type === "current" ? this.currentOn : null;
    return repository?.state === "ready" && repository.root === row.path && on === (this.services.location()?.on ?? null);
  }
  settleSwitch() {
    if (this.switching === null || this.services.loading())
      return;
    if (this.services.repository() !== null || this.services.repositoryError() !== null)
      this.switching = null;
  }
  switchRow(index, cx) {
    const row = this.rows[index];
    if (!row)
      return;
    this.selected = index;
    this.handle.focus();
    if (this.services.busy()) {
      this.services.reportError(BUSY);
      return;
    }
    if (row.kind.type === "current" && row.overview === null) {
      this.switching = null;
      this.services.source.select(null);
      this.services.refresh("repository", cx);
      this.services.reportError("Current is not a Git repository");
      return;
    }
    if (this.active(row))
      return;
    this.switching = rowKey2(row);
    this.services.source.select(row.kind.type === "current" ? null : { cwd: row.path, on: null });
    this.services.refresh("repository", cx);
  }
  toggleSelectedProject() {
    const row = this.rows[this.selected];
    if (row?.kind.type !== "project")
      return;
    if (!this.expanded.delete(row.kind.root))
      this.expanded.add(row.kind.root);
    this.rebuild();
  }
  move(delta) {
    if (this.rows.length === 0)
      return;
    this.handle.focus();
    this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta));
  }
  manage(cx) {
    const rows = this.allRows();
    const selected = this.rows[this.selected];
    const key = selected ? rowKey2(selected) : null;
    let index = rows.findIndex((row) => rowKey2(row) === key);
    if (index < 0)
      index = rows.findIndex((row) => this.active(row));
    openWorkspacePicker(this.services.overlay, {
      rows: () => this.allRows(),
      selected: Math.max(0, index),
      choose: (row, cx) => this.chooseWorkspace(row, cx)
    });
    cx.notify();
  }
  chooseWorkspace(row, cx) {
    if (row.kind.type === "worktree") {
      this.expanded.add(row.kind.project);
      this.rebuild();
    }
    const index = this.rows.findIndex((candidate) => rowKey2(candidate) === rowKey2(row));
    if (index >= 0)
      this.switchRow(index, cx);
  }
  add(cx) {
    if (this.services.busy() || this.adding) {
      this.services.reportError(BUSY);
      return;
    }
    this.adding = true;
    const overlay = this.services.overlay;
    cx.spawn(async (cx) => {
      try {
        const folder = await pickFolder({ prompt: "Add Project" });
        if (!folder || !this.alive)
          return;
        const root = await projectRoot(gitAt(null)(folder));
        if (!this.alive)
          return;
        if (!this.registry.add(root)) {
          showResult(overlay, "Git operation", false, "Project is already registered");
          return;
        }
        showResult(overlay, "Add Project", true, "Project added", undefined, cx);
        this.announced = true;
        this.refresh(cx);
      } catch (error) {
        if (this.alive)
          showResult(overlay, "Git operation", false, message3(error));
      } finally {
        this.adding = false;
        cx.notify();
      }
    });
  }
  removeProject(cx) {
    if (this.services.busy() || this.adding) {
      this.services.reportError(BUSY);
      return;
    }
    const row = this.rows[this.selected];
    if (row?.kind.type !== "project") {
      this.services.reportError("Select a registered Project");
      return;
    }
    const root = row.kind.root;
    this.services.overlay.open({
      kind: "confirm",
      title: "Remove Project",
      width: DIALOG.medium,
      lines: ["Remove this Project from Workspaces?", root, "", "Files and worktrees stay on disk."],
      primary: "[Enter] Remove",
      secondary: "[Esc] Cancel",
      onConfirm: (cx) => this.remove(root, cx)
    });
    cx.notify();
  }
  remove(root, cx) {
    const overlay = this.services.overlay;
    try {
      if (!this.registry.remove(root)) {
        showResult(overlay, "Git operation", false, "Project is not registered");
        return;
      }
    } catch (error) {
      showResult(overlay, "Git operation", false, message3(error));
      return;
    }
    this.expanded.delete(root);
    this.statuses.delete(root);
    this.rebuild();
    showResult(overlay, "Remove Project", true, "Project removed", undefined, cx);
    this.announced = true;
    this.refresh(cx);
  }
  key(event, cx) {
    if (isChord(event))
      return;
    const moves = {
      down: 1,
      j: 1,
      up: -1,
      k: -1,
      pagedown: this.page,
      pageup: -this.page,
      home: -this.rows.length,
      end: this.rows.length
    };
    const delta = moves[event.keystroke];
    if (delta !== undefined)
      this.move(delta);
    else if (event.keystroke === "enter")
      this.switchRow(this.selected, cx);
    else if (event.keystroke === "space")
      this.toggleSelectedProject();
    else
      return;
    cx.stop_propagation();
    cx.notify();
  }
  scrollWheel(event, look, cx) {
    this.wheel += event.delta_lines ? event.delta_lines.y * look.row : event.delta.y;
    const steps = Math.trunc(this.wheel / look.row);
    if (steps === 0)
      return;
    this.wheel -= steps * look.row;
    cx.stop_propagation();
    this.move(-steps);
    cx.notify();
  }
  click(index, cx) {
    const project = this.rows[index]?.kind.type === "project";
    this.switchRow(index, cx);
    if (project)
      this.toggleSelectedProject();
  }
  layout() {
    const placed = [];
    const [first] = this.rows;
    if (first)
      placed.push({ index: 0, top: CURRENT_TOP, height: rowHeight(first) + CARD_PAD });
    let next = PROJECTS_TOP;
    let grouped = false;
    for (const [index, row] of this.rows.entries()) {
      if (index === 0)
        continue;
      if (row.kind.type === "project") {
        if (grouped)
          next += GROUP_GAP;
        grouped = true;
      } else {
        next += ITEM_GAP;
      }
      const height = rowHeight(row) + CARD_PAD;
      placed.push({ index, top: next, height });
      next += height;
    }
    return { placed, content: Math.max(next, PROJECTS_TOP) };
  }
  scrollTo(placed, content) {
    const height = this.height || content;
    const selected = placed.find((entry) => entry.index === this.selected);
    if (this.selected === 0)
      this.scroll = 0;
    else if (selected && selected.top < this.scroll)
      this.scroll = selected.top;
    else if (selected && selected.top + selected.height > this.scroll + height)
      this.scroll = selected.top + selected.height - height;
    this.scroll = Math.max(0, Math.min(this.scroll, content - height));
  }
  title(look) {
    if (!this.refreshing || this.loaded && !this.announced)
      return "Workspaces";
    return h_flex23().child(spinner(look)).child(this.loaded ? " Refreshing Workspaces" : " Loading Workspaces");
  }
  nameSpans(row, look, spans, reserved) {
    const { t } = look;
    const name = pathLabel(row.path);
    if (row.kind.type === "worktree")
      spans.push({ text: `  ${worktreeLabel(row.path, row.kind.project)}` });
    else
      spans.push({ text: name });
    if (row.kind.type === "project") {
      const count = ` · ${row.worktrees} ${row.worktrees === 1 ? "worktree" : "worktrees"}`;
      if (this.width >= spansWidth(spans) + displayWidth(count) + reserved)
        spans.push({ text: count, color: t.hint });
    }
    return spans;
  }
  nameLine(look, row, focusedRow, index) {
    const { t } = look;
    const switching = this.switching === rowKey2(row);
    const icon = row.kind.type === "worktree" ? "worktree" : "repository";
    const marker = switching ? [] : this.active(row) ? [{ text: padToWidth(GLYPH.marker, ICON_CELLS + 1), color: t.accent }] : [{ text: " ", icon, color: t.hint }];
    const spans = this.nameSpans(row, look, marker, switching ? ICON_CELLS + 1 : 0);
    const content = line2(look, spans).flex_1();
    const result = h_flex23().flex_none().h(look.row).min_w(0);
    if (switching)
      result.child(h_flex23().flex_none().w((ICON_CELLS + 1) * look.cell).child(spinner(look)));
    result.child(content);
    const actions = row.kind.type === "project" && (focusedRow || this.hovered === index) && this.width > 3;
    if (actions)
      result.child(Button4.new(`git-workspace-remove-${index}`).accessibility_label("Remove Project").flex_none().h(look.row).text_color(t.error).hover((style) => style.bg(t.hover)).child("[-]").on_click((_, cx) => {
        cx.stop_propagation();
        this.selected = index;
        this.removeProject(cx);
      }));
    return result;
  }
  summaryLine(look, row) {
    const { t } = look;
    if (this.switching === rowKey2(row))
      return line2(look, [{ text: "Loading repository", color: t.accent }]);
    if (row.error)
      return line2(look, [{ text: row.error, color: row.kind.type === "current" ? t.warning : t.error }]);
    if (!row.branch)
      return line2(look, []);
    const overview = row.overview;
    const working = [];
    if (overview && overview.changedPaths > 0) {
      working.push({ text: "● ", color: t.warning }, { text: `${overview.changedPaths}f`, color: t.hint });
      if (overview.additions > 0)
        working.push({ text: ` +${overview.additions}`, color: t.success });
      if (overview.deletions > 0)
        working.push({ text: ` -${overview.deletions}`, color: t.error });
    }
    const prefix = { text: " ", icon: "branch", color: t.accent };
    const suffix = working.length ? 3 + spansWidth(working) : 0;
    const branch = truncateToWidth(row.branch.checkedOut, fitted(this.width, spansWidth([prefix]), suffix));
    const spans = [prefix, { text: branch, color: t.accent }];
    if (working.length)
      spans.push({ text: GLYPH.separator }, ...working);
    return line2(look, spans);
  }
  upstreamLine(look, row) {
    const { t } = look;
    const branch = row.branch;
    if (!branch?.upstream)
      return null;
    if (this.switching === rowKey2(row))
      return line2(look, []);
    const sync = [];
    if (branch.ahead === 0 && branch.behind === 0)
      sync.push({ text: "✓", color: t.success });
    if (branch.ahead > 0)
      sync.push({ text: `↑${branch.ahead}`, color: t.success });
    if (branch.ahead > 0 && branch.behind > 0)
      sync.push({ text: " " });
    if (branch.behind > 0)
      sync.push({ text: `↓${branch.behind}`, color: t.warning });
    const prefix = { text: " ", icon: "remote", color: t.accent };
    const upstream = truncateToWidth(branch.upstream, fitted(this.width, spansWidth([prefix]), 3 + spansWidth(sync)));
    return line2(look, [prefix, { text: upstream, color: t.hint }, { text: GLYPH.separator }, ...sync]);
  }
  rowElement(look, entry, focused) {
    const { t } = look;
    const row = this.rows[entry.index];
    if (!row)
      return div27();
    const focusedRow = focused && entry.index === this.selected;
    const index = entry.index;
    const element = div27().id(`git-workspace-row-${index}`).absolute().left(0).right(0).top(rows(look, entry.top - this.scroll)).h(rows(look, entry.height)).flex().flex_col().justify_center().overflow_hidden().px(8).bg(focusedRow ? t.accentSoft : t.background).border(1).border_color(focusedRow ? t.accentEdge : t.rule).when(focusedRow, (el) => el.font_weight(600)).when(!focusedRow, (el) => el.hover((style) => style.bg(t.hover))).on_hover((hovered, cx) => {
      if (hovered)
        this.hovered = index;
      else if (this.hovered === index)
        this.hovered = null;
      cx.notify();
    }).on_click((_, cx) => {
      cx.stop_propagation();
      this.click(index, cx);
      cx.notify();
    }).child(this.nameLine(look, row, focusedRow, index)).child(this.summaryLine(look, row));
    const upstream = this.upstreamLine(look, row);
    if (upstream)
      element.child(upstream);
    if (focusedRow)
      element.child(div27().absolute().bottom(0).left(0).right(0).h(2).bg(t.accent));
    return element;
  }
  header(look, top, child) {
    return div27().absolute().left(0).right(0).top(rows(look, top - this.scroll)).h(look.row).px(4).flex().items_center().child(child);
  }
  addButton(look) {
    const { t } = look;
    const wide = this.width >= ADD_WIDE;
    return Button4.new("git-workspace-add").accessibility_label("Add Project").flex_none().h(look.row).px(6).items_center().border(1).border_color(t.lineStrong).rounded(2).text_size(Math.max(10, look.size - 2)).text_color(t.accentText).font_weight(600).hover((style) => style.bg(t.accentSoft).border_color(t.accent)).child(wide ? "+ ADD PROJECT" : "+").on_click((_, cx) => {
      cx.stop_propagation();
      this.add(cx);
      cx.notify();
    });
  }
  sections(look) {
    const { t } = look;
    const wide = this.width >= ADD_WIDE;
    const projects = h_flex23().w_full().items_center().gap(6).child(sectionLabel(look, "Projects", { rule: true }));
    if (wide)
      projects.child(this.addButton(look));
    const children = [
      this.header(look, 0, sectionLabel(look, "Current", { rule: true })),
      this.header(look, SEPARATOR, div27().w_full().h(1).bg(t.rule)),
      this.header(look, PROJECTS_HEADER, projects)
    ];
    if (!wide)
      children.push(this.header(look, PROJECTS_HEADER + 1, h_flex23().w_full().justify_end().child(this.addButton(look))));
    return children;
  }
  render(look) {
    this.settleSwitch();
    const focused = this.isFocused();
    const { placed, content } = this.layout();
    this.scrollTo(placed, content);
    const height = this.height || content;
    const visible = placed.filter((entry) => entry.top + entry.height > this.scroll && entry.top < this.scroll + height);
    this.page = Math.max(1, visible.length);
    const body = div27().id("git-workspaces-list").relative().flex_1().min_h(0).min_w(0).overflow_hidden().on_size_change((size, cx) => {
      const rows = Math.max(1, Math.floor(size.height / look.screenRow));
      const width = Math.max(1, Math.floor((size.width - 18) / look.screenCell));
      if (rows === this.height && width === this.width)
        return;
      this.height = rows;
      this.width = width;
      cx.notify();
    }).on_scroll_wheel((event, cx) => this.scrollWheel(event, look, cx)).children(this.sections(look)).children(visible.map((entry) => this.rowElement(look, entry, focused)));
    const frame = box(look, { id: "git-workspaces", title: this.title(look), focused }, body);
    const handle = this.handle;
    return frame.track_focus(handle).on_mouse_down("left", () => handle.focus()).on_key_down((event, cx) => this.key(event, cx));
  }
}

// src/main.ts
var REFRESH_MS = 1e4;
var EMPTY_FACTS = { head: null, identity: null, github: false, remotes: [], stash: false };
var NEXT_COMMANDS = {
  changes: "changes",
  history: "graph",
  graph: "graph",
  files: "files",
  settings: "settings",
  commands: "commands",
  workspaces: "workspace",
  "files-search": "files-search",
  fetch: "fetch",
  pull: "pull",
  commit: "commit",
  push: "push",
  branches: "branch",
  stash: "stash"
};
function errorMessage3(error) {
  return error instanceof Error ? error.message : String(error);
}
async function readFacts(git) {
  const [head, name, email, origin, remotes, stash] = await Promise.all([
    git(["rev-parse", "--verify", "--quiet", "HEAD"]),
    git(["config", "user.name"]),
    git(["config", "user.email"]),
    git(["remote", "get-url", "origin"]),
    git(["remote"]),
    git(["rev-parse", "--verify", "--quiet", "refs/stash"])
  ]);
  const user = name.stdout.trim();
  const mail = email.stdout.trim();
  return {
    head: head.code === 0 ? head.stdout.trim() || null : null,
    identity: user && mail ? { name: user, email: mail } : null,
    github: origin.code === 0 && origin.stdout.includes("github.com"),
    remotes: remotes.stdout.split(`
`).filter(Boolean),
    stash: stash.code === 0
  };
}

class Session {
  source;
  placement;
  services;
  overlay;
  shell;
  root;
  workspaces;
  settings;
  tabs;
  graph;
  changes;
  commands;
  tab = "changes";
  repository = null;
  readGit = null;
  facts = EMPTY_FACTS;
  repositoryError = null;
  error = null;
  context = null;
  on = null;
  loading = false;
  watched = null;
  statusRequest = 0;
  operation = null;
  body = { width: 0, height: 0, cols: 0, rows: 0, wide: true };
  active = true;
  constructor(source, placement, cx) {
    this.source = source;
    this.placement = placement;
    this.root = cx.focus_handle();
    this.overlay = new Overlay(cx, () => this.tabs[this.tab].focus());
    this.services = {
      source,
      overlay: this.overlay,
      context: () => JSON.stringify(this.source.current()),
      location: () => this.source.current(),
      repository: () => this.repository,
      repositoryError: () => this.repositoryError,
      loading: () => this.loading,
      facts: () => this.facts,
      git: () => this.readGit,
      historyGit: () => {
        const repository = this.repository;
        if (repository?.state !== "ready")
          return null;
        const on = this.on;
        return (args) => exec6("git", args, { cwd: repository.root, on, timeout: 300000 });
      },
      mutate: (context, label, action, cx) => this.mutate(context, label, action, cx),
      busy: () => this.operation,
      refresh: (scope, cx) => this.refresh(scope, cx),
      activeTab: () => this.tab,
      setTab: (tab, cx) => this.setTab(tab, cx),
      selectedCommit: () => this.graph.selectedCommit(),
      revealCommit: (sha, cx) => {
        this.setTab("graph", cx);
        this.graph.reveal(sha, cx);
      },
      openCommitDiff: (sha, cx) => {
        this.changes.showCommit(sha, cx);
        this.setTab("changes", cx);
      },
      reportError: (message) => {
        this.error = message;
      },
      commands: () => this.commands
    };
    this.workspaces = new WorkspacesBox(this.services, cx);
    this.settings = new SettingsTab(cx, (cx) => this.commands.dispatch("update", cx), () => this.commands.update.status());
    const changes = new ChangesTab(this.services, this.workspaces, cx);
    this.changes = changes;
    this.graph = new GraphTab(this.services, cx, () => this.settings.graph, this.workspaces);
    const files = new FilesTab(this.services, this.workspaces, cx);
    this.tabs = { changes, graph: this.graph, files, settings: this.settings };
    this.commands = new Commands(this.services, { changes, graph: this.graph, files, workspaces: this.workspaces });
    this.shell = new Shell({
      active: () => this.tabs[this.tab],
      setTab: (tab, cx) => this.setTab(tab, cx),
      commands: () => this.commands,
      overlayOpen: () => this.overlay.isOpen()
    });
    changes.activate(cx);
    this.listenCommands(cx);
    this.commands.update.watch(cx);
    this.refresh("repository", cx);
    cx.timer.every(REFRESH_MS, (cx) => {
      if (this.settings.autoRefresh)
        this.refresh("changes", cx);
    });
  }
  close() {
    this.active = false;
    this.statusRequest++;
    this.watched = null;
    this.overlay.release();
    this.commands.release();
    for (const tab of Object.values(this.tabs))
      tab.release();
    this.workspaces.release();
    this.root.release();
  }
  listenCommands(cx) {
    cx.spawn(async (cx) => {
      while (this.active) {
        const command = await nextCommand();
        if (!this.active)
          return;
        this.command(command, cx);
        cx.notify();
      }
    });
  }
  command(command, cx) {
    const shortcut = NEXT_COMMANDS[command];
    if (command === "focus")
      this.tabs[this.tab].focus();
    else if (command === "close")
      this.placement.close();
    else if (command === "refresh")
      this.refresh("repository", cx);
    else if (shortcut && !this.overlay.isOpen())
      this.shell.dispatch(shortcut, cx);
  }
  setTab(tab, cx) {
    if (tab === this.tab)
      return;
    this.tabs[this.tab].deactivate(cx);
    this.tab = tab;
    const next = this.tabs[tab];
    next.activate(cx);
    next.focus();
  }
  broadcast(scope, cx) {
    for (const tab of Object.values(this.tabs))
      tab.refresh?.(scope, cx);
  }
  refresh(scope, cx) {
    if (scope === "workspaces")
      this.workspaces.refresh(cx);
    if (scope === "workspaces" || scope === "history") {
      this.broadcast(scope, cx);
      return;
    }
    const where = this.source.current();
    const context = JSON.stringify(where);
    if (context !== this.context) {
      this.context = context;
      this.on = where?.on ?? null;
      this.statusRequest++;
      this.repository = null;
      this.readGit = null;
      this.facts = EMPTY_FACTS;
      this.repositoryError = null;
      this.error = null;
      this.watched = null;
      this.loading = false;
      this.broadcast("repository", cx);
    }
    if (!where?.cwd || this.loading || !this.active || this.operation)
      return;
    this.loading = true;
    const request = ++this.statusRequest;
    const current = () => this.active && request === this.statusRequest && context === JSON.stringify(this.source.current());
    const cwd = where.cwd;
    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec6("git", args, { cwd, on: where.on });
        const repository = await readRepository(git);
        const facts = repository.state === "ready" ? await readFacts(git) : EMPTY_FACTS;
        if (!current())
          return;
        this.applyRepository(repository, facts, cx);
        this.broadcast(scope, cx);
        if (repository.state === "ready" && !this.on)
          this.watch(repository.root, context, cx);
      } catch (error) {
        if (current())
          this.repositoryError = errorMessage3(error);
      } finally {
        if (current()) {
          this.loading = false;
          cx.notify();
        }
      }
    });
  }
  applyRepository(repository, facts, cx) {
    const on = this.on;
    this.repository = repository;
    this.readGit = repository.state === "ready" ? shareSummaryReads((args) => exec6("git", args, { cwd: repository.root, on })) : null;
    this.facts = facts;
    this.repositoryError = null;
    this.loading = false;
    this.workspaces.refresh(cx, repository.state === "ready" ? repository : undefined);
  }
  watch(root, context, cx) {
    if (this.watched === root)
      return;
    this.watched = root;
    const watching = () => this.active && this.context === context && this.watched === root;
    cx.spawn(async (cx) => {
      try {
        while (watching()) {
          await watchFolder(root);
          if (watching() && this.settings.autoRefresh)
            this.refresh("changes", cx);
        }
      } catch {
        if (this.context === context && this.watched === root)
          this.watched = null;
      }
    });
  }
  mutate(context, label, action, cx) {
    const repository = this.repository;
    if (repository?.state !== "ready" || this.operation)
      return;
    if (context !== this.context || context !== JSON.stringify(this.source.current())) {
      this.error = "Repository changed; review the current repository before retrying";
      return;
    }
    const on = this.on;
    const current = () => this.active && context === JSON.stringify(this.source.current());
    this.operation = label;
    this.error = null;
    this.statusRequest++;
    this.loading = false;
    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec6("git", args, { cwd: repository.root, on });
        const latest = await readRepository(git);
        if (!current())
          return;
        if (latest.state !== "ready" || latest.root !== repository.root)
          throw new Error("Repository changed; refresh before retrying");
        await action(git, cx);
      } catch (error) {
        if (this.active)
          this.error = `${label} failed in ${repository.root}: ${errorMessage3(error)}. Inspect the repository before retrying.`;
      } finally {
        if (this.active) {
          this.operation = null;
          this.refresh("repository", cx);
          cx.notify();
        }
      }
    });
  }
  render(cx) {
    if (JSON.stringify(this.source.current()) !== this.context)
      this.refresh("repository", cx);
    this.workspaces.syncProjects(cx);
    const view = look();
    const tab = this.tabs[this.tab];
    const repository = this.repository;
    const path = repository?.state === "ready" ? repository.root : this.source.current()?.cwd ?? "";
    const root = v_flex24().id("git").relative().size_full().min_h(0).bg(view.t.background).text_color(view.t.text).font_family(view.font).text_size(view.size).line_height(`${view.row}px`).child(this.shell.header(view)).child(v_flex24().id("git-body").flex_1().min_h(0).min_w(0).p(6).overflow_hidden().on_size_change((size, cx) => {
      const cols = Math.floor(size.width / view.screenCell);
      const rows = Math.floor(size.height / view.screenRow);
      if (cols === this.body.cols && rows === this.body.rows)
        return;
      this.body = { ...size, cols, rows, wide: cols >= WIDE_COLUMNS };
      cx.notify();
    }).child(tab.render(view, this.body, cx))).child(this.shell.statusBar(view, {
      repository,
      facts: this.facts,
      path,
      status: tab.status?.() ?? {},
      graph: this.tab === "graph",
      progress: this.operation ?? this.workspaces.progress() ?? (this.loading ? "Refreshing repository" : null),
      error: this.error ?? this.repositoryError
    })).on_modifiers_changed((event, cx) => this.shell.modifiersChanged(event.modifiers.alt, cx)).on_key_down((event, cx) => this.shell.keyDown(event, cx)).track_focus(this.root);
    const dialog = this.overlay.render(view);
    return dialog ? root.child(dialog) : root;
  }
}

class Git extends View {
  session = null;
  placement = null;
  init(_props, cx) {
    const source = new RepositoryContext;
    this.placement = new GitPlacement(source, cx);
    if (this.placement.launcher)
      return;
    this.session = new Session(source, this.placement, cx);
  }
  async close() {
    this.session?.close();
    this.session = null;
  }
  render(cx) {
    return this.session?.render(cx) ?? div28();
  }
}
export {
  Git as default
};
