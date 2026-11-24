# Testing

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

## Linux performance gate

Run `bun run performance` locally or use the Linux performance workflow. It maintains a persistent bare Linux cache, then clones the pinned v6.12 commit into an automatically removed temporary directory with depth 1 and a complete working tree. Cache/download/checkout setup is excluded from scenario timings. This bounds CI cost; it does not model full-history traversal, every ref, or GUI rendering in Herdr.

The gate calls production modules with real Git and validates their results. Each scenario records its first call separately and 20 subsequent calls. The nearest-rank p95 must meet the budget below; every call, including the first, must remain below twice that budget. The first call is not a cold-cache measurement: checkout and earlier scenarios affect filesystem caches. Thresholds are product targets, not guarantees for every machine: ordinary actions should complete within half a second, previews within 200 ms, and repository-wide search within one second.

| Scenario                              | p95 budget |
| ------------------------------------- | ---------- |
| Repository status                     | 500 ms     |
| File listing and tree construction    | 300 ms     |
| First 100 synthetic history entries   | 500 ms     |
| Repository content search             | 1000 ms    |
| Blame for 40 visible lines            | 500 ms     |
| Working diff preview                  | 200 ms     |
| Changes from a shared status snapshot | 500 ms     |
| Stage and status refresh of one file  | 500 ms     |

Any exceeded budget or incorrect result fails the job. `performance.json` records samples and environment; override its location with `PERF_REPORT`. CI uploads it even on failure. Compare Linux runner results separately from local OS results. Clone failures fail the job rather than skipping the gate. This benchmark modifies only its disposable clone.

Linux history is deliberately excluded: 120 local commits sharing the Linux tree exercise history pagination without downloading ancestry. Blame covers only the shallow snapshot; neither scenario establishes deep-history performance. Path ranking has a separate 100 ms p95 budget because it runs during interactive search (the UI also debounces input by 120 ms). Staging cleanup runs outside the measured interval. These are component budgets: host IPC, repository facts, workspaces, QuickJS execution, layout, and drawing require separate Herdr validation before claiming end-to-end responsiveness.

Changes follows the current refresh path: status is read once outside its timing, then `readChanges` receives that snapshot and checks tracked plus untracked changes. This measures the Changes read after status, not the whole refresh or concurrent Changes/Workspaces request sharing. The shallow/synthetic history scenario exercises the current history module but does not validate full-history commit-graph preparation or redundant-ref reduction; use `performance:full` for that.

### Persistent fixture cache

- Missing cache: clone v6.12, fetch upstream's current HEAD, verify the pinned fixture, then publish the completed cache. A failed download or validation does not publish a partial repository.
- Existing cache: verify its upstream and pinned revision, then fetch upstream HEAD and the fixture tag before every run. Fetch failures fail the run; an old cache is not silently accepted as current.
- The cache tracks upstream HEAD in `refs/heads/upstream`, but the benchmark stays at v6.12 commit `adc218676eef25575469234709c2d87185ca223a`. Updating upstream must not change the benchmark dataset or budgets.
- Default cache directory: `$XDG_CACHE_HOME/herdr-git-mods/performance`, or `~/.cache/herdr-git-mods/performance` when XDG is unset. Set `PERF_CACHE_DIR` to override it for either command.
- Each run clones over Git's local file transport into its own temporary working tree, with no alternates or shared object files. Fixture edits and synthetic commits never modify the cache. Deleting the cache does not invalidate an already-created test checkout.
- Cache contents survive benchmark/container cleanup. To force a fresh download, remove only `linux-v6.12.git` inside the cache directory when no cache setup is running. Interrupted first downloads may leave `.linux-download-*` directories; they are never used as a valid cache.

```sh
PERF_CACHE_DIR=/path/to/performance-cache bun run performance
PERF_CACHE_DIR=/path/to/performance-cache bun run performance:container
```

The first download also fetches current upstream HEAD, so it is still network-bound. Later runs fetch updates and perform a local checkout, not another full GitHub clone. Checkout still reads/writes the complete Linux working tree; caching does not make setup instantaneous or establish a cold filesystem-cache measurement.

Cache verification uses real Git regression tests for upstream advancement, pinned/private checkouts, failed publication and fetch failures. A local smoke run with two separate containers confirmed a cache miss followed by a hit, upstream refresh, isolation from test mutations, and host-user ownership after container removal. The Linux-sized cold/warm run was not completed: GitHub's ref endpoint stalled even for `ls-remote` over HTTP/1.1 and HTTP/2, and the clone timed out. No Linux cache speedup is claimed from that attempt.

### Constrained Linux runner

`bun run performance:container` shares the same persistent host cache directory at `/performance-cache`. Git clone/fetch run inside the container, using its Git/network environment; cache writes use the host UID/GID to remain writable by ordinary local runs. Testcontainers builds the image, copies the current source, and runs the gate with 2 CPU cores and 2 GiB of memory. The mutable benchmark checkout lives on the container filesystem, separate from the cache bind mount. It verifies cgroup v2 limits before measuring and stops the container in `finally`; Testcontainers' resource reaper handles abandoned resources. Docker must be running and able to bind-mount the host cache path (Docker Desktop file sharing applies). The launcher uses `DOCKER_HOST` when provided or resolves the active Docker context.

