import { settings, theme } from "herdr";

export type Color = `#${string}`;

export type ThemeMode = "auto" | "void" | "frost";

export interface Palette {
  surface0: Color;
  background: Color;
  panel: Color;
  panelFocus: Color;
  hover: Color;
  accent: Color;
  accentStrong: Color;
  accentText: Color;
  accentSoft: Color;
  accentEdge: Color;
  text: Color;
  textInverse: Color;
  hint: Color;
  secondary: Color;
  muted: Color;
  error: Color;
  success: Color;
  warning: Color;
  info: Color;
  azure: Color;
  ice: Color;
  reference: Color;
  typeChange: Color;
  unmerged: Color;
  focus: Color;
  selection: Color;
  header: Color;
  inert: Color;
  rule: Color;
  lineStrong: Color;
  scrim: Color;
  diffAdded: Color;
  diffRemoved: Color;
  badgeHead: Color;
  badgeHeadBorder: Color;
  badgeLocal: Color;
  badgeLocalBorder: Color;
  badgeRemote: Color;
  badgeRemoteBorder: Color;
  badgeRemoteHead: Color;
  badgeRemoteHeadBorder: Color;
  badgeTag: Color;
  badgeTagBorder: Color;
  badgeOther: Color;
  badgeOtherBorder: Color;
  lanes: readonly Color[];
}

export interface Look {
  t: Palette;
  font: string;
  size: number;
  cell: number;
  row: number;
  screenCell: number;
  screenRow: number;
}

const THEME_STORAGE_KEY = "git-theme";
const FALLBACK_FONT = "JetBrains Mono";
const FALLBACK_SIZE = 14;
const CELL_RATIO = 0.6;
const ROW_RATIO = 1.3;
const LIGHT_LUMINANCE = 140;

const VOID: Palette = {
  surface0: "#04080f",
  background: "#08111d",
  panel: "#0d1a2b",
  panelFocus: "#10253a",
  hover: "#14263d",
  accent: "#35d6ff",
  accentStrong: "#7be4ff",
  accentText: "#5fdfff",
  accentSoft: "#35d6ff1f",
  accentEdge: "#35d6ff59",
  text: "#e8f4ff",
  textInverse: "#03121c",
  hint: "#7893ad",
  secondary: "#9db7cf",
  muted: "#7893ad",
  error: "#ff6b7d",
  success: "#3fe0c0",
  warning: "#ffb24a",
  info: "#6aa6ff",
  azure: "#3b8cff",
  ice: "#b9ecff",
  reference: "#5fdfff",
  typeChange: "#6aa6ff",
  unmerged: "#ffb24a",
  focus: "#35d6ff1f",
  selection: "#35d6ff2b",
  header: "#08111d",
  inert: "#08111d",
  rule: "#1f3a57",
  lineStrong: "#4a80ab",
  scrim: "#04080fc2",
  diffAdded: "#3fe0c024",
  diffRemoved: "#ff6b7d24",
  badgeHead: "#ff6b7d1f",
  badgeHeadBorder: "#ff6b7d8c",
  badgeLocal: "#3fe0c01f",
  badgeLocalBorder: "#3fe0c08c",
  badgeRemote: "#6aa6ff1f",
  badgeRemoteBorder: "#6aa6ff8c",
  badgeRemoteHead: "#3b8cff1f",
  badgeRemoteHeadBorder: "#3b8cff8c",
  badgeTag: "#ffb24a1f",
  badgeTagBorder: "#ffb24a8c",
  badgeOther: "#5fdfff1f",
  badgeOtherBorder: "#5fdfff8c",
  lanes: ["#35d6ff", "#3b8cff", "#3fe0c0", "#ffb24a", "#ff6b7d", "#b9ecff"],
};

const FROST: Palette = {
  surface0: "#e3edf7",
  background: "#f1f7fc",
  panel: "#ffffff",
  panelFocus: "#f0f7fa",
  hover: "#d9e7f3",
  accent: "#0a6f94",
  accentStrong: "#05587a",
  accentText: "#05638a",
  accentSoft: "#0a6f941a",
  accentEdge: "#0a6f9459",
  text: "#07192b",
  textInverse: "#ffffff",
  hint: "#486782",
  secondary: "#3a5671",
  muted: "#486782",
  error: "#b3182f",
  success: "#00735b",
  warning: "#8a5200",
  info: "#1f5fc4",
  azure: "#1f63d6",
  ice: "#8fd9f5",
  reference: "#05638a",
  typeChange: "#1f5fc4",
  unmerged: "#8a5200",
  focus: "#0a6f941a",
  selection: "#0a6f9429",
  header: "#f1f7fc",
  inert: "#f1f7fc",
  rule: "#b4cbe0",
  lineStrong: "#5b86a8",
  scrim: "#e3edf7c2",
  diffAdded: "#00735b1f",
  diffRemoved: "#b3182f1f",
  badgeHead: "#b3182f1f",
  badgeHeadBorder: "#b3182f8c",
  badgeLocal: "#00735b1f",
  badgeLocalBorder: "#00735b8c",
  badgeRemote: "#1f5fc41f",
  badgeRemoteBorder: "#1f5fc48c",
  badgeRemoteHead: "#1f63d61f",
  badgeRemoteHeadBorder: "#1f63d68c",
  badgeTag: "#8a52001f",
  badgeTagBorder: "#8a52008c",
  badgeOther: "#05638a1f",
  badgeOtherBorder: "#05638a8c",
  lanes: ["#0a6f94", "#1f63d6", "#00735b", "#8a5200", "#b3182f", "#5b86a8"],
};

export const GLYPH = {
  marker: "\u25b6 ",
  cursor: "\u258f",
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

export function themeMode(): ThemeMode {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === "void" || saved === "frost") return saved;
  return "auto";
}

export function setThemeMode(mode: ThemeMode): void {
  localStorage.setItem(THEME_STORAGE_KEY, mode);
}

function isLightHex(value: string | undefined): boolean {
  if (!value?.startsWith("#") || value.length < 7) return false;
  const r = Number.parseInt(value.slice(1, 3), 16);
  const g = Number.parseInt(value.slice(3, 5), 16);
  const b = Number.parseInt(value.slice(5, 7), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return false;
  return 0.299 * r + 0.587 * g + 0.114 * b > LIGHT_LUMINANCE;
}

function palette(): Palette {
  const mode = themeMode();
  if (mode === "void") return VOID;
  if (mode === "frost") return FROST;
  const names: Record<string, string> = theme();
  return isLightHex(names.background) ? FROST : VOID;
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
  const zoom = number(setting("zoom"), 1);
  const cell = size * CELL_RATIO * number(setting("terminal_cell_width"), 1);
  const row = Math.round(size * ROW_RATIO * number(setting("terminal_line_height"), 1));
  return {
    t: palette(),
    font: typeof font === "string" && font ? font : FALLBACK_FONT,
    size,
    cell,
    row,
    screenCell: cell * zoom,
    screenRow: row * zoom,
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
  if (letter === "R" || letter === "C") return t.accentText;
  if (letter === "T") return t.typeChange;
  if (letter === "U") return t.unmerged;
  return t.hint;
}
