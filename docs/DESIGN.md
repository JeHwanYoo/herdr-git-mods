# Design

Herdr Git Mods reproduces the interface of the herdr-git TUI v0.6.1 ([JeHwanYoo/herdr-git](https://github.com/JeHwanYoo/herdr-git) at `main`) as a native Herdr mod. Its screens, regions, labels, toolbar buttons, dialog texts, empty states, status bar and keyboard shortcuts follow that source. When this document and the TUI disagree, the TUI source wins; record any deliberate difference here.

`src/ui/theme.ts` holds the palette, font and cell metrics, glyphs, spinner frames, dialog widths and the wide-layout threshold. Read values from it instead of repeating numbers or color logic in a view.

## Cell grid

All text uses the person's terminal font: `settings().font_family` (or `font`) and `font_size`, falling back to JetBrains Mono 14. One cell is `font_size × 0.6 × terminal_cell_width` wide; one row is `round(font_size × 1.3 × terminal_line_height)` tall. The view sets that font, size and row height (in px) on its root, so regions are built in whole rows and columns with `cols(look, n)` and `rows(look, n)`. Herdr scales those px by its zoom, and reports sizes and pointer positions in the scaled px, so convert measurements to columns and rows with `look.screenCell` and `look.screenRow`. Boxes draw a 1px outline at the centre of their border cells with the title on the top edge, like a ratatui `Block`; a focused box uses `accent`.

The TUI's colors map to theme names in `palette()`:

| TUI constant                       | Role in `Palette`                                                                     | `theme()` name                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ACCENT`                           | `accent`                                                                              | `accent`                                                                   |
| `TEXT`, `HINT`                     | `text`, `hint`                                                                        | `foreground`                                                               |
| `TEXT_INVERSE`                     | `textInverse`                                                                         | `accent_foreground`                                                        |
| `SECONDARY`                        | `secondary`                                                                           | `muted`                                                                    |
| `MUTED`                            | `muted`                                                                               | `dim`                                                                      |
| `ERROR`, `SUCCESS`, `WARNING`      | `error`, …                                                                            | `ansi1`, `ansi2`, `ansi3`                                                  |
| `REFERENCE`                        | `reference`                                                                           | `ansi11`                                                                   |
| `STATUS_TYPE_CHANGE`               | `typeChange`                                                                          | `ansi4`                                                                    |
| `STATUS_UNMERGED`                  | `unmerged`                                                                            | `ansi5`                                                                    |
| `SURFACE_FOCUS`                    | `focus`                                                                               | `selected`                                                                 |
| `SURFACE_HOVER`                    | `hover`                                                                               | `hover`                                                                    |
| `SURFACE_SELECTION`                | `selection`                                                                           | `selection`                                                                |
| `SURFACE_PANEL` (buttons)          | `panel`                                                                               | `popover`                                                                  |
| `SURFACE_HEADER`                   | `header`                                                                              | `raised`                                                                   |
| `SURFACE_INERT` (status bar)       | `inert`                                                                               | `raised`                                                                   |
| `RULE`, box outlines               | `rule`                                                                                | `border`                                                                   |
| `DIFF_ADDED_BG`, `DIFF_REMOVED_BG` | `diffAdded`, `diffRemoved`                                                            | `ansi2`, `ansi1` at alpha `33`                                             |
| `BADGE_*_BG`                       | `badgeHead`, `badgeLocal`, `badgeRemote`, `badgeRemoteHead`, `badgeTag`, `badgeOther` | `ansi1`, `ansi2`, `ansi4`, `ansi5`, `ansi3` at alpha `40`; `ansi5` at `2a` |
| `GRAPH_LANES`                      | `lanes`                                                                               | `ansi11`, `ansi14`, `ansi10`, `ansi13`, `ansi9`, `ansi12`                  |

## Color

Use `theme()` names only, so the mod follows light, dark and custom themes. Never write a hex value in a view.

Git status letters are bold: `A`/`?` `success`, `M` `warning`, `D` `error`, `R`/`C` `accent`, `T` `typeChange`, `U` `unmerged`, anything else `hint`.

## Screen

From top to bottom, as in the TUI:

| Region         | Content                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Header         | Tabs `Changes  Graph  Files  Commands  Settings`, the active one on `accent`; the version at the right                             |
| Toolbar        | `Fetch  Pull  Commit  Push  Branch  Stash` as six equal filled buttons                                                             |
| Second toolbar | Graph: `Checkout  Rebase  Cherry-pick  Revert  Reset  Copy SHA`. Changes: `Diff Last` / `Compare` radios, then the comparison line |
| Body           | The active tab (below)                                                                                                             |
| Status bar     | `Branch: <name> · HEAD <sha>`, `Selected: <sha>` on Graph, repository path, blame or GitHub identity, progress spinner, last error |

| Tab      | Body                                                                                                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changes  | At 90 columns or more: `Files` over `Workspaces` on the left, then `Before · <Language>` and `After`, with draggable dividers. Narrower: the three stacked 25/37/38                                         |
| Graph    | `Filter`, `Commits · Loaded in X s` with lanes, ref badges, subject, relative date, author and short SHA, `[PgDn] Load more`, then `Workspaces` beside `Commit details` (and a preview when a file is open) |
| Files    | `Filter`, the `Files · N` tree over `Workspaces`, and `Preview`                                                                                                                                             |
| Settings | Native graph, Background refresh, Versions                                                                                                                                                                  |

Commands opens the command palette. Every operation runs through a dialog: a picker (`Search`, rows with `▶`, optional `Status` column), a confirmation (`Confirm Git operation` with the branch, the exact Git command and its effect), a form, or a custom dialog, each with `[Enter] …` / `[Esc] …` buttons. Holding Alt shows each control's shortcut in place of its icon.

## Motion and refresh

Animate with Herdr's native tools: `.frames()`, `svg().spin()`, `.loop()` and `.transition()`. Never redraw on a timer to animate; each redraw repaints the whole window. Use timers only for data, and only as often as the data changes.

## Differences from the TUI

- Herdr owns the window: Git opens as a pane (see [ARCHITECTURE.md](ARCHITECTURE.md#pane-presentation)), and `q` does not close it. Herdr's pane header already names it, so the TUI's `Git` title rule is left out.
- Settings › Native graph replaces the Kitty graphics switch: on draws smooth native curves, off draws box-drawing lanes.
- Update Herdr Git Mods shows Herdr and herdr-core versions and opens Herdr's update settings; the mod has no updater of its own.
- Projects in Workspaces are local to this machine and stored in the mod's `localStorage`.
- Syntax colors come from the mod's highlighter, not syntect.
- Cherry-pick, Revert and Reset use the target picker of Checkout and Rebase (selected commit, branches, typed hash) instead of acting on the selected commit directly, so every commit action can target a branch.
- Diff Last compares a root commit with Git's empty tree, showing all initial additions on any branch or detached HEAD. Uncommitted changes still take precedence.
- Operation-result dialogs use `[Enter] Close`; Escape does not dismiss a completed or failed result. Escape still cancels pending forms, pickers and confirmations.
