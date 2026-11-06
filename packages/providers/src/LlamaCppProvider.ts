import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { ModelOption } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import { type ClaudeBackend, type Environment, makeClaudeProvider } from "./ClaudeProvider.ts";
import { type Provider, ProviderError } from "./Provider.ts";

/** Where llama-server listens, and the key it was started with (`--api-key`), if any. */
export interface LlamaCppConnection {
  readonly baseUrl: string;
  readonly apiKey: string | null;
  /** Model for sessions that do not choose one; the first listed when unset. */
  readonly defaultModel?: string | null;
}

export interface LlamaCppProviderConfig {
  /** The `claude` executable that runs the agent loop. */
  readonly executable?: string | undefined;
  /**
   * Read each time it is needed, so that settings changes apply right away. May
   * start the server first (Apollo-managed llama.cpp), or fail saying what to set up.
   */
  readonly connection: Effect.Effect<LlamaCppConnection, ProviderError>;
  /** Reviewer model for auto mode (see ClaudeBackend.review). */
  readonly review?: ClaudeBackend["review"];
}

const fail = (message: string) => new ProviderError({ provider: "llamacpp", message });

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const getJson = (connection: LlamaCppConnection, path: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const url = new URL(path, connection.baseUrl.endsWith("/") ? connection.baseUrl : `${connection.baseUrl}/`);
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        headers: connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {},
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${url}`);
      return (await response.json()) as unknown;
    },
    catch: (cause) =>
      fail(
        `llama-server is not reachable at ${connection.baseUrl} (${errorMessage(cause)}). ` +
          "Start it with `llama-server -m <model.gguf> --jinja`, or change its address in Apollo's provider settings.",
      ),
  });

interface ListedModel {
  readonly id: string;
  readonly meta?: { readonly n_params?: number; readonly n_ctx_train?: number } | null;
  /** Router mode only. */
  readonly status?: { readonly value?: string; readonly failed?: boolean } | null;
}

const describe = (model: ListedModel) => {
  const params = model.meta?.n_params;
  const parts = [
    params ? `${params >= 1e9 ? `${(params / 1e9).toFixed(1)}B` : `${Math.round(params / 1e6)}M`} parameters` : null,
    "local",
  ];
  return parts.filter(Boolean).join(" · ");
};

/**
 * Display name for a model id: a file path (`…/Qwen3-8B-Q4_K_M.gguf` → `Qwen3-8B-Q4_K_M`)
 * or, in router mode, a Hugging Face reference (`unsloth/Qwen3-8B-GGUF:Q4_K_M` → `Qwen3-8B · Q4_K_M`).
 */
export const labelOf = (id: string) => {
  const [path, quant] = id.split(/:(?=[^/\\]+$)/);
  const name = path!.split(/[\\/]/).pop()!.replace(/\.gguf$/i, "").replace(/[-_.]?GGUF$/i, "");
  return quant ? `${name} · ${quant}` : name;
};

/** Models still downloading, or that failed to load, are listed by a router but not usable. */
const usable = (model: ListedModel) =>
  !model.status?.failed && model.status?.value !== "downloading" && model.status?.value !== "incomplete";

/** The models llama-server serves (one, or several in router mode), from its OpenAI-style list. */
export const listLlamaCppModels = (connection: LlamaCppConnection) =>
  getJson(connection, "v1/models").pipe(
    Effect.map((body): ReadonlyArray<ModelOption> => {
      const data = ((body as { data?: ReadonlyArray<ListedModel> }).data ?? []).filter(usable);
      const fallback = data.some((m) => m.id === connection.defaultModel) ? connection.defaultModel : data[0]?.id;
      return data.map((model) => ({
        id: model.id,
        label: labelOf(model.id),
        description: describe(model),
        isDefault: model.id === fallback,
        efforts: [],
        defaultEffort: null,
      }));
    }),
  );

/** Tokens one request can use: llama-server's per-slot context (`n_ctx` / `--parallel`). */
export const llamaCppContextSize = (connection: LlamaCppConnection, model: string) =>
  getJson(connection, `props?model=${encodeURIComponent(model)}`).pipe(
    Effect.map((body) => {
      const props = body as { default_generation_settings?: { n_ctx?: number }; n_ctx?: number };
      const size = props.default_generation_settings?.n_ctx ?? props.n_ctx;
      return typeof size === "number" && size > 0 ? size : null;
    }),
    // Older builds or proxies may not have /props; Claude Code then assumes its default.
    Effect.orElseSucceed(() => null),
  );

type Block = { type: string; text?: string };
type Message = { role: string; content: string | Array<Block> };

const blocks = (content: Message["content"]): Array<Block> =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;

/**
 * Claude Code puts some context (its environment block) in `system` messages
 * between the turns. Anthropic accepts that; many chat templates do not ("System
 * message must be at the beginning"). Folds each one into the neighbouring user
 * message, as a system reminder, keeping its place in the conversation.
 */
export const foldSystemMessages = (messages: ReadonlyArray<Message>): Array<Message> => {
  const out: Array<Message> = [];
  let pending: Array<Block> = [];
  for (const message of messages) {
    if (message.role === "system") {
      const text = blocks(message.content)
        .map((b) => b.text ?? "")
        .join("\n");
      const reminder = { type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` };
      const previous = out.at(-1);
      if (previous?.role === "user") previous.content = [...blocks(previous.content), reminder];
      else pending.push(reminder);
      continue;
    }
    if (message.role === "user" && pending.length > 0) {
      out.push({ ...message, content: [...pending, ...blocks(message.content)] });
      pending = [];
      continue;
    }
    out.push({ ...message });
  }
  if (pending.length > 0) out.push({ role: "user", content: pending });
  return out;
};

