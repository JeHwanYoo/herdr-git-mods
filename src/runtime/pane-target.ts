type RunCommand = (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

interface PaneTarget {
  pane: string;
  close: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function documentValue(reply: Record<string, unknown>): Record<string, unknown> {
  if (reply.error) {
    const message = record(reply.error) ? reply.error.message : null;
    throw new Error(typeof message === "string" ? message : "Could not read the tab layout");
  }
  const result = reply.result;
  if (record(result) && typeof result.version === "number" && result.version > 0 && record(result.value))
    return result.value;
  throw new Error("The tab layout is unavailable");
}

function documentReply(output: string): Record<string, unknown> {
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const reply: unknown = JSON.parse(line);
    if (!record(reply) || reply.id !== 2) continue;
    return documentValue(reply);
  }
  throw new Error("Herdr core did not return the tab layout");
}

function tabRoot(document: Record<string, unknown>, tab: string): Record<string, unknown> {
  if (Array.isArray(document.spaces))
    for (const space of document.spaces) {
      if (!record(space) || !Array.isArray(space.tabs)) continue;
      const entry: unknown = space.tabs.find((entry: unknown) => record(entry) && entry.id === tab);
      if (record(entry) && record(entry.root)) return entry.root;
    }
  throw new Error("The tab is no longer available");
}

function gitPane(node: Record<string, unknown>): string | null {
  if (typeof node.id !== "string" || !node.id) throw new Error("The tab layout has an invalid node");
  if (node.type === "block") return record(node.content) && node.content.mod === "git" ? node.id : null;
  if ((node.type !== "row" && node.type !== "column") || !Array.isArray(node.children))
    throw new Error("The tab layout has an unsupported split");
  let found: string | null = null;
  for (const child of node.children) {
    if (!record(child)) throw new Error("The tab layout has an invalid split");
    found ??= gitPane(child);
  }
  return found;
}

export async function readGitPaneTarget(
  execute: RunCommand,
  tab: string,
  on: string | null,
  windows = false,
): Promise<PaneTarget> {
  const hello = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { generation: 1 } });
  const request = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "doc.get", params: { name: "herdr-app", on } });
  const result = windows
    ? await execute("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `@('${hello.replaceAll("'", "''")}','${request.replaceAll("'", "''")}') | & hc connect`,
      ])
    : await execute("sh", ["-c", 'printf "%s\\n" "$1" "$2" | hc connect', "herdr-git", hello, request]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not read the tab layout");
  const rawTab = on && tab.startsWith(`${on}/`) ? tab.slice(on.length + 1) : tab;
  const root = tabRoot(documentReply(result.stdout), rawTab);
  const existing = gitPane(root);
  const pane = existing ?? root.id;
  if (typeof pane !== "string" || !pane) throw new Error("The tab layout has no root");
  return { pane: on && !pane.startsWith(`${on}/`) ? `${on}/${pane}` : pane, close: existing !== null };
}
