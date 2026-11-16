import { h_flex, v_flex } from "gpui-base";
import { type AsyncContext, type Context, div, type Element, type KeyEvent, type ScrollWheelEvent } from "gpui-kit";
import { fileLanguage, type LineHistoryCommit, readLineHistory } from "../../git/files.ts";
import { relativeTime } from "../../git/history.ts";
import { type CodeLine, CodeView, highlight } from "../code-view.ts";
import type { Services } from "../shell.ts";
import { cols, type Look } from "../theme.ts";
import { box, footerHint, padToWidth, spinner, truncateToWidth, viewportOffset } from "../widgets.ts";

export interface LineHistoryTarget {
  file: string;
  ranges: [number, number][];
  revision: string | null;
}

export interface DialogSize {
  cols: number;
  rows: number;
}

const SPLIT_COLUMNS = 72;
const FOOTER = "j/k commit · PgUp/PgDn scroll · Enter open in Graph · Esc close";

interface SplitRows {
  before: CodeLine[];
  after: CodeLine[];
}

const BLANK: CodeLine = { number: null, text: "", tokens: [], tone: "plain" };

function splitPatch(patch: string, path: string): SplitRows {
  const at = patch.indexOf("\n@@");
  const hunks = patch.startsWith("@@") ? patch : at < 0 ? "" : patch.slice(at + 1);
  const rows: SplitRows = { before: [], after: [] };
  let removed: CodeLine[] = [];
  let added: CodeLine[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      rows.before.push(removed[index] ?? BLANK);
      rows.after.push(added[index] ?? BLANK);
    }
    removed = [];
    added = [];
  };
  let oldLine = 0;
  let newLine = 0;
  for (const line of hunks.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flush();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    const text = line.slice(1);
    const tokens = highlight(text, path);
    if (line.startsWith("-")) removed.push({ number: oldLine++, text, tokens, tone: "removed" });
    else if (line.startsWith("+")) added.push({ number: newLine++, text, tokens, tone: "added" });
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
  private reading = true;
  private entries: LineHistoryCommit[] = [];
  private error: string | null = null;
  private selected = 0;
  private scroll = 0;
  private height = 1;
  private shown = -1;
  private readonly before = new CodeView("git-line-history-before");
  private readonly after = new CodeView("git-line-history-after");
  private closed = false;

  constructor(
    private readonly services: Services,
    private readonly target: LineHistoryTarget,
  ) {}

  read(cx: AsyncContext): void {
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
        if (this.closed || context !== this.services.context()) return;
        this.entries = entries;
      } catch (error) {
        if (this.closed) return;
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.reading = false;
        cx.notify();
      }
    });
  }

  release(): void {
    this.closed = true;
    this.before.release();
    this.after.release();
  }

  private select(index: number): void {
    this.selected = Math.max(0, Math.min(index, this.entries.length - 1));
    this.scroll = viewportOffset(this.scroll, this.selected, this.entries.length, this.height);
  }

  private open(cx: Context): void {
    const entry = this.entries[this.selected];
    if (!entry) return;
    this.services.overlay.close(cx);
    this.release();
    this.services.revealCommit(entry.sha, cx);
  }

  key(event: KeyEvent, cx: Context): boolean {
    const moves: Record<string, number> = {
      down: this.selected + 1,
      j: this.selected + 1,
      up: this.selected - 1,
      k: this.selected - 1,
      home: 0,
      end: this.entries.length - 1,
    };
    const move = moves[event.keystroke];
    if (event.keystroke === "enter") this.open(cx);
    else if (move !== undefined) this.select(move);
    else if (event.keystroke === "pageup" || event.keystroke === "pagedown") {
      this.before.key(event, cx);
      this.after.key(event, cx);
    } else return false;
    return true;
  }

  private wheel(event: ScrollWheelEvent, look: Look, cx: Context): void {
    const steps = Math.trunc((event.delta_lines ? event.delta_lines.y * look.row : event.delta.y) / look.row);
    if (!steps) return;
    cx.stop_propagation();
    this.select(this.selected - steps);
    cx.notify();
  }

  private row(look: Look, index: number, width: number): Element {
    const { t } = look;
    const entry = this.entries[index];
    const selected = index === this.selected;
    const now = Math.floor(Date.now() / 1000);
    const text = entry
      ? `${selected ? "▶" : " "} ${entry.sha.slice(0, 7)}  ${padToWidth(entry.author, 18)}  ${padToWidth(relativeTime(now - entry.authorTime), 14)}  ${entry.summary}`
      : "";
    return div()
      .id(`git-line-history-${index}`)
      .flex_none()
      .h(look.row)
      .whitespace_nowrap()
      .overflow_hidden()
      .text_color(selected ? t.text : t.hint)
      .when(selected, (el) => el.bg(t.selection).font_weight(700))
      .hover((style) => style.bg(t.hover))
      .child(truncateToWidth(text, width))
      .on_click((_, cx) => {
        cx.stop_propagation();
        if (selected) this.open(cx);
        else this.select(index);
        cx.notify();
      });
  }

  private list(look: Look, width: number): Element {
    const { t } = look;
    const area = v_flex()
      .id("git-line-history-list")
      .flex_1()
      .min_h(0)
      .overflow_hidden()
      .on_size_change((size, cx) => {
        const height = Math.max(1, Math.floor(size.height / look.row));
        if (height === this.height) return;
        this.height = height;
        this.select(this.selected);
        cx.notify();
      })
      .on_scroll_wheel((event, cx) => this.wheel(event, look, cx));
    if (this.reading) return area.child(h_flex().h(look.row).child(spinner(look)).child(" Reading line history"));
    if (this.error)
      return area.child(
        div()
          .text_color(t.error)
          .child(this.error.split("\n")[0] ?? ""),
      );
    if (!this.entries.length) return area.child(div().text_color(t.hint).child("No commits touched these lines."));
    const end = Math.min(this.entries.length, this.scroll + this.height);
    for (let index = this.scroll; index < end; index++) area.child(this.row(look, index, width));
    return area;
  }

  private diff(look: Look, width: number): Element | null {
    const entry = this.entries[this.selected];
    if (this.reading || this.error || !entry) return null;
    if (this.shown !== this.selected) {
      this.shown = this.selected;
      const rows = splitPatch(entry.patch, this.target.file);
      const language = fileLanguage(this.target.file);
      this.before.set(rows.before, language);
      this.after.set(rows.after, language);
    }
    const previous = this.entries[this.selected + 1];
    const short = entry.sha.slice(0, 7);
    const from = previous ? previous.sha.slice(0, 7) : entry.patch.includes("\n--- /dev/null") ? "none" : `${short}^`;
    const panel = (id: string, title: string, view: CodeView) =>
      box(look, { id, title }, view.render(look, { focused: false })).flex_1();
    const split = width >= SPLIT_COLUMNS ? h_flex() : v_flex();
    return split
      .flex_1()
      .min_h(0)
      .min_w(0)
      .items_stretch()
      .child(panel("git-line-history-before-box", `Before · ${from}`, this.before))
      .child(panel("git-line-history-after-box", `After · ${short}`, this.after));
  }

  render(look: Look, size: DialogSize): Element {
    const width = Math.max(1, size.cols - 4);
    const diff = this.diff(look, width);
    return v_flex()
      .size_full()
      .min_h(0)
      .px(cols(look, 1))
      .child(this.list(look, width))
      .when(!!diff, (el) => el.child(diff ?? div()))
      .when(!diff, (el) => el.child(div().flex_1()))
      .child(footerHint(look, FOOTER));
  }
}

export function openLineHistory(
  services: Services,
  title: string,
  target: LineHistoryTarget,
  size: DialogSize,
  cx: AsyncContext,
): void {
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
    onCancel: () => dialog.release(),
  });
  dialog.read(cx);
}
