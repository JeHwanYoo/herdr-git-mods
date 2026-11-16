# Herdr mods research

## Intent analysis

Establish the runtime, placement, development, and distribution constraints for building Herdr Git Mods as a desktop app mod.

Verified on 2026-11-16 against Herdr app 0.1.16 and herdr-core (`hc`) 0.1.21 on macOS, the herdr.dev index generated at 2026-11-16 02:00 UTC, and this repository's uncommitted `main` branch. The first investigation ran on 2026-11-03 against Herdr app 0.1.12. Findings not checked again carry that date.

## Research topics

1. How do desktop mods differ from TUI plugins?
2. What files, APIs, build tools, and checks does a mod get?
3. Where can a mod appear, and can it open a full-height pane beside a split tab?
4. How are mods described, listed, and installed from herdr.dev?
5. What remains to check before publishing?

## Findings

### Two Herdrs

Herdr ships two apps with separate extension systems. The Herdr app runs its terminals in herdr-core (`hc`).[^app-agents]

|            | Herdr TUI                                                                | Herdr app                                                               |
| ---------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| What it is | Terminal multiplexer                                                     | Desktop app (GPUI)                                                      |
| Extensions | Plugins: `herdr-plugin.toml`, any language, run as a pane process        | Mods: JavaScript that describes native GPUI elements                    |
| Sharing    | GitHub topic `herdr-plugin`; `herdr plugin install owner/repo` builds it | GitHub topic `herdr-mod`; the person's agent reads and copies the files |
| Listing    | Marketplace, refreshed every 30 minutes                                  | herdr.dev/mods, Community section, within the hour                      |

The TUI column comes from the 2026-11-03 investigation. herdr-git[^herdr-git] is a Rust TUI plugin drawn with ratatui. Mods cannot use HTML, CSS, a web view, Node APIs, or a terminal UI, so this port rewrites the UI in gpui-kit and reuses only the Git behavior.

### What a mod is

A mod is a folder under `~/.config/herdr-app/mods/<name>/`:[^app-agents]

| File            | Purpose                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `main.js`       | Required. Default-exports a class extending `View` from `gpui-kit`                                                                        |
| `mod.json`      | Where Herdr docks it the first time: `place` (`right`, `left`, `top`, `bottom`, `none`), `size`, optional `title`, `focusable`, `overlay` |
| `*.js`, `*.svg` | Modules imported with relative paths, and icons                                                                                           |

- Herdr docks one copy per `mod.json` into the shown layout the first time it sees the folder. After that, layouts decide where it appears.
- Saving any file reloads every copy. A broken save keeps the old version running and shows in `herdr-app status`.
- Since 0.1.14, module code runs once per source version and all copies share it. Per-copy state belongs in the class.[^changelog]
- `herdr` module APIs come from `~/.config/herdr-app/herdr.d.ts`, and UI elements from `gpui-kit.d.ts`. Herdr rewrites both on every start to match the installed version.
- `exec(cmd, args, { cwd, on, timeout })` runs a program in the person's environment, on another machine when `on` is set. Output is capped at 8 MiB. The timeout defaults to 30 seconds and can be raised to 10 minutes (added in 0.1.14). It rejects when the program cannot start.[^herdr-dts]
- `watchFolder(dir)` has no `on` option, so it watches this machine only and remote spaces need a timer. Since 0.1.16 the returned promise has `cancel()` to stop a watch, and at most 64 folders are watched at once across all mods.[^herdr-dts]
- Herdr ships a `changes` mod with a changed-file list, diff, and commit box. It is a reference for colors and Git read flags. Shipped mods must not be edited; `mod.clone` duplicates one.

### Full-height pane beside a split tab

A mod pane is a leaf in a tab's split tree, and `pane.split {direction, pane?, mod?, props?}` splits the pane it names.[^herdr-dts] The mod API still exposes no tab tree: `panes()` returns panes without rectangles or parents, and `layout()` describes the window layout. The commands still include no way to move a pane to another tab or reparent a subtree. `pane.swap` now also takes a `target` pane in the same tab (0.1.14).[^changelog]

