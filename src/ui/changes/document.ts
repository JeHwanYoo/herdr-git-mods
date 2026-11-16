import { type CodeHighlighter, highlighter, type Token } from "../syntax.ts";

export type CellTone = "plain" | "added" | "removed" | "blank" | "fold" | "meta";
type MetaTone = "hunk" | "file" | "hint";

export interface Cell {
  number: number | null;
  source: string | null;
  gutter: boolean;
  tokens: Token[];
  tone: CellTone;
  meta: MetaTone;
}

export interface FoldKey {
  kind: "context" | "change";
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

export interface DiffRow {
  before: Cell;
  after: Cell;
  fold: FoldKey | null;
}

export const GUTTER = 5;
const TAB = 8;

export function foldId(key: FoldKey): string {
  return `${key.kind}:${key.oldStart}:${key.oldEnd}:${key.newStart}:${key.newEnd}`;
}

export function expandTabs(tokens: Token[]): Token[] {
  let column = 0;
  return tokens.map((token) => {
    let text = "";
    for (const character of token.text) {
      if (character === "\t") {
        const spaces = TAB - (column % TAB);
        text += " ".repeat(spaces);
        column += spaces;
      } else {
        text += character;
        column += 1;
      }
    }
    return { text, kind: token.kind };
  });
}

export function codeCell(
  number: number | null,
  source: string | null,
  tokens: Token[],
  tone: CellTone,
  gutter = true,
): Cell {
  return { number, source, gutter, tokens: expandTabs(tokens), tone, meta: "hint" };
}

function metaTone(line: string): MetaTone {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("---") || line.startsWith("+++")) return "file";
  return "hint";
}

export function textCell(text: string, tone: CellTone = "meta"): Cell {
  return {
    number: null,
    source: null,
    gutter: false,
    tokens: expandTabs([{ text, kind: "plain" }]),
    tone,
    meta: metaTone(text),
  };
}

const BLANK: Cell = {
  number: null,
  source: null,
  gutter: false,
  tokens: [{ text: " ", kind: "plain" }],
  tone: "blank",
  meta: "hint",
};

function hunkStarts(line: string): [number, number] | null {
  if (!line.startsWith("@@")) return null;
  const parts = line.split(/\s+/);
  const old = Number.parseInt((parts[1] ?? "").replace(/^-/, "").split(",")[0] ?? "", 10);
  const next = Number.parseInt((parts[2] ?? "").replace(/^\+/, "").split(",")[0] ?? "", 10);
  return Number.isNaN(old) || Number.isNaN(next) ? null : [old, next];
}

function foldLabel(kind: FoldKey["kind"], count: number, expanded: boolean): string {
  return `  ⋯ ${count} ${kind === "context" ? "unchanged" : "changed"} lines · ${expanded ? "collapse" : "expand"}`;
}

type Line = { kind: "line"; text: string } | { kind: "fold"; key: FoldKey; expanded: boolean };

function contextRun(
  lines: string[],
  start: number,
  position: [number, number],
  toggles: ReadonlySet<string>,
  output: Line[],
): number {
  let end = start;
  while (end < lines.length && (lines[end] ?? "").startsWith(" ")) end++;
  const count = end - start;
  const run = lines.slice(start, end).map((text): Line => ({ kind: "line", text }));
  if (count <= 8) {
    output.push(...run);
    return end;
  }
  const [oldLine, newLine] = position;
  const key: FoldKey = {
    kind: "context",
    oldStart: oldLine + 3,
    oldEnd: oldLine + count - 3,
    newStart: newLine + 3,
    newEnd: newLine + count - 3,
  };
  const expanded = toggles.has(foldId(key));
  output.push(...run.slice(0, 3), { kind: "fold", key, expanded });
  if (expanded) output.push(...run.slice(3, count - 3));
  output.push(...run.slice(count - 3));
  return end;
}

function collapseContext(lines: string[], toggles: ReadonlySet<string>): Line[] {
  const output: Line[] = [];
  let oldLine = 0;
  let newLine = 0;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const hunk = hunkStarts(line);
    if (line.startsWith(" ") && !hunk) {
      const end = contextRun(lines, index, [oldLine, newLine], toggles, output);
      oldLine += end - index;
      newLine += end - index;
      index = end;
      continue;
    }
    if (hunk) [oldLine, newLine] = hunk;
    else if (line.startsWith("-") && !line.startsWith("---")) oldLine++;
    else if (line.startsWith("+") && !line.startsWith("+++")) newLine++;
    output.push({ kind: "line", text: line });
    index++;
  }
  return output;
}

class Builder {
  rows: DiffRow[] = [];
  private oldLine = 0;
  private newLine = 0;
  private removed: string[] = [];
  private added: string[] = [];
  private before: CodeHighlighter;
  private after: CodeHighlighter;

  constructor(
    path: string,
    private readonly toggles: ReadonlySet<string>,
  ) {
    this.before = highlighter(path);
    this.after = highlighter(path);
  }

  private shared(text: string, fold: FoldKey | null = null): void {
    this.rows.push({
      before: textCell(text, fold ? "fold" : "meta"),
      after: textCell(text, fold ? "fold" : "meta"),
      fold,
    });
  }

  flush(): void {
    const count = Math.max(this.removed.length, this.added.length);
    if (count === 0) return;
    const key: FoldKey = {
      kind: "change",
      oldStart: this.oldLine,
      oldEnd: this.oldLine + this.removed.length,
      newStart: this.newLine,
      newEnd: this.newLine + this.added.length,
    };
    const expanded = !this.toggles.has(foldId(key));
    this.shared(foldLabel("change", count, expanded), key);
    if (expanded)
      for (let row = 0; row < count; row++) {
        const removed = this.removed[row];
        const added = this.added[row];
        this.rows.push({
          before:
            removed === undefined ? BLANK : codeCell(this.oldLine++, removed, this.before.line(removed), "removed"),
          after: added === undefined ? BLANK : codeCell(this.newLine++, added, this.after.line(added), "added"),
          fold: null,
        });
      }
    this.oldLine = key.oldEnd;
    this.newLine = key.newEnd;
    this.removed = [];
    this.added = [];
  }

  line(line: Line): void {
    if (line.kind === "fold") {
      this.flush();
      const { key, expanded } = line;
      this.shared(foldLabel("context", key.oldEnd - key.oldStart, expanded), key);
      if (!expanded) {
        this.oldLine = key.oldEnd;
        this.newLine = key.newEnd;
      }
      return;
    }
    const text = line.text;
    if (text.startsWith("-") && !text.startsWith("---")) this.removed.push(text.slice(1));
    else if (text.startsWith("+") && !text.startsWith("+++")) this.added.push(text.slice(1));
    else this.other(text);
  }

  private other(text: string): void {
    this.flush();
    const hunk = hunkStarts(text);
    if (hunk) [this.oldLine, this.newLine] = hunk;
    if (hunk || !text.startsWith(" ")) {
      this.shared(text);
      return;
    }
    const code = text.slice(1);
    this.rows.push({
      before: codeCell(this.oldLine++, code, this.before.line(code), "plain"),
      after: codeCell(this.newLine++, code, this.after.line(code), "plain"),
      fold: null,
    });
  }
}

export function buildDiff(patch: string, path: string, toggles: ReadonlySet<string>): DiffRow[] {
  const lines = patch.replace(/\n$/, "").split("\n");
  const builder = new Builder(path, toggles);
  for (const line of collapseContext(lines, toggles)) builder.line(line);
  builder.flush();
  return builder.rows;
}
