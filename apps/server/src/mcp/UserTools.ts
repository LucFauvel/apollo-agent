import { randomUUID } from "node:crypto";
import { ApolloError, ConnectorInfo, ProviderKind } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { AppSettings } from "../AppSettings.ts";
import { Browser } from "../browser/Browser.ts";
import { Secrets } from "../secrets/Secrets.ts";
import { SessionManager } from "../SessionManager.ts";
import { McpCaller } from "./Caller.ts";

/** Tools that reach the user: visuals shown in the conversation, and secrets they provide. */

const shared = {
  failure: ApolloError,
  failureMode: "return" as const,
  dependencies: [McpCaller],
};

const MAX_HTML = 512 * 1024;

const ShowHtml = Tool.make("apollo_show_html", {
  ...shared,
  description: [
    "Show the user a visual in the conversation: a chart, table, diagram, mockup or small interactive page.",
    "`html` is one complete, self-contained document: inline <style> and <script>; libraries may load from a CDN",
    "(e.g. cdn.jsdelivr.net). It renders in a sandboxed frame about 720 px wide, on the app's dark background",
    "(#09090b, text #e4e4e7): use transparent or dark backgrounds and a light theme only if the content needs it.",
    "Check it first with apollo_preview_html when it has scripts or a non-trivial layout. Use it when a visual",
    "answers better than text, not for plain prose.",
  ].join(" "),
  parameters: Schema.Struct({
    html: Schema.String,
    title: Schema.optional(Schema.String),
    /** Initial height in px; the frame grows to fit its content up to 900 px. */
    height: Schema.optional(Schema.Number),
  }),
  success: Schema.Struct({ shown: Schema.Boolean, visualId: Schema.String }),
}).annotate(Tool.Destructive, false);

const PreviewHtml = Tool.make("apollo_preview_html", {
  ...shared,
  description: [
    "Render an HTML document in the built-in browser without showing it to the user, and get a PNG path",
    "(open it with your image tool), its content height and its console output. Use it to check a visual",
    "before apollo_show_html. `width` 240-1600 (default 720; about 390 for phones), `appearance` dark by default.",
  ].join(" "),
  parameters: Schema.Struct({
    html: Schema.String,
    width: Schema.optional(Schema.Number),
    appearance: Schema.optional(Schema.Literals(["dark", "light"])),
  }),
  success: Schema.Struct({ path: Schema.String, contentHeight: Schema.Number, log: Schema.Array(Schema.String) }),
}).annotate(Tool.Readonly, true);

const RequestSecret = Tool.make("apollo_request_secret", {
  ...shared,
  description: [
    "Ask the user for a secret (API key, token, password) in a private card and wait for the answer.",
    "They type it or pick it from 1Password; you never see the value, and it is never stored in the conversation.",
    "delivery `secretRef` (default): a one-use reference for Apollo tools, e.g. apollo_browser_act",
    "`{ action: \"type\", ref, secretRef }` to fill a password field. delivery `file`: the path of a private file",
    'to read inside a shell command, e.g. `GH_TOKEN="$(cat <path>)" gh auth status`; never print, log or copy it.',
    "Both expire after 15 minutes. Explain in `reason` what it is for. Fails if the user declines or does not answer.",
  ].join(" "),
  parameters: Schema.Struct({
    label: Schema.String,
    reason: Schema.String,
    placeholder: Schema.optional(Schema.String),
    delivery: Schema.optional(Schema.Literals(["secretRef", "file"])),
    /** How long to wait for the user, in seconds (default 600, at most 3600). */
    timeoutSeconds: Schema.optional(Schema.Number),
  }),
  success: Schema.Struct({
    delivery: Schema.Literals(["secretRef", "file"]),
    secretRef: Schema.NullOr(Schema.String),
    path: Schema.NullOr(Schema.String),
    expiresInSeconds: Schema.Number,
  }),
});

