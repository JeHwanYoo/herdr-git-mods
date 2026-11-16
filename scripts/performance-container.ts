import assert from "node:assert/strict";
import { resolve } from "node:path";
import { GenericContainer } from "testcontainers";
import { phase } from "./performance-progress.ts";

console.log("Linux container performance gate · 2 CPU / 2 GiB · live benchmark output");
if (!process.env.DOCKER_HOST) {
  console.log("[SETUP] Resolving Docker context");
  const context = Bun.spawnSync(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  assert.equal(context.exitCode, 0, context.stderr.toString());
  process.env.DOCKER_HOST = context.stdout.toString().trim();
}

const image = await phase("Build benchmark image (base image pull / apt install may take several minutes)", () =>
  GenericContainer.fromDockerfile(resolve("scripts/performance-container")).build(),
);
const container = await phase("Start container and copy benchmark sources", () =>
  image
    .withResourcesQuota({ cpu: 2, memory: 2 })
    .withCopyDirectoriesToContainer([{ source: resolve("src"), target: "/app/src" }])
    .withCopyFilesToContainer([
      { source: resolve("scripts/performance.ts"), target: "/app/scripts/performance.ts" },
      { source: resolve("scripts/performance-progress.ts"), target: "/app/scripts/performance-progress.ts" },
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
      container.getId(),
      "bun",
      "scripts/performance.ts",
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await benchmark.exited;
  console.log("[REPORT] Copying benchmark measurements from container");
  const report = await container.exec(["cat", "/tmp/performance.json"]);
  assert.equal(report.exitCode, 0, report.output);
  await Bun.write(process.env.PERF_REPORT ?? "performance.json", report.stdout);
  if (exitCode !== 0) {
    console.error(
      `Performance gate failed. See the FAIL rows above and ${process.env.PERF_REPORT ?? "performance.json"}.`,
    );
    process.exitCode = 1;
  }
} finally {
  await phase("Stop and remove benchmark container", () => container.stop());
}
