import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * Schedule specs: when a scheduled task or heartbeat runs.
 *
 * - One-shots: `in 30m`, `in 2 hours`, `today at 5pm`, `tomorrow at 9am`,
 *   `2026-11-05 09:00` (read in the schedule's time zone). Relative forms are
 *   stored as the absolute time they name, so re-reading a spec never moves it.
 * - Intervals: `every 30m`, `every 2 hours`, `every hour`, `30m`.
 * - Calendar: `daily at 9am`, `every day at 18:30`, `weekdays at 9am`,
 *   `weekends at 10am`, `every monday at 9am`, `every mon, wed and fri 8:15`,
 *   `hourly`.
 * - Cron: five fields (`0 9 * * 1-5`), or six with seconds.
 */
export type Spec =
  | { readonly kind: "once"; readonly spec: string; readonly description: string; readonly at: number }
  | { readonly kind: "interval"; readonly spec: string; readonly description: string; readonly everyMs: number }
  | { readonly kind: "cron"; readonly spec: string; readonly description: string; readonly cron: Cron.Cron };

export type SpecResult = { readonly ok: true; readonly spec: Spec } | { readonly ok: false; readonly error: string };

/** Recurring schedules may not run more often than this. */
export const MIN_INTERVAL_MS = 5 * 60_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const isTimeZone = (tz: string) => Option.isSome(DateTime.zoneMakeNamed(tz));

const fail = (error: string): SpecResult => ({ ok: false, error });
const ok = (spec: Spec): SpecResult => ({ ok: true, spec });

const EXAMPLES = 'Try "every 30m", "daily at 9am", "weekdays at 8:30", "every monday 9am", "in 2h", "tomorrow at 9am", "2026-12-01 09:00" or a cron expression like "0 9 * * 1-5".';

// --- durations ----------------------------------------------------------------

const UNITS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
  d: DAY, day: DAY, days: DAY,
  w: 7 * DAY, week: 7 * DAY, weeks: 7 * DAY,
};

/** "1h30m", "2 hours", "90 minutes", "hour" (one); `null` when it is not a duration. */
export const parseDuration = (text: string): number | null => {
  const compact = text.trim().replace(/\band\b|,/g, " ");
  if (/^(an?\s+)?(second|minute|hour|day|week)$/.test(compact)) return UNITS[compact.replace(/^an?\s+/, "")]!;
  const parts = [...compact.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join("").replace(/\s/g, "") !== compact.replace(/\s/g, "")) {
    return null;
  }
  let total = 0;
  for (const [, amount, unit] of parts) {
    const ms = UNITS[unit!];
    if (ms === undefined) return null;
    total += Number(amount) * ms;
  }
  return total > 0 ? Math.round(total) : null;
};

