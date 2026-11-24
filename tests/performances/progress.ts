export async function phase<T>(name: string, action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const elapsed = () => `${((performance.now() - started) / 1000).toFixed(1)} s`;
  console.log(`[START] ${name}`);
  const timer = setInterval(() => console.log(`[WAIT] ${name} · ${elapsed()} elapsed`), 5000);
  timer.unref();
  try {
    const result = await action();
    console.log(`[DONE] ${name} · ${elapsed()}`);
    return result;
  } catch (error) {
    console.error(`[FAIL] ${name} · ${elapsed()}`);
    throw error;
  } finally {
    clearInterval(timer);
  }
}

export function sampleProgress(name: string, completed: number, total: number, ms: number): void {
  if (completed === 1 || completed % 5 === 0 || completed === total)
    console.log(`[MEASURE] ${name} · ${completed}/${total} samples · last ${ms.toFixed(1)} ms`);
}
