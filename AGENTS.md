# Working on Apollo

See README.md for what Apollo is and how it fits together.

## Conventions

- TypeScript everywhere, run directly by Node 26 (no build step for server/packages).
  Relative imports use explicit `.ts` extensions.
- Server and shared packages use **Effect 4** (`effect@4.1.2`): services are
  `Context.Service` classes with `Layer`s, errors are `Schema.TaggedError`s, and
  long-lived resources are tied to a `Scope`. Effect 4 APIs differ from Effect 3: check
  `node_modules/effect/dist/*.d.ts` rather than relying on memory.
- `packages/contracts` is the single source of truth for the wire protocol. Change a
  schema there, and both server and web pick it up.
- Provider adapters translate native events into `AgentEvent` and nothing else.
  Orchestration logic belongs in `apps/server/src/SessionManager.ts`.
- Database migrations in `apps/server/src/Database.ts` are append-only.
- Installed apps run the server as one esbuild bundle (`apps/desktop/scripts/bundle-server.ts`).
  Server and package code must not read files relative to its own source
  (`import.meta.url`, `__dirname`); take paths from `ServerConfig` instead.
- Every route except `/health`, `/api/auth/{session,pair}`, `/mcp` and static UI files
  requires a paired session (`apps/server/src/auth/`). Node clients that send auth headers
  over WebSocket need `NodeSocket.layerWebSocketConstructor`. The global constructor
  rejects headers, and the RPC client then retries forever without an error.

## Checks

```sh
pnpm typecheck && pnpm test
```

`apps/server/src/SessionManager.test.ts` covers orchestration with a fake provider.
Use `it.live` for tests that sleep or wait: `it.effect` runs on a TestClock.

To regenerate the Codex protocol types for reference:
`codex app-server generate-ts --out <dir>`.
