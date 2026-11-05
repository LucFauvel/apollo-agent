import type { InputAction, InputField, InputResponse, InputValue } from "@apollo/contracts";
import { useState } from "react";
import type { TranscriptItem } from "../transcript.ts";
import { Button, cx, inputClass } from "./ui.tsx";

type Draft = Record<string, string | boolean | Array<string>>;

const initialDraft = (fields: ReadonlyArray<InputField>): Draft =>
  Object.fromEntries(
    fields.map((f) => {
      const d = f.default;
      if (f.kind === "boolean") return [f.name, d === true];
      if (f.kind === "multi-select") return [f.name, Array.isArray(d) ? [...d] : []];
      return [f.name, d === null || Array.isArray(d) ? "" : String(d)];
    }),
  );

/** Converts the form draft into typed values, or explains what is missing. */
const toValues = (
  fields: ReadonlyArray<InputField>,
  draft: Draft,
): { values: Record<string, InputValue> } | { error: string } => {
  const values: Record<string, InputValue> = {};
  for (const field of fields) {
    const raw = draft[field.name];
    if (field.kind === "boolean") {
      values[field.name] = raw === true;
      continue;
    }
    if (field.kind === "multi-select") {
      const list = Array.isArray(raw) ? raw : [];
      if (field.required && list.length === 0) return { error: `${field.title} is required.` };
      values[field.name] = list;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text === "") {
      if (field.required) return { error: `${field.title} is required.` };
      continue;
    }
    if (field.kind === "number" || field.kind === "integer") {
      const n = Number(text);
      if (!Number.isFinite(n) || (field.kind === "integer" && !Number.isInteger(n))) {
        return { error: `${field.title} must be ${field.kind === "integer" ? "a whole number" : "a number"}.` };
      }
      values[field.name] = n;
      continue;
    }
    values[field.name] = text;
  }
  return { values };
};

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: InputField;
  value: Draft[string] | undefined;
  onChange: (value: Draft[string]) => void;
}) {
  switch (field.kind) {
    case "boolean":
      return (
        <label className="flex items-center gap-2 text-sm text-zinc-200">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {field.title}
        </label>
      );
    case "select":
      return (
        <select className={inputClass} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "multi-select": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {field.options.map((o) => (
            <label key={o.value} className="flex items-center gap-1.5 text-sm text-zinc-200">
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value))
                }
              />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    default:
      return (
        <input
          className={inputClass}
          type={field.secret ? "password" : field.kind === "string" ? "text" : "number"}
          step={field.kind === "integer" ? 1 : "any"}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

const resolvedLabel: Record<InputAction, string> = {
  accept: "Submitted",
  decline: "Declined",
  cancel: "Cancelled",
};

/** A form (or a link to open) that an agent's MCP server asked the user to complete. */
export function InputRequestItem({
  item,
  onRespond,
}: {
  item: Extract<TranscriptItem, { kind: "input" }>;
  onRespond: (requestId: string, response: InputResponse) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(item.fields));
  const [error, setError] = useState<string | null>(null);
  const pending = item.action === null;

  const submit = () => {
    const result = toValues(item.fields, draft);
    if ("error" in result) return setError(result.error);
    setError(null);
    onRespond(item.requestId, { action: "accept", values: result.values });
  };

  return (
    <div className="rounded-lg border border-sky-700/40 bg-sky-950/20 p-3 text-sm">
      <div className="text-[10px] font-semibold tracking-wide text-sky-300/80 uppercase">{item.source} needs input</div>
      {item.message ? <div className="mt-1 whitespace-pre-wrap text-zinc-200">{item.message}</div> : null}
      {item.url ? (
        <a className="mt-2 block truncate font-mono text-xs text-sky-300 underline" href={item.url} target="_blank" rel="noreferrer">
          {item.url}
        </a>
      ) : null}

      {pending ? (
        <>
          {item.fields.length > 0 ? (
            <div className="mt-3 space-y-3">
              {item.fields.map((field) => (
                <div key={field.name} className="space-y-1">
                  {field.kind !== "boolean" ? (
                    <div className="text-xs font-medium text-zinc-300">
                      {field.title}
                      {field.required ? <span className="text-sky-300"> *</span> : null}
                    </div>
                  ) : null}
                  <FieldInput
                    field={field}
                    value={draft[field.name]}
                    onChange={(value) => setDraft({ ...draft, [field.name]: value })}
                  />
                  {field.description ? (
                    <div className="text-[11px] whitespace-pre-wrap text-zinc-500">{field.description}</div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {error ? <div className="mt-2 text-xs text-red-400">{error}</div> : null}
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="primary" onClick={submit}>
              {item.url ? "Done" : "Submit"}
            </Button>
            <Button size="sm" variant="danger" onClick={() => onRespond(item.requestId, { action: "decline", values: {} })}>
              Decline
            </Button>
          </div>
        </>
      ) : (
        <div className={cx("mt-2 text-xs", item.action === "accept" ? "text-zinc-500" : "text-zinc-600")}>
          {resolvedLabel[item.action]}
        </div>
      )}
    </div>
  );
}
