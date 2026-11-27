import { h_flex, v_flex } from "gpui-base";
import { type AsyncContext, type Context, div, type Element, type FocusHandle, type KeyEvent } from "gpui-kit";
import { VERSION } from "../version.ts";
import type { TabView } from "./shell.ts";
import { type Look, setThemeMode, type ThemeMode, themeMode } from "./theme.ts";
import { box, padToWidth } from "./widgets.ts";

const LABEL_WIDTH = 24;
const THEME_OPTIONS: readonly { mode: ThemeMode; label: string; description: string }[] = [
  { mode: "auto", label: "Auto", description: "Follows Herdr dark or light theme" },
  { mode: "void", label: "Void", description: "Deepfield dark cockpit palette" },
  { mode: "frost", label: "Frost", description: "Deepfield daylight palette" },
];

interface SettingRow {
  id: string;
  label: string;
  kind: "switch" | "select" | "action";
  control: string;
  on: boolean;
  status: string;
  description: string;
  activate: (cx: Context) => void;
}

function themeOption(mode: ThemeMode) {
  return THEME_OPTIONS.find((option) => option.mode === mode) ?? THEME_OPTIONS[0];
}

function switchControl(look: Look, on: boolean): Element {
  const { t } = look;
  return h_flex()
    .flex_none()
    .items_center()
    .gap(8)
    .child(
      div()
        .relative()
        .flex_none()
        .w(36)
        .h(18)
        .rounded_full()
        .bg(on ? t.accent : t.background)
        .border(1)
        .border_color(on ? t.accent : t.lineStrong)
        .child(
          div()
            .absolute()
            .top(2)
            .left(on ? 20 : 2)
            .w(12)
            .h(12)
            .rounded_full()
            .bg(on ? t.textInverse : t.secondary),
        ),
    )
    .child(
      div()
        .flex_none()
        .w(28)
        .text_size(Math.max(10, look.size - 2))
        .font_weight(600)
        .text_color(on ? t.accentText : t.hint)
        .child(on ? "ON" : "OFF"),
    );
}

function selectControl(look: Look, text: string, open: boolean): Element {
  const { t } = look;
  return h_flex()
    .flex_none()
    .h(look.row + 4)
    .px(8)
    .gap(8)
    .items_center()
    .bg(open ? t.accentSoft : t.background)
    .border(1)
    .border_color(open ? t.accent : t.lineStrong)
    .rounded(2)
    .text_size(Math.max(10, look.size - 2))
    .font_weight(600)
    .text_color(t.text)
    .child(text.toUpperCase())
    .child(
      div()
        .text_color(open ? t.accentText : t.hint)
        .child(open ? "▴" : "▾"),
    );
}

function actionControl(look: Look, text: string): Element {
  const { t } = look;
  return h_flex()
    .flex_none()
    .h(look.row + 4)
    .px(8)
    .items_center()
    .bg(t.background)
    .border(1)
    .border_color(t.lineStrong)
    .rounded(2)
    .text_size(Math.max(10, look.size - 2))
    .font_weight(600)
    .text_color(t.accentText)
    .child(text);
}

export class SettingsTab implements TabView {
  readonly id = "settings";
  graph: boolean;
  autoRefresh: boolean;
  private selected = 0;
  private themeOpen = false;
  private themeCursor = 0;
  private handle: FocusHandle;

  constructor(
    cx: AsyncContext,
    private readonly checkUpdates: (cx: Context) => void,
    private readonly updateStatus: () => string | null,
  ) {
    this.handle = cx.focus_handle();
    this.graph = localStorage.getItem("git-graph") !== "off";
    this.autoRefresh = localStorage.getItem("git-auto-refresh") !== "off";
  }

  activate(): void {
    this.handle.focus();
  }

  deactivate(): void {
    this.themeOpen = false;
  }

  focus(): void {
    this.handle.focus();
  }

  escape(): boolean {
    if (!this.themeOpen) return false;
    this.themeOpen = false;
    return true;
  }

  release(): void {
    this.handle.release();
  }

  private toggleThemeMenu(): void {
    this.themeOpen = !this.themeOpen;
    if (this.themeOpen) {
      const index = THEME_OPTIONS.findIndex((option) => option.mode === themeMode());
      this.themeCursor = Math.max(0, index);
    }
  }

  private chooseTheme(mode: ThemeMode): void {
    setThemeMode(mode);
    this.themeOpen = false;
  }

