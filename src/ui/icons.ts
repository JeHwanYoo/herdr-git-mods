import { div, type Element, type Path, PathBuilder } from "gpui-kit";
import type { Color, Look } from "./theme.ts";

const SVG_PATHS = {
  branch:
    "M 4 6 L 4 10 M 6 10 C 12 10 12 7 12 6 M 6 4 C 6 7 2 7 2 4 C 2 1 6 1 6 4 Z M 14 4 C 14 7 10 7 10 4 C 10 1 14 1 14 4 Z M 6 12 C 6 15 2 15 2 12 C 2 9 6 9 6 12 Z",
  remote: "M 14 8 C 14 16 2 16 2 8 C 2 0 14 0 14 8 Z M 8 2 C 4 5 4 11 8 14 C 12 11 12 5 8 2 Z M 2 8 L 14 8",
  tag: "M 2 2 L 8 2 L 14 8 L 8 14 L 2 8 Z M 5 5 L 6 5",
  github:
    "M 4 11 C 1 10 1 6 3 5 L 3 2 L 6 4 L 10 4 L 13 2 L 13 5 C 15 6 15 10 12 11 L 10 12 L 10 15 M 6 15 L 6 12 L 4 11 M 6 14 C 4 15 3 13 2 13",
  local: "M 2 3 L 14 3 L 14 11 L 2 11 Z M 8 11 L 8 14 M 5 14 L 11 14",
  worktree: "M 2 5 L 6 5 L 8 7 L 14 7 L 14 13 L 2 13 Z M 2 5 L 2 3 L 8 3 L 10 5 L 14 5 L 14 7",
  repository: "M 4 2 L 13 2 L 13 13 L 4 13 C 1 13 1 10 4 10 L 13 10 M 4 2 C 2 2 2 3 2 5 L 2 11 M 6 4 L 10 4",
  file: "M 3 2 L 9 2 L 13 6 L 13 14 L 3 14 Z M 9 2 L 9 6 L 13 6 M 6 10 L 10 10",
  fetch: "M 8 2 L 8 10 M 5 7 L 8 10 L 11 7 M 2 10 L 2 14 L 14 14 L 14 10",
  cherryPick:
    "M 5 9 C 5 5 8 3 12 2 M 11 8 L 12 2 M 7 11 C 7 14 2 14 2 11 C 2 8 7 8 7 11 Z M 14 10 C 14 13 9 13 9 10 C 9 7 14 7 14 10 Z",
  revert: "M 6 3 L 2 7 L 6 11 M 2 7 L 10 7 C 14 7 14 10 14 13",
  checkout: "M 3 14 L 3 8 C 3 5 5 4 8 4 L 14 4 M 10 1 L 14 4 L 10 7",
  rebase: "M 4 14 L 4 2 M 1 5 L 4 2 L 7 5 M 12 14 L 12 11 C 12 8 10 8 7 8 L 4 8",
  reset: "M 3 5 C 7 0 14 3 14 8 C 14 14 7 16 3 12 M 2 2 L 2 6 L 6 6",
  copy: "M 6 6 L 14 6 L 14 14 L 6 14 Z M 10 4 L 10 2 L 2 2 L 2 10 L 4 10",
} as const;

export type IconName = keyof typeof SVG_PATHS;

export const ICON_CELLS = 2;

const VIEW_BOX = 16;
const paths = new Map<IconName, Path>();
let pathSize = 0;

function iconPath(name: IconName, size: number): Path {
  if (size !== pathSize) {
    pathSize = size;
    paths.clear();
  }
  const previous = paths.get(name);
  if (previous) return previous;
  const scale = size / VIEW_BOX;
  const builder = PathBuilder.stroke(1.6 * scale);
  for (const command of SVG_PATHS[name].matchAll(/([MLCZ])([^MLCZ]*)/g)) {
    const [x = 0, y = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0] = (command[2] ?? "").trim().split(/\s+/).map(Number);
    switch (command[1]) {
      case "M":
        builder.move_to(x * scale, y * scale);
        break;
      case "L":
        builder.line_to(x * scale, y * scale);
        break;
      case "C":
        builder.cubic_bezier_to(x3 * scale, y3 * scale, x * scale, y * scale, x2 * scale, y2 * scale);
        break;
      case "Z":
        builder.close();
        break;
    }
  }
  const path = builder.build();
  paths.set(name, path);
  return path;
}

export function iconCell(look: Look, name: IconName, color: Color = look.t.text): Element {
  const width = ICON_CELLS * look.cell;
  const size = Math.min(width * 0.875, look.row * 0.8);
  return div()
    .flex_none()
    .w(width)
    .h(look.row)
    .flex()
    .items_center()
    .justify_center()
    .child(window.paint_path(iconPath(name, size), color).size(size));
}