herdr-core holds the tree. `hc connect` accepts JSON-RPC, and `doc.get` with `name: "herdr-app"` returns every space's tabs with their `root` node. In the live document, a tab's root node has the same id as the tab.

Observed on 2026-11-16 in a scratch tab built as a 2×2 grid: `pane.split` with the root node's id as `pane`, `direction: "right"` and `mod: "git"` wrapped the whole grid in a new row and put the Git pane beside it at full tab height. The tree went from `row[column[t1, t2], column[t3, t4]]` to `row[row[column[t1, t2], column[t3, t4]], git]`.[^probe] Neither `herdr.d.ts` nor the app's `AGENTS.md` documents that `pane` accepts a split node id, so a later release could drop this behavior without notice.

The 2026-11-03 investigation found no such path and considered porting the TUI plugin's approach instead. That plugin[^herdr-git-sidebar] reads pane rectangles with `herdr pane layout`, parks every pane but one in a temporary tab, splits the remaining pane, and moves the parked panes back. The desktop mod API has no pane-move command, so that approach still does not carry over.

### How this repository opens Git

`mods/git/mod.json` declares `place: none` and a frameless `window` overlay of 2×2 pixels. The root `keys.json` binds `cmd-g` to `mod.open:git`, which toggles the mod as that overlay. The overlay copy is a launcher (`src/runtime/pane.ts`, `src/runtime/pane-target.ts`):

1. It reads the focused tab's tree through `exec` of `hc connect` with `doc.get`, on the space's machine when the space is remote. Windows hosts pipe the requests through PowerShell instead of `sh`.
2. If the tree already holds a `git` block, it closes that pane. Otherwise it splits the tab root to the right with the Git mod, passing the tab, the repository location, and the source pane as props.
3. It closes its own overlay with `closeOverlay(props().overlay)`, and reports failures with `notify`.

A `window` overlay does not dim the window, stays open on outside clicks, opens without taking the keyboard, and closes on a layout switch.[^herdr-dts] The launcher closes itself as soon as it finishes, so those properties matter only for the instant it is open. The whole flow was not exercised end to end in this verification; the scratch-tab split above covers the step that the 0.1.12 investigation found missing.

### Checking a mod

`herdr-app check <mod folder>` loads the mod once, renders it, and exits nonzero with the error. It works on a folder outside `~/.config/herdr-app`. `init()` runs for real during a check, and since 0.1.16 `checking()` from `herdr` returns true there so a mod can skip starting helpers or writing files.[^app-agents] The 2026-11-03 investigation also found that a check does not lay out the mod, run deferred rows or nested renders, or reach later async states, so a passing check does not replace trying the mod in the app.

Observed on 2026-11-16: `herdr-app check mods/git` passes, and a mod calling an unknown element method fails with `unknown element method`. The check writes `jsconfig.json` and `gpui-kit.d.ts` into the mod folder for editors; `.gitignore` keeps them out of the repository so installs copy only the mod's own files.

`herdr-app shot [file.png]` saves a frame of the running window. Since 0.1.16 it shows the current frame even when the window is not being drawn.[^changelog] Use it for `preview.png`.

### TypeScript and Bun

Herdr runs mods in QuickJS-ng (through rquickjs). Each `herdr-app check` result below was observed on 2026-11-16 with Herdr app 0.1.16, except two rows from 2026-11-03: the globals row, and the bundle row, which `mods/git` passing its check covers again.

