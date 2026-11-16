# Coding standards

## No comments

Express intent through names, small functions, and constants.

Line and block comments are forbidden in `.ts` files under `src/`, `tests/`, and `scripts/`. String and regex contents and the generated `mods/git/main.js` are exempt. `bun run check-comments` parses files and reports comment locations by file, line, and column; CI runs the same check.

Put explanations in pull requests, `RECIPE.md`, or convention documents.

## TypeScript

- `tsconfig.json` runs the compiler in strict mode with `noUncheckedIndexedAccess`, `noImplicitOverride`, and unused-code checks. Fix the code instead of loosening an option.
- Do not use `any`, non-null assertions (`!`), or `@ts-` directives. Narrow the type with a check. Use type assertions (`as`) only when an external API's type declarations are inaccurate and you have verified the value's type.
- Import types with `import type` or inline `type` specifiers.
- Code in `src/` runs in Herdr's QuickJS runtime. Use only `gpui-kit`, `gpui-base`, `herdr`, and the language itself.

## Lint and format

[Biome](https://biomejs.dev) formats and lints every file it supports, configured in `biome.json`. It runs its recommended rules plus stricter ones: no unused imports, variables, or parameters, no `any`, no `console` outside `scripts/`, `const` where possible, and a limit on cognitive complexity per function. `bun run lint` reports problems and `bun run lint:fix` applies formatting, import order, and safe fixes.

Do not disable a rule in a file. If a rule is wrong for the project, change `biome.json` in its own pull request and explain why.

## Deep modules

A deep module hides a lot of work behind a small interface. Callers get a large result from a simple call and never learn how the module produces it. Hiding complexity this way keeps it out of the rest of the system.

- **Keep the interface small.** Export as few functions, arguments, and fields as the callers need. Each one is something every caller has to learn.
- **Keep the implementation deep.** Move parsing, edge cases, retries, and format details inside the module. A caller should not handle a case the module could have handled.

Signs that a module is shallow:

- Callers call several of its functions in a fixed order.
- Callers inspect its output to handle cases the module could have handled.
- Its interface is about as long as its implementation.
- Changing its internals forces changes in its callers.

Merge a shallow module into its caller, or move more of the work behind its interface.
