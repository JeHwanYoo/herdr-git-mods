# Herdr Git Mods

A Git client for Herdr App.

Runs in the [Herdr App](https://herdr.dev) with the interface of the [herdr-git](https://github.com/JeHwanYoo/herdr-git) TUI plugin.

Everything Git, in one pane. No extra setup, no overlays covering your Herdr.

## Install

Requires the Herdr App 0.1.16 or later and Git.

Tell your agent in Herdr:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: github.com/JeHwanYoo/herdr-git-mods
```

Focus a terminal in a Git repository and press ⌘G to open Git on the right of the tab. Press ⌘G again to close it.

## Features

| Feature                     | What you can do                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changes                     | Review changed files, stage or unstage them, and discard tracked changes                                                                           |
| Diffs                       | View changes side by side and compare commits or branches                                                                                          |
| Graph                       | Browse and filter commit history with a lane graph                                                                                                 |
| Files                       | Browse repository files, search file names and contents, and preview files with syntax highlighting, working-tree changes, blame, and line history |
| Blame & line history        | See who changed selected lines and review their history                                                                                            |
| Copy                        | Copy selected code with its file path and line numbers                                                                                             |
| Commit                      | Create or amend a commit                                                                                                                           |
| Remotes                     | Add, view, or remove remotes; fetch, pull, and choose where to push                                                                                |
| Branches & tags             | Find and switch branches, create branches and tags, and rename or delete local branches                                                            |
| Rebase                      | Rebase onto a branch or commit, including interactive rebase                                                                                       |
| Cherry-pick, revert & reset | Apply a commit, undo it, or reset to it                                                                                                            |
| Stash                       | Save uncommitted changes and restore them                                                                                                          |
| Workspaces                  | Switch between repositories, Projects, and worktrees                                                                                               |

## Keyboard shortcuts

Hold `Alt` to see all keyboard shortcuts.

## Development

Install [Bun](https://bun.com), then run:

```sh
bun install
bun run check  # Lint, type check, tests, build, and herdr-app check
bun run link   # Build and install the mod into Herdr
```

## Contributing

[Contribution guide](CONTRIBUTING.md)

## License

[MIT](LICENSE)
