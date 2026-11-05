import type { BotId, Skill, SkillId } from "@apollo/contracts";
import { describe, expect, it } from "@effect/vitest";
import { effectiveSkills } from "./SkillSync.ts";

const skill = (name: string, botId: string | null, status: Skill["status"] = "active"): Skill => ({
  id: `skill-${name}-${botId}` as SkillId,
  botId: botId as BotId | null,
  name,
  description: "",
  body: "",
  status,
  version: 1,
  sourceSessionId: null,
  createdAt: 0,
  updatedAt: 0,
});

describe("effectiveSkills", () => {
  it("keeps active, path-safe skills and lets the bot's own shadow global ones", () => {
    const result = effectiveSkills([
      skill("deploy", null),
      skill("deploy", "bot-1"),
      skill("draft", "bot-1", "proposed"),
      skill("../escape", "bot-1"),
      skill("Bad Name", null),
      skill("audit", null),
    ]);
    expect(result.map((s) => [s.name, s.botId])).toEqual([
      ["audit", null],
      ["deploy", "bot-1"],
    ]);
  });
});