const describeDuration = (ms: number): string => {
  const units: Array<[number, string]> = [
    [7 * DAY, "week"],
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
    [1000, "second"],
  ];
  const parts: Array<string> = [];
  let rest = ms;
  for (const [size, name] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n} ${name}${n === 1 ? "" : "s"}`);
      rest -= n * size;
    }
  }
  return parts.join(" ");
};

// --- times of day ---------------------------------------------------------------

/** "9am", "9:30 pm", "21:00", "noon", "midnight" as [hour, minute]. */
export const parseTimeOfDay = (text: string): readonly [number, number] | null => {
  const t = text.trim();
  if (t === "noon") return [12, 0];
  if (t === "midnight") return [0, 0];
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(t);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3]?.replaceAll(".", "");
  if (!m[2] && !meridiem) return null; // a bare "9" is ambiguous
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 23) {
    return null;
  }
  return [hour, minute];
};

const formatTime = ([hour, minute]: readonly [number, number]) =>
  `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;

// --- weekdays -------------------------------------------------------------------

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const parseWeekday = (word: string): number | null => {
  const w = word.replace(/s$/, "");
  const index = DAY_NAMES.findIndex((name) => w.length >= 3 && name.startsWith(w));
  return index === -1 ? null : index;
};

const describeDays = (days: ReadonlyArray<number>) => {
  const names = days.map((d) => DAY_NAMES[d]!.charAt(0).toUpperCase() + DAY_NAMES[d]!.slice(1, 3));
  return names.length === 1 ? `Every ${DAY_NAMES[days[0]!]!.charAt(0).toUpperCase()}${DAY_NAMES[days[0]!]!.slice(1)}` : names.join(", ");
};

// --- wall-clock times in a zone -------------------------------------------------------

const zonedParts = (at: number, tz: string) => DateTime.toParts(DateTime.makeZonedUnsafe(at, { timeZone: tz }));

/** Epoch ms of a wall-clock time in `tz`, or null when it does not exist. */
const wallClock = (tz: string, year: number, month: number, day: number, hour: number, minute: number) =>
  Option.getOrNull(
    Option.map(
      DateTime.makeZoned({ year, month, day, hour, minute }, { timeZone: tz, adjustForTimeZone: true }),
      DateTime.toEpochMillis,
    ),
  );

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-05 09:00": how a one-shot is stored. */
const formatWallClock = (at: number, tz: string) => {
  const p = zonedParts(at, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
};

const describeOnce = (at: number, tz: string) =>
  new Date(at).toLocaleString("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const once = (at: number, tz: string): Spec => ({
  kind: "once",
  at,
  spec: formatWallClock(at, tz),
  description: `Once, ${describeOnce(at, tz)}`,
});

// --- parsing --------------------------------------------------------------------

/** `spec` is what gets stored: the user's wording for calendar forms, so re-reading keeps the description. */
const cronSpec = (expression: string, tz: string, description: string, spec = expression): SpecResult => {
  const parsed = Cron.parse(expression, tz);
  if (parsed._tag === "Failure") return fail(`"${expression}" is not a valid cron expression: ${parsed.failure.message}`);
  return ok({ kind: "cron", spec, cron: parsed.success, description });
};

/** Reads a spec. `now` anchors relative one-shots ("in 30m"). */
export const parseSpec = (input: string, tz: string, now = Date.now()): SpecResult => {
  if (!isTimeZone(tz)) return fail(`unknown time zone "${tz}"`);
  const text = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (text.length === 0) return fail(`say when it should run. ${EXAMPLES}`);

  // Cron: five or six fields of digits, *, /, -, , and names.
  const fields = text.split(" ");
  if ((fields.length === 5 || fields.length === 6) && /^[\d*/,?-]+$/.test(fields[0]!)) {
    return cronSpec(input.trim().replace(/\s+/g, " "), tz, `Cron "${input.trim()}"`);
  }

  // Absolute: "2026-11-05 09:00", "2026-11-05t09:00", or with an offset ("…z", "…+01:00").
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2}):(\d{2}))?$/.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi] = iso;
    if (h === undefined) return fail(`add a time, e.g. "${text} 09:00"`);
    const at = wallClock(tz, Number(y), Number(mo), Number(d), Number(h), Number(mi));
    if (at === null) return fail(`"${input.trim()}" is not a valid time`);
    return ok(once(at, tz));
  }
  if (/^\d{4}-\d{2}-\d{2}t[\d:.]+(z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const at = Date.parse(input.trim());
    if (Number.isNaN(at)) return fail(`"${input.trim()}" is not a valid time`);
    return ok(once(at, tz));
  }

  // "in 30m"
  const inMatch = /^in (.+)$/.exec(text);
  if (inMatch) {
    const ms = parseDuration(inMatch[1]!);
    if (ms === null) return fail(`"${inMatch[1]}" is not a duration. ${EXAMPLES}`);
    return ok(once(now + ms, tz));
  }

  // "today at 5pm", "tomorrow 9am", "at 5pm" (the next one)
  const dayMatch = /^(today|tomorrow|tonight)?\s*(?:at )?(.+)$/.exec(text);
  if (dayMatch && (dayMatch[1] || text.startsWith("at "))) {
    const time = parseTimeOfDay(dayMatch[2]!);
    if (time) {
      const p = zonedParts(now, tz);
      const base = new Date(Date.UTC(p.year, p.month - 1, p.day + (dayMatch[1] === "tomorrow" ? 1 : 0)));
      let at = wallClock(tz, base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), time[0], time[1]);
      if (at === null) return fail(`"${input.trim()}" does not exist in ${tz}`);
      if (!dayMatch[1] && at <= now) {
        const next = new Date(base.getTime() + DAY);
        at = wallClock(tz, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), time[0], time[1]);
        if (at === null) return fail(`"${input.trim()}" does not exist in ${tz}`);
      }
      return ok(once(at, tz));
    }
  }

  if (text === "hourly" || text === "every hour on the hour") return cronSpec("0 * * * *", tz, "Every hour, on the hour", text);

  // "daily at 9am", "every day at 9am", "weekdays at 9am", "every monday 9am"
  const calendar = /^(?:every |on )?(day|daily|weekdays?|weekends?|[a-z, ]+?)(?: at| @)? ([\d:]+ ?(?:am|pm|a\.m\.|p\.m\.)?|noon|midnight)$/.exec(text);
  if (calendar) {
    const time = parseTimeOfDay(calendar[2]!);
    if (time) {
      const what = calendar[1]!.trim();
      const at = `${time[1]} ${time[0]}`;
      if (what === "day" || what === "daily") return cronSpec(`${at} * * *`, tz, `Daily at ${formatTime(time)}`, text);
      if (what === "weekday" || what === "weekdays") return cronSpec(`${at} * * 1-5`, tz, `Weekdays at ${formatTime(time)}`, text);
      if (what === "weekend" || what === "weekends") return cronSpec(`${at} * * 0,6`, tz, `Weekends at ${formatTime(time)}`, text);
      const words = what.split(/[ ,]+/).filter((w) => w.length > 0 && w !== "and");
      const days = words.map(parseWeekday);
      if (days.length > 0 && days.every((d) => d !== null)) {
        const unique = [...new Set(days as Array<number>)].sort((a, b) => a - b);
        return cronSpec(`${at} * * ${unique.join(",")}`, tz, `${describeDays(unique)} at ${formatTime(time)}`, text);
      }
    }
  }
  if (text === "daily" || text === "weekdays" || text === "weekends") return fail(`add a time, e.g. "${text} at 9am"`);

  // "every 30m", "30m", "every hour"
  const every = /^(?:every )?(.+)$/.exec(text);
  const everyMs = every ? parseDuration(every[1]!) : null;
  if (everyMs !== null) {
    return ok({
      kind: "interval",
      everyMs,
      spec: `every ${describeDuration(everyMs)}`,
      description: `Every ${describeDuration(everyMs)}`,
    });
  }

  return fail(`could not read "${input.trim()}". ${EXAMPLES}`);
};

