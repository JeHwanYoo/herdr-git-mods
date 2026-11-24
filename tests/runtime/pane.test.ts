import { expect, test } from "bun:test";
import { readGitPaneTarget } from "../../src/runtime/pane-target.ts";
import { RepositorySelection } from "../../src/runtime/repository-selection.ts";

function reply(root: unknown, tab = "tb-work"): string {
  return [
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { generation: 1 } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { version: 14, value: { spaces: [{ id: "sp-work", tabs: [{ id: tab, root }] }] } },
    }),
  ].join("\n");
}

function terminal(id: string) {
  return { id, type: "block", content: { terminal: `terminal-${id}` } };
}

const nested = {
  id: "split-root",
  type: "column",
  children: [{ id: "split-top", type: "row", children: [terminal("left"), terminal("right")] }, terminal("bottom")],
};

test("opening Git targets the tab root, not a focused or rightmost terminal in a nested layout", async () => {
  const result = await readGitPaneTarget(async () => ({ code: 0, stdout: reply(nested), stderr: "" }), "tb-work", null);
  expect(result).toEqual({ pane: "split-root", close: false });
});

test("a single-pane tab uses its current root id, not its tab id", async () => {
  const result = await readGitPaneTarget(
    async () => ({ code: 0, stdout: reply(terminal("only")), stderr: "" }),
    "tb-work",
    null,
  );
  expect(result).toEqual({ pane: "only", close: false });
});

test("toggling finds an existing Git pane even after it was moved into a nested split", async () => {
  const root = {
    ...nested,
    id: "outer-root",
    children: [
      nested,
      {
        id: "nested-mods",
        type: "row",
        children: [terminal("other"), { id: "git-pane", type: "block", content: { mod: "git" } }],
      },
    ],
  };
  const result = await readGitPaneTarget(async () => ({ code: 0, stdout: reply(root), stderr: "" }), "tb-work", null);
  expect(result).toEqual({ pane: "git-pane", close: true });
});

test("remote tab roots and existing Git panes retain the machine namespace", async () => {
  for (const id of ["remote-root", "build/remote-root"]) {
    const result = await readGitPaneTarget(
      async (_command, args) => {
        const request: unknown = JSON.parse(args.at(-1) ?? "");
        expect(request).toMatchObject({ method: "doc.get", params: { name: "herdr-app", on: "build" } });
        return { code: 0, stdout: reply({ ...nested, id }), stderr: "" };
      },
      "build/tb-work",
      "build",
    );
    expect(result).toEqual({ pane: "build/remote-root", close: false });
  }
  const result = await readGitPaneTarget(
    async () => ({
      code: 0,
      stdout: reply({ id: "remote-git", type: "block", content: { mod: "git" } }),
      stderr: "",
    }),
    "build/tb-work",
    "build",
  );
  expect(result).toEqual({ pane: "build/remote-git", close: true });
});

test("unavailable, missing and unsupported tab layouts fail instead of splitting an arbitrary pane", async () => {
  const outputs = [
    "",
    "invalid json",
    JSON.stringify({ id: 2, error: { message: "machine unavailable" } }),
    JSON.stringify({ id: 2, result: { version: 0, value: null } }),
    reply(nested, "another-tab"),
    reply({ ...nested, type: "unknown" }),
    reply({ ...nested, id: null }),
  ];
  for (const stdout of outputs)
    await expect(readGitPaneTarget(async () => ({ code: 0, stdout, stderr: "" }), "tb-work", null)).rejects.toThrow();
  await expect(
    readGitPaneTarget(async () => ({ code: 1, stdout: "", stderr: "hc: connection failed" }), "tb-work", null),
  ).rejects.toThrow("hc: connection failed");
});

const source = { pane: "shell", tab: "work", terminal: "t1", cwd: "/repo" };
const gitFocus = { tab: "work", pane: "git", terminal: null, cwd: null, on: null };

test("focusing Git retains the source repository and follows its live folder", () => {
  const selection = new RepositorySelection("work", "shell", { cwd: "/repo", on: null });
  expect(selection.read(gitFocus, [source])).toEqual({ cwd: "/repo", on: null });
  expect(selection.read(gitFocus, [{ ...source, cwd: "/another-repo" }])).toEqual({ cwd: "/another-repo", on: null });
  expect(selection.read(gitFocus, [])).toEqual({ cwd: "/another-repo", on: null });
});

test("following another terminal is preserved when keyboard focus returns to Git", () => {
  const selection = new RepositorySelection("work", "shell", { cwd: "/repo", on: null });
  const other = { pane: "other", tab: "work", terminal: "t2", cwd: "/other" };
  expect(selection.read({ ...gitFocus, ...other }, [source, other])).toEqual({ cwd: "/other", on: null });
  expect(selection.read(gitFocus, [source, other])).toEqual({ cwd: "/other", on: null });
});

test("tab switches retain the pane's repository instead of following another tab", () => {
  const selection = new RepositorySelection("work", "shell", { cwd: "/repo", on: "build" });
  expect(selection.read({ ...gitFocus, tab: "another-tab", cwd: "/elsewhere", terminal: "t3" }, [])).toEqual({
    cwd: "/repo",
    on: "build",
  });
  expect(selection.read({ ...gitFocus, on: "build" }, [source])).toEqual({ cwd: "/repo", on: "build" });
});

test("explicit repository selection stays pinned until Follow terminal restores the live source", () => {
  const selection = new RepositorySelection("work", "shell", { cwd: "/repo", on: null });
  selection.select({ cwd: "/worktree", on: "build" });
  expect(selection.read(gitFocus, [source])).toEqual({ cwd: "/worktree", on: "build" });
  selection.select(null);
  expect(selection.read(gitFocus, [source])).toEqual({ cwd: "/repo", on: null });
});
