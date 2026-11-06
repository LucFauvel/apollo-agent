import type { OnePasswordField, OnePasswordItem, OnePasswordStatus, SecretResponse, SessionId } from "@apollo/contracts";
import { ArrowLeft, Eye, EyeOff, KeyRound, Loader2, Lock, Search, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage, rpc } from "../rpc.ts";
import type { TranscriptItem } from "../transcript.ts";
import { OnePasswordLogo } from "./icons.tsx";
import { Badge, Button, cx, inputClass } from "./ui.tsx";

type Item = Extract<TranscriptItem, { kind: "secret" }>;

// One status check per page load; the CLI's answer rarely changes.
let statusRequest: Promise<OnePasswordStatus> | null = null;
const onePasswordStatus = () => {
  statusRequest ??= rpc((c) => c["secrets.onePasswordStatus"]()).catch((error) => {
    statusRequest = null;
    throw error;
  });
  return statusRequest;
};

/** Search 1Password, pick an item, then one of its fields. Values stay on the server. */
function OnePasswordPicker({
  hint,
  onPick,
  onCancel,
}: {
  hint: string;
  onPick: (field: OnePasswordField, item: OnePasswordItem) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState(hint);
  const [items, setItems] = useState<ReadonlyArray<OnePasswordItem> | null>(null);
  const [item, setItem] = useState<OnePasswordItem | null>(null);
  const [fields, setFields] = useState<ReadonlyArray<OnePasswordField> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // The card is usually at the bottom of the conversation: bring the picker into view.
  useEffect(() => {
    const timer = setTimeout(() => root.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 50);
    return () => clearTimeout(timer);
  }, [item, items, fields]);

  useEffect(() => {
    if (item) return;
    setBusy(true);
    const timer = setTimeout(() => {
      rpc((c) => c["secrets.onePasswordSearch"]({ query: query.trim() }))
        .then((found) => {
          setItems(found);
          setError(null);
        })
        .catch((e) => setError(errorMessage(e)))
        .finally(() => setBusy(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query, item]);

  const open = (picked: OnePasswordItem) => {
    setItem(picked);
    setFields(null);
    setBusy(true);
    rpc((c) => c["secrets.onePasswordFields"]({ itemId: picked.id, vaultId: picked.vaultId }))
      .then(setFields)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  const row = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-zinc-800";

  return (
    <div ref={root} className="animate-fade-up mt-3 scroll-mb-4 rounded-xl border border-zinc-800 bg-zinc-950/80">
      <div className="flex items-center gap-2 border-b border-zinc-800/80 px-2.5 py-2">
        <OnePasswordLogo size={14} />
        {item ? (
          <button className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-zinc-300 hover:text-zinc-100" onClick={() => setItem(null)}>
            <ArrowLeft className="size-3.5 shrink-0" />
            <span className="truncate">{item.title}</span>
          </button>
        ) : (
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              autoFocus
              className={cx(inputClass, "h-7 py-0 pl-7 text-xs")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search 1Password"
            />
          </div>
        )}
        {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin text-zinc-500" /> : null}
        <button className="text-[11px] text-zinc-500 hover:text-zinc-300" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className="max-h-56 overflow-y-auto p-1">
        {error ? <div className="px-2.5 py-2 text-xs text-red-300">{error}</div> : null}
        {!item && items
          ? items.length === 0 && !busy
            ? <div className="px-2.5 py-2 text-xs text-zinc-500">No items match.</div>
            : items.map((it) => (
                <button key={`${it.vaultId}/${it.id}`} className={row} onClick={() => open(it)}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-zinc-200">{it.title}</span>
                    {it.subtitle ? <span className="block truncate text-[11px] text-zinc-500">{it.subtitle}</span> : null}
                  </span>
                  <span className="shrink-0 text-[10px] text-zinc-600">{it.vault}</span>
                </button>
              ))
          : null}
        {item && fields
          ? fields.length === 0
            ? <div className="px-2.5 py-2 text-xs text-zinc-500">This item has no fields Apollo can use.</div>
            : fields.map((f) => (
                <button key={f.reference} className={row} onClick={() => onPick(f, item)}>
                  {f.type === "CONCEALED" ? <Lock className="size-3.5 shrink-0 text-zinc-500" /> : <KeyRound className="size-3.5 shrink-0 text-zinc-500" />}
                  <span className="min-w-0 flex-1 truncate text-zinc-200">{f.label}</span>
                  {f.section ? <span className="shrink-0 text-[10px] text-zinc-600">{f.section}</span> : null}
                  <span className="shrink-0 font-mono text-[10px] text-zinc-600 lowercase">{f.type}</span>
                </button>
              ))
          : null}
      </div>
      <div className="border-t border-zinc-800/80 px-2.5 py-1.5 text-[10px] text-zinc-600">
        Apollo reads only the field you pick, on this machine. Neither the agent nor this page sees its value.
      </div>
    </div>
  );
}

/** The private card an agent's `apollo_request_secret` puts in the conversation. */
export function SecretItem({ item, sessionId }: { item: Item; sessionId: SessionId }) {
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const [picking, setPicking] = useState(false);
  const [status, setStatus] = useState<OnePasswordStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = item.outcome === null;

  useEffect(() => {
    if (pending) void onePasswordStatus().then(setStatus, () => undefined);
  }, [pending]);

  const respond = (response: SecretResponse) => {
    setBusy(true);
    setError(null);
    rpc((c) => c["secrets.respond"]({ sessionId, requestId: item.requestId, response }))
      .then(() => {
        setValue("");
        setPicking(false);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  if (!pending) {
    return (
      <div className="animate-fade-up flex items-center gap-2.5 rounded-xl border border-zinc-800/80 bg-zinc-900/30 px-3 py-2 text-xs">
        <KeyRound className="size-3.5 shrink-0 text-zinc-500" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-zinc-400">
          Secret requested: <span className="text-zinc-200">{item.label}</span>
        </span>
        {item.outcome === "provided" ? (
          <Badge tone={item.source === "1password" ? "sky" : "emerald"}>
            {item.source === "1password" ? <OnePasswordLogo size={10} /> : <ShieldCheck className="size-2.5" />}
            {item.source === "1password" ? "From 1Password" : "Provided"}
          </Badge>
        ) : (
          <Badge tone={item.outcome === "declined" ? "red" : "zinc"}>{item.outcome === "declined" ? "Declined" : "Expired"}</Badge>
        )}
      </div>
    );
  }

  return (
    <div className="animate-fade-up rounded-xl border border-amber-600/40 bg-gradient-to-b from-amber-950/25 to-zinc-950 p-3.5 shadow-[0_0_0_4px_rgba(245,158,11,0.04)]">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300">
          <KeyRound className="size-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-amber-50">{item.label}</div>
          {item.reason ? <div className="mt-0.5 text-xs leading-relaxed text-zinc-400">{item.reason}</div> : null}
        </div>
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value) respond({ _tag: "typed", value });
        }}
      >
        <div className="relative min-w-0 flex-1">
          <input
            type={visible ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            className={cx(inputClass, "pr-9 font-mono text-xs")}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={item.placeholder ?? "Paste or type the secret"}
          />
          <button
            type="button"
            className="absolute top-1/2 right-2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
            title={visible ? "Hide" : "Show"}
            onClick={() => setVisible(!visible)}
          >
            {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        </div>
        <Button type="submit" variant="primary" disabled={!value || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Lock />} Provide
        </Button>
      </form>
      <div className="mt-2 flex items-center gap-2">
        {status?.installed ? (
          <Button size="sm" onClick={() => setPicking(!picking)} disabled={busy} title={status.ready ? undefined : (status.message ?? undefined)}>
            <OnePasswordLogo /> Use 1Password
          </Button>
        ) : null}
        <span className="flex-1 text-[11px] text-zinc-600">Kept out of the conversation; the agent only gets a way to use it.</span>
        <Button size="sm" variant="ghost" onClick={() => respond({ _tag: "decline" })} disabled={busy}>
          Decline
        </Button>
      </div>
      {error ? <div className="mt-2 text-xs text-red-300">{error}</div> : null}
      {picking ? (
        <OnePasswordPicker
          hint={item.label.replace(/\b(api|key|token|password|secret|personal access)\b/gi, "").trim()}
          onCancel={() => setPicking(false)}
          onPick={(field) => respond({ _tag: "onePassword", reference: field.reference })}
        />
      ) : null}
    </div>
  );
}
