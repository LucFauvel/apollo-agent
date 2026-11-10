import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool, type Toolkit } from "effect/ai";
import { ApolloToolkit, unknownModel } from "./ApolloMcp.ts";
import { ArtifactToolkit } from "./ArtifactTools.ts";
import { BotToolkit } from "./BotTools.ts";
import { BrowserToolkit } from "./BrowserTools.ts";
import { ChangeToolkit, SEMANTIC_DIFF_ONLY_WHEN_ASKED } from "./ChangeTools.ts";
import { JobToolkit } from "./JobTools.ts";
import { MonitorToolkit, timeoutMs } from "./MonitorTools.ts";
import { ProjectToolkit } from "./ProjectTools.ts";
import { PullRequestToolkit } from "./PullRequestTools.ts";
import { UserToolkit } from "./UserTools.ts";
import { WorktreeToolkit } from "./WorktreeTools.ts";

/**
 * The MCP server refuses, at startup, a tool whose parameters do not encode to a JSON
 * Schema object (an empty Struct, say: use Tool.EmptyParams). That stops the whole server,
 * so check every tool here.
 */
const toolkits: Record<string, Toolkit.Any> = {
  ApolloToolkit,
  ArtifactToolkit,
  BotToolkit,
  BrowserToolkit,
  ChangeToolkit,
  JobToolkit,
  MonitorToolkit,
  ProjectToolkit,
  PullRequestToolkit,
  UserToolkit,
  WorktreeToolkit,
};

const isObjectSchema = (tool: Tool.Any) => (Tool.getJsonSchema(tool) as { type?: unknown }).type === "object";

describe("MCP tools", () => {
  for (const [name, toolkit] of Object.entries(toolkits)) {
    it(`${name}: every tool takes an object of parameters`, () => {
      const bad = Object.values(toolkit.tools as Record<string, Tool.Any>)
        .filter((tool) => !isObjectSchema(tool))
        .map((tool) => tool.name);
      expect(bad).toEqual([]);
    });
  }

  it("would have caught an empty Struct", () => {
    const empty = Tool.make("example", { parameters: Schema.Struct({}) });
    expect(isObjectSchema(empty)).toBe(false);
    expect(isObjectSchema(Tool.make("example", { parameters: Tool.EmptyParams }))).toBe(true);
  });
});

describe("spawning workers", () => {
  it("accepts only model ids the provider offers, and lists them when refusing", () => {
    const available = [{ id: "claude-opus-5-5" }, { id: "claude-sonnet-5-5" }];
    expect(unknownModel("claude-opus-5-5", "claude", available)).toBeNull();
    expect(unknownModel("opus", "claude", available)).toBe(
      '"opus" is not a claude model. Available: claude-opus-5-5, claude-sonnet-5-5. Use one of these ids, or omit model for the default.',
    );
  });

  it("tells the agent to check model ids before spawning", () => {
    const spawn = (ApolloToolkit.tools as Record<string, Tool.Any>)["apollo_spawn_session"]!;
    expect(spawn.description).toContain("apollo_list_models");
    expect((ApolloToolkit.tools as Record<string, Tool.Any>)["apollo_list_models"]).toBeDefined();
  });
});

describe("the full semantic diff", () => {
  it("says, first, that it is only for when the user asks", () => {
    const tool = (ChangeToolkit.tools as Record<string, Tool.Any>)["apollo_semantic_diff"]!;
    expect(tool.description!.startsWith(SEMANTIC_DIFF_ONLY_WHEN_ASKED)).toBe(true);
    expect(SEMANTIC_DIFF_ONLY_WHEN_ASKED).toContain("never on your own initiative");
    expect((Tool.getJsonSchema(tool) as { required?: Array<string> }).required).toEqual(["request"]);
  });
});

describe("monitors", () => {
  it("time out after an hour by default, within 1 minute and 24 hours, or never when persistent", () => {
    expect(timeoutMs(undefined, undefined)).toBe(60 * 60_000);
    expect(timeoutMs(0, false)).toBe(60_000);
    expect(timeoutMs(10_000, undefined)).toBe(24 * 60 * 60_000);
    expect(timeoutMs(5, true)).toBeNull();
  });
});
