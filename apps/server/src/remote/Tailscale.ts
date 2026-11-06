import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { ApolloError, type RemoteAccess } from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../Config.ts";
import { Store } from "../Store.ts";

/** HTTPS port on the tailnet; not 443, so Apollo never replaces something the user serves there. */
export const TAILNET_PORT = 8443;
const SETTING = "remote.tailscale";

const CANDIDATES = [
  "tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

const findTailscale = () => {
  const override = process.env.APOLLO_TAILSCALE_BIN;
  if (override) return override;
  for (const candidate of CANDIDATES.slice(1)) if (existsSync(candidate)) return candidate;
  return CANDIDATES[0]!;
};

const run = (bin: string, args: ReadonlyArray<string>) =>
  new Promise<string>((resolve, reject) => {
    execFile(bin, [...args], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(((stderr || stdout || error.message) as string).trim()));
      else resolve(stdout);
    });
  });

/**
 * Publishes Apollo to the user's tailnet with `tailscale serve`: HTTPS with the tailnet's
 * certificate, reachable only by the user's own devices, while Apollo itself keeps
 * listening on localhost. Every request still needs a paired device's token.
 */
const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const store = yield* Store;
  const bin = findTailscale();
  let lastError: string | null = null;
  /** The tailnet origin while published, kept for the request guard (no CLI call per request). */
  let tailnetOrigin: string | null = null;

  const status = Effect.promise(async () => {
    try {
      const json = JSON.parse(await run(bin, ["status", "--json"])) as {
        BackendState?: string;
        Self?: { DNSName?: string };
      };
      const dnsName = json.Self?.DNSName?.replace(/\.$/, "") || null;
      return { state: json.BackendState === "Running" ? ("running" as const) : ("stopped" as const), dnsName };
    } catch (error) {
      const missing = /ENOENT|not found/i.test((error as Error).message);
      return { state: missing ? ("missing" as const) : ("stopped" as const), dnsName: null };
    }
  });

  const urlFor = (dnsName: string) => `https://${dnsName}:${TAILNET_PORT}`;

  const read: Effect.Effect<RemoteAccess> = Effect.gen(function* () {
    const enabled = (yield* store.getSetting(SETTING)) === "on";
    const { state, dnsName } = yield* status;
    tailnetOrigin = enabled && dnsName ? urlFor(dnsName) : null;
    return {
      tailscale: state,
      dnsName,
      enabled,
      url: enabled && dnsName ? urlFor(dnsName) : null,
      error: lastError,
    };
  });

  const serve = Effect.tryPromise({
    try: () => run(bin, ["serve", "--bg", `--https=${TAILNET_PORT}`, `http://127.0.0.1:${config.port}`]),
    catch: (error) => (error as Error).message,
  });

  const setEnabled = (enabled: boolean) =>
    Effect.gen(function* () {
      lastError = null;
      if (enabled) {
        const { state } = yield* status;
        if (state !== "running") {
          return yield* new ApolloError({
            code: "invalid",
            message: state === "missing" ? "Tailscale is not installed on this computer." : "Tailscale is not connected; open it and sign in.",
          });
        }
        const failure = yield* serve.pipe(Effect.flip, Effect.option);
        if (failure._tag === "Some") {
          lastError = failure.value;
          return yield* new ApolloError({ code: "internal", message: `tailscale serve failed: ${failure.value}` });
        }
      } else {
        yield* Effect.tryPromise(() => run(bin, ["serve", `--https=${TAILNET_PORT}`, "off"])).pipe(Effect.ignore);
      }
      yield* store.setSetting(SETTING, enabled ? "on" : null);
      return yield* read;
    });

  // Apollo's port can change between launches (the desktop app picks a free one): point the
  // tailnet address at this run's port.
  if ((yield* store.getSetting(SETTING)) === "on") {
    yield* read;
    yield* serve.pipe(
      Effect.tapError((error) => Effect.sync(() => void (lastError = error))),
      Effect.ignore,
      Effect.forkScoped,
    );
  }

  return {
    read,
    setEnabled,
    /** Requests through the tailnet address carry it as their Origin (the phone app's WebSocket). */
    isTailnetOrigin: (origin: string) => tailnetOrigin !== null && origin === tailnetOrigin,
  };
});

export class Tailscale extends Context.Service<Tailscale, Effect.Success<typeof make>>()("apollo/Tailscale") {}

export const layer = Layer.effect(Tailscale, make);
