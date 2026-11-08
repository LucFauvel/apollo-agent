import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool, type Toolkit } from "effect/ai";
import { ApolloToolkit, unknownModel } from "./ApolloMcp.ts";
import { BotToolkit } from "./BotTools.ts";
import { BrowserToolkit } from "./BrowserTools.ts";
import { ChangeToolkit } from "./ChangeTools.ts";
import { JobToolkit } from "./JobTools.ts";
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
  BotToolkit,
  BrowserToolkit,
  ChangeToolkit,
  JobToolkit,
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
