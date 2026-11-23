# Contributing

You can contribute bug reports, fixes, documentation, and feature proposals.

## Before you start

Search existing issues and pull requests for the same problem. For a new feature or a change across several modules, open an issue to discuss the scope before implementing it. Small fixes and documentation edits can go directly to a pull request.

Use the issue templates. For bugs, include steps to reproduce, expected and actual behavior, and your Herdr app, OS, and Git versions. For feature requests, describe the task you are trying to complete and how the proposed behavior would help.

Remove private repository data and credentials from logs and screenshots.

## Set up development

Install [Bun](https://bun.com) 1.4.4 or later, Git, and the [Herdr app](https://herdr.dev/download/). The type check reads Herdr's type declarations from `~/.config/herdr-app`, so start the Herdr app once before running it, or set `HERDR_APP_HOME`.

1. Open [JeHwanYoo/herdr-git-mods](https://github.com/JeHwanYoo/herdr-git-mods) on GitHub and click **Fork** to create a copy under your account.
2. Clone your fork below. Replace `YOUR_USERNAME` with your GitHub username.
3. Create a branch from `main`, install the development dependencies, and run the checks.

```sh
git clone https://github.com/YOUR_USERNAME/herdr-git-mods.git
cd herdr-git-mods
git switch -c describe-your-change
bun install
bun run check
```

Edit the TypeScript in `src/`. `bun run build` bundles it into `mods/git/main.js`, the file Herdr loads. Commit the built file with your change: Herdr installs mods by copying files and runs no build step.

To try your build in the running Herdr app:

```sh
bun run link     # Build, check, and copy the mod into Herdr
bun run unlink   # Remove the mod installed by link
```

The mod is copied to `~/.config/herdr-app/mods/git/`, or `$HERDR_APP_HOME/mods/git/` if set. Merge the repository's `keys.json` binding into the Herdr home's `keys.json`, preserving existing bindings and asking before replacing a conflicting key, then press ⌘G to open and close the rightmost Git pane. Run `bun run link` after each change; Herdr reloads the copied mod. The script refuses to overwrite or remove a mod it did not install. If the mod breaks, Herdr keeps the last working version running and reports the error in `herdr-app status`.

## Make a change

Keep each pull request focused on one problem. Read [AGENTS.md](AGENTS.md) for the file index, then follow the conventions it lists:

- [CODING_STANDARDS.md](docs/CODING_STANDARDS.md): no comments
- [TESTING.md](docs/TESTING.md): what a test must prove, and the tests to avoid
- [DESIGN.md](docs/DESIGN.md): interface parity with herdr-git: cell grid, colors, and screen layout
- [ARCHITECTURE.md](docs/ARCHITECTURE.md): source layout and allowed module dependencies

For code changes, run `bun run check` before opening a pull request. Run `bun run lint:fix` first to apply formatting and safe lint fixes.

| Script                   | What it does                                              |
| ------------------------ | --------------------------------------------------------- |
| `bun run lint`           | Biome: formatting, lint rules, and import order           |
| `bun run check-comments` | Rejects comments in `src/`, `tests/`, and `scripts/`      |
| `bun run typecheck`      | TypeScript in strict mode, with Herdr's type declarations |
| `bun test`               | Tests against real Git repositories                       |
| `bun run build`          | Bundles `src/` into `mods/git/main.js`                    |
| `bun run check-mod`      | Loads the mod once with `herdr-app check`                 |
| `bun run check`          | All of the above                                          |

CI runs `bun run ci`: lint, the comment check, the type check of tests and scripts, the tests, and a check that `mods/git/main.js` matches `src/`. CI has no Herdr app, so it cannot type-check `src/main.ts` or run `herdr-app check`. Run `bun run check` locally for those. Add regression tests when the risk and impact justify them.

For UI changes, test the affected workflow in the Herdr app and attach a screenshot. `herdr-app shot` saves the current window as a PNG. Use a disposable repository when testing Git operations that change files or history.

For documentation changes, check links, commands, and formatting. Keep README.md focused on current usage and describe feature changes in your pull request.

The repository owner updates `RECIPE.md` and `preview.png` for releases. Leave them unchanged in contribution pull requests unless the maintainer asks.

## Open a pull request

Push your branch to your fork and open a pull request against `main`. Use the [PR template](.github/pull_request_template.md), replace its prompts with your answers, and keep its section headings. Write a title that names the change.

Explain the problem and resulting behavior, link related issues, and report the checks you ran with their results. If you could not run a check, say which one and why. Include steps for testing behavior that automated checks do not cover. Mark unfinished work as a draft.

## References

The workflow follows the contribution practices in [Open Source Guides](https://opensource.guide/how-to-contribute/). GitHub documents how to expose [contribution guidelines](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors) and configure [issue and pull request templates](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests).
