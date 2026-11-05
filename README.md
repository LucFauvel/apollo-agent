# Apollo

Apollo is a desktop app for running **bots**: long-lived personas that orchestrate
**Claude Code** and **Codex** sessions and share **memory** and **skills** across both.

- A bot has one **orchestrator** (main) session you talk to, plus any number of
  **worker** sessions, shown nested under it. Each session picks its own provider,
  so one bot can mix Claude and Codex workers.
- The orchestrator delegates through Apollo's MCP tools (`apollo_spawn_session`,
  `apollo_wait_session`, …). Workers report back when they finish a turn.
- Memory and skills live in Apollo, not in either agent, so whatever one provider
  learns, the other can use.

## Requirements

- Node **26.12+** for development (runs TypeScript and `node:sqlite` natively), pnpm 12.
  The desktop app runs the server on Electron's bundled Node.
- `claude` (Claude Code) and/or `codex` CLIs installed and logged in

## Running

```sh
pnpm install
pnpm dev            # server + web UI → http://127.0.0.1:5733
pnpm dev:desktop    # same, inside the Electron shell
pnpm start          # build the UI and run the desktop app against it
pnpm package        # build an installer into apps/desktop/release/
```

### Installers

`pnpm package` builds the UI, bundles the server and its workspace packages into one
file with esbuild (`apps/desktop/scripts/bundle-server.ts`), then runs electron-builder:
an AppImage on Linux, a dmg on macOS, an NSIS installer on Windows. Each platform
builds its own installer. `pnpm --filter @apollo/desktop package:dir` gives an unpacked
build that is faster to try.

The installed app uses the `claude` and `codex` CLIs on your `PATH`; it reads the
`PATH` from your login shell so launchers that start apps with a minimal environment
still find them. It does not ship Claude Code's own 300+ MB binary. Set
`APOLLO_CLAUDE_BIN` / `APOLLO_CODEX_BIN` to use specific ones.

Dev state goes to `./.apollo-dev`; otherwise Apollo stores everything in `~/.apollo`
(`APOLLO_DATA_DIR` overrides both).

| Variable | Default | Purpose |
| --- | --- | --- |
| `APOLLO_PORT` / `APOLLO_HOST` | `4317` / `127.0.0.1` | Server bind address |
| `APOLLO_DATA_DIR` | `~/.apollo` | SQLite database location |
| `APOLLO_CLAUDE_BIN` / `APOLLO_CODEX_BIN` | SDK's own (dev), `claude` on PATH (installed) / `codex` | Provider executables |
| `APOLLO_WEB_DIST` | unset | Serve a built UI from the server |
| `APOLLO_ALLOWED_ORIGINS` | unset | Extra browser origins allowed to call the API (comma-separated) |
| `APOLLO_PUBLIC_URL` | server URL | Base URL used in printed pairing links (the Vite UI in dev) |
| `APOLLO_NODE` | Electron's Node | Runtime the desktop app uses to start the server |
| `APOLLO_MAX_STORAGE_MB` | `2048` | Database size compaction works to stay under |
| `APOLLO_MEMORY_ARCHIVE_LIMIT` | `2000` | Archive memories kept per bot (and globally) |
| `APOLLO_DETAIL_RETENTION_DAYS` | `30` | Age after which tool output and reasoning are trimmed |
| `APOLLO_LOG_HTTP=1` | off | Log every HTTP request |
| `APOLLO_SCREENSHOT` | unset | Desktop: save a PNG of the window and quit (`APOLLO_SCREENSHOT_DELAY`, `APOLLO_SCREENSHOT_JS` run first) |

## Checks

```sh
pnpm typecheck
pnpm test
# Live end-to-end (uses real Claude + Codex tokens; needs a running server):
APOLLO_PAIRING_LINK="$(pnpm -s pair | head -1)" node apps/server/scripts/smoke.ts /path/to/scratch/dir
```

## Layout

```
packages/contracts   Domain schemas + typed RPC group (Effect Schema / effect/rpc)
packages/providers   Provider adapters behind one interface
                     ClaudeProvider → Claude Agent SDK (streaming input)
                     CodexProvider  → `codex app-server` JSON-RPC over stdio
apps/server          Effect 4 server: SessionManager, SQLite store, MCP server, WS RPC
apps/web             React 19 + Vite + Tailwind UI
apps/desktop         Electron shell (spawns the server, loads the UI)
```

## Architecture

