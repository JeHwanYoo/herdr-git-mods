# Testing

Put Git and Herdr runtime tests in `tests/git/` and `tests/runtime/`.

A test earns its place when it can catch a bug a user would hit. Test behavior through a module's public interface, with real inputs, and assert on results a user or caller can observe.

## How this project tests

- Git logic runs against real Git. `tests/` creates temporary repositories, puts them in the state under test (a conflict, a rename, a detached HEAD, an upstream ahead and behind), and calls the module. Tests run Git with an empty global configuration so your own settings cannot change the result.
- Tests run under Bun, which has no Herdr runtime. Modules that tests reach must not import `gpui-kit`, `gpui-base`, or `herdr`. Pass the Herdr dependency in, as `readRepository(git)` does, so the test can pass real Git.
- Herdr UI cannot run under Bun. Verify UI changes with `herdr-app check` and in the running app, and record the result with `herdr-app shot`.
- Before adding a test, break the code it covers and confirm the test fails.

Run the tests with `bun test`, or every check with `bun run check`.

## Tests to avoid

### Tautological tests

The test repeats the implementation. The code defines `WIDE_COLUMNS = 90` and the test asserts that same value.

Bad case:

```ts
const WIDE_COLUMNS = 90;

test("the wide layout starts at 90 columns", () => {
  expect(WIDE_COLUMNS).toBe(90);
});
```

This passes even if the Changes tab never switches layout at that width.

Such a test checks how the code is written, so it fails on a rename or a harmless refactor. It never checks what the value does.

### Structure-sensitive tests

The test enforces how the source is organized instead of what the program does: it reads source files to check their names, the order of elements, or which function calls which.

Bad case:

```ts
test("the view reads the repository", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  expect(source).toContain("readRepository(");
});
```

Finding a function call in the source does not prove that the view renders its result or handles its errors.

These tests break on any reorganization and stay green while users see wrong behavior or unhandled errors.

### Tests that cannot fail

The test replaces a complex dependency with a mock or stub so simple that the behavior under test disappears. A stub `exec` that always returns clean `git status` output passes every time and never meets a detached HEAD, a merge conflict, a path with spaces, or a corrupt index.

Bad case:

```ts
const git: RunGit = async (args) => ({
  code: 0,
  stdout: args.includes("rev-parse") ? "/tmp/repo\n" : "# branch.head main\0",
  stderr: "",
});

test("Git failures are handled", async () => {
  await expect(readRepository(git)).resolves.toMatchObject({ state: "ready" });
});
```

The stub always succeeds, so this test never exercises the failure its name claims to cover. Removing error handling would leave it green. A clean-repository test alone also cannot establish that conflicts or renames work.

These tests stay green while the same code fails in production. Use the real dependency. When that is too slow or unsafe, reproduce the failure modes the real one has and show that the test fails when the code under test is wrong.
