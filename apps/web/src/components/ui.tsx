import type { ProviderKind, SessionStatus } from "@apollo/contracts";
import { type LucideIcon, X } from "lucide-react";
import type { ButtonHTMLAttributes, CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ProviderLogo } from "./icons.tsx";

export const cx = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

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
      type="button"
      {...props}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors",
        "focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40",
        "[&_svg]:shrink-0",
        size === "sm" ? "h-7 px-2.5 text-xs [&_svg]:size-3.5" : "h-8 px-3 text-[13px] [&_svg]:size-4",
        variant === "primary" && "bg-zinc-100 text-zinc-900 shadow-sm hover:bg-white",
        variant === "secondary" && "border border-zinc-800 bg-zinc-900 text-zinc-200 hover:border-zinc-700 hover:bg-zinc-800/80",
        variant === "ghost" && "text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100",
        variant === "danger" && "border border-red-900/60 bg-red-950/40 text-red-300 hover:bg-red-900/40",
        className,
      )}
    />
  );
}

/** A square, icon-only button. `label` is its tooltip and accessible name. */
export function IconButton({
  icon: Icon,
  label,
  active = false,
  size = "md",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      {...props}
      className={cx(
        "relative inline-flex shrink-0 items-center justify-center rounded-lg transition-colors",
        "focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "size-6" : "size-8",
        active ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:bg-zinc-800/70 hover:text-zinc-100",
        className,
      )}
    >
      <Icon className={size === "sm" ? "size-3.5" : "size-4"} strokeWidth={1.75} />
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Display names, in the order pickers list them. */
export const PROVIDERS: ReadonlyArray<{ kind: ProviderKind; name: string; detail: string }> = [
  { kind: "claude", name: "Claude Code", detail: "Anthropic" },
  { kind: "codex", name: "Codex", detail: "OpenAI" },
  { kind: "llamacpp", name: "llama.cpp", detail: "Local model" },
  { kind: "cursor", name: "Cursor", detail: "Cursor Agent" },
  { kind: "grok", name: "Grok", detail: "xAI" },
  { kind: "opencode", name: "OpenCode", detail: "Any model provider" },
  { kind: "antigravity", name: "Antigravity", detail: "Google" },
  { kind: "muse", name: "Muse Code", detail: "Meta" },
  { kind: "pi", name: "Pi", detail: "Any model provider" },
  { kind: "copilot", name: "GitHub Copilot", detail: "GitHub" },
];

export const providerName = (provider: ProviderKind) => PROVIDERS.find((p) => p.kind === provider)?.name ?? provider;

const effortLabel = (effort: string) => effort.charAt(0).toUpperCase() + effort.slice(1);

/**
 * The provider's logo, optionally followed by the model and effort. With no
 * model, only the logo shows (the provider's default model).
 */
export function ModelChip({
  provider,
  model,
  effort,
  className,
}: {
  provider: ProviderKind;
  /** Display name of the model; omitted means the provider's default. */
  model?: string | null;
  effort?: string | null;
  className?: string;
}) {
  return (
    <span
      className={cx("inline-flex min-w-0 items-center gap-1.5 text-xs text-zinc-300", className)}
      title={`${providerName(provider)} · ${model ?? "default model"}${effort ? ` · ${effort} effort` : ""}`}
    >
      <ProviderLogo provider={provider} size={14} className="shrink-0" />
      {model ? <span className="truncate">{model}</span> : null}
      {effort ? <span className="shrink-0 text-zinc-500">{effortLabel(effort)}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const statusColor: Record<SessionStatus, string> = {
  idle: "bg-zinc-600",
  starting: "bg-amber-400 animate-pulse",
  running: "bg-emerald-400 animate-pulse",
  "waiting-approval": "bg-amber-400",
  error: "bg-red-500",
  closed: "bg-zinc-700",
};

export const statusLabel: Record<SessionStatus, string> = {
  idle: "Idle",
  starting: "Starting",
  running: "Working",
  "waiting-approval": "Needs approval",
  error: "Error",
  closed: "Closed",
};

export function StatusDot({ status, className }: { status: SessionStatus; className?: string }) {
  return <span className={cx("size-1.5 shrink-0 rounded-full", statusColor[status], className)} title={statusLabel[status]} />;
}

export function Badge({
  children,
  tone = "zinc",
  className,
  title,
}: {
  children: ReactNode;
  tone?: "zinc" | "amber" | "violet" | "emerald" | "sky" | "red";
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-px text-[10px] font-medium",
        tone === "zinc" && "bg-zinc-800 text-zinc-400",
        tone === "amber" && "bg-amber-500/15 text-amber-300",
        tone === "violet" && "bg-violet-500/15 text-violet-300",
        tone === "emerald" && "bg-emerald-500/15 text-emerald-300",
        tone === "sky" && "bg-sky-500/15 text-sky-300",
        tone === "red" && "bg-red-500/15 text-red-300",
        className,
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

const useEscape = (onClose: () => void) =>
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

export function Modal({
  title,
  description,
  icon,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  wide?: boolean;
}) {
  useEscape(onClose);
  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          "animate-pop-in flex max-h-[88vh] w-full flex-col rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/50",
          wide ? "max-w-3xl" : "max-w-lg",
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-5 pt-4 pb-3">
          {icon ? <div className="mt-0.5 shrink-0">{icon}</div> : null}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold text-zinc-100">{title}</div>
            {description ? <div className="mt-0.5 text-xs text-zinc-500">{description}</div> : null}
          </div>
          <IconButton icon={X} label="Close" size="sm" onClick={onClose} className="-mr-1" />
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pt-1 pb-5">{children}</div>
        <div className="flex justify-end gap-2 rounded-b-2xl border-t border-zinc-800/80 bg-zinc-900/40 px-5 py-3">{footer}</div>
      </div>
    </div>
  );
}

/** A side panel next to the conversation. */
const PANEL_MIN = 300;
/** The conversation keeps at least this much room beside a panel. */
const PANEL_ROOM = 420;

const panelWidthKey = (name: string) => `apollo.panelWidth.${name}`;
const savedPanelWidth = (name: string): number | null => {
  try {
    const value = Number(localStorage.getItem(panelWidthKey(name)));
    return Number.isFinite(value) && value >= PANEL_MIN ? value : null;
  } catch {
    return null;
  }
};
const defaultPanelWidth = (width: "normal" | "wide") =>
  width === "wide" ? Math.min(640, Math.round(window.innerWidth * 0.45)) : 380;
const clampPanelWidth = (value: number) => Math.max(PANEL_MIN, Math.min(value, window.innerWidth - PANEL_ROOM));

/**
 * A panel on the right. Drag its left edge to resize it (double-click to reset); each
 * panel remembers its width.
 */
export function Panel({
  title,
  actions,
  onClose,
  children,
  width = "normal",
  name,
}: {
  title: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: "normal" | "wide";
  /** Which panel this is, for remembering its width. */
  name?: string;
}) {
  const key = name ?? width;
  const [size, setSize] = useState(() => clampPanelWidth(savedPanelWidth(key) ?? defaultPanelWidth(width)));
  const [dragging, setDragging] = useState(false);
  // Keep the conversation usable when the window gets smaller.
  useEffect(() => {
    const onResize = () => setSize((current) => clampPanelWidth(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const save = (value: number) => {
    try {
      localStorage.setItem(panelWidthKey(key), String(Math.round(value)));
    } catch {
      // Storage off: the width lasts until the panel closes.
    }
  };
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startSize = size;
    let latest = startSize;
    setDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (e: PointerEvent) => {
      latest = clampPanelWidth(startSize + (startX - e.clientX));
      setSize(latest);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setDragging(false);
      save(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const reset = () => {
    const value = clampPanelWidth(defaultPanelWidth(width));
    setSize(value);
    try {
      localStorage.removeItem(panelWidthKey(key));
    } catch {}
  };
  return (
    <aside className="animate-slide-in relative flex shrink-0 flex-col border-l border-zinc-800/80 bg-zinc-950" style={{ width: size }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        title="Drag to resize · double-click to reset"
        onPointerDown={startDrag}
        onDoubleClick={reset}
        style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
        className="group/resize absolute inset-y-0 -left-1.5 z-20 w-3 cursor-col-resize"
      >
        <span
          className={cx(
            "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-all duration-150",
            dragging ? "w-0.5 bg-sky-400" : "bg-transparent group-hover/resize:w-0.5 group-hover/resize:bg-sky-500/60",
          )}
        />
      </div>
      {/* Same height as the session header beside it, so their borders line up. */}
      <div className="app-drag flex h-14 shrink-0 items-center gap-2 border-b border-zinc-800/80 pr-2 pl-4">
        <div className="flex min-w-0 flex-1 items-center gap-1">{title}</div>
        {actions}
        <IconButton icon={X} label="Close panel" size="sm" onClick={onClose} />
      </div>
      {children}
    </aside>
  );
}

export interface MenuItem {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly hint?: string;
}

/** A button that opens a small list of actions. */
export function Menu({ icon, label, items }: { icon: LucideIcon; label: string; items: ReadonlyArray<MenuItem> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <IconButton icon={icon} label={label} active={open} onClick={() => setOpen(!open)} />
      {open ? (
        <div className="animate-pop-in absolute top-full right-0 z-40 mt-1 min-w-52 rounded-xl border border-zinc-800 bg-zinc-900 p-1 shadow-xl shadow-black/40">
          {items.map(({ label: itemLabel, icon: Icon, onSelect, disabled, danger, hint }) => (
            <button
              key={itemLabel}
              type="button"
              disabled={disabled}
              title={hint}
              onClick={() => {
                setOpen(false);
                onSelect();
              }}
              className={cx(
                "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] disabled:opacity-40",
                danger ? "text-red-300 hover:bg-red-500/10" : "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
              )}
            >
              <Icon className="size-4 shrink-0 opacity-80" strokeWidth={1.75} />
              {itemLabel}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium text-zinc-300">{label}</span>
      {children}
      {hint ? <span className="block text-[11px] leading-relaxed text-zinc-500">{hint}</span> : null}
    </label>
  );
}

/** A titled group of fields inside a dialog. */
export function FormSection({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-zinc-800/80 pt-5 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">{title}</h3>
        {description ? <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

export const inputClass =
  "w-full rounded-lg border border-zinc-800 bg-zinc-900/70 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 transition-colors hover:border-zinc-700 focus:border-zinc-500 focus:bg-zinc-900 focus:outline-none disabled:opacity-50";

/** An on/off switch with an optional label and description. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  title,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  title?: string;
}) {
  const knob = (
    <span
      className={cx(
        "relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-emerald-500" : "bg-zinc-700",
      )}
    >
      <span
        className={cx(
          "absolute size-3.5 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </span>
  );
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className={cx("flex items-start gap-3 text-left", label ? "w-full" : "")}
    >
      {label ? (
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-zinc-200">{label}</span>
          {description ? <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-500">{description}</span> : null}
        </span>
      ) : null}
      <span className={label ? "mt-0.5" : ""}>{knob}</span>
    </button>
  );
}

export interface OptionCard<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly detail?: string;
  readonly icon?: ReactNode;
}

/** Mutually exclusive choices shown as cards. */
export function OptionCards<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<OptionCard<T>>;
}) {
  return (
    <div className={cx("grid gap-2", options.length % 3 === 0 || options.length > 4 ? "grid-cols-3" : "grid-cols-2")}>
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cx(
              "flex min-w-0 items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
              selected
                ? "border-zinc-500 bg-zinc-800/80 ring-1 ring-zinc-500/40"
                : "border-zinc-800 bg-zinc-900/30 hover:border-zinc-700 hover:bg-zinc-900",
            )}
          >
            {option.icon ? <span className="mt-0.5 shrink-0">{option.icon}</span> : null}
            <span className="min-w-0">
              <span className={cx("block truncate text-[13px] font-medium", selected ? "text-zinc-100" : "text-zinc-300")}>
                {option.label}
              </span>
              {option.detail ? <span className="mt-0.5 block truncate text-[11px] leading-snug text-zinc-500" title={option.detail}>{option.detail}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Animates its content's height open and closed. Content mounts the first time
 * it opens, so long tool outputs cost nothing until someone looks at them.
 */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  return (
    <div
      aria-hidden={!open}
      className={cx(
        "grid transition-[grid-template-rows,opacity] duration-250 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className={cx("min-h-0 overflow-hidden", className)}>{mounted || open ? children : null}</div>
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? (
    <div className="rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">{children}</div>
  ) : null;
}

export function EmptyState({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 flex size-10 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-zinc-500">
        <Icon className="size-5" strokeWidth={1.5} />
      </div>
      <div className="text-sm font-medium text-zinc-300">{title}</div>
      {children ? <div className="mt-1 max-w-xs text-xs leading-relaxed text-zinc-500">{children}</div> : null}
    </div>
  );
}

/**
 * A small dark tooltip shown on hover (after a short delay) and on keyboard focus.
 * It floats above the page (so scroll areas do not clip it), over the trigger, or
 * under it when there is no room above. `align` anchors it to the trigger's start,
 * centre or end.
 */
export function Tooltip({
  content,
  children,
  align = "center",
}: {
  content: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
}) {
  const trigger = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = (delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => trigger.current && setAnchor(trigger.current.getBoundingClientRect()), delay);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setAnchor(null);
  };
  useEffect(() => hide, []);

  const below = anchor !== null && anchor.top < 90;
  const style: React.CSSProperties | undefined = anchor
    ? {
        position: "fixed",
        ...(below ? { top: anchor.bottom + 6 } : { bottom: window.innerHeight - anchor.top + 6 }),
        ...(align === "start"
          ? { left: anchor.left }
          : align === "end"
            ? { right: window.innerWidth - anchor.right }
            : { left: anchor.left + anchor.width / 2, transform: "translateX(-50%)" }),
      }
    : undefined;

  return (
    <span
      ref={trigger}
      className="inline-flex"
      onMouseEnter={() => show(350)}
      onMouseLeave={hide}
      onFocus={() => show(0)}
      onBlur={hide}
      onMouseDown={hide}
    >
      {children}
      {anchor
        ? createPortal(
            <span
              role="tooltip"
              style={style}
              className="animate-fade-in pointer-events-none z-[60] w-max max-w-64 rounded-lg border border-zinc-700/80 bg-zinc-900 px-2.5 py-1.5 text-left text-[11px] leading-snug text-zinc-200 shadow-xl shadow-black/40"
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
