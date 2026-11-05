import type {
  Bot,
  ProviderKind,
  Schedule,
  ScheduleKind,
  SchedulePreview,
  ScheduleRun,
  ScheduleRunStatus,
  SessionId,
} from "@apollo/contracts";
import { useEffect, useMemo, useState } from "react";
import { errorMessage, rpc } from "../rpc.ts";
import { useApp } from "../store.ts";
import { NO_CHOICE, ProviderPicker, selection } from "./Dialogs.tsx";
import { type ModelChoice, ModelPicker } from "./ModelPicker.tsx";
import { Button, cx, Field, inputClass, Modal } from "./ui.tsx";

/** Re-renders every `ms`, for relative times. */
const useNow = (ms = 30_000) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
};

/** "in 12 min", "3 h ago", "in 2 d". */
export const relativeTime = (at: number, now: number) => {
  const diff = at - now;
  const abs = Math.abs(diff);
  const text =
    abs < 60_000
      ? "less than a minute"
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)} min`
        : abs < 86_400_000
          ? `${Math.round(abs / 3_600_000)} h`
          : `${Math.round(abs / 86_400_000)} d`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
};

const absoluteTime = (at: number) =>
  new Date(at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const statusStyle: Record<ScheduleRunStatus, string> = {
  running: "bg-emerald-500/15 text-emerald-300",
  delivered: "bg-sky-500/15 text-sky-300",
  silent: "bg-zinc-700/50 text-zinc-400",
  failed: "bg-red-500/15 text-red-300",
  skipped: "bg-amber-500/15 text-amber-300",
};

function StatusChip({ status }: { status: ScheduleRunStatus }) {
  return <span className={cx("rounded px-1.5 py-px text-[10px] font-medium", statusStyle[status])}>{status}</span>;
}

const kindInfo: Record<ScheduleKind, { label: string; detail: string }> = {
  task: {
    label: "Task",
    detail: "Runs the prompt in a fresh worker session, then reports to the orchestrator. For self-contained jobs.",
  },
  heartbeat: {
    label: "Heartbeat",
    detail: "Sends the prompt into the orchestrator's own conversation, for check-ins that need its context.",
  },
};

/** Asks for permission to show desktop notifications, once. */
export const askForNotifications = () => {
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission();
  }
};

function RunHistory({ schedule, onOpenSession }: { schedule: Schedule; onOpenSession: (id: SessionId) => void }) {
  const [runs, setRuns] = useState<ReadonlyArray<ScheduleRun> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessions = useApp((s) => s.sessions);
  const now = useNow();

  // Reload whenever the schedule changes (a run started or finished).
  useEffect(() => {
    rpc((c) => c["schedules.runs"]({ scheduleId: schedule.id }))
      .then(setRuns)
      .catch((e) => setError(errorMessage(e)));
  }, [schedule]);

  if (error) return <div className="text-[11px] text-red-400">{error}</div>;
  if (runs === null) return <div className="text-[11px] text-zinc-500">Loading…</div>;
  if (runs.length === 0) return <div className="text-[11px] text-zinc-500">No runs yet.</div>;
  return (
    <div className="space-y-1.5">
      {runs.map((run) => {
        const session = run.sessionId ? sessions.get(run.sessionId) : undefined;
        return (
          <div key={run.id} className="rounded border border-zinc-800/80 px-2 py-1.5">
            <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
              <StatusChip status={run.status} />
              <span title={absoluteTime(run.startedAt)}>{relativeTime(run.startedAt, now)}</span>
              {session ? (
                <button className="ml-auto hover:text-zinc-200" onClick={() => onOpenSession(session.id)}>
                  open session →
                </button>
              ) : null}
            </div>
            {run.summary ? (
              <div className="mt-1 line-clamp-4 text-[11px] whitespace-pre-wrap text-zinc-300">{run.summary}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ScheduleCard({
  schedule,
  onEdit,
  onOpenSession,
}: {
  schedule: Schedule;
  onEdit: () => void;
  onOpenSession: (id: SessionId) => void;
}) {
  const [showRuns, setShowRuns] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();
  const act = (f: Parameters<typeof rpc>[0]) => {
    setError(null);
    rpc(f).catch((e) => setError(errorMessage(e)));
  };

  return (
    <div className={cx("rounded-md border border-zinc-800/80 p-2.5", !schedule.enabled && "opacity-60")}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-zinc-100">{schedule.name}</span>
            <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-px text-[10px] text-zinc-400">
              {kindInfo[schedule.kind].label.toLowerCase()}
            </span>
            {schedule.createdBy === "bot" ? (
              <span className="shrink-0 rounded bg-violet-500/15 px-1.5 py-px text-[10px] text-violet-300" title="Created by the orchestrator">
                by bot
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-400">{schedule.description}</div>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-zinc-400" title={schedule.enabled ? "Turn off" : "Turn on"}>
          <input
            type="checkbox"
            checked={schedule.enabled}
            onChange={(e) => act((c) => c["schedules.update"]({ scheduleId: schedule.id, enabled: e.target.checked }))}
          />
          on
        </label>
      </div>
      <div className="mt-1.5 line-clamp-2 text-[11px] text-zinc-500" title={schedule.prompt}>
        {schedule.prompt}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-zinc-500">
        {schedule.nextRunAt !== null ? (
          <span title={absoluteTime(schedule.nextRunAt)}>next {relativeTime(schedule.nextRunAt, now)}</span>
        ) : (
          <span>{schedule.enabled ? "no upcoming run" : "off"}</span>
        )}
        {schedule.lastStatus ? (
          <span className="flex items-center gap-1">
            · last <StatusChip status={schedule.lastStatus} />
          </span>
        ) : null}
        {schedule.failureStreak > 0 ? <span className="text-red-400">· {schedule.failureStreak} failed in a row</span> : null}
      </div>
      <div className="mt-2 flex gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={schedule.lastStatus === "running"}
          onClick={() => act((c) => c["schedules.runNow"]({ scheduleId: schedule.id }))}
        >
          {schedule.lastStatus === "running" ? "Running…" : "Run now"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShowRuns((v) => !v)}>
          History
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => {
            if (confirm(`Delete schedule "${schedule.name}"?`)) act((c) => c["schedules.delete"]({ scheduleId: schedule.id }));
          }}
        >
          Delete
        </Button>
      </div>
      {error ? <div className="mt-1 text-[11px] text-red-400">{error}</div> : null}
      {showRuns ? (
        <div className="mt-2 border-t border-zinc-800/80 pt-2">
          <RunHistory schedule={schedule} onOpenSession={onOpenSession} />
        </div>
      ) : null}
    </div>
  );
}

const SPEC_EXAMPLES = ["every 30m", "daily at 9am", "weekdays at 8:30", "every monday 9am", "in 2h", "0 9 * * 1-5"];

/** Live description and upcoming runs of the spec being typed. */
function useSpecPreview(spec: string, timezone: string) {
  const [preview, setPreview] = useState<{ value: SchedulePreview | null; error: string | null }>({ value: null, error: null });
  useEffect(() => {
    if (!spec.trim()) {
      setPreview({ value: null, error: null });
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      rpc((c) => c["schedules.preview"]({ spec, ...(timezone.trim() ? { timezone: timezone.trim() } : {}) }))
        .then((value) => !cancelled && setPreview({ value, error: null }))
        .catch((e) => !cancelled && setPreview({ value: null, error: errorMessage(e) }));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [spec, timezone]);
  return preview;
}

export function ScheduleDialog({ bot, schedule, onClose }: { bot: Bot; schedule: Schedule | null; onClose: () => void }) {
  const [kind, setKind] = useState<ScheduleKind>(schedule?.kind ?? "task");
  const [name, setName] = useState(schedule?.name ?? "");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [spec, setSpec] = useState(schedule?.spec ?? "");
  const [timezone, setTimezone] = useState(schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [useBotDefault, setUseBotDefault] = useState(schedule ? schedule.provider === null : true);
  const initialProvider = schedule?.provider ?? bot.defaultWorker;
  const [provider, setProvider] = useState<ProviderKind>(initialProvider.provider);
  const [model, setModel] = useState<ModelChoice>({ model: initialProvider.model ?? null, effort: initialProvider.effort ?? null });
  const [cwd, setCwd] = useState(schedule?.cwd ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const preview = useSpecPreview(spec, timezone);

  const save = () => {
    setSaving(true);
    setError(null);
    askForNotifications();
    const providerValue = kind === "task" && !useBotDefault ? selection(provider, model) : null;
    const fields = { name, prompt, spec, timezone, provider: providerValue, cwd: cwd.trim() || null };
    rpc((c) =>
      schedule
        ? c["schedules.update"]({ scheduleId: schedule.id, ...fields })
        : c["schedules.create"]({ botId: bot.id, kind, ...fields }),
    )
      .then(onClose)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setSaving(false));
  };

  return (
    <Modal
      title={schedule ? `Edit schedule · ${schedule.name}` : `New schedule · ${bot.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || !prompt.trim() || !spec.trim() || saving} onClick={save}>
            {schedule ? "Save" : "Create schedule"}
          </Button>
        </>
      }
    >
      {schedule ? null : (
        <Field label="Kind">
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(kindInfo) as Array<ScheduleKind>).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={cx(
                  "rounded-md border px-3 py-2 text-left",
                  kind === k ? "border-zinc-500 bg-zinc-800/70" : "border-zinc-800 hover:border-zinc-700",
                )}
              >
                <div className="text-sm font-medium text-zinc-100">{kindInfo[k].label}</div>
                <div className="mt-0.5 text-[11px] text-zinc-500">{kindInfo[k].detail}</div>
              </button>
            ))}
          </div>
        </Field>
      )}
      <Field label="Name">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning digest" autoFocus />
      </Field>
      <Field
        label="Prompt"
        hint={
          kind === "task"
            ? "The worker does not see the orchestrator's conversation: say everything it needs. It answers [SILENT] when there is nothing to report."
            : "Sent to the orchestrator as-is. It answers [SILENT] when there is nothing worth telling you."
        }
      >
        <textarea
          className={cx(inputClass, "min-h-24")}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            kind === "task"
              ? "Check open PRs in ~/code/app and list the ones waiting on me."
              : "Check on the running workers and tell me if any is stuck."
          }
        />
      </Field>
      <div className="grid grid-cols-[1fr_12rem] gap-3">
        <Field label="When">
          <input className={inputClass} value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="weekdays at 9am" />
        </Field>
        <Field label="Time zone">
          <input className={inputClass} value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </Field>
      </div>
      <div className="-mt-2 text-[11px]">
        {preview.error ? (
          <span className="text-amber-300">{preview.error}</span>
        ) : preview.value ? (
          <span className="text-zinc-400">
            <span className="text-zinc-200">{preview.value.description}</span>
            {preview.value.nextRuns.length > 0 ? ` · next: ${preview.value.nextRuns.slice(0, 3).map(absoluteTime).join(", ")}` : null}
          </span>
        ) : (
          <span className="text-zinc-500">
            e.g.{" "}
            {SPEC_EXAMPLES.map((example, i) => (
              <span key={example}>
                {i > 0 ? ", " : null}
                <button type="button" className="font-mono text-zinc-400 hover:text-zinc-200" onClick={() => setSpec(example)}>
                  {example}
                </button>
              </span>
            ))}
          </span>
        )}
      </div>
      {kind === "task" ? (
        <>
          <Field label="Worker">
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-xs text-zinc-300">
                <input type="checkbox" checked={useBotDefault} onChange={(e) => setUseBotDefault(e.target.checked)} />
                Use the bot's default worker ({bot.defaultWorker.provider}
                {bot.defaultWorker.model ? ` · ${bot.defaultWorker.model}` : ""})
              </label>
              {useBotDefault ? null : (
                <>
                  <ProviderPicker
                    value={provider}
                    onChange={(p) => {
                      setProvider(p);
                      setModel(NO_CHOICE);
                    }}
                  />
                  <ModelPicker provider={provider} value={model} onChange={setModel} />
                </>
              )}
            </div>
          </Field>
          <Field label="Working directory" hint={`Empty uses the bot's (${bot.cwd}).`}>
            <input className={inputClass} value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={bot.cwd} />
          </Field>
        </>
      ) : null}
      {error ? <div className="text-xs text-red-400">{error}</div> : null}
    </Modal>
  );
}

