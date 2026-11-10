import type { DatabaseSync } from "node:sqlite";
import type { AgentEvent, Bot, BotAvatar, BotId, Session, SessionId } from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Auth } from "../auth/Auth.ts";
import { presentedToken } from "../auth/http.ts";
import { Database } from "../Database.ts";
import { Jobs } from "../jobs/Jobs.ts";
import { SessionManager } from "../SessionManager.ts";
import { Store } from "../Store.ts";

/**
 * Push notifications to paired phones (the Apollo app), through Expo's push service, and
 * the same notifications for the desktop app (`Notices`) and browser tabs (a `pushed`
 * Notify): when a turn finishes with something for the user, or an agent needs an
 * approval, an answer or a secret.
 */

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export interface PushMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly data: {
    readonly sessionId: SessionId | null;
    readonly kind: string;
    /** The bot it is from: the phone shows its avatar as the sender (notification service extension). */
    readonly botId?: BotId;
    readonly avatar?: BotAvatar;
    /** When it was sent (server time, ms): the phone dismisses it once the bot's chats are seen after that. */
    readonly at: number;
  };
  readonly sound: "default";
  readonly priority: "high";
  /** Lets the phone's notification service extension restyle it before it shows. */
  readonly mutableContent: true;
}

/** Expo's answer per message: `ok`, or an error such as `DeviceNotRegistered`. */
export type PushTicket = { readonly status: "ok" } | { readonly status: "error"; readonly details?: { readonly error?: string } };

/** Delivers messages; Expo's HTTP API in production, a fake in tests. */
export class PushSender extends Context.Service<PushSender, (messages: ReadonlyArray<PushMessage>) => Promise<ReadonlyArray<PushTicket>>>()(
  "apollo/push/PushSender",
) {
  static readonly expo = Layer.succeed(PushSender, async (messages) => {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        // Only needed when "enhanced push security" is on for the EAS project.
        ...(process.env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
      },
      body: JSON.stringify(messages),
    });
    const body = (await response.json().catch(() => ({}))) as { data?: ReadonlyArray<PushTicket> };
    if (!response.ok) throw new Error(`Expo push failed (${response.status})`);
    return body.data ?? [];
  });
}

/** Push tokens, each tied to the paired client that registered it. */
export const makePushTokens = (db: DatabaseSync) => ({
  register: (token: string, clientId: string, platform: string, now = Date.now()) =>
    void db
      .prepare(
        `insert into push_tokens (token, client_id, platform, created_at) values (?, ?, ?, ?)
         on conflict (token) do update set client_id = excluded.client_id, platform = excluded.platform`,
      )
      .run(token, clientId, platform, now),
  remove: (token: string) => void db.prepare("delete from push_tokens where token = ?").run(token),
  /** Tokens of clients still paired: revoking a phone stops its notifications. */
  active: (now = Date.now()) =>
    (
      db
        .prepare(
          `select p.token from push_tokens p join client_sessions c on c.id = p.client_id
           where c.revoked_at is null and c.expires_at > ?`,
        )
        .all(now) as Array<{ token: string }>
    ).map((r) => r.token),
});

/** Plain text for a notification body: no markdown, one short line. */
export const plain = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);

/**
 * The notification for an event, or null. Reflections are left out, and so are the turns
 * of workers a bot spawned (the orchestrator reports on them), though a worker that needs
 * the user (an approval, a question) still says so. Stopped turns and silent replies
 * (heartbeats with nothing to say) stay quiet.
 */
