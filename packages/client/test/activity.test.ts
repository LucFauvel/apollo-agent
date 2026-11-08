import { describe, expect, it } from "vitest";
import { bySubagent, stepTitle, summarizeActivity, toBlocks, toolName, toolSummary, type TranscriptItem } from "../src/index.ts";

const tool = (key: string, name: string, output: string | null = "ok"): TranscriptItem =>
  ({ kind: "tool", key, name, summary: "", output, isError: false }) as unknown as TranscriptItem;
const thought = (key: string): TranscriptItem => ({ kind: "reasoning", key, text: "hmm", streaming: false }) as unknown as TranscriptItem;
const said = (key: string): TranscriptItem => ({ kind: "assistant", key, text: "done", streaming: false }) as unknown as TranscriptItem;

describe("activity", () => {
  it("folds consecutive thoughts and tool calls into one block", () => {
    const blocks = toBlocks([thought("1"), tool("2", "Bash"), said("3"), tool("4", "Read")]);
    expect(blocks.map((b) => b.kind)).toEqual(["activity", "assistant", "activity"]);
  });

  it("counts every category, git and connectors included", () => {
    const blocks = toBlocks([thought("1"), tool("2", "mcp__apollo__apollo_pr_create"), tool("3", "mcp__claude_ai_Slack__slack_send_message"), tool("4", "Bash"), tool("5", "Bash")]);
    const block = blocks[0];
    if (block?.kind !== "activity") throw new Error("expected an activity block");
    expect(summarizeActivity(block.steps).text).toBe("Thought · 1 git action · 1 connector call · 2 commands");
  });

  it("shows a subagent and the calls it made under it", () => {
    const sub = { ...(tool("3", "Read") as object), parent: "2" } as unknown as TranscriptItem;
    const blocks = toBlocks([tool("2", "Agent"), sub]);
    const block = blocks[0];
    if (block?.kind !== "activity") throw new Error("expected an activity block");
    expect(summarizeActivity(block.steps).text).toBe("1 subagent · 1 read");
    expect(bySubagent(block.steps[1]!, block.steps)).toBe(true);
    expect(stepTitle(block.steps[0] as never)).toBe("Subagent");
  });

  it("names tools as people read them", () => {
    expect(toolName("mcp__claude_ai_Slack__slack_send_message")).toBe("Slack · send message");
    expect(toolName("mcp__apollo__apollo_browser_open")).toBe("browser open");
    expect(toolSummary("mcp__apollo__apollo_browser_open", '{"url":"https://example.com"}')).toBe("https://example.com");
  });
});

describe("compacting", () => {
  const at = (seq: number, event: unknown) => ({ sessionId: "s", seq, at: 0, event }) as never;
  it("shows while the agent compacts, until it is done or the turn ends", async () => {
    const { reduceTranscript, isCompacting } = await import("../src/index.ts");
    let state = { sessionId: "s" as never, lastSeq: 0, items: [] as ReadonlyArray<TranscriptItem> };
    state = reduceTranscript(state, at(1, { _tag: "TurnStarted" }));
    state = reduceTranscript(state, at(0, { _tag: "Compacting", active: true }));
    expect(isCompacting(state.items)).toBe(true);
    state = reduceTranscript(state, at(0, { _tag: "Compacting", active: false }));
    expect(isCompacting(state.items)).toBe(false);
    state = reduceTranscript(state, at(0, { _tag: "Compacting", active: true }));
    state = reduceTranscript(state, at(2, { _tag: "TurnCompleted", outcome: "interrupted", error: null }));
    expect(isCompacting(state.items)).toBe(false);
    expect(state.items.map((i) => i.kind)).toEqual(["turn-end"]);
  });
});

