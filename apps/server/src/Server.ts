import { createServer } from "node:http";
import { ApolloRpcs } from "@apollo/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as Auth from "./auth/Auth.ts";
import * as Browser from "./browser/Browser.ts";
import * as Secrets from "./secrets/Secrets.ts";
import * as Compaction from "./Compaction.ts";
import * as AuthHttp from "./auth/http.ts";
import * as Config from "./Config.ts";
import * as Database from "./Database.ts";
import * as ApolloMcp from "./mcp/ApolloMcp.ts";
import * as LocalModels from "./local/LocalModels.ts";
import * as AppSettings from "./AppSettings.ts";
import * as DesktopStatus from "./DesktopStatus.ts";
import * as Files from "./Files.ts";
import * as Push from "./push/Push.ts";
import * as Tailscale from "./remote/Tailscale.ts";
import * as ProviderVersions from "./ProviderVersions.ts";
import * as PullRequests from "./pullRequests/PullRequests.ts";
import * as Jobs from "./jobs/Jobs.ts";
import * as ProviderSettings from "./ProviderSettings.ts";
import * as RpcHandlers from "./RpcHandlers.ts";
import * as Scheduler from "./schedule/Scheduler.ts";
import * as SessionManager from "./SessionManager.ts";
import * as Store from "./Store.ts";

const layerRpc = RpcServer.layerHttp({
  group: ApolloRpcs,
  path: "/rpc",
  protocol: "websocket",
}).pipe(Layer.provide([RpcHandlers.layer, RpcSerialization.layerJson]));

const layerHealth = HttpRouter.add("GET", "/health", HttpServerResponse.jsonUnsafe({ ok: true }));

/** Serves the built web UI when `APOLLO_WEB_DIST` is set (desktop/production). */
const layerWeb = Layer.unwrap(
  Effect.map(Config.ServerConfig, (config) =>
    config.webDistDir
      ? HttpStaticServer.layer({ root: config.webDistDir, spa: true })
      : Layer.empty,
  ),
);

const layerRoutes = Layer.mergeAll(layerRpc, ApolloMcp.layer, layerHealth, layerWeb, AuthHttp.layer, DesktopStatus.layer, Files.layer, Push.layerRoutes);

const layerHttpServer = Layer.unwrap(
  Effect.map(Config.ServerConfig, (config) =>
    NodeHttpServer.layer(() => createServer(), { port: config.port, host: config.host }),
  ),
);

const layerCore = Compaction.layer.pipe(
  Layer.provideMerge(Push.layerWatcher),
  Layer.provideMerge(Push.PushSender.expo),
  Layer.provideMerge(Push.Notices.layer),
  Layer.provideMerge(ProviderVersions.layer),
  Layer.provideMerge(PullRequests.layer),
  Layer.provideMerge(Jobs.layer),
  Layer.provideMerge(Secrets.layer),
  Layer.provideMerge(Browser.layer),
  Layer.provideMerge(Scheduler.layer),
  Layer.provideMerge(SessionManager.layer),
  Layer.provideMerge(SessionManager.layerProviders),
  Layer.provideMerge(LocalModels.layer),
  Layer.provideMerge(ProviderSettings.layer),
  Layer.provideMerge(Tailscale.layer),
  Layer.provideMerge(AppSettings.layer),
  Layer.provideMerge(Auth.layer),
  Layer.provideMerge(Store.layer),
  Layer.provideMerge(Database.layer),
);

export const layer = HttpRouter.serve(layerRoutes, { disableLogger: process.env.APOLLO_LOG_HTTP !== "1" }).pipe(
  Layer.provide(layerCore),
  Layer.provide(layerHttpServer),
  Layer.provide(Config.layerFromEnv),
);