export const notificationFor = (
  session: Session,
  bot: Bot | undefined,
  event: AgentEvent,
  lastReply: string | null,
): { kind: string; title: string; body: string } | null => {
  if (session.role === "reflection") return null;
  const spawned = session.role === "worker" && session.parentSessionId !== null;
  if (spawned && event._tag !== "ApprovalRequested" && event._tag !== "InputRequested") return null;
  const who = session.role === "main" ? (bot?.name ?? "Your bot") : `${session.title} · ${bot?.name ?? "worker"}`;
  switch (event._tag) {
    case "ApprovalRequested":
      return { kind: "approval", title: `${who} needs your approval`, body: plain(event.title) || "Open Apollo to allow or decline." };
    case "InputRequested":
      return { kind: "question", title: `${who} has a question`, body: plain(event.message) || "Open Apollo to answer." };
    case "SecretRequested":
      return { kind: "secret", title: `${who} needs a secret`, body: plain(event.label) };
    case "BrowserHandoff":
      return { kind: "handoff", title: `${who} needs you in the browser`, body: plain(event.reason) || "Open Apollo to take over." };
    case "TurnCompleted": {
      if (event.outcome === "interrupted") return null;
      if (event.outcome === "failed") return { kind: "error", title: `${who} stopped with an error`, body: plain(event.error ?? "") };
      const reply = (lastReply ?? "").trim();
      if (reply === "[SILENT]") return null;
      return { kind: "done", title: who, body: plain(reply) || "Finished." };
    }
    default:
      return null;
  }
};

/** What a session's finished turn still waits on (SessionManager.waitingOn, plus its jobs). */
export interface Waiting {
  /** A turn is under way, or about to start (a report just arrived). */
  readonly busy: boolean;
  /** Workers it spawned that are busy and will report back. */
  readonly workers: number;
  /** Background jobs it started that will report back when they end. */
  readonly jobs: number;
  /** Other bots' answers to its apollo_ask_bot, still being written. */
  readonly botReplies: number;
  /** Its last turn answered another bot: that bot reports to the user, not this turn. */
  readonly answeredBot: boolean;
}

/** Work under way that will wake the session with a new turn when it is done. */
export const isWaiting = (w: Waiting) => w.workers + w.jobs + w.botReplies > 0;

export interface HoldTiming {
  /** How long a finished turn's notice waits once nothing is pending, so a turn that starts right away replaces it. */
  readonly settleMs: number;
  /**
   * After the work a turn waited on is over, how long to wait for it to wake the session
   * before telling the user anyway (it died or was stopped without reporting back).
   */
  readonly graceMs: number;
  /** How often held notices are checked. */
  readonly sweepMs: number;
  /**
   * How long a notice may wait on background jobs alone (no busy worker, no pending bot
   * answer) before it goes out anyway: a job can run for hours (a server started with
   * notify on). Workers and bot answers have no such cap.
   */
  readonly jobCapMs: number;
}

/** A held notice waiting only on background jobs goes out after this long. */
export const JOB_HOLD_CAP_MS = 10 * 60_000;

export const DEFAULT_HOLD: HoldTiming = { settleMs: 1_500, graceMs: 15_000, sweepMs: 500, jobCapMs: JOB_HOLD_CAP_MS };

type Note = { readonly kind: string; readonly title: string; readonly body: string };

/**
 * Decides when a finished turn is worth a notification. A turn that ends while its session
 * still waits on something (a worker, a background job, another bot's answer) has nothing
 * ready for the user yet: "I'll report back when the worker is done". Its notice is held,
 * and dropped when the next turn starts: the turn that ends with nothing pending is the one
 * the user hears about. When the waited-on work ends without waking the session (a worker
 * died, a job was stopped), the held notice goes out after a grace period, so an idle
 * session never goes unannounced. Only finished turns are held: approvals, questions and
 * errors need the user now.
 */
