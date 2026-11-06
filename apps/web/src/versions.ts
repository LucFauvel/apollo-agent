import type { ProviderKind, ProviderVersion } from "@apollo/contracts";
import { useEffect, useSyncExternalStore } from "react";
import { errorMessage, rpc } from "./rpc.ts";

/**
 * Installed vs latest versions of Claude Code, Codex and llama.cpp, shared by the
 * sidebar's update dot and the Providers dialog. Re-read every hour.
 */
let versions: ReadonlyArray<ProviderVersion> = [];
let updating: ReadonlySet<ProviderKind> = new Set();
let lastError: string | null = null;
const listeners = new Set<() => void>();
const changed = () => {
  snapshot = { versions, updating, error: lastError };
  for (const l of listeners) l();
};
let snapshot: { versions: ReadonlyArray<ProviderVersion>; updating: ReadonlySet<ProviderKind>; error: string | null } = {
  versions,
  updating,
  error: lastError,
};
let started = false;

const load = (refresh = false) =>
  rpc((c) => c["providers.versions"]({ refresh }))
    .then((v) => {
      versions = v;
      changed();
    })
    .catch(() => undefined);

export const updateProvider = (provider: ProviderKind) => {
  updating = new Set([...updating, provider]);
  lastError = null;
  changed();
  return rpc((c) => c["providers.update"]({ provider }))
    .then((v) => {
      versions = versions.map((x) => (x.provider === provider ? v : x));
    })
    .catch((e) => {
      lastError = `${provider}: ${errorMessage(e)}`;
    })
    .finally(() => {
      updating = new Set([...updating].filter((p) => p !== provider));
      changed();
    });
};

export const refreshVersions = () => load(true);

export function useProviderVersions() {
  useEffect(() => {
    if (started) return;
    started = true;
    void load();
    setInterval(() => void load(), 60 * 60_000);
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => snapshot,
  );
}
