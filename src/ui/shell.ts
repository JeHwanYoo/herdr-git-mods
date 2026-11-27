import { Button, h_flex, v_flex } from "gpui-base";
import type { AsyncContext, Context, Element, KeyEvent, ScrollWheelEvent } from "gpui-kit";
import { div } from "gpui-kit";
import type { Repository, RunGit } from "../git/repository.ts";
import type { RepositoryContext, RepositoryLocation } from "../runtime/context.ts";
import { VERSION } from "../version.ts";
import { iconCell } from "./icons.ts";
import type { Overlay } from "./overlay.ts";
import { GLYPH, type Look } from "./theme.ts";
import { type ActionCell, actionBar, displayWidth, spinner, tabLabel, truncateToWidth } from "./widgets.ts";

export type TabId = "changes" | "graph" | "files" | "settings";

const TAB_ORDER: readonly TabId[] = ["changes", "graph", "files", "settings"];

export type QuickAction = "fetch" | "pull" | "commit" | "push" | "branch" | "stash";

export type GraphAction = "checkout" | "rebase" | "cherry-pick" | "revert" | "reset" | "copy-sha";

export type AppShortcut = TabId | "commands" | "workspace" | "files-search" | "actions" | QuickAction | GraphAction;

export type RefreshScope = "workspaces" | "history" | "changes" | "repository";

export interface BodySize {
  width: number;
  height: number;
  cols: number;
  rows: number;
  wide: boolean;
}

export interface TabStatus {
  selected?: string | null;
  blame?: string | null;
  progress?: string | null;
  error?: string | null;
}

export interface TabView {
  readonly id: TabId;
  activate(cx: AsyncContext): void;
  deactivate(cx: AsyncContext): void;
  render(look: Look, size: BodySize, cx: Context): Element;
  focus(): void;
  release(): void;
  escape?(cx: Context): boolean;
  shortcut?(shortcut: AppShortcut, cx: Context): boolean;
  toolbar?(look: Look, hints: boolean): ActionCell[];
  info?(look: Look): Element | null;
  status?(): TabStatus;
  refresh?(scope: RefreshScope, cx: AsyncContext): void;
}

export interface QuickActionState {
  enabled: boolean;
  running: string | null;
  primary?: boolean;
}

export interface CommandHandler {
  quickAction(action: QuickAction, cx: Context): void;
  quickActionState(action: QuickAction): QuickActionState;
  openPalette(cx: Context): void;
  shortcut(shortcut: AppShortcut, cx: Context): boolean;
  release(): void;
}

export interface RepositoryFacts {
  head: string | null;
  identity: { name: string; email: string } | null;
  github: boolean;
  remotes: string[];
  stash: boolean;
}

type Mutation = (
  context: string,
  label: string,
  action: (git: RunGit, cx: AsyncContext) => Promise<void>,
  cx: AsyncContext,
) => void;

export interface Services {
  readonly source: RepositoryContext;
  readonly overlay: Overlay;
  context(): string;
  location(): RepositoryLocation | null;
  repository(): Repository | null;
  repositoryError(): string | null;
  loading(): boolean;
  facts(): RepositoryFacts;
  git(): RunGit | null;
  historyGit(): RunGit | null;
  mutate: Mutation;
  busy(): string | null;
  refresh(scope: RefreshScope, cx: AsyncContext): void;
  activeTab(): TabId;
  setTab(tab: TabId, cx: AsyncContext): void;
  selectedCommit(): string | null;
  revealCommit(sha: string, cx: AsyncContext): void;
  openCommitDiff(sha: string, cx: AsyncContext): void;
  reportError(message: string | null): void;
  commands(): CommandHandler;
}

export interface ShellHost {
  active(): TabView;
  setTab(tab: TabId, cx: Context): void;
  commands(): CommandHandler;
  overlayOpen(): boolean;
}

export interface StatusLine {
  repository: Repository | null;
  facts: RepositoryFacts;
  path: string;
  status: TabStatus;
  graph: boolean;
  progress: string | null;
  error: string | null;
}

const TAB_LABELS: Record<TabId, { label: string; shortcut: string }> = {
  changes: { label: "Changes", shortcut: "1" },
  graph: { label: "Graph", shortcut: "2" },
  files: { label: "Files", shortcut: "3" },
  settings: { label: "Settings", shortcut: "," },
};

