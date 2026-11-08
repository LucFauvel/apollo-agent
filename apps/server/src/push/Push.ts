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
import { SessionManager } from "../SessionManager.ts";
import { Store } from "../Store.ts";

/**
 * Push notifications to paired phones (the Apollo app), through Expo's push service:
 * when a turn finishes, or an agent needs an approval, an answer or a secret.
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
 * The notification for an event, or null. Reflections and workers a bot spawned are
 * left out: the orchestrator reports on its workers. Stopped turns and silent replies
 * (heartbeats with nothing to say) stay quiet.
 */
export const notificationFor = (
  session: Session,
  bot: Bot | undefined,
  event: AgentEvent,
  lastReply: string | null,
): { kind: string; title: string; body: string } | null => {
  if (session.role === "reflection" || (session.role === "worker" && session.parentSessionId !== null)) return null;
  const who = session.role === "main" ? (bot?.name ?? "Your bot") : `${session.title} · ${bot?.name ?? "worker"}`;
  switch (event._tag) {
    case "ApprovalRequested":
      return { kind: "approval", title: `${who} needs your approval`, body: plain(event.title) || "Open Apollo to allow or decline." };
    case "InputRequested":
      return { kind: "question", title: `${who} has a question`, body: plain(event.message) || "Open Apollo to answer." };
    case "SecretRequested":
      return { kind: "secret", title: `${who} needs a secret`, body: plain(event.label) };
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

/** Sends to every paired phone and forgets tokens Expo says are gone. */
const deliver = (
  tokens: ReturnType<typeof makePushTokens>,
  send: PushSender["Service"],
  note: { kind: string; title: string; body: string },
  sessionId: SessionId | null,
  bot: Pick<Bot, "id" | "avatar"> | undefined,
) =>
  Effect.gen(function* () {
    const to = tokens.active();
    if (to.length === 0) return;
    const messages = to.map(
      (token): PushMessage => ({
        to: token,
        title: note.title,
        body: note.body,
        data: { sessionId, kind: note.kind, ...(bot ? { botId: bot.id, avatar: bot.avatar } : {}) },
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
}

/** The latest notifications, for the desktop app, which polls for the ones it has not shown. */
export class Notices extends Context.Service<
  Notices,
  { readonly record: (note: Omit<Notice, "id">) => void; readonly since: (after: number) => ReadonlyArray<Notice> }
>()("apollo/push/Notices") {
  static readonly layer = Layer.sync(Notices, () => {
    const recent: Array<Notice> = [];
    let next = 1;
    return Notices.of({
      record: (note) => {
        recent.push({ id: next++, ...note });
        if (recent.length > 50) recent.shift();
      },
      since: (after) => recent.filter((n) => n.id > after),
    });
  });
}

/** Watches every session and pushes the events above. */
export const layerWatcher = Layer.effectDiscard(
  Effect.gen(function* () {
    const manager = yield* SessionManager;
    const store = yield* Store;
    const send = yield* PushSender;
    const notices = yield* Notices;
    const tokens = makePushTokens(yield* Database);
    const lastReply = new Map<SessionId, string>();
    yield* manager.liveEvents.pipe(
      Stream.runForEach(({ sessionId, event }) =>
        Effect.gen(function* () {
          if (event._tag === "TurnStarted") lastReply.delete(sessionId);
          if (event._tag === "AssistantMessage") lastReply.set(sessionId, event.text);
          // (Secret requests arrive as a Notify from the secrets service, handled below.)
          if (!["ApprovalRequested", "InputRequested", "TurnCompleted"].includes(event._tag)) return;
          const session = yield* store.getSession(sessionId);
          // Reflections work in the background and never need the user.
          if (session.role === "reflection") return;
          const bot = yield* store.getBot(session.botId).pipe(Effect.option);
          const note = notificationFor(session, bot._tag === "Some" ? bot.value : undefined, event, lastReply.get(sessionId) ?? null);
          if (event._tag === "TurnCompleted") lastReply.delete(sessionId);
          if (note) {
            notices.record({ ...note, sessionId });
            yield* Effect.forkDetach(deliver(tokens, send, note, sessionId, bot._tag === "Some" ? bot.value : undefined));
          }
        }).pipe(Effect.ignore),
      ),
      Effect.forkScoped,
    );
    // Notifications bots send themselves (apollo_notify, scheduled results, secret requests).
    yield* manager.changes.pipe(
      Stream.runForEach((change) =>
        Effect.gen(function* () {
          if (change._tag !== "Notify") return;
          const note = { kind: "notify", title: change.title, body: plain(change.body) };
          notices.record({ ...note, sessionId: change.sessionId ?? "" });
          const bot = change.sessionId
            ? yield* store.getSession(change.sessionId).pipe(
                Effect.flatMap((session) => store.getBot(session.botId)),
                Effect.option,
              )
            : undefined;
          yield* Effect.forkDetach(deliver(tokens, send, note, change.sessionId ?? null, bot?._tag === "Some" ? bot.value : undefined));
        }),
      ),
      Effect.forkScoped,
    );
  }),
);

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
      notices.record({ ...note, sessionId: "" });
      const phones = tokens.active().length;
      yield* deliver(tokens, send, note, null, bot);
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
