import { describe, expect, it } from "vitest";
import { makeInflight } from "../src/inflight.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("makeInflight", () => {
  it("shares a running task between callers", async () => {
    const run = makeInflight<string>();
    const d = deferred<string>();
    let starts = 0;
    const start = () => (starts++, d.promise);
    const a = run("k", start);
    const b = run("k", start);
    expect(a).toBe(b);
    d.resolve("file");
    expect(await b).toBe("file");
    expect(starts).toBe(1);
  });

  it("forgets a task once it succeeded, so the next call checks again", async () => {
    const run = makeInflight<string>();
    let starts = 0;
    await run("k", async () => `v${++starts}`);
    expect(run.size()).toBe(0);
    expect(await run("k", async () => `v${++starts}`)).toBe("v2");
  });

  it("forgets a task that failed", async () => {
    const run = makeInflight<string>();
    await expect(run("k", () => Promise.reject(new Error("gone")))).rejects.toThrow("gone");
    expect(run.size()).toBe(0);
    expect(await run("k", async () => "ok")).toBe("ok");
  });
});