const QUICK_ACTIONS: readonly (Pick<ActionCell, "label" | "shortcut" | "icon" | "symbol"> & { id: QuickAction })[] = [
  { id: "fetch", label: "Fetch", shortcut: "f", icon: "fetch" },
  { id: "pull", label: "Pull", shortcut: "l", symbol: "↓" },
  { id: "commit", label: "Commit", shortcut: "c", symbol: "●" },
  { id: "push", label: "Push", shortcut: "u", symbol: "↑" },
  { id: "branch", label: "Branch", shortcut: "b", icon: "branch" },
  { id: "stash", label: "Stash", shortcut: "s", symbol: "≡" },
];

const SHORTCUT_CODES: Record<string, AppShortcut> = {
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
  "˙": "copy-sha",
};

const SHORT_SHA = 8;
const SELECTED_MIN_COLS = 80;

export function shortCommit(sha: string): string {
  return sha.slice(0, SHORT_SHA);
}

function appShortcut(event: KeyEvent, hints: boolean): AppShortcut | null {
  const { alt, control, platform } = event.modifiers;
  if (control || platform || (!alt && !hints)) return null;
  for (const candidate of [event.key, event.key_char ?? ""]) {
    const shortcut = SHORTCUT_CODES[candidate.toLowerCase()];
    if (shortcut) return shortcut;
  }
  return null;
}

function identityText(facts: RepositoryFacts): string {
  return facts.identity ? `${facts.identity.name}(${facts.identity.email})` : "Local unavailable";
}

export class Shell {
  hints = false;
  private statusScroll = 0;
  private statusCols = 0;

  constructor(private readonly host: ShellHost) {}

  modifiersChanged(alt: boolean, cx: Context): void {
    if (this.hints === alt) return;
    this.hints = alt;
    cx.notify();
  }

  keyDown(event: KeyEvent, cx: Context): void {
    if (this.host.overlayOpen()) return;
    const shortcut = appShortcut(event, this.hints);
    if (shortcut) {
      this.dispatch(shortcut, cx);
    } else if (event.keystroke === "tab") {
      const index = TAB_ORDER.indexOf(this.host.active().id);
      this.host.setTab(TAB_ORDER[(index + 1) % TAB_ORDER.length] ?? "changes", cx);
    } else if (event.keystroke !== "escape" || !this.host.active().escape?.(cx)) return;
    cx.stop_propagation();
    cx.notify();
  }

  dispatch(shortcut: AppShortcut, cx: Context): void {
    if (shortcut === "changes" || shortcut === "graph" || shortcut === "files" || shortcut === "settings")
      this.host.setTab(shortcut, cx);
    else if (shortcut === "commands") this.host.commands().openPalette(cx);
    else if (!this.host.active().shortcut?.(shortcut, cx)) this.host.commands().shortcut(shortcut, cx);
  }

  private tabsRow(look: Look): Element {
    const { t } = look;
    const active = this.host.active().id;
    const row = h_flex()
      .flex_none()
      .w_full()
      .px(8)
      .gap(2)
      .items_center()
      .bg(t.panel)
      .border_b(1)
      .border_color(t.rule)
      .whitespace_nowrap();
    const entries: { id: string; label: string; shortcut: string; active: boolean; onClick: (cx: Context) => void }[] =
      [
        ...TAB_ORDER.slice(0, 3).map((tab) => ({
          id: `git-tab-${tab}`,
          ...TAB_LABELS[tab],
          active: active === tab,
          onClick: (cx: Context) => this.host.setTab(tab, cx),
        })),
        {
          id: "git-tab-commands",
          label: "Commands",
          shortcut: "P",
          active: false,
          onClick: (cx: Context) => this.host.commands().openPalette(cx),
        },
        {
          id: "git-tab-settings",
          ...TAB_LABELS.settings,
          active: active === "settings",
          onClick: (cx: Context) => this.host.setTab("settings", cx),
        },
      ];
    for (const entry of entries) row.child(tabLabel(look, entry, this.hints));
    return row.child(div().flex_1()).child(
      Button.new("git-version")
        .accessibility_label(`Herdr Git Mods ${VERSION}`)
        .flex_none()
        .h(look.row + 2)
        .px(8)
        .items_center()
        .bg(t.hover)
        .border(1)
        .border_color(t.rule)
        .rounded(2)
        .text_size(Math.max(10, look.size - 2))
        .text_color(t.hint)
        .hover((style) => style.bg(t.accentSoft).border_color(t.accent).text_color(t.accentText))
        .child(`v${VERSION}`)
        .on_click((_, cx) => {
          cx.stop_propagation();
          this.host.setTab("settings", cx);
          cx.notify();
        }),
    );
  }