CI restores and saves the host cache with GitHub Actions cache, using the fixture version and runner OS as the restore prefix and a per-run key to save fetched updates. It runs the same container command and uploads `performance.json`. CPU quotas bound available CPU time rather than emulate a particular processor generation; local ARM and CI x86 results are not interchangeable. This is a backend and pure UI-data performance gate, not a GPU, frame-time, or native Herdr integration benchmark.

All three performance commands announce their scope and report path. Excluded setup/cleanup phases print start/end messages and elapsed time every five seconds while waiting. Each measured scenario announces its p95 and maximum budgets, then reports sample 1, every fifth sample, and sample 21. Sample progress is printed after the elapsed time is captured; no progress timer runs inside measured scenarios, including the full-history baseline and preparation-plus-first-page measurement.

The container runner announces Docker build/start before waiting and streams the benchmark's stdout/stderr live through `docker exec`, rather than buffering until completion. Docker context/host selection, enforced quotas, report copying, exit-code propagation and Testcontainers cleanup remain in the launcher. Image build, clone and checkout time are not scenario latency budgets.

The content-search latency case measures the first 1,000 matches for `schedule`. Search visits literal file paths in bounded batches and stops at the existing UI result cap. This does not establish the same latency for rare or absent terms, which require a full scan. Re-run the container gate in independent containers when assessing performance changes; one passing run is insufficient evidence of stability.

Local verification (2026-11-16, Linux arm64 container, 2 CPU / 2 GiB): all nine component scenarios passed. The shared-status Changes read measured p95 100.8 ms and maximum 101.7 ms. The run exercised live container output, five-second clone wait updates, sample progress, report copying and container cleanup. This was one run, not a stability claim or a rerun of the full-history/native UI gates.

### Full-history Linux gate

Run `bun run performance:full /path/to/full/linux` in addition to the bounded CI fixture. The source must be a local, non-shallow Linux clone with more than 500,000 reachable commits and 70,000 files. The gate creates a disposable complete checkout using shared read-only source objects; edits and commit-graph writes belong to the disposable clone, not the source. Keep the source available and do not prune its objects while the gate runs.

The report (`performance-full.json`, or `PERF_REPORT`) records the revision, commit/ref/file counts, environment, setup, an unprepared first-page traversal, one-time graph preparation, and preparation plus the first usable page. Clone/setup is excluded. The unprepared traversal explicitly disables commit-graph reads, even when the source already has an index. These are not cold filesystem-cache measurements.

| Full-history scenario                    | p95 budget | Maximum individual call |
| ---------------------------------------- | ---------- | ----------------------- |
| Prepared first 100 commits               | 500 ms     | 1,000 ms                |
| Prepared next 100 commits                | 500 ms     | 1,000 ms                |
| Changes from an existing status snapshot | 500 ms     | 1,000 ms                |

Each scenario records the first call and 20 further samples. Pagination walks 2,200 commits and checks exact order and uniqueness against Git's traversal of the frozen revisions. Before/after preparation must return identical first-page data. Changes includes a tracked edit and an untracked file; its timing excludes the preceding status call, not merely the Git process portion. Failures and budget violations make the command fail. One-time preparation is reported separately and is not hidden in the prepared latency figures.

For native UI acceptance, verify the same source in Herdr's QuickJS runtime: preparation must allow tab switching, and a prepared Graph request must reach its rendered commit list within one second. A Bun-only gate does not establish this. Use a temporary probe around the production view plus `herdr-app shot` rather than replacing the view with a benchmark-only screen. Remove the probe after verification. Neither the local gate nor this UI target replaces the separately constrained Linux CI measurements.

#### Local full-history result (2026-11-16)

macOS arm64, Apple Git 2.54.0, Bun 1.4.4; Linux `aebb7274476403040d582c61478df8f4a7bf9cd3`, 1,507,066 reachable commits, 97,371 files and 957 refs. The unprepared first-page traversal took 8,950 ms. One-time preparation took 14,891 ms; preparation plus the first page took 15,076 ms. Preparation therefore makes the first use slower, not faster; subsequent queries use the persistent Git index.

| Scenario                   | Measured p95 | Measured maximum |
| -------------------------- | ------------ | ---------------- |
| Prepared first 100 commits | 214 ms       | 260 ms           |
| Next 100 commits           | 56 ms        | 65 ms            |
| Changes after status       | 189 ms       | 196 ms           |

All three budgets passed, with exact first-page equivalence and 2,200 commits checked for order and duplication. These local measurements do not claim the same timings on the constrained Linux container or other hardware.

Herdr 0.1.16 / QuickJS was verified with the production view in an isolated full Linux checkout: five uninterrupted foreground requests reached Graph view rendering in 218, 212, 251, 215 and 225 ms (maximum 251 ms, versus the 1,000 ms UI target). The final native screenshot showed the populated graph and commit details. During preparation, switching to Settings reached its view render in 13 ms. These are request-to-view-render timings, not GPU frame-time measurements. Earlier attempts interrupted by tab changes were rejected; no interrupted samples were used in the successful five-request run.

Typechecking, all 64 tests, the generated production bundle and `herdr-app check` passed. The temporary native probe and checkout were removed after verification; the production mod was installed with the project's link script.