export function SchedulesPanel({
  bot,
  onClose,
  onOpenSession,
}: {
  bot: Bot;
  onClose: () => void;
  onOpenSession: (id: SessionId) => void;
}) {
  const all = useApp((s) => s.schedules);
  const schedules = useMemo(() => [...all.values()].filter((s) => s.botId === bot.id), [all, bot.id]);
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);

  useEffect(askForNotifications, []);

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-zinc-800/80 bg-zinc-950">
      <div className="flex h-12 items-center gap-2 border-b border-zinc-800/80 px-3">
        <span className="text-xs font-medium text-zinc-100">Schedules</span>
        <Button size="sm" className="ml-auto" onClick={() => setEditing("new")}>
          New
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          ✕
        </Button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {bot.pausedReason !== null && schedules.some((s) => s.enabled) ? (
          <div className="rounded-md border border-amber-700/30 bg-amber-950/30 px-2.5 py-2 text-[11px] text-amber-200">
            {bot.name} is paused, so its schedules are skipped until you resume it.
          </div>
        ) : null}
        {schedules.map((schedule) => (
          <ScheduleCard key={schedule.id} schedule={schedule} onEdit={() => setEditing(schedule)} onOpenSession={onOpenSession} />
        ))}
        {schedules.length === 0 ? (
          <p className="text-xs text-zinc-500">
            Nothing scheduled. Schedule a task (a self-contained job in a fresh worker, like a morning digest) or a
            heartbeat (a recurring check-in in {bot.name}'s own conversation). You can also ask {bot.name} to set one
            up. Results reach its conversation and your desktop notifications.
          </p>
        ) : null}
      </div>
      {editing !== null ? (
        <ScheduleDialog bot={bot} schedule={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </aside>
  );
}
