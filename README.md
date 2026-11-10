# Apollo

Apollo is a desktop app for running **bots**: long-lived personas that orchestrate
**Claude Code**, **Codex** and **local llama.cpp** sessions and share **memory** and
**skills** across all of them.

- A bot has one **orchestrator** (main) session you talk to, plus any number of
  **worker** sessions, shown nested under it. Each session picks its own provider,
  so one bot can mix Claude, Codex and local workers.
- The orchestrator delegates through Apollo's MCP tools (`apollo_spawn_session`,
  `apollo_wait_session`, …). Workers report back when they finish a turn.
- Memory and skills live in Apollo, not in either agent, so whatever one provider
  learns, the other can use.
- A **built-in browser** gives every session a real Chromium to read and drive web pages
  and local dev servers. You watch its tabs live in the Browser panel and can take over.
- Agents can **show visuals** (charts, tables, mockups) in the conversation, and **ask for
  secrets** in a private card you fill by typing or from **1Password**; they never see the value.
- Agents can set up **monitors** (`apollo_monitor_start`): a command whose every output line
  reaches the agent as a message, so it reacts to events without polling. Running monitors show
  above the message box, with a Stop button.

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

The desktop app keeps running in the menu bar (macOS) or system tray (Windows, Linux)
when you close its window, so scheduled tasks and workers carry on. Open it again from
the tray icon, or quit from the tray menu.

Icons come from SVG sources in `apps/desktop/resources/icons/` (the mark, the app tile and
the tray glyph). `pnpm --filter @apollo/desktop icons` renders them with Electron into
`resources/icon.{icns,ico,png}` and `resources/tray/*.png`. The `.icns` is only rebuilt on
macOS. The rendered files are committed.

The installed app uses the `claude` and `codex` CLIs on your `PATH`; it reads the
`PATH` from your login shell so launchers that start apps with a minimal environment
still find them. It does not ship Claude Code's own 300+ MB binary. Set
`APOLLO_CLAUDE_BIN` / `APOLLO_CODEX_BIN` to use specific ones.

**Providers** (sidebar footer) holds credentials and endpoints:

- *Claude Code* signs in with your `claude login` by default. That can be a Claude subscription
  or a Console account. You can save an Anthropic API key and switch to it; switching back keeps
  the key. Keys are stored in Apollo's database and never sent back to the UI. Anthropic's terms
  do not allow third-party products to offer claude.ai (subscription) login without approval,
  so builds you distribute should use API keys.
- *llama.cpp* runs local models with the Claude Code harness: tools, MCP, skills and
  approvals work as they do for Claude. By default Apollo manages it (**Local models**):
  - **Install.** Apollo downloads the official llama.cpp release for your hardware. CUDA
    builds come with their runtime; Vulkan, ROCm, Metal and CPU builds are also available.
    Each download is checked against GitHub's published SHA-256, and newer builds are
    offered as updates.
  - **Server.** Apollo runs llama-server in router mode on a private port with a random key.
    It starts with Apollo, restarts if it crashes, and stops when Apollo quits. Models load
    on first use and unload after 15 idle minutes. `--fit` sizes each model to memory with
    at least 64K context, and an 8-bit KV cache halves that cache's memory.
  - **Finding models**, like Hermes: suggestions are the most downloaded chat models from
    ggml-org, unsloth, bartowski and LM Studio, and search covers all GGUF models on
    Hugging Face. Each build is sized for this machine before download: weights, plus a KV
    cache estimated from the model's GGUF header (read with a ranged request), plus buffers.
    The result is *Fits your GPU*, *Uses system RAM* or *Too big*. Apollo suggests the best
    build that fits, never below 4-bit, and marks the largest model that runs fully on the
    GPU with ★. Downloads go through llama-server, with progress.

  Or choose *My own server* and point Apollo at a llama-server you run yourself, for example
  `llama-server -m model.gguf -c 65536`. It needs the Anthropic Messages API (`/v1/messages`,
  January 2026 or later).

Dev state goes to `./.apollo-dev`; otherwise Apollo stores everything in `~/.apollo`
(`APOLLO_DATA_DIR` overrides both).

