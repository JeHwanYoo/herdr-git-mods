# Agents

## Docs

| Doc                                                  | What it decides                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [README.md](README.md)                               | Install and current features, for people using the mod                                          |
| [RECIPE.md](RECIPE.md)                               | The brief Herdr agents build the mod from; listed on herdr.dev/mods                             |
| [CONTRIBUTING.md](CONTRIBUTING.md)                   | Development setup, checks, and pull requests                                                    |
| [docs/CODING_STANDARDS.md](docs/CODING_STANDARDS.md) | No comments; deep modules                                                                       |
| [docs/TESTING.md](docs/TESTING.md)                   | What tests prove and which tests to avoid                                                       |
| [docs/DESIGN.md](docs/DESIGN.md)                     | Interface parity with herdr-git: cell grid, colors, screen layout, and known differences        |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)         | Source layout, module dependencies, and Herdr runtime rules                                     |
| [docs/research/\*](docs/research/)                   | Research behind decisions, such as how Herdr mods are shared and how Herdr lays out its tab bar |

## Documentation guidelines

Write all documentation in English.

Limit documentation to shared rules and keep it minimal. Update existing documents when shared rules change. Record change-specific decisions and validation in a pull request or the developer's issue tracker; do not create separate records unless requested.

Write README.md for people using the mod: easy to scan, focused on current usage. Record feature changes in a pull request or the developer's issue tracker.

## Pull requests

Use the [PR template](.github/pull_request_template.md) when opening or updating a pull request. Keep its headings and replace the prompts with your answers.

## Review responsibility

Reviews must assess changes against the guidelines in `docs/`, regardless of who performs the review or which tool is used.

## Local testing

Start Herdr once, install dependencies with `bun install`, and run `bun run link` to build, check, and copy the mod into `~/.config/herdr-app/mods/git/` (or `$HERDR_APP_HOME/mods/git/`). Merge the root `keys.json` binding into the Herdr home's `keys.json`, preserving existing bindings and asking before replacing a conflicting key. In Herdr, focus a terminal in a Git repository and press ⌘G to open or close the rightmost Git pane. Run `bun run link` after changes to reload the mod, and use `herdr-app shot` to record UI verification. `bun run unlink` removes the mod installed by the script; remove the key binding separately if no longer needed.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
