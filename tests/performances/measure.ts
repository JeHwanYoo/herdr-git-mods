import { sampleProgress } from "./progress.ts";

export type Row = {
  name: string;
  budgetMs: number;
  firstMs: number;
  p95Ms: number;
  maxMs: number;
  samplesMs: number[];
  passed: boolean;
};

export function createMeasure(rows: Row[]) {
  return async function measure(
    name: string,
    budgetMs: number,
    action: (iteration: number) => Promise<void>,
    cleanup?: () => Promise<void>,
  ) {
    console.log(`[MEASURE] ${name} · 21 samples · p95 <= ${budgetMs} ms, max <= ${budgetMs * 2} ms`);
    const samplesMs: number[] = [];
    for (let i = 0; i < 21; i++) {
      const start = performance.now();
      await action(i);
      const ms = performance.now() - start;
      samplesMs.push(ms);
      await cleanup?.();
      sampleProgress(name, i + 1, 21, ms);
    }
    const firstMs = samplesMs.shift() ?? 0;
    const sorted = [...samplesMs].sort((a, b) => a - b);
    const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
    const maxMs = Math.max(...samplesMs, firstMs);
    const passed = p95Ms <= budgetMs && maxMs <= budgetMs * 2;
    rows.push({ name, budgetMs, firstMs, p95Ms, maxMs, samplesMs, passed });
    console.log(
      `${passed ? "PASS" : "FAIL"} ${name}: p95 ${p95Ms.toFixed(1)} ms / ${budgetMs} ms, max ${maxMs.toFixed(1)} ms`,
    );
  };
}

export type Measure = ReturnType<typeof createMeasure>;
