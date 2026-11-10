import type { AgentCliState } from "@apollo/contracts";
import { describe, expect, it } from "vitest";
import { becameUsable } from "./agentCliChanges.ts";

const cli = (patch: Partial<AgentCliState>): AgentCliState => ({
  provider: "codex",
  executable: null,
  bundled: false,
  install: null,
  installError: null,
  login: null,
  signIn: null,
  ...patch,
});

const signedIn = { loggedIn: true, email: "me@home.com", orgName: null, plan: "plus" };
const signedOut = { loggedIn: false, email: null, orgName: null, plan: null };

describe("becameUsable", () => {
  it("reports a CLI that was just installed or signed in", () => {
    const installing = cli({ install: { step: "Downloading", startedAt: 1 } });
    const installed = cli({ executable: "/home/me/.local/bin/codex", login: signedOut });
    expect(becameUsable([installing], [installed])).toEqual([{ provider: "codex", installed: true }]);
    const done = cli({ executable: "/home/me/.local/bin/codex", login: signedIn });
    expect(becameUsable([installed], [done])).toEqual([{ provider: "codex", installed: false }]);
  });

  it("ignores the first state and changes that do not make a CLI usable", () => {
    const done = cli({ executable: "/home/me/.local/bin/codex", login: signedIn });
    expect(becameUsable([], [done])).toEqual([]);
    expect(becameUsable([done], [{ ...done, signIn: { url: null, userCode: null, needsCode: false, error: null } }])).toEqual([]);
    expect(becameUsable([cli({})], [cli({ installError: "offline" })])).toEqual([]);
  });
});