```
 Electron / browser ──WS RPC (/rpc)──▶ Apollo server ──▶ SQLite (bots, sessions, event log,
                                         │    ▲               memories + FTS5, skills)
                         SessionManager ─┤    │
                     ┌───────────────────┘    │ MCP (/mcp, per-session bearer token)
                     ▼                        │
           ProviderSession (claude | codex) ──┘
```

- **Normalized events.** Each adapter turns its provider's native stream into one
  `AgentEvent` union (`TurnStarted`, `AssistantDelta`, `ToolStarted`, `ApprovalRequested`, …).
  The server appends them to a per-session log. The UI replays the log, then follows it live.
  Text deltas are broadcast but not stored; the final message is.
- **One process per live session.** A provider session's lifetime is an Effect `Scope`.
  Closing it stops the Claude query or the `codex app-server` process. Sessions reopen
  lazily on the next message and resume through the provider's own thread id.
- **Three memory layers**, shared by every session of a bot whatever the provider:
  1. *Core memory* is always in the prompt: notes about the user (shared by all bots) and
     the bot's own notes. Each has a character budget (1375 / 2200), so agents consolidate
     instead of piling up. Agents edit it with `apollo_core_memory`; you can in the Knowledge panel.
  2. *The archive* holds everything else, searched by keyword (`apollo_memory_search`).
     Saving a memory that already exists refreshes it instead of duplicating it.
  3. *Past sessions*: `apollo_session_search` / `apollo_session_read` search and read
     earlier conversations of the bot (messages, not tool output).
- **Learning loop.** With `autoLearn` on, every 3 completed turns (or when you press
  *Reflect*) Apollo starts a short **reflection** session. It reads the transcript, saves
  memories, tidies core memory, and proposes skills. Proposals wait in the Knowledge panel until you approve
  them; approving one archives the previous version.
- **Native skills.** Active skills are mirrored to `<data dir>/skills/<bot id>/` as a
  Claude Code plugin (`apollo-skills`, with `skills/<name>/SKILL.md`). Claude loads it as a
  local plugin; Codex loads its `skills/` folder as an extra skill root. When skills change,
  live sessions reload them. SQLite stays the source of truth: the folder is regenerated.
- **Bounded storage.** A compaction pass runs a minute after startup, then every 6 hours
  (or via *Compact now* in the Knowledge panel). It trims tool output and reasoning older than
  30 days, deletes finished reflection sessions, evicts the least recently used archive
  memories beyond 2000 per bot, and keeps 5 archived versions per skill. Over the storage
  budget it drops old tool events, then the least recently active idle workers. Messages,
  orchestrator history, core memory and active skills are never removed to meet the budget.
  Freed pages go back to the OS (incremental vacuum).
- **Approvals.** In `approval-required` mode, Claude's `canUseTool` and Codex's approval
  requests both surface as the same approval card.
- **Input requests.** When an MCP server asks the user for input (an MCP elicitation, from
  either provider) or Codex calls its `request_user_input` tool, the session shows a form
  built from the requested schema, or a link for URL-mode requests such as OAuth.

## Pairing & security

Apollo only talks to **paired devices**, the same model t3code uses:

- **Pairing links** (`…/pair#token=…`) carry a one-time token that expires after 10 minutes.
  The token sits in the URL fragment, so it never reaches server logs. To get one:
  - run `pnpm pair` (dev) or `node apps/server/src/bin.ts pair [--label "Work laptop"]`;
  - on a fresh install, copy the link the server prints at startup;
  - or open **Devices** on a device that is already paired.
- Redeeming a link creates a **client session**: an HttpOnly, SameSite=Strict cookie for
  browsers, or a bearer token for CLI clients (`"bearer": true`). Sessions slide for
  30 days and appear under **Devices**, where you can revoke them.
- The **desktop app** pairs itself. Each launch hands its server a fresh random bootstrap
  token, and Electron keeps the session cookie between launches.
- Only SHA-256 hashes of pairing and session tokens are stored.
- `/rpc` and `/api/*` require a session. `/mcp` uses separate per-agent-session bearer
  tokens. Browser requests from a foreign `Origin` are refused outright; this matters
  because browsers allow cross-origin WebSockets. Add trusted origins with `APOLLO_ALLOWED_ORIGINS`.
- The server binds to `127.0.0.1` by default.

## Known gaps / next steps

- Archive and transcript search are keyword-based (FTS5), like Hermes. Embeddings could be
  added behind `searchMemories` / `searchTranscripts` if paraphrased lookups start missing.
- Installers are unsigned, and the app has no icon or auto-update yet.
- Pending approvals and input requests are lost if the server restarts mid-turn; the
  provider sees the turn end.