  private rows(): SettingRow[] {
    const current = themeOption(themeMode());
    return [
      {
        id: "graph",
        label: "Native graph",
        kind: "switch",
        control: this.graph ? "ON" : "OFF",
        on: this.graph,
        status: this.graph ? "Native curves in Graph" : "Box-drawing characters in use",
        description:
          "Antialiased graph curves and commit rules drawn natively; off draws lanes with box-drawing characters",
        activate: () => {
          this.themeOpen = false;
          this.graph = !this.graph;
          localStorage.setItem("git-graph", this.graph ? "on" : "off");
        },
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
        },
      },
      {
        id: "theme",
        label: "Theme",
        kind: "select",
        control: current?.label ?? "Auto",
        on: this.themeOpen,
        status: current?.description ?? "",
        description: "Select Auto (follows Herdr), Void (dark), or Frost (light)",
        activate: () => this.toggleThemeMenu(),
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
        },
      },
    ];
  }

  private themeKey(keystroke: string): boolean {
    const last = THEME_OPTIONS.length - 1;
    const moves: Record<string, number> = { up: -1, k: -1, down: 1, j: 1, home: -last, end: last };
    const move = moves[keystroke];
    if (move !== undefined) this.themeCursor = Math.max(0, Math.min(last, this.themeCursor + move));
    else if (keystroke === "enter" || keystroke === "space") {
      const option = THEME_OPTIONS[this.themeCursor];
      if (option) this.chooseTheme(option.mode);
    } else if (keystroke === "escape") this.themeOpen = false;
    else return false;
    return true;
  }

  private key(event: KeyEvent, cx: Context): void {
    if (this.themeOpen) {
      if (!this.themeKey(event.keystroke)) return;
      cx.stop_propagation();
      cx.notify();
      return;
    }
    const rows = this.rows();
    const last = rows.length - 1;
    const moves: Record<string, number> = { up: -1, k: -1, down: 1, j: 1, home: -last, end: last };
    const move = moves[event.keystroke];
    if (move !== undefined) this.selected = Math.max(0, Math.min(last, this.selected + move));
    else if (event.keystroke === "enter" || event.keystroke === "space") rows[this.selected]?.activate(cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  private themeDropdown(look: Look): Element {
    const { t } = look;
    const current = themeMode();
    const menu = v_flex()
      .id("git-theme-dropdown")
      .mt(4)
      .bg(t.panel)
      .border(1)
      .border_color(t.lineStrong)
      .rounded(2)
      .shadow_md()
      .overflow_hidden();
    for (const [index, option] of THEME_OPTIONS.entries()) {
      const focused = index === this.themeCursor;
      const chosen = option.mode === current;
      menu.child(
        h_flex()
          .id(`git-theme-option-${option.mode}`)
          .h(look.row + 8)
          .px(10)
          .gap(10)
          .items_center()
          .cursor_pointer()
          .border_l(2)
          .border_color(focused ? t.accent : "#00000000")
          .when(index > 0, (el) => el.border_t(1).border_color(t.rule))
          .when(focused, (el) => el.bg(t.accentSoft))
          .when(!focused, (el) => el.hover((style) => style.bg(t.hover)))
          .child(
            div()
              .flex_none()
              .w(14)
              .text_color(t.accentText)
              .font_weight(700)
              .child(chosen ? "✓" : ""),
          )
          .child(
            div()
              .flex_none()
              .w(64)
              .text_size(Math.max(10, look.size - 1))
              .font_weight(chosen || focused ? 600 : 400)
              .text_color(chosen || focused ? t.accentText : t.text)
              .child(option.label.toUpperCase()),
          )
          .child(div().flex_1().truncate().text_color(t.secondary).child(option.description))
          .on_click((_, cx) => {
            cx.stop_propagation();
            this.themeCursor = index;
            this.handle.focus();
            this.chooseTheme(option.mode);
            cx.notify();
          }),
      );
    }
    return menu;
  }

  private rowControl(look: Look, row: SettingRow): Element {
    if (row.kind === "switch") return switchControl(look, row.on);
    if (row.kind === "select") return selectControl(look, row.control, row.on);
    return actionControl(look, row.control);
  }

  render(look: Look): Element {
    const { t } = look;
    const body = v_flex().p(8).gap(8);
    for (const [index, row] of this.rows().entries()) {
      const active = index === this.selected;
      const card = v_flex()
        .id(`git-setting-${row.id}`)
        .p(8)
        .gap(4)
        .border(1)
        .border_l(2)
        .border_color(active ? t.accent : t.rule)
        .when(active, (el) => el.bg(t.accentSoft))
        .when(!active, (el) => el.bg(t.background).hover((style) => style.bg(t.hover)))
        .on_click((_, cx) => {
          this.selected = index;
          this.handle.focus();
          row.activate(cx);
          cx.notify();
        })
        .child(
          h_flex()
            .h(look.row + 4)
            .items_center()
            .gap(8)
            .whitespace_nowrap()
            .child(div().font_weight(600).text_color(t.text).child(padToWidth(row.label, LABEL_WIDTH)))
            .child(this.rowControl(look, row))
            .child(div().text_color(t.secondary).child(row.status)),
        )
        .child(
          div()
            .h(look.row)
            .truncate()
            .text_color(t.hint)
            .child(`${" ".repeat(LABEL_WIDTH)}${row.description}`),
        );
      if (row.kind === "select" && this.themeOpen) card.child(this.themeDropdown(look));
      body.child(card);
    }
    return box(look, { id: "git-settings", title: "Settings", focused: this.handle.is_focused() }, body)
      .size_full()
      .track_focus(this.handle)
      .on_key_down((event, cx) => this.key(event, cx));
  }
}
