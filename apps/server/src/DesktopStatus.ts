import type { DesktopStatus } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { safeEqual } from "./auth/Auth.ts";
import { ServerConfig } from "./Config.ts";
import { LocalModels } from "./local/LocalModels.ts";
import { Notices } from "./push/Push.ts";
import { Store } from "./Store.ts";

export const DESKTOP_STATUS_PATH = "/api/desktop/status";

const busy = new Set(["starting", "running"]);

/** Bot activity and the local model server, for the desktop app's menu bar / tray. */
export const desktopStatus = Effect.gen(function* () {
  const store = yield* Store;
  const local = yield* Effect.serviceOption(LocalModels);
  const sessions = yield* store.listSessions();
  const bots = (yield* store.listBots).map((bot) => {
    const own = sessions.filter((s) => s.botId === bot.id);
    return {
      id: bot.id,
      name: bot.name,
      paused: bot.pausedReason !== null,
      working: own.filter((s) => busy.has(s.status)).length,
      needsYou: own.filter((s) => s.status === "waiting-approval").length,
    };
  });
  let localModels: DesktopStatus["localModels"] = null;
  if (Option.isSome(local)) {
    const state = yield* local.value.state;
    if (state.engine.installed) {
      localModels = {
        server: state.server.status,
        loaded: state.models.filter((m) => m.status === "loaded").map((m) => m.id),
        loading: state.models
          .filter((m) => m.status === "loading")
          .map((m) => ({ model: m.id, percent: Math.floor((m.loadProgress ?? 0) * 100) })),
        downloads: state.models
          .filter((m) => m.status === "downloading")
          .map((m) => ({
            model: m.id,
            percent: m.download && m.download.total > 0 ? Math.floor((m.download.done / m.download.total) * 100) : 0,
          })),
      };
    }
  }
  return { bots, localModels } satisfies DesktopStatus;
});

/**
 * `GET /api/desktop/status` for the desktop shell, which authenticates with the
 * per-launch bootstrap token it started the server with. Anything else gets 401.
 */
export const layer = HttpRouter.add(
  "GET",
  DESKTOP_STATUS_PATH,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const header = request.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!config.desktopBootstrapToken || !safeEqual(token, config.desktopBootstrapToken)) {
      return HttpServerResponse.jsonUnsafe({ error: "Only the desktop app may read this." }, { status: 401 });
    }
    const after = Number(new URL(request.url, "http://apollo.invalid").searchParams.get("after") ?? "NaN");
    const notices = yield* Effect.serviceOption(Notices);
    const notifications = Option.isSome(notices) && Number.isFinite(after) ? notices.value.since(after) : undefined;
    return HttpServerResponse.jsonUnsafe({ ...(yield* desktopStatus), ...(notifications ? { notifications } : {}) });
  }),
);
