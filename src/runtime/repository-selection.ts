export interface RepositoryLocation {
  cwd: string | null;
  on: string | null;
}

interface RepositoryFocus extends RepositoryLocation {
  tab: string | null;
  pane: string | null;
  terminal: string | null;
}

interface RepositoryPane {
  pane: string;
  tab: string;
  terminal: string | null;
  cwd: string | null;
}

export class RepositorySelection {
  private selected: RepositoryLocation | null = null;

  constructor(
    private readonly tab: string | null = null,
    private source: string | null = null,
    private followed: RepositoryLocation | null = null,
  ) {}

  select(location: RepositoryLocation | null): void {
    this.selected = location ? { ...location } : null;
  }

  read(focus: RepositoryFocus, panes: readonly RepositoryPane[]): RepositoryLocation | null {
    const followed = this.follow(focus, panes);
    return this.selected ? { ...this.selected } : followed;
  }

  follow(focus: RepositoryFocus, panes: readonly RepositoryPane[]): RepositoryLocation | null {
    if (this.tab && focus.tab !== this.tab) return this.followed ? { ...this.followed } : null;
    if (focus.terminal) {
      this.source = focus.pane;
      this.followed = { cwd: focus.cwd, on: focus.on };
    } else {
      const source = panes.find((pane) => pane.pane === this.source && pane.tab === focus.tab && pane.terminal);
      if (source?.cwd) this.followed = { cwd: source.cwd, on: focus.on };
    }
    return this.followed ? { ...this.followed } : null;
  }
}
