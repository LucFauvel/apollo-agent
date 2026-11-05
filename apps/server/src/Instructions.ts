import {
  type Bot,
  CORE_MEMORY_LIMITS,
  type CoreMemory,
  type CoreMemoryTarget,
  coreMemoryUsage,
  type Session,
  type SessionEvent,
  type Skill,
} from "@apollo/contracts";

/** Tool names exposed by Apollo's MCP server (see `mcp/ApolloToolkit.ts`). */
export const MCP_SERVER_NAME = "apollo";

const coreBlock = (title: string, target: CoreMemoryTarget, entries: ReadonlyArray<string>) =>
  [
    `### ${title} (${coreMemoryUsage(entries)}/${CORE_MEMORY_LIMITS[target]} chars, target \`${target}\`)`,
    entries.length > 0 ? entries.map((e) => `- ${e}`).join("\n") : "(empty)",
  ].join("\n");

/**
 * Builds the standing instructions appended to the provider's own system
 * prompt. Memory has three layers: core memory (small, always here), the
 * memory archive and past transcripts (both searched on demand with MCP tools).
 */
export const buildInstructions = (input: {
  readonly bot: Bot;
  readonly session: Session;
  readonly core: CoreMemory;
  readonly skills: ReadonlyArray<Skill>;
}): string => {
  const { bot, session, core, skills } = input;
  const sections: Array<string> = [];

  sections.push(
    `# Apollo\nYou are running inside Apollo as part of the bot "${bot.name}". Apollo's tools are on the "${MCP_SERVER_NAME}" MCP server.`,
  );

  if (bot.instructions.trim().length > 0) {
    sections.push(`## Bot instructions\n${bot.instructions.trim()}`);
  }

  switch (session.role) {
    case "main":
      sections.push(
        [
          "## Your role: orchestrator",
          `You are ${bot.name}'s main session; the user talks to you directly.`,
          "Handle quick requests yourself. For substantial, long-running or parallelizable work, delegate to worker sessions:",
          "- `apollo_spawn_session` starts a worker with a task prompt. Pick the provider that fits:",
          `  \`claude\`, \`codex\` or \`llamacpp\` (bot default: \`${bot.defaultWorker.provider}\`). Workers can run in parallel.`,
          "  `llamacpp` is a local model on this machine: free and private, but weaker and slower. Use it for simple or",
          "  private tasks. If a `llamacpp` worker fails to start, llama-server is not running: use another provider.",
          "- Workers report back automatically when they finish a turn; you can also use `apollo_wait_session`.",
          "- `apollo_list_sessions`, `apollo_send_to_session` and `apollo_interrupt_session` manage workers.",
          "Give workers complete, self-contained task descriptions: they do not see this conversation.",
          `- At most ${bot.limits.maxConcurrentWorkers} workers can run at once. If a spawn is refused for that, wait for one with \`apollo_wait_session\`.`,
          "- Match the model and effort to the task: cheap and fast for simple work, stronger for hard problems.",
          "- If Apollo says the bot is paused, stop delegating and tell the user; only they can resume it.",
          "Summarize worker results for the user instead of pasting them verbatim.",
        ].join("\n"),
      );
      break;
    case "worker":
      sections.push(
        [
          "## Your role: worker",
          `You are a worker session of ${bot.name}${session.parentSessionId ? ", started by its orchestrator" : ""}.`,
          "Focus on your task. End each turn with a concise summary of what you did and what remains,",
          "since that final message is what gets reported back.",
        ].join("\n"),
      );
      break;
    case "reflection":
      sections.push(
        [
          "## Your role: reflection",
          "You review another session's transcript and extract durable knowledge. Do not modify files or run commands.",
        ].join("\n"),
      );
      break;
  }

  sections.push(
    [
      "## Memory",
      "Apollo's memory is shared by every session of this bot, whatever the provider. It has three layers:",
      "1. **Core memory** (below) is always in your prompt. It is small on purpose: keep only what every future",
      "   session should know up front (who the user is, standing preferences, key project facts). Edit it with",
      "   `apollo_core_memory`. When it is full, consolidate: merge or shorten entries, and move details to the archive.",
      "2. **The archive** holds everything else. `apollo_memory_search` finds entries by keyword; `apollo_memory_save`",
      "   adds durable facts, preferences and lessons; `apollo_memory_forget` removes wrong or duplicate ones.",
      "3. **Past sessions**: `apollo_session_search` searches earlier conversations of this bot, and",
      "   `apollo_session_read` shows the messages around a hit.",
      "Search before asking the user something they may have told you before. Never store secrets or credentials.",
      "",
      "This snapshot was taken when the session started; edits apply to future sessions.",
      "",
      coreBlock("About the user (shared by all bots)", "user", core.user),
      "",
      coreBlock(`${bot.name}'s notes`, "notes", core.notes),
    ].join("\n"),
  );

  const active = skills.filter((s) => s.status === "active");
  sections.push(
    [
      "## Skills",
      "Skills are reusable procedures learned from earlier work. Before a task that matches one, load it with",
      "`apollo_skill_read` and follow it. When you work out a reusable, non-obvious procedure, propose it with",
      "`apollo_skill_propose`; the user reviews proposals before they become active.",
      "Active skills are also installed as native skills (plugin `apollo-skills`), so your harness may offer them directly.",
      active.length > 0
        ? `\nAvailable skills:\n${active.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`
        : "\nNo skills yet.",
    ].join("\n"),
  );

  return sections.join("\n\n");
};

/** Condenses a session log into a transcript for a reflection pass. */
export const transcriptForReflection = (
  events: ReadonlyArray<SessionEvent>,
  maxChars = 40_000,
): string => {
  const lines: Array<string> = [];
  for (const { event } of events) {
    switch (event._tag) {
      case "UserMessage":
        lines.push(`${event.author.toUpperCase()}: ${event.text}`);
        break;
      case "AssistantMessage":
        lines.push(`ASSISTANT: ${event.text}`);
        break;
      case "ToolStarted":
        lines.push(`TOOL ${event.name}: ${event.summary}`);
        break;
      case "ToolCompleted":
        if (event.isError) lines.push(`TOOL ERROR: ${event.output.slice(0, 500)}`);
        break;
      case "TurnCompleted":
        if (event.outcome !== "completed") lines.push(`(turn ${event.outcome}${event.error ? `: ${event.error}` : ""})`);
        break;
      default:
        break;
    }
  }
  const text = lines.join("\n");
  return text.length <= maxChars ? text : `…(earlier transcript truncated)…\n${text.slice(-maxChars)}`;
};

export const reflectionPrompt = (session: Session, transcript: string) =>
  [
    `Review this transcript of the session "${session.title}" (${session.provider}) and extract what is worth keeping.`,
    "",
    "1. Call `apollo_memory_search` to check what is already known, so you do not save duplicates.",
    "2. Save new durable knowledge to the archive with `apollo_memory_save`: user preferences, facts about projects",
    "   and environments, and lessons from mistakes (kind `lesson`). Use scope `global` only for knowledge useful to",
    "   every bot. If you find archive entries that are wrong or duplicated, fix them with `apollo_memory_forget`.",
    "3. Update core memory with `apollo_core_memory` only for what every future session must know up front.",
    "   Keep it tidy: replace outdated entries and merge related ones rather than appending.",
    "4. If the session worked out a reusable multi-step procedure, propose it with `apollo_skill_propose`",
    "   (or propose an improved version of an existing skill under the same name).",
    "5. Reply with a short list of what you changed. Changing nothing is fine when nothing is durable.",
    "",
    "<transcript>",
    transcript,
    "</transcript>",
  ].join("\n");
