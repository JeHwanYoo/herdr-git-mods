# Coding standards

## No comments

Express intent through names, small functions, and constants.

Line and block comments are forbidden in `.ts` files under `src/`, `tests/`, and `scripts/`. String and regex contents and the generated `mods/git/main.js` are exempt. `bun run check-comments` parses files and reports comment locations by file, line, and column; CI runs the same check.

Put explanations in pull requests, `RECIPE.md`, or convention documents.

## TypeScript

- `tsconfig.json` runs the compiler in strict mode with `noUncheckedIndexedAccess`, `noImplicitOverride`, and unused-code checks. Fix the code instead of loosening an option.
- Do not use `any`, non-null assertions (`!`), or `@ts-` directives. Narrow the type with a check. Use type assertions (`as`) only when an external API's type declarations are inaccurate and you have verified the value's type.
- Import types with `import type` or inline `type` specifiers.
- Code in `src/` runs in Herdr's QuickJS runtime. Use `gpui-kit`, `gpui-base`, `herdr`, and the language itself. Release verification uses the host’s native `crypto` module.

## Lint and format

[Biome](https://biomejs.dev) formats and lints every file it supports, configured in `biome.json`. It runs its recommended rules plus stricter ones: no unused imports, variables, or parameters, no `any`, no `console` outside `scripts/`, `const` where possible, and a limit on cognitive complexity per function. `bun run lint` reports problems and `bun run lint:fix` applies formatting, import order, and safe fixes.

Do not disable a rule in a file. If a rule is wrong for the project, change `biome.json` in its own pull request and explain why.
