import type { AccountProvider, AgentCliState } from "@apollo/contracts";

/** CLIs that became usable between two states: just installed, or just signed in. */
export const becameUsable = (before: ReadonlyArray<AgentCliState>, after: ReadonlyArray<AgentCliState>) => {
  const out: Array<{ provider: AccountProvider; installed: boolean }> = [];
  for (const next of after) {
    const prev = before.find((c) => c.provider === next.provider);
    if (!prev) continue;
    const installed = prev.executable === null && next.executable !== null;
    const signedIn = prev.login?.loggedIn !== true && next.login?.loggedIn === true;
    if (installed || signedIn) out.push({ provider: next.provider, installed });
  }
  return out;
};