export const makeTurnNotices = (timing: HoldTiming) => {
  const held = new Map<
    SessionId,
    { readonly note: Note; readonly botId: BotId; readonly heldAt: number; clearSince: number | null; waited: boolean }
  >();
  return {
    /** A turn started: whatever an earlier turn held back is replaced by this one's outcome. */
    turnStarted: (id: SessionId) => void held.delete(id),
    /** A notice for a session event: returned to send now, or held (finished turns). */
    offer: (id: SessionId, botId: BotId, note: Note, now = Date.now()): Note | null => {
      if (note.kind !== "done") return note;
      held.set(id, { note, botId, heldAt: now, clearSince: null, waited: false });
      return null;
    },
    /** Sessions with a held notice. */
    held: () => [...held.keys()],
    /**
     * Rechecks held notices against what their sessions wait on (`null`: the session is
     * gone) and returns those to send now.
     */
    sweep: (now: number, waiting: ReadonlyMap<SessionId, Waiting | null>) => {
      const due: Array<{ readonly sessionId: SessionId; readonly botId: BotId; readonly note: Note }> = [];
      for (const [id, hold] of held) {
        if (!waiting.has(id)) continue;
        const w = waiting.get(id) ?? null;
        if (w === null || w.answeredBot) {
          held.delete(id);
          continue;
        }
        // Only jobs left, for too long: say so now. (Released once: the turn a job's report
        // starts later decides for itself.)
        const jobsOnly = !w.busy && w.jobs > 0 && w.workers === 0 && w.botReplies === 0;
        if (jobsOnly && now - hold.heldAt >= timing.jobCapMs) {
          held.delete(id);
          due.push({ sessionId: id, botId: hold.botId, note: hold.note });
          continue;
        }
        if (w.busy || isWaiting(w)) {
          hold.clearSince = null;
          hold.waited ||= isWaiting(w);
          continue;
        }
        hold.clearSince ??= now;
        if (now - hold.clearSince >= (hold.waited ? timing.graceMs : timing.settleMs)) {
          held.delete(id);
          due.push({ sessionId: id, botId: hold.botId, note: hold.note });
        }
      }
      return due;
    },
  };
};