| Attempt                                                                                          | Result                                                                                                                                        |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts` and no `main.js`                                                                       | Fails: the folder must contain `main.js`                                                                                                      |
| TypeScript syntax in `main.js`                                                                   | Fails: `unexpected token in expression: 'interface'`                                                                                          |
| `import "./util.ts"` from `main.js`                                                              | Loads the file but parses it as JavaScript: `missing initializer for variable` on a typed `const` (0.1.12 reported `Unexpected token ':'`)    |
| `import "bun"` or `import "node:child_process"`                                                  | Fails: the only built-in modules are `gpui-kit`, `gpui`, `gpui-base`, `gpui-shell`, `gpui-fps` and `gpui-component`, plus the mod's own files |
| Globals                                                                                          | `Bun`, `Deno` and `WebAssembly` were undefined on 0.1.12                                                                                      |
| TypeScript bundled by `bun build --format esm` with `gpui-kit`, `gpui-base` and `herdr` external | Passes, including interfaces, enums, generics, type-only imports and class fields                                                             |

The 0.1.12 runtime also defined `process`, `require` and `setTimeout`. The app's `AGENTS.md` rules out Node APIs and `setTimeout`, so this project does not rely on any of them.

This repository therefore writes TypeScript in `src/`, uses Bun only for development (build, tests, scripts), and commits the bundled `mods/git/main.js`. Bun's default output keeps `// src/<file>.ts` markers; the comment rule applies to the sources, not to the bundle.

`gpui-kit.d.ts` says not to commit it, because the runtime rewrites it for each version. `herdr.d.ts` is also published at herdrdev/herdr-app `defaults/herdr.d.ts`[^published-dts], and on 2026-11-16 the published `master` copy was identical to the installed 0.1.16 file. `defaults/gpui-kit.d.ts` returns 404 there, so CI still cannot type-check code that imports Herdr modules.

### Placing the mod

Observed in the running Herdr app 0.1.12 on 2026-11-03 and not repeated since:

- A mod folder added while Herdr ran was not docked by its `mod.json` `place` and did not appear in `seen.json`, either as a copy or a symlink. Docking at the next start was not tested. `pane.split {direction, mod}` opened it at once.
- Deleting a mod folder closed the pane that showed it.
- Through a symlinked mod folder, Herdr drew `main.js` but no icon from `git.svg`. The 0.1.15 changelog says mod icons now load when the mod folder is a link.[^changelog] That fix was not observed here, and `bun run link` still copies the mod.

The Files and Changes buttons are still hard-coded in the shipped `tabs` mod on 0.1.16, and their panels still sit in the `panel-body` stack of the shipped `main` layout. A Git button beside them would need clones of both, as herdr-layout-research.md[^layout-research] describes. This repository's launcher does not use the tab bar, so it needs neither clone.

### Sharing on herdr.dev/mods

The app's `AGENTS.md` for 0.1.16 gives the same sharing steps as on 2026-11-03:[^app-agents]

1. Push the mod to a public GitHub repository.
2. Lay out one folder per mod like the app home: `mods/<name>/`, `RECIPE.md`, `preview.png`, and an optional `keys.json`. A layout has `layouts/<name>.json` instead.
3. Add the repository topic `herdr-mod`.
4. The mod appears under Community within the hour. On 2026-11-03 herdr.dev also said Herdr does not review mods and screens community pictures before showing them.[^herdr-mods]

One repository can hold several mods, one folder each. A repository with a single mod can use its root as that folder, as atuinsh/herdr-atuin-threads[^atuin-threads] and vytasgavelis/herdr-reviewer[^reviewer] do. This repository does the same.

#### How the listing works

herdr.dev builds both Community lists from two JSON files that a crawler writes. Read on 2026-11-16 from the index generated at 02:00 UTC:[^mods-index][^layouts-index]

| List    | Index                                         | Crawler query                  | Topic repositories | Skipped | Listed                            |
| ------- | --------------------------------------------- | ------------------------------ | ------------------ | ------- | --------------------------------- |
| Mods    | `https://assets.herdr.dev/mods/index.json`    | `topic:herdr-mod is:public`    | 742                | 104     | 821 mods from 638 repositories    |
| Layouts | `https://assets.herdr.dev/layouts/index.json` | `topic:herdr-layout is:public` | 433                | 15      | 459 layouts from 418 repositories |