  private quickActions(look: Look): Element {
    const commands = this.host.commands();
    return actionBar(
      look,
      QUICK_ACTIONS.map((action) => {
        const state = commands.quickActionState(action.id);
        return {
          ...action,
          id: `git-quick-${action.id}`,
          variant: state.primary ? "primary" : "secondary",
          enabled: state.enabled,
          running: state.running,
          onClick: (cx: Context) => commands.quickAction(action.id, cx),
        };
      }),
      this.hints,
    );
  }

  header(look: Look): Element {
    const tab = this.host.active();
    const controls = v_flex().flex_none().w_full().px(6).pt(6).gap(6).child(this.quickActions(look));
    if (tab.toolbar) controls.child(actionBar(look, tab.toolbar(look, this.hints), this.hints));
    if (tab.info) {
      const info = tab.info(look);
      if (info)
        controls.child(
          h_flex()
            .flex_none()
            .h(look.row + 2)
            .px(8)
            .items_center()
            .bg(look.t.panel)
            .border(1)
            .border_color(look.t.rule)
            .overflow_hidden()
            .whitespace_nowrap()
            .child(info),
        );
    }
    return v_flex().flex_none().w_full().child(this.tabsRow(look)).child(controls);
  }

  private branchLine(look: Look, line: StatusLine): Element[] {
    const { t } = look;
    const repository = line.repository;
    if (repository?.state !== "ready") return [div().text_color(t.hint).child("No repository")];
    const head = line.facts.head;
    const selected =
      line.graph && this.statusCols >= SELECTED_MIN_COLS && line.status.selected && line.status.selected !== head
        ? ` · Selected: ${shortCommit(line.status.selected)}`
        : "";
    const branch = repository.branch.name;
    if (branch) {
      const suffix = `${head ? ` · HEAD ${shortCommit(head)}` : " · Uncommitted"}${selected}`;
      const budget = Math.max(0, Math.max(40, this.statusCols) - 2 - (8 + displayWidth(suffix)));
      return [
        div().text_color(t.hint).child("Branch: "),
        div().text_color(t.accentText).font_weight(600).child(truncateToWidth(branch, budget)),
        div().text_color(t.hint).child(suffix),
      ];
    }
    if (head)
      return [
        div()
          .text_color(t.warning)
          .child(`Detached HEAD: ${shortCommit(head)}`),
        div().text_color(t.hint).child(selected),
      ];
    return [div().text_color(t.hint).child("Uncommitted")];
  }

  private scrollStatus(event: ScrollWheelEvent, look: Look, cx: Context): void {
    const horizontal = Math.abs(event.delta.x) > Math.abs(event.delta.y) ? event.delta.x : event.delta.y;
    if (!event.modifiers.shift && Math.abs(event.delta.x) <= Math.abs(event.delta.y)) return;
    const next = Math.max(
      0,
      this.statusScroll - Math.sign(horizontal) * Math.max(1, Math.round(Math.abs(horizontal) / look.cell)),
    );
    if (next === this.statusScroll) return;
    this.statusScroll = next;
    cx.stop_propagation();
    cx.notify();
  }

  statusBar(look: Look, line: StatusLine): Element {
    const { t } = look;
    const separator = () => div().flex_none().text_color(t.rule).child(` ${GLYPH.rule} `);
    const content = h_flex()
      .flex_none()
      .h(look.row)
      .items_center()
      .whitespace_nowrap()
      .ml(-this.statusScroll * look.cell)
      .children(this.branchLine(look, line))
      .child(separator())
      .child(div().text_color(t.secondary).child(line.path))
      .child(separator())
      .when(line.status.blame == null, (el) =>
        el.child(iconCell(look, line.facts.github ? "github" : "local", t.hint)).child(" "),
      )
      .child(
        div()
          .text_color(t.secondary)
          .child(line.status.blame ?? identityText(line.facts)),
      );
    const progress = line.progress ?? line.status.progress;
    if (progress)
      content
        .child(separator())
        .child(spinner(look))
        .child(div().text_color(t.accentText).child(` ${progress}`));
    const error = line.status.error ?? line.error;
    if (error) content.child(separator()).child(div().text_color(t.error).child(`Error: ${error}`));
    return h_flex()
      .id("git-status-bar")
      .flex_none()
      .w_full()
      .h(look.row + 8)
      .px(8)
      .items_center()
      .overflow_hidden()
      .bg(t.panel)
      .border_t(1)
      .border_color(t.rule)
      .text_color(t.text)
      .on_size_change((size, cx) => {
        const columns = Math.floor(size.width / look.screenCell);
        if (columns === this.statusCols) return;
        this.statusCols = columns;
        cx.notify();
      })
      .on_scroll_wheel((event, cx) => this.scrollStatus(event, look, cx))
      .child(content);
  }
}
