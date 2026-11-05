import type { ProviderKind, SessionStatus } from "@apollo/contracts";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useEffect } from "react";

export const cx = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
}) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-3 text-sm",
        variant === "primary" && "bg-zinc-100 text-zinc-900 hover:bg-white",
        variant === "secondary" && "border border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800",
        variant === "ghost" && "text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100",
        variant === "danger" && "border border-red-900/60 bg-red-950/40 text-red-300 hover:bg-red-900/40",
        className,
      )}
    />
  );
}

const providerStyles: Record<ProviderKind, string> = {
  claude: "bg-orange-500/10 text-orange-300 ring-orange-500/20",
  codex: "bg-sky-500/10 text-sky-300 ring-sky-500/20",
  llamacpp: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20",
};

/** Display names, in the order pickers list them. */
export const PROVIDERS: ReadonlyArray<{ kind: ProviderKind; name: string; detail: string }> = [
  { kind: "claude", name: "Claude Code", detail: "Agent SDK" },
  { kind: "codex", name: "Codex", detail: "app-server" },
  { kind: "llamacpp", name: "llama.cpp", detail: "local model" },
];

export function ProviderBadge({
  provider,
  model,
  effort,
}: {
  provider: ProviderKind;
  /** Display name of the model; omitted means the provider's default. */
  model?: string | null;
  effort?: string | null;
}) {
  const parts = [provider, model, effort].filter(Boolean);
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center rounded px-1.5 py-px font-mono text-[10px] ring-1 ring-inset",
        providerStyles[provider],
      )}
      title={`${provider} · ${model ?? "default model"}${effort ? ` · ${effort} effort` : ""}`}
    >
      {parts.join(" · ")}
    </span>
  );
}

const statusColor: Record<SessionStatus, string> = {
  idle: "bg-zinc-600",
  starting: "bg-amber-400 animate-pulse",
  running: "bg-emerald-400 animate-pulse",
  "waiting-approval": "bg-amber-400",
  error: "bg-red-500",
  closed: "bg-zinc-700",
};

export function StatusDot({ status }: { status: SessionStatus }) {
  return <span className={cx("size-1.5 shrink-0 rounded-full", statusColor[status])} title={status} />;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div
        className={cx("w-full rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl", wide ? "max-w-3xl" : "max-w-lg")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-zinc-800 px-5 py-3 text-sm font-semibold text-zinc-100">{title}</div>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-3">{footer}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-zinc-300">{label}</span>
      {children}
      {hint ? <span className="block text-[11px] text-zinc-500">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none";
