/**
 * The updater's persisted state (`<userData>/updates/state.json`) and its check schedule, as
 * pure functions. The anonymous GitHub API allows ~60 requests an hour per IP (shared with
 * everything else on that IP), so background checks are rare, jittered, remembered across
 * restarts, and back off on failures and rate limits.
 */
import type { CheckResult } from "./check.ts";

export interface UpdaterState {
  readonly lastCheckAt: number | null;
  /** Consecutive failed checks (network errors, rate limits). */
  readonly failures: number;
  /** GitHub asked us not to come back before this. */
  readonly retryAt: number | null;
  /** The newest build a notification was already shown for: never twice for one build. */
  readonly notifiedBuild: number | null;
  /**
   * Builds that failed here after they were put in place (or whose staged bundle failed its
   * checks): never offered again. Only build numbers, sorted, so the list stays small; a skip is
   * dropped only once the app runs a build at or above it, when it can no longer be offered.
   */
  readonly skipped: ReadonlyArray<number>;
}

export const EMPTY_STATE: UpdaterState = { lastCheckAt: null, failures: 0, retryAt: null, notifiedBuild: null, skipped: [] };

/** Own-property read that never runs getters, toString or inherited (`__proto__`) values. */
const own = (o: object, key: string): unknown => {
  const d = Object.getOwnPropertyDescriptor(o, key);
  return d && "value" in d ? d.value : undefined;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const build = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

/** A skipped entry: a build number, or an object with a numeric `build` (the first format). */
const skippedBuild = (v: unknown): number | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? build(own(v, "build")) : build(v);

const sortedUnique = (builds: Iterable<number>): Array<number> => [...new Set(builds)].sort((a, b) => a - b);

/**
 * Never throws, whatever the file holds: anything not exactly the expected shape falls back to
 * the default for that field, and skipped builds that still read as build numbers are kept.
 */
export const parseState = (text: string | null): UpdaterState => {
  try {
    if (typeof text !== "string") return EMPTY_STATE;
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return EMPTY_STATE;
    const list = own(raw, "skipped");
    const skipped: Array<number> = [];
    if (Array.isArray(list)) {
      // Index loop: holes in a sparse array are just undefined.
      for (let i = 0; i < Math.min(list.length, 1_000_000); i++) {
        const b = skippedBuild(own(list, String(i)));
        if (b !== null) skipped.push(b);
      }
    }
    return {
      lastCheckAt: num(own(raw, "lastCheckAt")),
      failures: Math.max(0, Math.min(20, Math.floor(num(own(raw, "failures")) ?? 0))),
      retryAt: num(own(raw, "retryAt")),
      notifiedBuild: build(own(raw, "notifiedBuild")),
      skipped: sortedUnique(skipped),
    };
  } catch {
    return EMPTY_STATE;
  }
};

export const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const FIRST_FAILURE_RETRY_MS = 30 * 60_000;
const MAX_BACKOFF_MS = 24 * 60 * 60_000;

/** How long after the last check the next one is due: the interval, or a backoff after failures. */
export const intervalAfter = (failures: number): number =>
  failures <= 0 ? CHECK_INTERVAL_MS : Math.min(FIRST_FAILURE_RETRY_MS * 2 ** Math.min(failures - 1, 10), MAX_BACKOFF_MS);

/**
 * When the next background check runs. `random` is in [0, 1): up to 10% of the interval is
 * added as jitter (so many apps don't hit GitHub together), and at startup the check waits
 * 2–7 minutes so it never competes with the app starting.
 */
export const nextCheckAt = (s: UpdaterState, now: number, random: number, startup: boolean): number => {
  const interval = intervalAfter(s.failures);
  // Never checked: due now (the startup delay is jitter enough).
  let due = s.lastCheckAt === null ? now : s.lastCheckAt + interval + random * interval * 0.1;
  if (s.retryAt !== null && s.retryAt > due) due = s.retryAt;
  const earliest = now + (startup ? 2 * 60_000 + random * 5 * 60_000 : 60_000);
  return Math.max(due, earliest);
};

/** The state after a check with `result` at `now`. */
export const afterCheck = (s: UpdaterState, result: CheckResult, now: number): UpdaterState => {
  switch (result.kind) {
    case "not-configured":
      return s;
    case "error":
      return { ...s, lastCheckAt: now, failures: s.failures + 1 };
    case "rate-limited":
      return { ...s, lastCheckAt: now, failures: s.failures + 1, retryAt: result.retryAt };
    default:
      // A check that got an answer (including a refused release) resets the backoff.
      return { ...s, lastCheckAt: now, failures: 0, retryAt: null };
  }
};

/**
 * Adds a permanently skipped build. Skips at or below `runningBuild` are dropped: the policy
 * never offers those anyway (only builds strictly newer than the running one), so nothing that
 * can still be offered is ever forgotten.
 */
export const withSkipped = (s: UpdaterState, skippedBuildNumber: number, runningBuild: number | null): UpdaterState => ({
  ...s,
  skipped: sortedUnique([...s.skipped, skippedBuildNumber]).filter((b) => runningBuild === null || b > runningBuild),
});
