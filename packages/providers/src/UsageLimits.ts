import type { UsageMeter } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { Emit } from "./Provider.ts";

export interface LimitsRefresherOptions {
  /** One read of the provider's meters; `[]` means the provider has none (clears them). */
  readonly read: Effect.Effect<ReadonlyArray<UsageMeter>, unknown>;
  readonly emit: Emit;
  /** Reads run here, so they never hold up the caller (a turn). */
  readonly scope: Scope.Scope;
  /** An unforced refresh within this long of the last good read is skipped. */
  readonly minIntervalMs: number;
  readonly now?: () => number;
}

/**
 * Refreshes a provider's usage meters in the background. A refresh asked for while a read is
 * running is never dropped: one more read follows it, since the running one may predate what
 * prompted the request. A failed read emits nothing (the last meters stay).
 */
export const makeLimitsRefresher = (options: LimitsRefresherOptions): ((force: boolean) => Effect.Effect<void>) => {
  const now = options.now ?? Date.now;
  let reading = false;
  let again = false;
  let readAt = Number.NEGATIVE_INFINITY;
  const once: Effect.Effect<void> = options.read.pipe(
    Effect.flatMap((meters) =>
      Effect.andThen(
        Effect.sync(() => (readAt = now())),
        options.emit({ _tag: "UsageLimits", meters }),
      ),
    ),
    Effect.ignore,
  );
  const loop: Effect.Effect<void> = Effect.suspend(() => {
    again = false;
    return Effect.andThen(once, () => (again ? loop : Effect.void));
  });
  return (force) =>
    Effect.suspend(() => {
      if (reading) {
        again = true;
        return Effect.void;
      }
      if (!force && now() - readAt < options.minIntervalMs) return Effect.void;
      reading = true;
      return loop.pipe(
        Effect.ensuring(Effect.sync(() => (reading = false))),
        Effect.forkIn(options.scope),
        Effect.asVoid,
      );
    });
};
