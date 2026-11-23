import { h_flex, v_flex } from "gpui-base";
import { type AsyncContext, type Context, div, type Element, type FocusHandle, type KeyEvent } from "gpui-kit";
import { run } from "herdr";
import { type TabView, VERSION } from "./shell.ts";
import type { Look } from "./theme.ts";
import { box, padToWidth } from "./widgets.ts";

const LABEL_WIDTH = 24;

interface SettingRow {
  id: string;
  label: string;
  control: string;
  on: boolean;
  status: string;
  description: string;
  activate: () => void;
}

export class SettingsTab implements TabView {
  readonly id = "settings";
  graph: boolean;
  autoRefresh: boolean;
  private selected = 0;
  private handle: FocusHandle;

  constructor(cx: AsyncContext) {
    this.handle = cx.focus_handle();
    this.graph = localStorage.getItem("git-graph") !== "off";
    this.autoRefresh = localStorage.getItem("git-auto-refresh") !== "off";
  }

  activate(): void {
    this.handle.focus();
  }

  deactivate(): void {}

  focus(): void {
    this.handle.focus();
  }

  release(): void {
    this.handle.release();
  }

  private rows(): SettingRow[] {
    return [
      {
        id: "graph",
        label: "Native graph",
        control: this.graph ? " On  " : " Off ",
        on: this.graph,
        status: this.graph ? "Native curves in Graph" : "Box-drawing characters in use",
        description:
          "Antialiased graph curves and commit rules drawn natively; off draws lanes with box-drawing characters",
        activate: () => {
          this.graph = !this.graph;
          localStorage.setItem("git-graph", this.graph ? "on" : "off");
        },
      },
      {
        id: "refresh",
        label: "Background refresh",
        control: this.autoRefresh ? " On  " : " Off ",
        on: this.autoRefresh,
        status: this.autoRefresh ? "Watching the repository" : "Refresh from Commands",
        description: "Reloads status when files change and every 10 seconds",
        activate: () => {
          this.autoRefresh = !this.autoRefresh;
          localStorage.setItem("git-auto-refresh", this.autoRefresh ? "on" : "off");
        },
      },
      {
        id: "versions",
        label: "Versions",
        control: " Herdr updates ",
        on: false,
        status: `Current version v${VERSION}`,
        description: "Opens Herdr's update settings",
        activate: () => run("app.settings", { section: "updates" }),
      },
    ];
  }

  private key(event: KeyEvent, cx: Context): void {
    const rows = this.rows();
    const last = rows.length - 1;
    const moves: Record<string, number> = { up: -1, k: -1, down: 1, j: 1, home: -last, end: last };
    const move = moves[event.keystroke];
    if (move !== undefined) this.selected = Math.max(0, Math.min(last, this.selected + move));
    else if (event.keystroke === "enter" || event.keystroke === "space") rows[this.selected]?.activate();
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render(look: Look): Element {
    const { t } = look;
    const body = v_flex().pt(look.row).gap(look.row);
    for (const [index, row] of this.rows().entries())
      body.child(
        v_flex()
          .id(`git-setting-${row.id}`)
          .when(index === this.selected, (el) => el.bg(t.selection))
          .hover((style) => style.bg(index === this.selected ? t.selection : t.hover))
          .on_click((_, cx) => {
            this.selected = index;
            row.activate();
            this.handle.focus();
            cx.notify();
          })
          .child(
            h_flex()
              .h(look.row)
              .whitespace_nowrap()
              .child(
                div()
                  .font_weight(700)
                  .child(padToWidth(`  ${row.label}`, LABEL_WIDTH)),
              )
              .child(
                div()
                  .when(row.on, (el) => el.bg(t.accent).text_color(t.textInverse).font_weight(700))
                  .when(!row.on, (el) => el.bg(t.inert).text_color(t.hint))
                  .child(row.control),
              )
              .child(div().text_color(t.hint).child(`  ${row.status}`)),
          )
          .child(
            div()
              .h(look.row)
              .truncate()
              .text_color(t.secondary)
              .child(`${" ".repeat(LABEL_WIDTH)}${row.description}`),
          ),
      );
    return box(look, { id: "git-settings", title: "Settings", focused: this.handle.is_focused() }, body)
      .size_full()
      .track_focus(this.handle)
      .on_key_down((event, cx) => this.key(event, cx));
  }
}
