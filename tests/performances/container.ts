import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { GenericContainer } from "testcontainers";
import { performanceCacheDirectory } from "./fixture-cache.ts";
import { phase } from "./progress.ts";
import { parseSelection, usage } from "./selection.ts";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log(usage);
  process.exit(0);
}
const selection = parseSelection(args);
const reportPath = process.env.PERF_REPORT ?? (selection.source ? "performance-full.json" : "performance.json");

console.log("Linux container performance gate · 2 CPU / 2 GiB · live benchmark output");
if (!process.env.DOCKER_HOST) {
  console.log("[SETUP] Resolving Docker context");
  const context = Bun.spawnSync(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  assert.equal(context.exitCode, 0, context.stderr.toString());
  process.env.DOCKER_HOST = context.stdout.toString().trim();
}

const mounts = selection.source
  ? [{ source: resolve(selection.source), target: "/full-linux", mode: "ro" as const }]
  : [{ source: performanceCacheDirectory(), target: "/performance-cache", mode: "rw" as const }];
if (!selection.source) {
  const cache = performanceCacheDirectory();
  await mkdir(cache, { recursive: true });
  console.log(`[CACHE] Persistent host directory: ${cache}`);
}

const image = await phase("Build benchmark image (base image pull / apt install may take several minutes)", () =>
  GenericContainer.fromDockerfile(resolve("tests/performances")).build(),
);
const container = await phase("Start container and copy benchmark sources", () =>
  image
    .withResourcesQuota({ cpu: 2, memory: 2 })
    .withUser(`${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`)
    .withBindMounts(mounts)
    .withCopyDirectoriesToContainer([
      { source: resolve("src"), target: "/app/src" },
      { source: resolve("tests/performances"), target: "/app/tests/performances" },
    ])
    .start(),
);
try {
  console.log("[VERIFY] Checking enforced cgroup CPU and memory limits");
  const limits = await container.exec(["sh", "-c", "cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max"]);
  assert.equal(limits.exitCode, 0, limits.output);
  const [cpu, memory] = limits.stdout.trim().split("\n");
  const [quota, period] = (cpu ?? "").split(" ").map(Number);
  assert.equal(Number(quota) / Number(period), 2);
  assert.equal(Number(memory), 2 * 1024 ** 3);
  console.log("Verified cgroup limits: 2 CPU, 2 GiB", limits.stdout.trim());
  console.log("[RUN] Streaming benchmark output; clone/setup are excluded from scenario budgets");
  const benchmark = Bun.spawn(
    [
      "docker",
      "exec",
      "--env",
      "PERF_REPORT=/tmp/performance.json",
      "--env",
      "PERF_CACHE_DIR=/performance-cache",
      container.getId(),
      "bun",
      "tests/performances/runner.ts",
      ...(selection.source ? ["full-history", "/full-linux"] : args),
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await benchmark.exited;
  console.log("[REPORT] Copying benchmark measurements from container");
  const report = await container.exec(["cat", "/tmp/performance.json"]);
  assert.equal(report.exitCode, 0, report.output);
  await Bun.write(reportPath, report.stdout);
  if (exitCode !== 0) {
    console.error(`Performance gate failed. See the FAIL rows above and ${reportPath}.`);
    process.exitCode = 1;
  }
} finally {
  await phase("Stop and remove benchmark container", () => container.stop());
}
