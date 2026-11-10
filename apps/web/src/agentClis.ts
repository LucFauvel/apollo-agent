import type { AccountProvider, AgentCliState } from "@apollo/contracts";
import { useEffect, useSyncExternalStore } from "react";
import { becameUsable } from "./agentCliChanges.ts";
import { forgetModels } from "./models.ts";
import { follow } from "./rpc.ts";
import { refreshVersions } from "./versions.ts";

/** Claude Code and Codex on this computer (installed, installing, signed in), from `agentClis.watch`. */
let clis: ReadonlyArray<AgentCliState> = [];
const listeners = new Set<() => void>();
let started = false;

const apply = (next: ReadonlyArray<AgentCliState>) => {
  const usable = becameUsable(clis, next);
  // Model lists that failed before the install or sign-in can load now (the server forgot its own first).
  if (usable.length > 0) forgetModels();
  // A finished install has a version to show now.
  if (usable.some((u) => u.installed)) void refreshVersions();
  clis = next;
  for (const l of listeners) l();
};

export function useAgentCli(provider: AccountProvider): AgentCliState | null {
  useEffect(() => {
    if (started) return;
    started = true;
    follow((client) => client["agentClis.watch"](), apply);
  }, []);
  const all = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => clis,
  );
  return all.find((c) => c.provider === provider) ?? null;
}
