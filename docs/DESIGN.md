# Design

Herdr Git Mods implements the workflows of the herdr-git TUI v0.6.1 ([JeHwanYoo/herdr-git](https://github.com/JeHwanYoo/herdr-git) at `main`) as a native Herdr mod styled with the Deepfield cockpit design system. Its screens, regions, labels, toolbar buttons, dialog texts, empty states, status bar and keyboard shortcuts follow that source while using Deepfield's cold-blue `void` (dark) and `frost` (light) visual language.

`src/ui/theme.ts` holds the `VOID` and `FROST` palettes, theme mode persistence (`auto`, `void`, `frost`), font and cell metrics, glyphs, spinner frames, dialog widths and the wide-layout threshold. Read values from it instead of repeating numbers or color logic in a view.

## Cell grid

All text uses the person's terminal font: `settings().font_family` (or `font`) and `font_size`, falling back to JetBrains Mono 14. One cell is `font_size × 0.6 × terminal_cell_width` wide; one row is `round(font_size × 1.3 × terminal_line_height)` tall. The view sets that font, size and row height (in px) on its root, so virtualized lists, trees, diffs and hit testing keep exact cell-grid coordinates (`cols(look, n)`, `rows(look, n)`, `look.screenCell`, `look.screenRow`).

Icons that need custom shapes use SVG path data in `src/ui/icons.ts`. GPUI paints each icon within two columns and one row using the requested palette color or the default text color. The paths ship inside `main.js`, so updates can use the same bundle as a fresh install.

## Deepfield color tokens

`palette()` selects static `VOID` or `FROST` tokens based on `themeMode()` (`auto` detects light vs dark from Herdr's `theme().background` luminance; `void` and `frost` can be chosen explicitly in Settings). Never write a hex value in a view; read colors from `look.t` only.

| Deepfield token                  | Role in `Palette`                              | `void` (dark)                                                         | `frost` (light)                 |
| -------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------- | ------------------------------- |
| `surface-0`                      | `surface0`, `scrim` (76% alpha)                | `#04080f`                                                             | `#e3edf7`                       |
| `surface-100`                    | `background`, `header`, `inert`                | `#08111d`                                                             | `#f1f7fc`                       |
| `surface-200`                    | `panel` (panels, top bar, status bar, modals)  | `#0d1a2b`                                                             | `#ffffff`                       |
| `surface-300`                    | `hover` (hover rows, keycaps, scrollbar track) | `#14263d`                                                             | `#d9e7f3`                       |
| `line`, `line-strong`            | `rule`, `lineStrong`                           | `#1f3a57`, `#4a80ab`                                                  | `#b4cbe0`, `#5b86a8`            |
| `ink`, `ink-muted`, `ink-subtle` | `text`, `secondary`, `hint` / `muted`          | `#e8f4ff`, `#9db7cf`, `#7893ad`                                       | `#07192b`, `#3a5671`, `#486782` |
| `accent`, `accent-strong`        | `accent`, `accentStrong`                       | `#35d6ff`, `#7be4ff`                                                  | `#0a6f94`, `#05587a`            |
| `accent-text`, `on-accent`       | `accentText`, `textInverse`                    | `#5fdfff`, `#03121c`                                                  | `#05638a`, `#ffffff`            |
| `accent-soft`                    | `accentSoft`, `focus`                          | `#35d6ff1f`                                                           | `#0a6f941a`                     |
| `signal-ok`                      | `success`, `diffAdded` (~14% alpha)            | `#3fe0c0`                                                             | `#00735b`                       |
| `signal-warn`                    | `warning`, `unmerged`                          | `#ffb24a`                                                             | `#8a5200`                       |
| `signal-danger`                  | `error`, `diffRemoved` (~14% alpha)            | `#ff6b7d`                                                             | `#b3182f`                       |
| `info`, `azure`, `ice`           | `info`, `azure`, `ice`, `typeChange`           | `#6aa6ff`, `#3b8cff`, `#b9ecff`                                       | `#1f5fc4`, `#1f63d6`, `#8fd9f5` |
| Graph lanes                      | `lanes`                                        | `accent`, `azure`, `signal-ok`, `signal-warn`, `signal-danger`, `ice` | frost equivalents               |

Git status letters are bold: `A`/`?` `success`, `M` `warning`, `D` `error`, `R`/`C` `accentText`, `T` `typeChange`, `U` `unmerged`, anything else `hint`.

## Surfaces, containers and states

- **Panels (`box`)**: square corners, flat `surface-200` fill, 1px `line` border, and a header bar with a 6px `accent` dot, uppercase telemetry title and 1px bottom hairline. The focused panel shifts to a 6% accent-tinted fill (`panelFocus`), a 35% `accent` outer edge (`accentEdge`) and a solid 2px `accent` bottom edge.
- **Tabs**: transparent at rest on the `surface-200` top bar; the active tab uses `accent-soft` wash, `accent-text`, and a 2px `accent` bottom edge.
- **Buttons**: `radius-sm` (2px) corners and `line-strong` borders. Solid `accent` fill is reserved for primary modal actions and `Commit` when staged changes are ready. Destructive Graph actions (`Revert`, `Reset`) use `signal-danger` borders without a solid fill. Disabled buttons render at 42% opacity.
- **Lists & trees**: selected rows use `accent-soft` wash with a 2px `accent` left bar; hovered rows step to `surface-300`.
- **Overlays**: modals sit on `surface-200` with a drop shadow over a 76% `surface-0` scrim.

## Screen

From top to bottom:

| Region         | Content                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Top bar        | Tabs `CHANGES  GRAPH  FILES  COMMANDS  SETTINGS` with bottom accent rule on the active tab; version badge at the right             |
| Toolbar        | `Fetch  Pull  Commit  Push  Branch  Stash` (`Commit` highlighted as primary when staged changes exist)                             |
| Second toolbar | Graph: `Checkout  Rebase  Cherry-pick  Revert  Reset  Copy SHA`. Changes: `Diff Last` / `Compare` segmented buttons, then info bar |
| Body           | The active tab (below), with 6px panel gutters over `surface-100`                                                                  |
| Status bar     | `Branch: <name> · HEAD <sha>`, `Selected: <sha>` on Graph, repository path, blame or GitHub identity, progress spinner, last error |

| Tab      | Body                                                                                                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changes  | At 90 columns or more: `Files` over `Workspaces` on the left, then `Before · <Language>` and `After`, with draggable dividers. Narrower: the three stacked 25/37/38                                         |
| Graph    | `Filter` search field, `Commits · Loaded in X s` with lanes, bordered ref badges, subject, relative date, author and short SHA, `[PgDn] Load more`, then `Workspaces` beside `Commit details` (and preview) |
| Files    | `Filter` search field, the `Files · N` tree over `Workspaces`, and `Preview`                                                                                                                                |
| Settings | Native graph, Background refresh (Deepfield switches), Theme (`AUTO` / `VOID` / `FROST`), Versions                                                                                                          |

Commands opens the command palette. Every operation runs through a dialog: a picker (`Search`, rows with `▶`, optional `Status` column), a confirmation (`Confirm Git operation` with the branch, the exact Git command and its effect), a form, or a custom dialog, each with `[Enter] …` / `[Esc] …` buttons. Holding Alt shows Deepfield keycap hints in place of icons.

## Motion and refresh

Animate with Herdr's native tools: `.frames()`, `svg().spin()`, `.loop()` and `.transition()`. Never redraw on a timer to animate; each redraw repaints the whole window. Use timers only for data, and only as often as the data changes.

## Differences from the TUI

- Visual language uses the Deepfield cockpit design system (`void` dark and `frost` light palettes, flat panels with bottom accent edges, bordered ref badges, modal scrims, and switch controls) while retaining the terminal cell grid for virtualized lists, trees and diffs.
- Herdr owns the window: Git opens as a pane (see [ARCHITECTURE.md](ARCHITECTURE.md#pane-presentation)), and `q` does not close it. Herdr's pane header already names it, so the TUI's `Git` title rule is left out.
- Settings › Native graph replaces the Kitty graphics switch: on draws smooth native curves, off draws box-drawing lanes. Settings › Theme selects `AUTO`, `VOID`, or `FROST`.
- Update Herdr Git Mods shows Herdr and herdr-core versions and opens Herdr's update settings; the mod has no updater of its own.
- Projects in Workspaces are local to this machine and stored in Herdr shared state, so every Git pane shows the same list.
- Syntax colors come from the mod's highlighter, not syntect.
- Cherry-pick, Revert and Reset use the target picker of Checkout and Rebase (selected commit, branches, typed hash) instead of acting on the selected commit directly, so every commit action can target a branch.
- Diff Last compares a root commit with Git's empty tree, showing all initial additions on any branch or detached HEAD. Uncommitted changes still take precedence.
- Operation-result dialogs use `[Enter] Close`; Escape does not dismiss a completed or failed result. Escape still cancels pending forms, pickers and confirmations.
