import { h_flex, v_flex } from "gpui-base";
import { type AsyncContext, type Context, div, type Element, type KeyEvent } from "gpui-kit";
import { type BlameEntry, readBlameRange } from "../../git/diff.ts";
import type { ReviewSide } from "../code-view.ts";
import { showResult } from "../commands/result.ts";
import type { Services } from "../shell.ts";
import type { Look } from "../theme.ts";
import { footerHint } from "../widgets.ts";

export interface CopyRequest {
  path: string;
  side: ReviewSide | null;
  lines: number[];
  code: string[];
}

export interface BlameTarget {
  file: string;
  lines: number[];
  revision: string | null;
}

const OPTIONS = ["Code", "Line"] as const;

export function lineNumbersText(lines: number[]): string {
  const ranges: string[] = [];
  let start: number | null = null;
  let end = 0;
  for (const line of lines) {
    if (start !== null && line === end + 1) {
      end = line;
      continue;
    }
    if (start !== null) ranges.push(start === end ? String(start) : `${start}–${end}`);
    start = line;
    end = line;
  }
  if (start !== null) ranges.push(start === end ? String(start) : `${start}–${end}`);
  return ranges.join(", ");
}

function copyText(code: boolean, line: boolean, request: CopyRequest): string {
  const side = request.side ? `\nSide: ${request.side}` : "";
  const context = `File: ${request.path}${side}\nLines: ${lineNumbersText(request.lines)}`;
  if (code && line) return `${context}\n\n${request.code.join("\n")}`;
  return code ? request.code.join("\n") : context;
}

class CopyDialog {
  private focused = 0;
  private checked = [true, true];

  constructor(
    private readonly services: Services,
    private readonly request: CopyRequest,
    private readonly onCopied?: (cx: Context) => void,
  ) {}

  private toggle(index: number): void {
    this.focused = index;
    this.checked[index] = !this.checked[index];
  }

  private copy(cx: Context): void {
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

  key(event: KeyEvent, cx: Context): boolean {
    const key = event.keystroke;
    if (key === "up" || key === "k") this.focused = 0;
    else if (key === "down" || key === "j") this.focused = 1;
    else if (key === "tab" || key === "shift-tab") this.focused = 1 - this.focused;
    else if (key === "space") this.toggle(this.focused);
    else if (key === "1" || key === "2") this.toggle(Number(key) - 1);
    else if (key === "enter" || key === "y") this.copy(cx);
    else return false;
    cx.notify();
    return true;
  }

  render(look: Look): Element {
    const { t } = look;
    const { path, side, lines } = this.request;
    const body = v_flex()
      .min_w(0)
      .px(look.cell)
      .child(
        div()
          .h(look.row * 2)
          .whitespace_normal()
          .text_color(t.hint)
          .child(`${path} · ${side ?? "After"} lines ${lineNumbersText(lines)}`),
      );
    for (const [index, label] of OPTIONS.entries())
      body.child(
        h_flex()
          .id(`git-copy-option-${index}`)
          .h(look.row)
          .when(index === this.focused, (el) => el.bg(t.selection).font_weight(700))
          .text_color(index === this.focused ? t.text : t.hint)
          .child(`  [${this.checked[index] ? "x" : " "}] ${label}`)
          .on_click((_, cx) => {
            cx.stop_propagation();
            this.toggle(index);
            cx.notify();
          }),
      );
    return body.child(footerHint(look, "Space toggle · y copy · Esc close"));
  }
}

export function openCopySelection(services: Services, request: CopyRequest, onCopied?: (cx: Context) => void): void {
  const dialog = new CopyDialog(services, request, onCopied);
  services.overlay.open({
    kind: "custom",
    title: "Copy Selection",
    width: 52,
    render: (look) => dialog.render(look),
    key: (event, cx) => dialog.key(event, cx),
  });
}

function sameTarget(left: BlameTarget | null, right: BlameTarget | null): boolean {
  if (!left || !right) return left === right;
  return left.file === right.file && left.revision === right.revision && left.lines.join(",") === right.lines.join(",");
}

function entryText(entry: BlameEntry): string {
  if (/^0+$/.test(entry.sha)) return "Uncommitted";
  return `${entry.sha.slice(0, 7)} · ${entry.author} · ${entry.summary}`;
}

export class SelectionBlame {
  private target: BlameTarget | null = null;
  private reading = false;
  private entries: BlameEntry[] = [];
  private request = 0;

  sync(services: Services, target: BlameTarget | null, cx: AsyncContext): void {
    if (sameTarget(this.target, target)) return;
    this.reset();
    this.target = target;
    const git = services.git();
    const first = target?.lines[0];
    const last = target?.lines[target.lines.length - 1];
    if (!target || !git || first === undefined || last === undefined) return;
    const request = this.request;
    const context = services.context();
    this.reading = true;
    cx.spawn(async (cx) => {
      try {
        const entries = await readBlameRange(git, target.file, first, last, target.revision);
        if (request !== this.request || context !== services.context()) return;
        const wanted = new Set(target.lines);
        this.entries = entries.filter((entry) => wanted.has(entry.line));
      } catch {
        if (request !== this.request) return;
        this.entries = [];
      } finally {
        if (request === this.request) {
          this.reading = false;
          cx.notify();
        }
      }
    });
  }

  reset(): void {
    this.request++;
    this.target = null;
    this.reading = false;
    this.entries = [];
  }

  status(): string | null {
    if (!this.target) return null;
    if (this.reading) return "Blame…";
    const last = this.entries.reduce<BlameEntry | null>(
      (best, entry) => (best && best.line >= entry.line ? best : entry),
      null,
    );
    if (!last) return null;
    const others = new Set(this.entries.map((entry) => entry.author).filter((author) => author !== last.author)).size;
    const suffix = others === 0 ? "" : others === 1 ? " +1 author" : ` +${others} authors`;
    return `Blame ${entryText(last)}${suffix}`;
  }
}
