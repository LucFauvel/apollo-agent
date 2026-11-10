/**
 * Shares one running task per key between callers, and forgets it once it settles (either
 * way), so a later call starts afresh and can recheck what the task checks (a cache on disk
 * the system may have purged meanwhile).
 */
export const makeInflight = <T>() => {
  const running = new Map<string, Promise<T>>();
  const run = (key: string, start: () => Promise<T>): Promise<T> => {
    const existing = running.get(key);
    if (existing) return existing;
    const task = start();
    running.set(key, task);
    const forget = () => {
      if (running.get(key) === task) running.delete(key);
    };
    task.then(forget, forget);
    return task;
  };
  return Object.assign(run, { size: () => running.size });
};