| Variable | Default | Purpose |
| --- | --- | --- |
| `APOLLO_PORT` / `APOLLO_HOST` | `4317` / `127.0.0.1` | Server bind address |
| `APOLLO_DATA_DIR` | `~/.apollo` | SQLite database location |
| `APOLLO_LLAMACPP_URL` / `APOLLO_LLAMACPP_API_KEY` | `http://127.0.0.1:8080` / none | llama-server defaults, until changed under Providers |
| `APOLLO_CLAUDE_BIN` / `APOLLO_CODEX_BIN` | SDK's own (dev), `claude` on PATH (installed) / `codex` | Provider executables |
| `APOLLO_WEB_DIST` | unset | Serve a built UI from the server |
| `APOLLO_ALLOWED_ORIGINS` | unset | Extra browser origins allowed to call the API (comma-separated) |
| `APOLLO_PUBLIC_URL` | server URL | Base URL used in printed pairing links (the Vite UI in dev) |
| `APOLLO_NODE` | Electron's Node | Runtime the desktop app uses to start the server |
| `APOLLO_MAX_STORAGE_MB` | `2048` | Database size compaction works to stay under |
| `APOLLO_MEMORY_ARCHIVE_LIMIT` | `2000` | Archive memories kept per bot (and globally) |
| `APOLLO_DETAIL_RETENTION_DAYS` | `30` | Age after which tool output and reasoning are trimmed |
| `APOLLO_BROWSER_BIN` | first Chrome/Edge/Chromium/Brave found | Browser the built-in browser runs |
| `APOLLO_BROWSER_HEADLESS=0` | headless | Show the built-in browser's window too |
| `APOLLO_OP_BIN` | `op` on PATH | 1Password CLI used to fill secrets |
| `APOLLO_LOG_HTTP=1` | off | Log every HTTP request |
| `APOLLO_SCREENSHOT` | unset | Desktop: save a PNG of the window and quit (`APOLLO_SCREENSHOT_DELAY`, `APOLLO_SCREENSHOT_JS` run first) |

### Workspaces and project folders

A new bot gets a suggested name and its own workspace folder, `~/Apollo/<name>`, which Apollo creates.
Both can be changed before creating the bot. In **Settings** (gear icon in the sidebar), add the folders
where you keep your projects (e.g. `~/git`). Apollo finds the git repositories and folders with a project
manifest in them, up to two levels deep. You can pick one of those projects as a bot's workspace, and
every session can read and edit them: Claude gets them as `additionalDirectories`, Codex as writable
sandbox roots. Agents find projects with `apollo_list_projects`. The default workspace root can also
be changed in Settings.

### Built-in browser

Agents get browser tools on Apollo's MCP server, modelled on T3 Code's preview tools:

| Tool | Does |
| --- | --- |
| `apollo_browser_open` / `_navigate` | Open a page (`localhost:5173` gets http, bare hosts https), go back/forward/reload |
| `apollo_browser_snapshot` | The page as a text outline with element refs: `- button "Save" [ref=e7]` |
| `apollo_browser_act` | click, type, press, hover, select, scroll, by ref or CSS selector |
| `apollo_browser_wait_for` | Wait for text, a visible selector or a URL |
| `apollo_browser_evaluate` | Run JavaScript in the page |
| `apollo_browser_screenshot` | Save a PNG; agents open it with their image tool (Claude Code Read, Codex view_image) |
| `apollo_browser_tabs` / `_close` | List and close tabs |

`apollo_notify` sends you a desktop notification.

### Visuals and secrets

- `apollo_show_html` puts a self-contained HTML page in the conversation. It runs in a
  sandboxed frame with an opaque origin (scripts allowed, no access to Apollo's cookies,
  storage or API), sizes itself to its content, and opens in a window of its own.
  `apollo_preview_html` renders it in the built-in browser first and returns a PNG, the
  content height and console output, so the agent can check it before showing it.
- `apollo_request_secret` shows a private card: you type the value, or pick an item and
  field from 1Password, or decline. The agent gets a one-use `secretRef` (which
  `apollo_browser_act` can type into a password field) or, with `delivery: "file"`, a
  0600 file under `<data dir>/secrets` to read in a shell command. References and files
  expire after 15 minutes and are cleared at shutdown and startup. The value is never
  written to the event log, the database or the transcript.
- 1Password goes through its CLI (`op`, or `APOLLO_OP_BIN`), with the desktop app's CLI
  integration or `op signin`. Apollo lists items and field labels; it reads only the
  field you pick, on the server, so field values never reach the UI or the agent.

Apollo runs the Chrome, Edge, Chromium or Brave already installed (`APOLLO_BROWSER_BIN` picks
one), headless, with its own profile in `<data dir>/browser/profile`, so logins persist
between sessions and stay separate from your own browser. It starts on first use and quits
after 10 idle minutes. Tabs belong to a bot: all its sessions can use them, other bots
cannot. Snapshots also report console errors, page errors and dialogs; Apollo accepts alerts
and confirms and dismisses prompts, since agents cannot see them. Only http(s) pages open.

The **Browser** panel (header button) streams the selected tab live. Clicking, scrolling and
typing on it go to the page, and the address bar and back/forward/reload work as usual.

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
                     LlamaCppProvider → ClaudeProvider pointed at llama-server
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
- **Local models.** The llama.cpp provider is the Claude adapter with a different backend.
  Each session gets a small local proxy in front of llama-server, and Claude Code's environment
  points at it (`ANTHROPIC_BASE_URL`). The proxy folds the `system` messages Claude Code puts
  mid-conversation into the neighbouring user message, because many chat templates (Qwen3.5,
  for one) reject a system message that is not first. Claude Code authenticates to the proxy
  with a throwaway token, so neither your Anthropic credentials nor the llama-server key are in
  its environment. All of Claude Code's model aliases, including the small model it uses for
  background work, are set to the local model. Its context limit comes from llama-server's
  `/props`, so auto-compaction starts in time. Usage is recorded at $0.
