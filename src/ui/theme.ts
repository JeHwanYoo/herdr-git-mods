import { settings, theme } from "herdr";

export type Color = `#${string}`;

export interface Palette {
  background: Color;
  accent: Color;
  text: Color;
  textInverse: Color;
  hint: Color;
  secondary: Color;
  muted: Color;
  error: Color;
  success: Color;
  warning: Color;
  reference: Color;
  typeChange: Color;
  unmerged: Color;
  focus: Color;
  hover: Color;
  selection: Color;
  panel: Color;
  header: Color;
  inert: Color;
  rule: Color;
  diffAdded: Color;
  diffRemoved: Color;
  badgeHead: Color;
  badgeLocal: Color;
  badgeRemote: Color;
  badgeRemoteHead: Color;
  badgeTag: Color;
  badgeOther: Color;
  lanes: readonly Color[];
}

export interface Look {
  t: Palette;
  font: string;
  size: number;
  cell: number;
  row: number;
}

const MISSING: Color = "#00000000";
const FALLBACK_FONT = "JetBrains Mono";
const FALLBACK_SIZE = 14;
const CELL_RATIO = 0.6;
const ROW_RATIO = 1.3;

export const GLYPH = {
  marker: "\u25b6 ",
  cursor: "\u258f",
  branch: "\uf418",
  remote: "\uf0ac",
  tag: "\uf02b",
  github: "\uf408",
  local: "\ue702",
  folder: "\uf114",
  worktree: "\uf413",
  repository: "\uf401",
  file: "\uf15b",
  radioOn: "\u25cf",
  radioOff: "\u25cb",
  expanded: "\u25be",
  collapsed: "\u25b8",
  separator: " \u00b7 ",
  rule: "\u2502",
} as const;

export const SPINNER = { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], ms: 100 } as const;

export const DIALOG = { narrow: 56, medium: 68, wide: 78, card: 82 } as const;

export const WIDE_COLUMNS = 90;

function color(value: unknown): Color {
  return typeof value === "string" && value.startsWith("#") ? (value as Color) : MISSING;
}

function tinted(value: unknown, alpha: string): Color {
  const base = color(value);
  return base === MISSING ? MISSING : (`${base.slice(0, 7)}${alpha}` as Color);
}

function palette(): Palette {
  const names: Record<string, string> = theme();
  const named = (name: string) => color(names[name]);
  const tint = (name: string, alpha: string) => tinted(names[name], alpha);
  return {
    background: named("background"),
    accent: named("accent"),
    text: named("foreground"),
    textInverse: named("accent_foreground"),
    hint: named("foreground"),
    secondary: named("muted"),
    muted: named("dim"),
    error: named("ansi1"),
    success: named("ansi2"),
    warning: named("ansi3"),
    reference: named("ansi11"),
    typeChange: named("ansi4"),
    unmerged: named("ansi5"),
    focus: named("selected"),
    hover: named("hover"),
    selection: named("selection"),
    panel: named("popover"),
    header: named("raised"),
    inert: named("raised"),
    rule: named("border"),
    diffAdded: tint("ansi2", "33"),
    diffRemoved: tint("ansi1", "33"),
    badgeHead: tint("ansi1", "40"),
    badgeLocal: tint("ansi2", "40"),
    badgeRemote: tint("ansi4", "40"),
    badgeRemoteHead: tint("ansi5", "40"),
    badgeTag: tint("ansi3", "40"),
    badgeOther: tint("ansi5", "2a"),
    lanes: ["ansi11", "ansi14", "ansi10", "ansi13", "ansi9", "ansi12"].map(named),
  };
}

function setting(...keys: string[]): unknown {
  const values = settings();
  for (const key of keys) if (values[key] !== undefined && values[key] !== null) return values[key];
  return undefined;
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function look(): Look {
  const font = setting("font_family", "font");
  const size = number(setting("font_size"), FALLBACK_SIZE);
  return {
    t: palette(),
    font: typeof font === "string" && font ? font : FALLBACK_FONT,
    size,
    cell: size * CELL_RATIO * number(setting("terminal_cell_width"), 1),
    row: Math.round(size * ROW_RATIO * number(setting("terminal_line_height"), 1)),
  };
}

export function cols(look: Look, count: number): number {
  return count * look.cell;
}

export function rows(look: Look, count: number): number {
  return count * look.row;
}

export function lane(t: Palette, index: number): Color {
  return t.lanes[index % t.lanes.length] ?? t.accent;
}

export function statusColor(t: Palette, status: string): Color {
  const letter = status.charAt(0);
  if (letter === "A" || letter === "?") return t.success;
  if (letter === "M") return t.warning;
  if (letter === "D") return t.error;
  if (letter === "R" || letter === "C") return t.accent;
  if (letter === "T") return t.typeChange;
  if (letter === "U") return t.unmerged;
  return t.hint;
}
