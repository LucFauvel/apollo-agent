/**
 * The updater's persisted state (`<userData>/updates/state.json`) and its check schedule, as
 * pure functions. The anonymous GitHub API allows ~60 requests an hour per IP (shared with
 * everything else on that IP), so background checks are rare, jittered, remembered across
 * restarts, and back off on failures and rate limits.
 */
import type { CheckResult } from "./check.ts";

export interface SkippedBuild {
  readonly build: number;
  readonly version: string;
  readonly at: string;
  readonly why: string;
}

export interface UpdaterState {
  readonly lastCheckAt: number | null;
  /** Consecutive failed checks (network errors, rate limits). */
  readonly failures: number;
  /** GitHub asked us not to come back before this. */
  readonly retryAt: number | null;
  /** The newest build a notification was already shown for: never twice for one build. */
  readonly notifiedBuild: number | null;
  /** Builds that failed their post-update health check here (rolled back): never offered again. */
  readonly skipped: ReadonlyArray<SkippedBuild>;
}

export const EMPTY_STATE: UpdaterState = { lastCheckAt: null, failures: 0, retryAt: null, notifiedBuild: null, skipped: [] };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Lenient: a damaged file gives the empty state, but skipped builds that still parse are kept. */
export const parseState = (text: string | null): UpdaterState => {
  if (text === null) return EMPTY_STATE;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null) return EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
  const skipped = Array.isArray(raw.skipped)
    ? raw.skipped.flatMap((s: unknown): Array<SkippedBuild> => {
        const e = s as Partial<SkippedBuild> | null;
        return e && Number.isSafeInteger(e.build) ? [{ build: e.build!, version: String(e.version ?? "?"), at: String(e.at ?? ""), why: String(e.why ?? "") }] : [];
      })
    : [];
  return {
    lastCheckAt: num(raw.lastCheckAt),
    failures: Math.max(0, Math.min(20, Math.floor(num(raw.failures) ?? 0))),
    retryAt: num(raw.retryAt),
    notifiedBuild: num(raw.notifiedBuild),
    skipped,
  };
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

export const withSkipped = (s: UpdaterState, entry: SkippedBuild): UpdaterState =>
  s.skipped.some((e) => e.build === entry.build) ? s : { ...s, skipped: [...s.skipped, entry].slice(-50) };
