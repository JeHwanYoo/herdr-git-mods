import assert from "node:assert/strict";
import { resolve } from "node:path";
import { GenericContainer } from "testcontainers";

if (!process.env.DOCKER_HOST) {
  const context = Bun.spawnSync(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  assert.equal(context.exitCode, 0, context.stderr.toString());
  process.env.DOCKER_HOST = context.stdout.toString().trim();
}

const image = await GenericContainer.fromDockerfile(resolve("scripts/performance-container")).build();
const container = await image
  .withResourcesQuota({ cpu: 2, memory: 2 })
  .withCopyDirectoriesToContainer([{ source: resolve("src"), target: "/app/src" }])
  .withCopyFilesToContainer([{ source: resolve("scripts/performance.ts"), target: "/app/scripts/performance.ts" }])
  .start();
try {
  const limits = await container.exec(["sh", "-c", "cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max"]);
  assert.equal(limits.exitCode, 0, limits.output);
  const [cpu, memory] = limits.stdout.trim().split("\n");
  const [quota, period] = (cpu ?? "").split(" ").map(Number);
  assert.equal(Number(quota) / Number(period), 2);
  assert.equal(Number(memory), 2 * 1024 ** 3);
  console.log("Verified cgroup limits: 2 CPU, 2 GiB", limits.stdout.trim());
  const result = await container.exec(["bun", "scripts/performance.ts"], {
    env: { PERF_REPORT: "/tmp/performance.json" },
  });
  console.log(result.output);
  const report = await container.exec(["cat", "/tmp/performance.json"]);
  assert.equal(report.exitCode, 0, report.output);
  await Bun.write(process.env.PERF_REPORT ?? "performance.json", report.stdout);
  if (result.exitCode !== 0) {
    console.error("Performance gate failed. See the FAIL rows above and performance.json for measured timings.");
    process.exitCode = 1;
  }
} finally {
  await container.stop();
}
