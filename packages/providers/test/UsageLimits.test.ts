import type { UsageMeter } from "@apollo/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { ProviderEmission } from "../src/Provider.ts";
import { makeLimitsRefresher } from "../src/UsageLimits.ts";

const meter = (usedPercent: number): UsageMeter => ({ label: "Session", usedPercent, resetsAt: null, severity: null, headline: true });

/** A refresher whose reads each wait for the test to release them, answering 10%, 20%, ... */
const setup = (minIntervalMs: number, options: { fail?: () => boolean; time?: { now: number } } = {}) =>
  Effect.gen(function* () {
    const emitted: Array<ReadonlyArray<UsageMeter>> = [];
    const gates: Array<Deferred.Deferred<void>> = [];
    let reads = 0;
    const read = Effect.gen(function* () {
      const n = ++reads;
      const gate = yield* Deferred.make<void>();
      gates.push(gate);
      yield* Deferred.await(gate);
      if (options.fail?.()) return yield* Effect.fail("offline");
      return [meter(10 * n)];
    });
    const refresh = makeLimitsRefresher({
      read,
      emit: (e: ProviderEmission) => Effect.sync(() => void (e._tag === "UsageLimits" && emitted.push(e.meters))),
      scope: yield* Effect.scope,
      minIntervalMs,
      ...(options.time ? { now: () => options.time!.now } : {}),
    });
    /** Releases the next waiting read and lets it finish. */
    const release = Effect.gen(function* () {
      while (gates.length === 0) yield* Effect.yieldNow;
      yield* Deferred.succeed(gates.shift()!, undefined);
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
    });
    /** Waits until a read is out (asked of the provider, not answered yet). */
    const outstanding = Effect.gen(function* () {
      while (gates.length === 0) yield* Effect.yieldNow;
    });
    return { emitted, refresh, release, outstanding, reads: () => reads, waiting: () => gates.length };
  });

describe("makeLimitsRefresher", () => {
  it.live("a refresh asked for before the read is sent is answered by that read", () =>
    Effect.gen(function* () {
      const t = yield* setup(60_000);
      yield* t.refresh(true);
      yield* t.refresh(true);
      yield* t.release;
      expect(t.emitted).toEqual([[meter(10)]]);
      expect(t.waiting()).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.live("reads again after a running read when a refresh was asked for meanwhile, then settles", () =>
    Effect.gen(function* () {
      const t = yield* setup(60_000);
      yield* t.refresh(true);
      yield* t.outstanding;
      // A rate-limit change, then the turn's end, both while the first read is out.
      yield* t.refresh(true);
      yield* t.refresh(false);
      yield* t.release;
      // Not dropped: one follow-up read (not one per request), and its newer answer is shown last.
      yield* t.release;
      expect(t.emitted).toEqual([[meter(10)], [meter(20)]]);
      expect(t.reads()).toBe(2);
      expect(t.waiting()).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.live("skips an unforced refresh within the interval of a good read, but not a forced one", () =>
    Effect.gen(function* () {
      const time = { now: 1_000 };
      const t = yield* setup(60_000, { time });
      yield* t.refresh(true);
      yield* t.release;
      time.now += 30_000;
      yield* t.refresh(false);
      expect(t.waiting()).toBe(0);
      yield* t.refresh(true);
      yield* t.release;
      time.now += 61_000;
      yield* t.refresh(false);
      yield* t.release;
      expect(t.emitted.map((m) => m[0]!.usedPercent)).toEqual([10, 20, 30]);
    }).pipe(Effect.scoped),
  );

  it.live("emits nothing for a failed read, and a failed read does not start the interval", () =>
    Effect.gen(function* () {
      let failing = true;
      const t = yield* setup(60_000, { fail: () => failing });
      yield* t.refresh(true);
      yield* t.release;
      expect(t.emitted).toEqual([]);
      failing = false;
      yield* t.refresh(false);
      yield* t.release;
      expect(t.emitted).toEqual([[meter(20)]]);
    }).pipe(Effect.scoped),
  );
});