- **Models and settings.** Model lists come from the CLIs themselves (Claude Code's
  `supportedModels`, Codex's `model/list`, llama-server's `/v1/models`), cached for 30 minutes, with each model's reasoning
  effort levels. Every session has its own model, effort and permissions (or follows the bot's);
  open them from the provider badge in the session header. A change closes the provider process
  and the next message resumes the same conversation with the new settings; a running turn
  finishes first. The orchestrator can also pick a model and effort per worker.
- **Usage and guardrails.** Apollo records each session's token usage, and its cost for Claude.
  Codex reports no cost and local models cost nothing, so both count as $0. The figures are also totalled per bot per
  day, and they show in the session header, in the sidebar and in bot settings. Each bot has
  limits, which you set in its settings:
  - workers running at once (default 4); spawning more is refused;
  - orchestrator turns in a row that you did not start (default 25);
  - a daily token budget (fresh input + output) and a daily cost budget, both unlimited
    by default.

  Hitting a turn or budget limit **pauses** the bot. Going over a budget also interrupts the
  turns it is running. **Stop all** in the session header pauses the bot and interrupts every
  running turn. While a bot is paused, workers do not start, are not messaged, and do not
  report back, and reflection is skipped. Your own messages always go through.
  **Resume** clears the pause. It is refused while the bot is still over a daily budget:
  raise the budget, or wait until tomorrow (local time).
- **Acting on their own.** A bot can run on a schedule as well as when you message it.
  Open **Schedules** in the session header, or ask the orchestrator to set something up
  (its `apollo_schedule_*` MCP tools). There are two kinds:
  - **Tasks** run their prompt in a fresh worker session (`⏱ name`). The worker does not see the
    orchestrator's conversation, so the prompt must be self-contained. Its final message goes to the
    orchestrator as an Apollo message and to a desktop notification. Clicking the notification
    opens the run's session.
  - **Heartbeats** send their prompt into the orchestrator's own conversation, for check-ins that
    need its context.

  A run with nothing to report answers `[SILENT]`. Nothing is delivered for it, and the transcript
  shows "Nothing to report".

  Schedules read like `every 30m`, `daily at 9am`, `weekdays at 8:30`, `every mon, wed and fri 8:15`,
  `in 2h`, `tomorrow at 9am` or `2026-12-01 09:00`, or take a cron expression. They use the
  schedule's time zone (by default, the machine's). The editor previews the next runs.

  Scheduling rules:
  - Recurring schedules run at most every 5 minutes.
  - The scheduler checks every 30 s. A run that cannot start (the bot is paused, a heartbeat's
    orchestrator is busy, or every worker slot is taken) waits up to half its period, between
    2 minutes and 2 hours. After that it is skipped. Runs missed while Apollo was closed are
    skipped the same way, and they never pile up.
  - Runs follow the bot's guardrails: budgets and pauses apply, and a task counts as a worker.
    A scheduled turn starts a new count of autonomous orchestrator turns.
  - A schedule that fails three times in a row turns itself off.
  - A turn started by a schedule cannot create or change schedules, so runs cannot multiply.
  - The orchestrator may own at most 20 schedules.
  - Only the 5 most recent task sessions per schedule are kept. **History** keeps the last 50 runs.
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

- Schedules only run while Apollo is running. The desktop app quits when its window closes,
  so a "keep running in the tray" mode would let bots work while the window is closed.
  Webhooks and file watchers are not triggers yet.

- Local models: Claude Code's prompt and tool definitions are about 13k tokens, and small
  models call tools unreliably, so results depend on the model. Managed llama.cpp was tried
  on Linux with CUDA, not yet on Windows or macOS. If Apollo is killed outright (no clean
  shutdown), its llama-server keeps running until stopped.

- Archive and transcript search are keyword-based (FTS5), like Hermes. Embeddings could be
  added behind `searchMemories` / `searchTranscripts` if paraphrased lookups start missing.
- Built-in browser: Apollo does not download a browser, so machines without Chrome, Edge,
  Chromium or Brave cannot use it yet. Screenshots reach agents as files, not inline images,
  because Effect's MCP toolkit only returns JSON. File uploads and per-bot browser profiles
  are not supported yet.
- Secret requests waiting for an answer are lost if the server restarts; the agent's call
  fails and it has to ask again. A `file` secret can be read by the agent's shell like any
  file it owns: Apollo keeps it out of the conversation, but cannot stop an agent that
  prints it.
- Installers are unsigned, and the app has no icon or auto-update yet.
- Pending approvals and input requests are lost if the server restarts mid-turn; the
  provider sees the turn end.
