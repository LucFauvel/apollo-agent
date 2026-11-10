/**
 * Runs `task(0..count-1)` with at most `concurrency` at once, reporting each one done.
 * Once `signal` aborts, no further task starts and the result rejects with its reason.
 */
export const runPool = async <T>(
  count: number,
  concurrency: number,
  task: (n: number, signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  onDone?: (done: number) => void,
): Promise<Array<T>> => {
  // React Native's AbortSignal may lack throwIfAborted.
  const check = () => {
    if (signal.aborted) throw signal.reason ?? new Error("Aborted");
  };
  const results: Array<T> = new Array(count);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < count) {
      check();
      const n = next++;
      results[n] = await task(n, signal);
      check();
      onDone?.(++done);
    }
  };
  check();
  await Promise.all(Array.from({ length: Math.max(0, Math.min(concurrency, count)) }, worker));
  return results;
};
