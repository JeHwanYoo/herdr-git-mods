# Herdr layout research

## Intent analysis

Determine how a Git panel could join Herdr's shipped tab bar beside Files and Changes, and what maintaining that integration would take.

The first investigation ran on 2026-11-03 against Herdr app 0.1.12 on macOS. On 2026-11-16 the shipped tab bar and layout were read again in Herdr app 0.1.16; the cloned build was not rebuilt. This repository no longer takes this approach: it opens Git as a full-height pane from a `cmd-g` launcher (see herdr-mods-research.md[^mods-research]), and `bun run link` no longer makes clones. The procedure below records how the tab-bar integration works.

## Research topics

1. How do the tab bar, side panel, and panel memory interact?
2. Which cloned files and edits does a Git button need?
3. How is the integration checked, undone, and rebuilt after updates?
4. What does shipping it as a layout require?

## Findings

Herdr has no extension point for a tab bar button, so the button has to be built from clones of two shipped files.

### What Herdr ships

Checked in Herdr app 0.1.16 on 2026-11-16; unchanged from 0.1.12.[^shipped]

| Piece        | Where                              | What it does                                                                                                 |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Tab bar      | `mods/tabs/main.js`                | Draws the Files and Changes buttons from code. Each button selects a child of `panel-body` and shows `panel` |
| Side panel   | `layouts/main.json`, node `panel`  | A hidden column holding the `panel-body` stack, with `files` and `changes` as children                       |
| Panel memory | `syncPanel` in `mods/tabs/main.js` | Reopens each space's last panel, but only a panel listed in `enabled`                                        |

Herdr replaces its shipped layouts and mods on every start and moves an edited one aside as `<name>-edited`, so the edits go into clones: `herdr-git` for the layout and `herdr-git-tabs` for the tab bar. Clones keep the code they were cloned from and record `cloned_from: {name, version}`.[^herdr-dts] This repository does not commit them, because a committed clone would freeze one Herdr version's tab bar.

### The changes

| File                          | Change                                           |
| ----------------------------- | ------------------------------------------------ |
| `mods/herdr-git-tabs/main.js` | Add `"git"` to `enabled`                         |
| `mods/herdr-git-tabs/main.js` | Add a Git `panelButton` after the Changes button |
| `layouts/herdr-git.json`      | Point the `tabs` block at `herdr-git-tabs`       |
| `layouts/herdr-git.json`      | Append a `git` block to the `panel-body` stack   |

Without the `enabled` change the button still draws, but `syncPanel` closes the Git panel when you switch spaces.

### Build it by hand

On 2026-11-03 a `bun run link` script applied these changes; it has since been removed. By hand, clone both files. `layout.clone` also switches the window to the clone.

```sh
herdr-app do mod.clone '{"name":"tabs","as":"herdr-git-tabs"}'
herdr-app do layout.clone '{"name":"main","as":"herdr-git"}'
```

In `mods/herdr-git-tabs/main.js`, replace the `enabled` line and add one line after the Changes button. The lines being replaced are the same in 0.1.12 and 0.1.16. The result reads:

```js
const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "git"];
```

```js
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .child(panelButton("git", "Git", "mods/git/git.svg"))
```

In `layouts/herdr-git.json`, set `content.mod` of the node with `"id": "tabs"` to `"herdr-git-tabs"`, and add this child to the `panel-body` stack:

```json
{ "id": "git", "type": "block", "content": { "mod": "git" } }
```

### Verify

```sh
herdr-app check ~/.config/herdr-app/mods/herdr-git-tabs
herdr-app check ~/.config/herdr-app/mods/git
herdr-app status
```

On 2026-11-03 both checks passed, and `status` reported `"layout": "herdr-git"` with no errors. Clicking Git showed the branch and changes of the focused terminal's repository, and clicking it again hid the panel. The current `mods/git` was not tried in a panel.

### Undo

Press `ctrl-shift-l` to return to `main`, then delete `layouts/herdr-git.json` and `mods/herdr-git-tabs/`. Keep `mods/git/` if you still use it.

### After a Herdr update

The clones keep the old tab bar and layout. To pick up Herdr's changes, undo, then build again.

### Shipping a layout instead

herdr.dev lists layouts separately, from repositories with the `herdr-layout` topic and a `layouts/<name>.json`. fatwang2/Pulse[^pulse] ships one next to its mod: on 2026-11-03, `herdr/pulse-layout/layouts/herdr-pulse.json` was a clone of `main` from Herdr 0.1.12 with a `pulse` block docked on the right. It keeps Herdr's own `tabs`, so it adds no button.

A layout with the Git button would have to ship the `tabs` clone too, which freezes Herdr's tab bar code at one version for everyone who installs it. A folder with a `layouts/` file is not listed as a mod, so a layout would need its own folder and topic. See herdr-mods-research.md[^unlisted].

### Credit

rabeeh-ta/herdr-git-graph[^git-graph] adds its Git Graph panel to the tab bar with the same two clones.

## Footnotes

[^mods-research]: [herdr-mods-research.md](herdr-mods-research.md#how-this-repository-opens-git)
[^shipped]: `~/.config/herdr-app/mods/tabs/main.js` (`syncPanel`, `enabled`, `panelButton` lines) and `~/.config/herdr-app/layouts/main.json` (nodes `tabs`, `panel`, `panel-body`), Herdr app 0.1.16, checked on 2026-11-16.
[^herdr-dts]: `~/.config/herdr-app/herdr.d.ts`, Herdr app 0.1.16, `run` command list, checked on 2026-11-16.
[^pulse]: [fatwang2/Pulse](https://github.com/fatwang2/Pulse)
[^unlisted]: [herdr-mods-research.md](herdr-mods-research.md#why-repositories-go-unlisted)
[^git-graph]: [rabeeh-ta/herdr-git-graph](https://github.com/rabeeh-ta/herdr-git-graph)
