import { describe, expect, it } from "vitest";
import { runPool } from "../src/pool.ts";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("runPool", () => {
  it("runs every task, in order of results, within the concurrency", async () => {
    let running = 0;
    let peak = 0;
    const done: Array<number> = [];
    const results = await runPool(
      10,
      3,
      async (n) => {
        peak = Math.max(peak, ++running);
        await tick();
        running--;
        return n * 2;
      },
      new AbortController().signal,
      (d) => done.push(d),
    );
    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
    expect(peak).toBe(3);
    expect(done.at(-1)).toBe(10);
  });

  it("starts nothing more once aborted, and rejects", async () => {
    const controller = new AbortController();
    const started: Array<number> = [];
    const run = runPool(
      100,
      2,
      async (n) => {
        started.push(n);
        if (n === 3) controller.abort(new Error("left the screen"));
        await tick();
        return n;
      },
      controller.signal,
    );
    await expect(run).rejects.toThrow("left the screen");
    expect(started.length).toBeLessThanOrEqual(5);
  });

  it("rejects at once when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    let calls = 0;
    await expect(runPool(5, 2, async () => ++calls, controller.signal)).rejects.toThrow("stop");
    expect(calls).toBe(0);
  });
});