On 2026-11-03 the same indexes listed 232 mods from 192 repositories and 131 layouts.

Each mod entry records `fullName`, `owner`, `repo`, `url`, `stars`, `pushedAt`, the default branch and head commit, the folder (`path`, empty for the repository root), `name`, `blurb`, `modNames` (the folders under `mods/`), `hasKeys`, `hasPreview`, `recipeBytes` and `previewUrl`. Layout entries record `layoutFiles` instead of `modNames` and `hasKeys`.

- On 2026-11-03, `name` and `blurb` matched the `# Name` heading and the first paragraph of `RECIPE.md` in the two entries compared, herdr-git-graph[^git-graph] and herdr-atuin-threads[^atuin-threads]. Write that paragraph for the card.
- On 2026-11-03 a card's install line read `Read ~/.config/herdr-app/AGENTS.md, then add this mod: <folder>`, where `<folder>` is the GitHub URL of the repository, plus `/tree/<branch>/<path>` for a subfolder. Community mods had no herdr.dev page of their own.
- The page shows previews only from `assets.herdr.dev/previews/`, Herdr's moderated copies (2026-11-03). On 2026-11-16, 43 of the 821 listed mods had no preview, so a preview is still not required to be listed.
- `herdrdev/herdr-layout-examples` is in the layouts index. On 2026-11-03 the page left it out of Community and showed Herdr's own examples separately.
- 47 repositories appear in both lists. fatwang2/Pulse[^pulse] keeps its mod in `herdr/pulse` and its layout in `herdr/pulse-layout`, and has both topics.

#### Why repositories go unlisted

The crawler does not document its rules. The 2026-11-16 index adds one stated rule: its warnings skip a repository whose `RECIPE.md` exceeds 64 KB.

On 2026-11-03 the crawler skipped 30 of 222 `herdr-mod` repositories, and the unlisted ones had these in common:

| What the repository had                                    | Unlisted repositories |
| ---------------------------------------------------------- | --------------------- |
| A `layouts/*.json` file next to its mods                   | 20                    |
| No `mods/<name>/main.js`                                   | 6                     |
| A mod but no `RECIPE.md`                                   | 4                     |
| Everything, but pushed at 06:19 UTC, after the 06:00 index | 1                     |

The 104 repositories skipped on 2026-11-16 were not broken down again. To be listed as a mod, a folder needs `mods/<name>/main.js` and a `RECIPE.md` under 64 KB, and no `layouts/` folder. A layout belongs in a separate folder with the `herdr-layout` topic, as Pulse does. A new push shows up after the next crawl.

#### RECIPE.md

The recipe is a brief another agent can build the mod from in an empty folder. The files are one build of it; if they fail on a newer Herdr, the agent rebuilds from the recipe. The app's `AGENTS.md` for 0.1.16 asks for this order, written from the real files:[^app-agents]

1. `# Name`, one paragraph of what the person sees, `![Name](preview.png)`
2. What you see: regions, sizes, colors, type, and what each shows
3. How it behaves: agent statuses, clicks, keys, hovers, what moves
4. Built from: mods and their `props`, `herdr` functions and commands, programs it runs
5. Watch out: what a fresh build would get wrong, limits, assumptions
6. Done when: checks that prove a build works

Lead with the person and what they see. Code goes only in Built from and Watch out. Be exact (`#ab7748`, 29px, `agent.focus`) and describe nothing the build does not do.

#### How a person installs it

The person tells their agent `Read ~/.config/herdr-app/AGENTS.md, then add this mod: <herdr.dev/mods/owner/name or a GitHub folder>`. Per the 0.1.16 `AGENTS.md`, the agent:[^app-agents]

1. Reads the recipe and every file, and tells the person if the mod reaches the network, runs programs (`exec`, `hc`), or reads files outside its folder. This mod runs `git` and `hc`.
2. Copies each `mods/<name>/` into the person's `mods/`, leaving out the recipe and preview. If the name is taken, it renames the new mod and its paths.
3. Adapts the files only where their assumptions do not hold, or rebuilds from the recipe when they fail on this version.
4. Merges `keys.json` into the person's keys and asks before replacing a key they use.
5. Runs `herdr-app check` on each mod.

