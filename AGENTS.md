# Agents

## Docs

| Doc                                                  | What it decides                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [README.md](README.md)                               | Install and current features, for people using the mod                                          |
| [RECIPE.md](RECIPE.md)                               | The brief Herdr agents build the mod from; listed on herdr.dev/mods                             |
| [CONTRIBUTING.md](CONTRIBUTING.md)                   | Development setup, checks, and pull requests                                                    |
| [docs/CODING_STANDARDS.md](docs/CODING_STANDARDS.md) | No comments                                                                                     |
| [docs/TESTING.md](docs/TESTING.md)                   | What tests prove and which tests to avoid                                                       |
| [docs/DESIGN.md](docs/DESIGN.md)                     | Interface parity with herdr-git: cell grid, colors, screen layout, and known differences        |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)         | Source layout, module dependencies, and Herdr runtime rules                                     |
| [docs/research/\*](docs/research/)                   | Research behind decisions, such as how Herdr mods are shared and how Herdr lays out its tab bar |

## Documentation guidelines

Write all documentation in English.

Limit documentation to shared rules and keep it minimal. Update existing documents when shared rules change. Record change-specific decisions and validation in a pull request or the developer's issue tracker; do not create separate records unless requested.

Write README.md for people using the mod: easy to scan, focused on current usage. Record feature changes in a pull request or the developer's issue tracker.

## Commit messages

Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).

- `feat(files): preview working-tree images`

## Pull requests

Use the [PR template](.github/pull_request_template.md) when opening or updating a pull request. Keep its headings and replace the prompts with your answers.

## Review responsibility

Reviews must assess changes against the guidelines in `docs/`, regardless of who performs the review or which tool is used.

## Local testing

Start Herdr once, install dependencies with `bun install`, and run `bun run link` to build, check, and copy the mod into `~/.config/herdr-app/mods/git/` (or `$HERDR_APP_HOME/mods/git/`). The link script merges the root ⌘G binding into the Herdr home's `keys.json` and asks before replacing a conflicting global binding. In Herdr, focus a terminal in a Git repository and press ⌘G to open or close the rightmost Git pane. Run `bun run link` after changes to reload the mod, and use `herdr-app shot` to record UI verification. `bun run unlink` removes the mod installed by the script; remove the key binding separately if no longer needed.
