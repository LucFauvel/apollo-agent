import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replayBuffer } from "../src/replay.ts";

describe("replayBuffer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => {
    const batches: Array<ReadonlyArray<number>> = [];
    const log: Array<string> = [];
    const buffer = replayBuffer<number>({
      onBatch: (events) => {
        batches.push(events);
        log.push(`batch ${events.join(",")}`);
      },
      onCaughtUp: () => log.push("caught up"),
      now: () => Date.now(),
    });
    return { buffer, batches, log };
  };

  it("hands a burst of history over as one batch, then says it caught up", () => {
    const { buffer, batches, log } = make();
    for (let i = 1; i <= 500; i++) buffer.push(i);
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(16);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(500);
    expect(log).toEqual(["batch " + Array.from({ length: 500 }, (_, i) => i + 1).join(",")]);
    vi.advanceTimersByTime(150);
    expect(log.at(-1)).toBe("caught up");
  });

  it("flushes the last replayed events before saying it caught up", () => {
    const log: Array<string> = [];
    // The quiet period ends before the pending flush would have.
    const buffer = replayBuffer<number>({
      onBatch: (events) => log.push(`batch ${events.join(",")}`),
      onCaughtUp: () => log.push("caught up"),
      timing: { quietMs: 5, flushMs: 16 },
    });
    buffer.push(1);
    buffer.push(2);
    vi.advanceTimersByTime(5);
    expect(log).toEqual(["batch 1,2", "caught up"]);
  });

  it("waits for quiet after the latest event, not the first", () => {
    const { buffer, log } = make();
    for (let i = 0; i < 10; i++) {
      buffer.push(i);
      vi.advanceTimersByTime(100);
    }
    expect(log).not.toContain("caught up");
    vi.advanceTimersByTime(50);
    expect(log.at(-1)).toBe("caught up");
  });

  it("at the cap, every event pushed so far (the one crossing it too) is handed over before it says so", () => {
    const { buffer, batches, log } = make();
    let t = 0;
    while (!log.includes("caught up")) {
      buffer.push(t);
      vi.advanceTimersByTime(50);
      t += 50;
    }
    const before = batches.slice(0, log.indexOf("caught up")).flat();
    expect(before).toEqual(Array.from({ length: before.length }, (_, i) => i * 50));
    expect(before.at(-1)).toBe(2000);
  });

  it("catches up after maxMs even when events never stop (a working session)", () => {
    const { buffer, log } = make();
    for (let t = 0; t <= 2000; t += 50) {
      buffer.push(t);
      vi.advanceTimersByTime(50);
    }
    expect(log.filter((l) => l === "caught up")).toHaveLength(1);
    const at = log.indexOf("caught up");
    expect(at).toBeGreaterThan(0);
    // Every event pushed before catching up was handed over before it.
    expect(log.slice(0, at).every((l) => l.startsWith("batch"))).toBe(true);
  });

  it("an empty conversation catches up after emptyMs", () => {
    const { log } = make();
    vi.advanceTimersByTime(2999);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(["caught up"]);
  });

  it("keeps batching live events after catching up, and says so only once", () => {
    const { buffer, log } = make();
    buffer.push(1);
    vi.advanceTimersByTime(500);
    buffer.push(2);
    buffer.push(3);
    vi.advanceTimersByTime(500);
    expect(log).toEqual(["batch 1", "caught up", "batch 2,3"]);
  });

  it("dispose drops what it holds: the owner resumes after the last event handed over", () => {
    const { buffer, batches } = make();
    buffer.push(1);
    vi.advanceTimersByTime(16);
    buffer.push(2);
    buffer.dispose();
    vi.advanceTimersByTime(5000);
    expect(batches.flat()).toEqual([1]);
  });

  it("does nothing once disposed", () => {
    const { buffer, log } = make();
    buffer.push(1);
    buffer.dispose();
    buffer.push(2);
    vi.advanceTimersByTime(5000);
    expect(log).toEqual([]);
  });
});
