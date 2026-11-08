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
import { CalendarClock, HeartPulse, History, Loader2, Pencil, Play, Plus, Timer, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { errorMessage, rpc } from "../rpc.ts";
import { useApp } from "../store.ts";
import { NO_CHOICE, ProviderPicker, selection } from "./Dialogs.tsx";
import { type ModelChoice, ModelPicker } from "./ModelPicker.tsx";
import { ProviderLogo } from "./icons.tsx";
import { Badge, Button, cx, EmptyState, ErrorText, Field, IconButton, inputClass, Modal, OptionCards, Panel, providerName, Toggle } from "./ui.tsx";

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
  return <span className={cx("rounded-md px-1.5 py-px text-[10px] font-medium", statusStyle[status])}>{status}</span>;
}

const kindInfo: Record<ScheduleKind, { label: string; detail: string; icon: typeof Timer }> = {
  task: {
    icon: Timer,
    label: "Task",
    detail: "Runs the prompt in a fresh worker session, then reports to the orchestrator. For self-contained jobs.",
  },
  heartbeat: {
    icon: HeartPulse,
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
          <div key={run.id} className="rounded-lg bg-zinc-900/60 px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
              <StatusChip status={run.status} />
              <span title={absoluteTime(run.startedAt)}>{relativeTime(run.startedAt, now)}</span>
              {session ? (
                <button className="ml-auto hover:text-zinc-200" onClick={() => onOpenSession(session.id)}>
                  Open session →
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

  const KindIcon = kindInfo[schedule.kind].icon;
  const running = schedule.lastStatus === "running";

  return (
    <div className={cx("group rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-3 transition-colors hover:border-zinc-700/80", !schedule.enabled && "opacity-60")}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-zinc-800/80 text-zinc-400" title={kindInfo[schedule.kind].label}>
          <KindIcon className="size-3.5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-zinc-100">{schedule.name}</span>
            {schedule.provider ? <ProviderLogo provider={schedule.provider.provider} size={12} className="shrink-0" /> : null}
            {schedule.createdBy === "bot" ? (
              <Badge tone="violet" title="Created by the orchestrator">
                by bot
              </Badge>
            ) : null}
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-400">{schedule.description}</div>
        </div>
        <Toggle
          checked={schedule.enabled}
          title={schedule.enabled ? "Turn off" : "Turn on"}
          onChange={(enabled) => act((c) => c["schedules.update"]({ scheduleId: schedule.id, enabled }))}
        />
      </div>
      <div className="mt-2 line-clamp-2 text-xs leading-relaxed text-zinc-500" title={schedule.prompt}>
        {schedule.prompt}
      </div>
      <div className="mt-2.5 flex items-center gap-2 text-[11px] text-zinc-500">
        {running ? (
          <span className="flex items-center gap-1 text-emerald-300">
            <Loader2 className="size-3 animate-spin" /> Running
          </span>
        ) : schedule.nextRunAt !== null ? (
          <span title={absoluteTime(schedule.nextRunAt)}>Next {relativeTime(schedule.nextRunAt, now)}</span>
        ) : (
          <span>{schedule.enabled ? "No upcoming run" : "Off"}</span>
        )}
        {schedule.lastStatus && !running ? <StatusChip status={schedule.lastStatus} /> : null}
        {schedule.failureStreak > 0 ? <span className="text-red-400">{schedule.failureStreak} failed in a row</span> : null}
        <span className="ml-auto flex items-center opacity-60 transition-opacity group-hover:opacity-100">
          <IconButton
            icon={Play}
            label="Run now"
            size="sm"
            disabled={running}
            onClick={() => act((c) => c["schedules.runNow"]({ scheduleId: schedule.id }))}
          />
          <IconButton icon={History} label="History" size="sm" active={showRuns} onClick={() => setShowRuns((v) => !v)} />
          <IconButton icon={Pencil} label="Edit" size="sm" onClick={onEdit} />
          <IconButton
            icon={Trash2}
            label="Delete"
            size="sm"
            className="hover:text-red-300"
            onClick={() => {
              if (confirm(`Delete schedule "${schedule.name}"?`)) act((c) => c["schedules.delete"]({ scheduleId: schedule.id }));
            }}
          />
        </span>
      </div>
      {error ? <div className="mt-1 text-[11px] text-red-400">{error}</div> : null}
      {showRuns ? (
        <div className="mt-2.5 border-t border-zinc-800/80 pt-2.5">
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
      title={schedule ? `Edit ${schedule.name}` : "New schedule"}
      description={schedule ? kindInfo[schedule.kind].detail : `Something ${bot.name} does on its own, on a schedule.`}
      icon={
        <span className="flex size-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400">
          <CalendarClock className="size-4.5" strokeWidth={1.75} />
        </span>
      }
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
        <OptionCards
          value={kind}
          onChange={setKind}
          options={(Object.keys(kindInfo) as Array<ScheduleKind>).map((k) => {
            const Icon = kindInfo[k].icon;
            return {
              value: k,
              label: kindInfo[k].label,
              detail: kindInfo[k].detail,
              icon: <Icon className="size-4 text-zinc-400" strokeWidth={1.75} />,
            };
          })}
        />
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
              <Toggle
                checked={useBotDefault}
                onChange={setUseBotDefault}
                label={
                  <span className="flex items-center gap-1.5">
                    Use the bot's default worker
                    <ProviderLogo provider={bot.defaultWorker.provider} size={13} />
                    <span className="text-zinc-500">
                      {providerName(bot.defaultWorker.provider)}
                      {bot.defaultWorker.model ? ` · ${bot.defaultWorker.model}` : ""}
                    </span>
                  </span>
                }
              />
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
      <ErrorText>{error}</ErrorText>
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
    <Panel
      name="schedules"
      title={<span className="text-[13px] font-semibold text-zinc-100">Schedules</span>}
      actions={
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus /> New
        </Button>
      }
      onClose={onClose}
    >
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
          <EmptyState icon={CalendarClock} title="Nothing scheduled">
            Schedule a <span className="text-zinc-300">task</span> (a self-contained job in a fresh worker, like a morning
            digest) or a <span className="text-zinc-300">heartbeat</span> (a recurring check-in in {bot.name}'s own
            conversation). You can also ask {bot.name} to set one up.
          </EmptyState>
        ) : null}
      </div>
      {editing !== null ? (
        <ScheduleDialog bot={bot} schedule={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </Panel>
  );
}
