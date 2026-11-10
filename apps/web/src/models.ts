import { effectiveModel } from "@apollo/client";
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

export { effectiveModel };

/**
 * Short display name for the model a session runs: the chosen id's label, or
 * the provider's default model when none was chosen (null until it is known).
 */
export const useModelLabel = (provider: ProviderKind, model: string | null): string | null => {
  const state = useModels(provider);
  if (state.status !== "ready") return model;
  return effectiveModel(state.models, model)?.label ?? model;
};