#### keys.json

Sections are `global`, `layout:<name>`, `terminal`, and `mod:<name>`. An action is a command (`name` or `name:value`, where the value fills the first argument), `send:<text>`, `<mod>.<command>` delivered to that mod's `nextCommand()`, or `terminal`. An object `{"command", "args"}` passes named arguments.[^app-agents] `mod.open:<name>` toggles a mod as the overlay its `mod.json` describes. Since a key cannot pass the tab tree, this repository binds `cmd-g` to `mod.open:git` and lets the launcher choose the pane to split.

### Publish checklist

- [ ] Create the public repository `JeHwanYoo/herdr-git-mods`
- [ ] `bun run check` passes
- [ ] Try the mod in the running app with a local repository and a remote space
- [ ] Save `preview.png` from `herdr-app shot` with the mod visible
- [ ] Update `RECIPE.md` to match the files
- [ ] Keep `RECIPE.md` under 64 KB
- [ ] Add the topic `herdr-mod`
- [ ] Confirm the mod appears under Community on herdr.dev/mods
- [ ] Ask a fresh agent to install it from the GitHub URL and confirm the check passes

### Open questions

- Behavior on Linux and Windows. Not tested.
- Splitting a tab root by its id is undocumented. Re-run the scratch-tab probe[^probe] after each Herdr update.

## Footnotes

[^app-agents]: `~/.config/herdr-app/AGENTS.md`, Herdr app 0.1.16, sections "Layouts and mods other people made", "Keys", "Commands", and "Mods", checked on 2026-11-16.
[^herdr-dts]: `~/.config/herdr-app/herdr.d.ts`, Herdr app 0.1.16 (`exec`, `run`, `OverlaySpec`, `watchFolder`, `checking`), checked on 2026-11-16.
[^changelog]: `~/.config/herdr-app/update-notes-cache.md`, Herdr changelog entries 0.1.13 to 0.1.16, read on 2026-11-16.
[^probe]: `herdr-app do tab.new`, `pane.split` (three times, then once on the root id with `mod: "git"`), and `tab.close`, with the tree read through `hc connect` `doc.get`; Herdr app 0.1.16, hc 0.1.21, macOS, 2026-11-16.
[^herdr-git]: [herdr-git](https://github.com/JeHwanYoo/herdr-git)
[^herdr-git-sidebar]: [herdr-git TUI plugin, `src/herdr/sidebar.rs`](https://github.com/JeHwanYoo/herdr-git/blob/main/src/herdr/sidebar.rs), read on 2026-11-03.
[^published-dts]: [herdrdev/herdr-app `defaults/herdr.d.ts`](https://github.com/herdrdev/herdr-app/blob/master/defaults/herdr.d.ts), compared with `diff` on 2026-11-16.
[^layout-research]: [herdr-layout-research.md](herdr-layout-research.md)
[^herdr-mods]: [Herdr mods](https://herdr.dev/mods/), read on 2026-11-03.
[^mods-index]: [mods index](https://assets.herdr.dev/mods/index.json), `generatedAt` 2026-11-16T02:00:16Z.
[^layouts-index]: [layouts index](https://assets.herdr.dev/layouts/index.json), `generatedAt` 2026-11-16T02:00:16Z.
[^atuin-threads]: [atuinsh/herdr-atuin-threads](https://github.com/atuinsh/herdr-atuin-threads)
[^reviewer]: [vytasgavelis/herdr-reviewer](https://github.com/vytasgavelis/herdr-reviewer)
[^git-graph]: [rabeeh-ta/herdr-git-graph](https://github.com/rabeeh-ta/herdr-git-graph)
[^pulse]: [fatwang2/Pulse](https://github.com/fatwang2/Pulse)