/** Sends to every paired phone and forgets tokens Expo says are gone. */
const deliver = (
  tokens: ReturnType<typeof makePushTokens>,
  send: PushSender["Service"],
  note: { kind: string; title: string; body: string },
  sessionId: SessionId | null,
  bot: Pick<Bot, "id" | "avatar"> | undefined,
  at: number,
) =>
  Effect.gen(function* () {
    const to = tokens.active();
    if (to.length === 0) return;
    const messages = to.map(
      (token): PushMessage => ({
        to: token,
        title: note.title,
        body: note.body,
        data: { sessionId, kind: note.kind, ...(bot ? { botId: bot.id, avatar: bot.avatar } : {}), at },
        sound: "default",
        priority: "high",
        mutableContent: true,
      }),
    );
    const tickets = yield* Effect.tryPromise(() => send(messages));
    tickets.forEach((ticket, i) => {
      if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") tokens.remove(to[i]!);
    });
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Push notification failed", cause)));

export interface Notice {
  readonly id: number;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly sessionId: string;
  /** Its bot, `""` when unknown. */
  readonly botId: string;
  /** When it was sent (server time, ms). */
  readonly at: number;
}

/** The latest notifications, for the desktop app, which polls for the ones it has not shown. */
export class Notices extends Context.Service<
  Notices,
  {
    readonly record: (note: Omit<Notice, "id" | "at"> & { readonly at?: number }) => void;
    readonly since: (after: number) => ReadonlyArray<Notice>;
    /** The user saw this bot's chats: its notifications up to now are not shown again. */
    readonly dismiss: (botId: string) => void;
  }
>()("apollo/push/Notices") {
  static readonly layer = Layer.sync(Notices, () => {
    let recent: Array<Notice> = [];
    let next = 1;
    return Notices.of({
      record: (note) => {
        recent.push({ ...note, id: next++, at: note.at ?? Date.now() });
        if (recent.length > 50) recent.shift();
      },
      since: (after) => recent.filter((n) => n.id > after),
      dismiss: (botId) => {
        recent = recent.filter((n) => n.botId !== botId);
      },
    });
  });
}

const SEEN_KEY = "notifications.seen";

/**
 * When the user last saw each bot's chats: opening one of its sessions, or coming back to
 * one on screen, on any device. Recording it clears the desktop app's pending notices and
 * tells every connected client (NotificationsSeen), which dismiss the bot's notifications
 * delivered up to then; clients that were away compare against the marks when they return.
 */
export class NotificationsSeen extends Context.Service<
  NotificationsSeen,
  {
    readonly mark: (botId: BotId, now?: number) => Effect.Effect<number>;
    readonly all: Effect.Effect<ReadonlyArray<{ readonly botId: BotId; readonly at: number }>>;
  }
>()("apollo/push/NotificationsSeen") {
  static readonly layer = Layer.effect(
    NotificationsSeen,
    Effect.gen(function* () {
      const store = yield* Store;
      const manager = yield* SessionManager;
      const notices = yield* Notices;
      const marks = new Map<BotId, number>();
      try {
        for (const [botId, at] of Object.entries(JSON.parse((yield* store.getSetting(SEEN_KEY)) ?? "{}") as Record<string, unknown>)) {
          if (typeof at === "number") marks.set(botId as BotId, at);
        }
      } catch {
        // A damaged record only costs dismissals of notifications already delivered.
      }
      const all = Effect.suspend(() =>
        Effect.map(store.listBots, (bots) => {
          const known = new Set(bots.map((b) => b.id));
          return [...marks].filter(([botId]) => known.has(botId)).map(([botId, at]) => ({ botId, at }));
        }),
      );
      return NotificationsSeen.of({
        all: all.pipe(Effect.orElseSucceed(() => [])),
        mark: (botId, now = Date.now()) =>
          Effect.gen(function* () {
            // (Never backwards, should two devices race.)
            const at = Math.max(now, marks.get(botId) ?? 0);
            marks.set(botId, at);
            notices.dismiss(botId);
            const known = new Set((yield* store.listBots).map((b) => b.id));
            for (const id of marks.keys()) if (!known.has(id)) marks.delete(id);
            yield* store.setSetting(SEEN_KEY, JSON.stringify(Object.fromEntries(marks)));
            yield* manager.publish({ _tag: "NotificationsSeen", botId, at });
            return at;
          }).pipe(Effect.orElseSucceed(() => now)),
      });
    }),
  );
}

/** Watches every session and pushes the events above, holding finished turns back while work is pending. */
export const makeLayerWatcher = (timing: HoldTiming = DEFAULT_HOLD) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const manager = yield* SessionManager;
      const store = yield* Store;
      const jobs = yield* Jobs;
      const send = yield* PushSender;
      const notices = yield* Notices;
      const tokens = makePushTokens(yield* Database);
      const lastReply = new Map<SessionId, string>();
      const turns = makeTurnNotices(timing);

      /** To phones, the desktop app and browser tabs. */
      const announce = (sessionId: SessionId, botId: BotId, note: Note) =>
        Effect.gen(function* () {
          const bot = yield* store.getBot(botId).pipe(Effect.option);
          const at = Date.now();
          notices.record({ ...note, sessionId, botId, at });
          yield* manager.publish({ _tag: "Notify", botId, sessionId, title: note.title, body: note.body, pushed: true });
          yield* Effect.forkDetach(deliver(tokens, send, note, sessionId, bot._tag === "Some" ? bot.value : undefined, at));
        });

      yield* manager.liveEvents.pipe(
        Stream.runForEach(({ sessionId, event }) =>
          Effect.gen(function* () {
            if (event._tag === "TurnStarted") {
              lastReply.delete(sessionId);
              turns.turnStarted(sessionId);
            }
            if (event._tag === "AssistantMessage") lastReply.set(sessionId, event.text);
            // (Secret requests and browser handoffs arrive as a Notify from their services, handled below.)
            if (!["ApprovalRequested", "InputRequested", "TurnCompleted"].includes(event._tag)) return;
            const session = yield* store.getSession(sessionId);
            // Reflections work in the background and never need the user.
            if (session.role === "reflection") return;
            const bot = yield* store.getBot(session.botId).pipe(Effect.option);
            const note = notificationFor(session, bot._tag === "Some" ? bot.value : undefined, event, lastReply.get(sessionId) ?? null);
            if (event._tag === "TurnCompleted") lastReply.delete(sessionId);
            const now = note && turns.offer(sessionId, session.botId, note);
            if (now) yield* announce(sessionId, session.botId, now);
          }).pipe(Effect.ignore),
        ),
        Effect.forkScoped,
      );

      // Held notices: sent once their session waits on nothing (or dropped by its next turn).
      const waitingOf = (id: SessionId) =>
        manager.waitingOn(id).pipe(
          Effect.map((w): Waiting | null => ({ ...w, jobs: jobs.reportingTo(id) })),
          Effect.orElseSucceed(() => null),
        );
      yield* Effect.gen(function* () {
        const ids = turns.held();
        if (ids.length === 0) return;
        const waiting = new Map<SessionId, Waiting | null>();
        for (const id of ids) waiting.set(id, yield* waitingOf(id));
        for (const { sessionId, botId, note } of turns.sweep(Date.now(), waiting)) yield* announce(sessionId, botId, note);
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Held notifications check failed", cause)),
        Effect.andThen(Effect.sleep(timing.sweepMs)),
        Effect.forever,
        Effect.forkScoped,
      );

      // Notifications bots send themselves (apollo_notify, scheduled results, secret requests, browser handoffs).
      yield* manager.changes.pipe(
        Stream.runForEach((change) =>
          Effect.gen(function* () {
            // (`pushed`: one of ours, above.)
            if (change._tag !== "Notify" || change.pushed) return;
            const note = { kind: "notify", title: change.title, body: plain(change.body) };
            const at = Date.now();
            notices.record({ ...note, sessionId: change.sessionId ?? "", botId: change.botId, at });
            const bot = yield* store.getBot(change.botId).pipe(Effect.option);
            yield* Effect.forkDetach(deliver(tokens, send, note, change.sessionId ?? null, bot._tag === "Some" ? bot.value : undefined, at));
          }),
        ),
        Effect.forkScoped,
      );
    }),
  );