const readBody = async (request: IncomingMessage) => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/**
 * A local proxy between Claude Code and llama-server that rewrites requests llama.cpp's
 * chat templates reject. It also keeps the real llama-server key out of Claude Code's
 * environment: Claude Code authenticates to the proxy with a throwaway token.
 */
export const startProxy = (connection: LlamaCppConnection) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const token = randomBytes(24).toString("hex");
      const target = connection.baseUrl.replace(/\/+$/, "");
      const server = createServer(async (request, response) => {
        try {
          const auth = request.headers.authorization ?? request.headers["x-api-key"];
          if (auth !== `Bearer ${token}` && auth !== token) {
            response.writeHead(401, { "content-type": "application/json" });
            return response.end(JSON.stringify({ error: { type: "authentication_error", message: "invalid token" } }));
          }
          let body: Buffer | undefined = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
          if (body && request.url?.startsWith("/v1/messages")) {
            const json = JSON.parse(body.toString()) as { messages?: Array<Message> };
            if (json.messages) json.messages = foldSystemMessages(json.messages);
            body = Buffer.from(JSON.stringify(json));
          }
          const abort = new AbortController();
          response.on("close", () => abort.abort());
          const upstream = await fetch(`${target}${request.url}`, {
            method: request.method ?? "GET",
            signal: abort.signal,
            headers: {
              "content-type": request.headers["content-type"] ?? "application/json",
              ...(connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {}),
            },
            ...(body ? { body } : {}),
          });
          response.writeHead(upstream.status, {
            "content-type": upstream.headers.get("content-type") ?? "application/json",
          });
          if (upstream.body) {
            // Claude Code cancels requests (Stop, interrupts): the stream then fails with an
            // AbortError, which must not go unhandled (it would take the whole server down).
            const stream = Readable.fromWeb(upstream.body as never);
            stream.on("error", () => response.destroy());
            stream.pipe(response);
          } else response.end();
        } catch (error) {
          if (response.destroyed || response.writableEnded) return;
          if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { type: "api_error", message: `llama-server: ${String(error)}` } }));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      return { connection: { baseUrl: `http://127.0.0.1:${port}`, apiKey: token } satisfies LlamaCppConnection, server };
    }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  ).pipe(Effect.map(({ connection }) => connection));

/** Environment that points Claude Code at llama-server for every model call it makes. */
export const llamaCppEnvironment = (
  connection: LlamaCppConnection,
  model: string,
  contextSize: number | null,
): Environment => {
  // Never fall back to the user's Anthropic credentials: they would be sent to llama-server.
  const token = connection.apiKey ?? "apollo-local";
  return {
    ANTHROPIC_BASE_URL: connection.baseUrl.replace(/\/+$/, ""),
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: token,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    // Claude Code uses smaller models for background work (titles, summaries, subagents).
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    // Auto-compaction must start before llama-server runs out of context.
    ...(contextSize ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextSize) } : {}),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Load every tool definition up front. Loading them on demand (ToolSearch) changes the
    // start of the prompt mid-conversation, which voids llama-server's prompt cache: a local
    // model then re-reads the whole prompt (minutes for a large model) after each lookup.
    ENABLE_TOOL_SEARCH: "false",
  };
};

/**
 * Claude Code's own system prompt says it runs on a Claude model. Behind llama.cpp
 * it does not, and the model should not claim to be Claude when asked.
 */
export const identity = (model: string) =>
  [
    "# Your model",
    `You are ${labelOf(model)} (\`${model}\`), an open-weights model running locally on this machine through`,
    "llama.cpp. You are not Claude and were not made by Anthropic: Claude Code is only the harness you run in (its",
    "tools and system prompt). Ignore any statement above that names a Claude model as yours. When asked who or what",
    `you are, say you are ${labelOf(model).split(" · ")[0]} running locally through Apollo.`,
  ].join("\n");

/**
 * A local model served by llama.cpp's llama-server, driven by the Claude Code
 * harness through llama-server's Anthropic Messages API (`/v1/messages`). Tools,
 * MCP, skills and approvals work as they do for Claude.
 */
export const makeLlamaCppProvider = (config: LlamaCppProviderConfig): Provider => {
  const backend: ClaudeBackend = {
    kind: "llamacpp",
    free: true,
    ...(config.review ? { review: config.review } : {}),
    listModels: Effect.flatMap(config.connection, listLlamaCppModels),
    prepare: (requested) =>
      Effect.gen(function* () {
        const connection = yield* config.connection;
        const models = yield* listLlamaCppModels(connection);
        const model = requested ?? models.find((m) => m.isDefault)?.id;
        if (!model) return yield* fail(`llama-server at ${connection.baseUrl} has no model loaded`);
        if (!models.some((m) => m.id === model)) {
          return yield* fail(`llama-server at ${connection.baseUrl} does not have the model ${model}`);
        }
        const contextSize = yield* llamaCppContextSize(connection, model);
        // Lives as long as the session.
        const proxy = yield* startProxy(connection);
        return { model, env: llamaCppEnvironment(proxy, model, contextSize), instructions: identity(model) };
      }),
  };
  return makeClaudeProvider({ executable: config.executable, backend });
};
