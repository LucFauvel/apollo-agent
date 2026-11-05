import type { ModelOption, ProviderKind } from "@apollo/contracts";
import { useEffect, useState } from "react";
import { errorMessage, rpc } from "./rpc.ts";

// One request per provider per page load; the server caches the CLI's answer too.
const requests = new Map<ProviderKind, Promise<ReadonlyArray<ModelOption>>>();

const load = (provider: ProviderKind) => {
  let request = requests.get(provider);
  if (!request) {
    request = rpc((c) => c["providers.models"]({ provider }));
    // Let a failed request be retried next time.
    request.catch(() => requests.delete(provider));
    requests.set(provider, request);
  }
  return request;
};

// Bumped when provider settings change, so open pickers load the lists again.
let generation = 0;
const listeners = new Set<() => void>();

/** Drops cached model lists (the server drops its own when settings change). */
export const forgetModels = () => {
  requests.clear();
  generation++;
  for (const listener of listeners) listener();
};

export type ModelsState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly models: ReadonlyArray<ModelOption> }
  | { readonly status: "error"; readonly error: string };

/** The models a provider offers, as its CLI reports them. */
export const useModels = (provider: ProviderKind): ModelsState => {
  const [state, setState] = useState<ModelsState>({ status: "loading" });
  const [current, setCurrent] = useState(generation);
  useEffect(() => {
    const listener = () => setCurrent(generation);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    load(provider).then(
      (models) => !cancelled && setState({ status: "ready", models }),
      (error) => !cancelled && setState({ status: "error", error: errorMessage(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [provider, current]);
  return state;
};

/** The model a session actually runs: the chosen one, or the provider's default. */
export const effectiveModel = (models: ReadonlyArray<ModelOption>, model: string | null) =>
  models.find((m) => m.id === model) ?? (model === null ? models.find((m) => m.isDefault) : undefined);

/** Short display name for a model id, falling back to the id itself. */
export const useModelLabel = (provider: ProviderKind, model: string | null): string | null => {
  const state = useModels(provider);
  if (model === null) return null;
  return state.status === "ready" ? (state.models.find((m) => m.id === model)?.label ?? model) : model;
};