export const layerWatcher = makeLayerWatcher();

const RegisterBody = Schema.Struct({
  token: Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(512)),
  platform: Schema.Literals(["ios", "android"]),
});
const UnregisterBody = Schema.Struct({ token: Schema.String });

/** `POST /api/push/register` and `/api/push/unregister`, from a paired phone. */
export const layerRoutes = Layer.mergeAll(
  // A test notification to this computer and every paired phone (Settings → Notifications).
  HttpRouter.add(
    "POST",
    "/api/notifications/test",
    Effect.gen(function* () {
      const notices = yield* Notices;
      const send = yield* PushSender;
      const tokens = makePushTokens(yield* Database);
      // Shown as if from your first bot, so the test looks like the real thing.
      const store = yield* Store;
      const bot = (yield* store.listBots)[0];
      const note = { kind: "test", title: bot?.name ?? "Apollo", body: "Notifications work. You'll hear from your bots here." };
      notices.record({ ...note, sessionId: "", botId: "" });
      const phones = tokens.active().length;
      yield* deliver(tokens, send, note, null, bot, Date.now());
      return HttpServerResponse.jsonUnsafe({ ok: true, phones });
    }),
  ),
  HttpRouter.add(
    "POST",
    "/api/push/register",
    Effect.gen(function* () {
      const auth = yield* Auth;
      const tokens = makePushTokens(yield* Database);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const client = auth.authenticate(presentedToken(request));
      if (client === null) return HttpServerResponse.jsonUnsafe({ error: "This device is not paired with Apollo." }, { status: 401 });
      const body = yield* HttpServerRequest.schemaBodyJson(RegisterBody);
      tokens.register(body.token, client.id, body.platform);
      return HttpServerResponse.jsonUnsafe({ ok: true });
    }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "Malformed request." }, { status: 400 })))),
  ),
  HttpRouter.add(
    "POST",
    "/api/push/unregister",
    Effect.gen(function* () {
      const tokens = makePushTokens(yield* Database);
      const body = yield* HttpServerRequest.schemaBodyJson(UnregisterBody);
      tokens.remove(body.token);
      return HttpServerResponse.jsonUnsafe({ ok: true });
    }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "Malformed request." }, { status: 400 })))),
  ),
);
