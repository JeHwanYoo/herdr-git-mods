import type { AsyncContext } from "gpui-kit";
import { appHome, closeOverlay, exec, focused, notify, panes, props, run, spaces } from "herdr";
import type { RepositoryContext, RepositoryLocation } from "./context.ts";
import { readGitPaneTarget } from "./pane-target.ts";

function textProperty(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null || !(key in input)) return null;
  const value: unknown = Reflect.get(input, key);
  return typeof value === "string" ? value : null;
}

export class GitPlacement {
  readonly launcher: boolean;
  private readonly tab: string | null;

  constructor(source: RepositoryContext, cx: AsyncContext) {
    const input: unknown = props();
    const overlay = textProperty(input, "overlay");
    this.tab = textProperty(input, "tab");
    this.launcher = overlay !== null;
    if (overlay) launchGitPane(overlay, source, cx);
    else
      source.bind(this.tab, textProperty(input, "sourcePane"), {
        cwd: textProperty(input, "cwd"),
        on: textProperty(input, "on"),
      });
  }

  close(): void {
    const pane = panes().find((pane) => pane.tab === this.tab && pane.mod === "git");
    if (pane) run("pane.close", { pane: pane.pane });
  }
}

async function openPane(
  target: string,
  tab: string,
  sourcePane: string | null,
  location: RepositoryLocation,
  cx: AsyncContext,
): Promise<void> {
  const before = new Set(
    panes()
      .filter((pane) => pane.tab === tab)
      .map((pane) => pane.pane),
  );
  run("pane.split", { pane: target, direction: "right", mod: "git", props: { tab, ...location, sourcePane } });
  for (let step = 0; step < 20; step++) {
    const made = panes().find((pane) => pane.tab === tab && pane.mod === "git" && !before.has(pane.pane));
    if (made) {
      if (focused()?.tab === tab) run("pane.focus", { pane: made.pane });
      return;
    }
    await cx.sleep(25);
  }
  throw new Error("The Git pane did not open");
}

function launchGitPane(overlay: string, repository: RepositoryContext, cx: AsyncContext): void {
  const start = focused();
  const space = spaces().find((space) => space.id === start?.space);
  const on = space?.machine ?? null;
  const source = panes().find((pane) => pane.tab === start?.tab && pane.terminal);
  const location = repository.current() ?? { cwd: source?.cwd || space?.folder || null, on };
  cx.spawn(async (cx) => {
    try {
      if (!start?.tab) throw new Error("Open a terminal tab first");
      const target = await readGitPaneTarget(exec, start.tab, on, /^[A-Za-z]:|\\/.test(appHome()));
      if (focused()?.tab !== start.tab) throw new Error("Tab changed; open Git again");
      if (target.close) {
        run("pane.close", { pane: target.pane });
        return;
      }
      await openPane(target.pane, start.tab, start.terminal ? start.pane : (source?.pane ?? null), location, cx);
    } catch (error) {
      notify({ title: "Git", body: error instanceof Error ? error.message : String(error), level: "error" });
    } finally {
      closeOverlay(overlay);
    }
  });
}
