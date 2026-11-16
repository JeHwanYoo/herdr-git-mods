import { focused, panes, spaces } from "herdr";
import { type RepositoryLocation, RepositorySelection } from "./repository-selection.ts";

export type { RepositoryLocation } from "./repository-selection.ts";

export class RepositoryContext {
  private selection = new RepositorySelection();

  bind(tab: string | null, source: string | null, location: RepositoryLocation): void {
    this.selection = new RepositorySelection(tab, source, location);
  }

  select(location: RepositoryLocation | null): void {
    this.selection.select(location);
  }

  current(): RepositoryLocation | null {
    return this.selection.read(...this.focus());
  }

  followed(): RepositoryLocation | null {
    return this.selection.follow(...this.focus());
  }

  private focus(): Parameters<RepositorySelection["read"]> {
    const now = focused();
    const space = spaces().find((entry) => entry.active);
    const live = panes();
    const pane = now?.pane ? live.find((entry) => entry.pane === now.pane) : null;
    const remote = now?.pane === null && now.terminal?.includes("/") ? (now.terminal.split("/")[0] ?? null) : null;
    return [
      {
        tab: now?.tab ?? null,
        pane: now?.pane ?? null,
        terminal: now?.terminal ?? null,
        cwd: pane?.cwd || now?.cwd || space?.folder || null,
        on: now?.pane === null ? remote : (space?.machine ?? null),
      },
      live,
    ];
  }
}