const ListProjects = Tool.make("apollo_list_projects", {
  ...shared,
  description: [
    "List the user's projects: git repositories and folders with a project manifest found in the project folders",
    "they set in Apollo's settings (e.g. ~/git). `query` filters by name or path (case-insensitive). Use it to find",
    "the repository a request is about, then work there by absolute path.",
  ].join(" "),
  parameters: Schema.Struct({ query: Schema.optional(Schema.String) }),
  success: Schema.Struct({
    projectFolders: Schema.Array(Schema.String),
    projects: Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String, git: Schema.Boolean })),
    truncated: Schema.Boolean,
  }),
}).annotate(Tool.Readonly, true);

const ListConnectors = Tool.make("apollo_list_connectors", {
  ...shared,
  description: [
    "What each provider's sessions can reach beyond their own tools: hosted connectors (claude.ai connectors for",
    "Claude, ChatGPT apps for Codex) and MCP servers the user configured, with their status. Use it to pick a provider",
    "for a task that needs e.g. Slack, GitHub or Notion. `refresh` asks the CLIs again (a few seconds).",
  ].join(" "),
  parameters: Schema.Struct({
    provider: Schema.optional(ProviderKind),
    refresh: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    providers: Schema.Array(
      Schema.Struct({ provider: ProviderKind, connectors: Schema.Array(ConnectorInfo), error: Schema.NullOr(Schema.String) }),
    ),
  }),
}).annotate(Tool.Readonly, true);

export const UserToolkit = Toolkit.make(ShowHtml, PreviewHtml, RequestSecret, ListProjects, ListConnectors);

const invalid = (message: string) => new ApolloError({ code: "invalid", message });

export const handlers = UserToolkit.toLayer(
  Effect.gen(function* () {
    const manager = yield* SessionManager;
    const browser = yield* Browser;
    const secrets = yield* Secrets;
    const appSettings = yield* AppSettings;
    return {
      apollo_list_connectors: ({ provider, refresh }) =>
        Effect.gen(function* () {
          const kinds: Array<ProviderKind> = provider ? [provider] : ["claude", "codex", "llamacpp"];
          // The other agents report no connectors; ask for one by name to check it.
          const providers = yield* Effect.forEach(
            kinds,
            (kind) =>
              manager.listConnectors(kind, refresh ?? false).pipe(
                Effect.map((connectors) => ({ provider: kind, connectors, error: null })),
                Effect.catch((error) => Effect.succeed({ provider: kind, connectors: [], error: error.message })),
              ),
            { concurrency: "unbounded" },
          );
          return { providers };
        }),
      apollo_list_projects: ({ query }) =>
        Effect.gen(function* () {
          const { projectFolders } = yield* appSettings.read;
          const q = query?.trim().toLowerCase();
          const all = yield* appSettings.projects;
          const matching = q ? all.filter((p) => p.path.toLowerCase().includes(q)) : all;
          return {
            projectFolders,
            projects: matching.slice(0, 200).map(({ name, path, git }) => ({ name, path, git })),
            truncated: matching.length > 200,
          };
        }),
      apollo_show_html: ({ html, title, height }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          if (!html.trim()) return yield* invalid("`html` is empty");
          if (html.length > MAX_HTML) return yield* invalid(`\`html\` is ${Math.round(html.length / 1024)} KB; keep it under 512 KB`);
          const visualId = randomUUID();
          yield* manager.appendEvent(caller.sessionId, {
            _tag: "Visual",
            visualId,
            title: title?.trim().slice(0, 120) || "",
            html,
            height: height && height > 0 ? Math.min(Math.round(height), 2000) : null,
          });
          return { shown: true, visualId };
        }),

      apollo_preview_html: ({ html, width, appearance }) =>
        Effect.gen(function* () {
          if (!html.trim()) return yield* invalid("`html` is empty");
          if (html.length > MAX_HTML) return yield* invalid("`html` is over 512 KB");
          return yield* browser.renderHtml(html, Math.min(Math.max(Math.round(width ?? 720), 240), 1600), appearance ?? "dark");
        }),

      apollo_request_secret: ({ label, reason, placeholder, delivery, timeoutSeconds }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          return yield* secrets.request(caller, {
            label,
            reason,
            placeholder,
            delivery: delivery ?? "secretRef",
            timeoutMs: Math.min(Math.max(timeoutSeconds ?? 600, 30), 3600) * 1000,
          });
        }),
    };
  }),
);