// --- timing ---------------------------------------------------------------------

/** The first run after `after`: `null` when a one-shot has passed. Intervals step from `anchor`. */
export const nextRun = (spec: Spec, after: number, anchor: number): number | null => {
  switch (spec.kind) {
    case "once":
      return spec.at > after ? spec.at : null;
    case "interval": {
      if (anchor > after) return anchor;
      const steps = Math.floor((after - anchor) / spec.everyMs) + 1;
      return anchor + steps * spec.everyMs;
    }
    case "cron":
      return Cron.next(spec.cron, new Date(after)).getTime();
  }
};

/** The first few runs after `now`. */
export const upcoming = (spec: Spec, now: number, count: number): Array<number> => {
  const runs: Array<number> = [];
  let cursor = now;
  const anchor = spec.kind === "interval" ? now + spec.everyMs : now;
  for (let i = 0; i < count; i++) {
    const next = nextRun(spec, cursor, anchor);
    if (next === null) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
};

/** Shortest gap between runs, over the next few: guards against "every minute" schedules. */
export const shortestGap = (spec: Spec, now: number): number | null => {
  if (spec.kind === "once") return null;
  if (spec.kind === "interval") return spec.everyMs;
  const runs = upcoming(spec, now, 6);
  let gap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < runs.length; i++) gap = Math.min(gap, runs[i]! - runs[i - 1]!);
  return gap;
};

/**
 * How late a run may still start: half its period, between 2 minutes and 2 hours.
 * A run that missed this window (Apollo was not running, or the bot was busy)
 * is skipped rather than started late, and missed runs never pile up.
 */
export const graceMs = (spec: Spec, due: number): number => {
  const period =
    spec.kind === "interval" ? spec.everyMs : spec.kind === "cron" ? Cron.next(spec.cron, new Date(due)).getTime() - due : 4 * HOUR;
  return Math.min(Math.max(period / 2, 2 * MINUTE), 2 * HOUR);
};
