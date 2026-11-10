import type { LocalModel, ModelOption } from "@apollo/contracts";

export interface ModelChoice {
  readonly model: string | null;
  readonly effort: string | null;
}

export const sameChoice = (a: ModelChoice, b: ModelChoice) => a.model === b.model && a.effort === b.effort;

/** The model a session actually runs: the chosen one, or the provider's default. */
export const effectiveModel = (models: ReadonlyArray<ModelOption>, model: string | null) =>
  models.find((m) => m.id === model) ?? (model === null ? models.find((m) => m.isDefault) : undefined);

/** A new model, keeping the effort only if that model supports it. */
export const withModel = (models: ReadonlyArray<ModelOption>, current: ModelChoice, model: string | null): ModelChoice => {
  const next = effectiveModel(models, model);
  return { model, effort: current.effort !== null && next?.efforts.includes(current.effort) ? current.effort : null };
};

export const withEffort = (current: ModelChoice, effort: string | null): ModelChoice => ({ model: current.model, effort });

export interface ChoiceSync {
  /** What the picker shows: the latest pick until the session reflects it. */
  readonly shown: (session: ModelChoice) => ModelChoice;
  readonly pick: (choice: ModelChoice) => void;
  /** Call when the session changes: drops the pending pick once the session shows it. */
  readonly sessionChanged: (session: ModelChoice) => void;
}

/**
 * Sends a session's model and effort picks one at a time, each with the full choice, so a
 * pick made before the previous update lands builds on it instead of on the stale session.
 */
export const makeChoiceSync = ({
  send,
  onChange,
  onError,
}: {
  /** Resolves with the session's choice as the server saved it. */
  send: (choice: ModelChoice) => Promise<ModelChoice>;
  onChange: () => void;
  onError: (error: unknown) => void;
}): ChoiceSync => {
  let pending: ModelChoice | null = null;
  let inflight = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let latest: ModelChoice | null = null;

  const settle = (session: ModelChoice) => {
    if (pending && inflight === 0 && sameChoice(pending, session)) {
      pending = null;
      onChange();
    }
  };

  return {
    shown: (session) => pending ?? session,
    pick: (choice) => {
      pending = choice;
      inflight++;
      onChange();
      tail = tail
        .then(() => send(choice))
        .then(
          (saved) => {
            inflight--;
            if (inflight === 0 && pending) {
              pending = saved;
              onChange();
              if (latest) settle(latest);
            }
          },
          (error) => {
            inflight--;
            if (inflight === 0) {
              pending = null;
              onChange();
            }
            onError(error);
          },
        );
    },
    sessionChanged: (session) => {
      latest = session;
      settle(session);
    },
  };
};

/** `unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M` → name and quant. */
export const splitModelId = (id: string) => {
  const [repo, quant] = id.split(/:(?=[^/]+$)/);
  return { name: repo!.split("/").pop()!.replace(/[-_.]?GGUF$/i, ""), author: repo!.split("/")[0]!, quant: quant ?? null };
};

export const downloadPercent = (model: LocalModel) =>
  model.download && model.download.total > 0 ? Math.floor((model.download.done / model.download.total) * 100) : 0;
