import type { AgentEvent, InputField, InputResponse, InputValue } from "@apollo/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { ProviderError } from "./Provider.ts";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Options from the enum shapes MCP allows (`enum`/`enumNames`, `oneOf`/`anyOf` of `const`). */
const optionsOf = (schema: Json): Array<{ value: string; label: string }> => {
  const consts = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null;
  if (consts) {
    return consts.filter(isRecord).map((o) => ({ value: String(o.const), label: str(o.title) || String(o.const) }));
  }
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.map((v, i) => ({ value: String(v), label: str(names[i]) || String(v) }));
  }
  return [];
};

const defaultOf = (value: unknown): InputValue | null => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as Array<string>;
  return null;
};

/**
 * Turns an MCP elicitation `requestedSchema` (a flat object of primitive
 * properties) into form fields. Properties of unsupported shapes are skipped.
 */
export const fieldsFromSchema = (schema: unknown): Array<InputField> => {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const fields: Array<InputField> = [];
  for (const [name, raw] of Object.entries(schema.properties)) {
    if (!isRecord(raw)) continue;
    const base = {
      name,
      title: str(raw.title) || name,
      description: str(raw.description),
      required: required.has(name),
      default: defaultOf(raw.default),
      secret: false,
    };
    if (raw.type === "array" && isRecord(raw.items)) {
      fields.push({ ...base, kind: "multi-select", options: optionsOf(raw.items) });
      continue;
    }
    const options = optionsOf(raw);
    if (options.length > 0) {
      fields.push({ ...base, kind: "select", options });
      continue;
    }
    if (raw.type === "string" || raw.type === "number" || raw.type === "integer" || raw.type === "boolean") {
      fields.push({ ...base, kind: raw.type, options: [] });
    }
  }
  return fields;
};

export interface InputRequest {
  readonly source: string;
  readonly message: string;
  readonly url: string | null;
  readonly fields: ReadonlyArray<InputField>;
}

/** Tracks input requests waiting on the user, for one provider session. */
export const makeInputRequests = (
  agent: (event: AgentEvent) => Effect.Effect<void>,
  fail: (message: string) => ProviderError,
) => {
  const pending = new Map<string, Deferred.Deferred<InputResponse>>();
  return {
    /** Emits `InputRequested`, waits for the answer, then emits `InputResolved`. */
    ask: (requestId: string, request: InputRequest) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<InputResponse>();
        pending.set(requestId, deferred);
        yield* agent({ _tag: "InputRequested", requestId, ...request, fields: [...request.fields] });
        const response = yield* Deferred.await(deferred).pipe(
          Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
        );
        yield* agent({ _tag: "InputResolved", requestId, action: response.action });
        return response;
      }),
    respond: (requestId: string, response: InputResponse) =>
      Effect.suspend(() => {
        const deferred = pending.get(requestId);
        return deferred
          ? Deferred.succeed(deferred, response).pipe(Effect.asVoid)
          : Effect.fail(fail(`unknown input request ${requestId}`));
      }),
    /** Withdraws a request the provider no longer waits on. */
    cancel: (requestId: string) =>
      Effect.suspend(() => {
        const deferred = pending.get(requestId);
        return deferred ? Deferred.succeed(deferred, { action: "cancel", values: {} }).pipe(Effect.asVoid) : Effect.void;
      }),
  };
};
