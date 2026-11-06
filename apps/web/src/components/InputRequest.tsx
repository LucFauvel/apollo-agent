import type { InputAction, InputField, InputResponse, InputValue } from "@apollo/contracts";
import { ClipboardList, ExternalLink } from "lucide-react";
import { useState } from "react";
import type { TranscriptItem } from "../transcript.ts";
import { Badge, Button, cx, inputClass } from "./ui.tsx";

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
      // A handful of options read better as cards (label, then the description after " — ").
      if (field.options.length > 0 && field.options.length <= 6) {
        return (
          <div className="grid gap-1.5">
            {field.options.map((o) => {
              const [label, ...detail] = o.label.split(" — ");
              const chosen = value === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={chosen}
                  onClick={() => onChange(chosen ? "" : o.value)}
                  className={cx(
                    "rounded-lg border px-3 py-2 text-left text-xs transition-colors",
                    chosen ? "border-sky-500/60 bg-sky-500/10 text-zinc-100" : "border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:border-zinc-700",
                  )}
                >
                  <span className="block font-medium">{label}</span>
                  {detail.length > 0 ? <span className="mt-0.5 block text-zinc-500">{detail.join(" — ")}</span> : null}
                </button>
              );
            })}
          </div>
        );
      }
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
    <div className={pending ? "rounded-xl border border-sky-700/40 bg-sky-950/20 p-3.5 text-sm" : "rounded-xl border border-zinc-800 bg-zinc-900/30 p-3.5 text-sm"}>
      <div className="flex items-center gap-2">
        <ClipboardList className={pending ? "size-4 text-sky-300" : "size-4 text-zinc-500"} strokeWidth={1.75} />
        <span className={pending ? "flex-1 text-xs font-medium text-sky-200" : "flex-1 text-xs font-medium text-zinc-400"}>
          {item.source} needs input
        </span>
        {!pending ? <Badge tone={item.action === "accept" ? "emerald" : "zinc"}>{resolvedLabel[item.action]}</Badge> : null}
      </div>
      {item.message ? <div className="mt-1 whitespace-pre-wrap text-zinc-200">{item.message}</div> : null}
      {item.url ? (
        <a
          className="mt-2 flex items-center gap-1.5 truncate font-mono text-xs text-sky-300 underline decoration-sky-300/40 underline-offset-2 hover:decoration-sky-300"
          href={item.url}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink className="size-3 shrink-0" />
          <span className="truncate">{item.url}</span>
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
            <Button size="sm" variant="ghost" onClick={() => onRespond(item.requestId, { action: "decline", values: {} })}>
              Decline
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
