import {
  type Bot,
  type Memory,
  type Project,
  PROJECT_CONTEXT_LIMIT,
  PROJECT_SUMMARY_LIMIT,
  type ProjectId,
  type SessionId,
} from "@apollo/contracts";
import { Archive, ArchiveRestore, ArrowLeft, FolderKanban, Plus, SquarePen, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { relativeTime } from "../format.ts";
import { errorMessage, rpc } from "../rpc.ts";
import { useApp } from "../store.ts";
import { contextConflict, edited, fieldsOf, type ProjectEdit, projectUpdate, rebase, startEdit } from "../projectForm.ts";
import { ProviderLogo } from "./icons.tsx";
import { Badge, Button, cx, EmptyState, ErrorText, Field, IconButton, inputClass, Panel, StatusDot } from "./ui.tsx";

const byRecent = (a: Project, b: Project) =>
  (a.status === b.status ? 0 : a.status === "active" ? -1 : 1) || b.updatedAt - a.updatedAt;

/** The bot's projects, sorted active first, then by last change. */
export const useBotProjects = (botId: string) => {
  const projects = useApp((s) => s.projects);
  return useMemo(() => [...projects.values()].filter((p) => p.botId === botId).sort(byRecent), [projects, botId]);
};

function useProjectMemories(project: Project | null) {
  const version = useApp((s) => (project ? (s.knowledgeVersion.get(project.botId) ?? 0) : 0));
  const [memories, setMemories] = useState<ReadonlyArray<Memory>>([]);
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    rpc((c) => c["memory.list"]({ botId: project.botId }))
      .then((all) => !cancelled && setMemories(all.filter((m) => m.projectId === project.id)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project?.id, project?.botId, version]);
  return memories;
}

function Counter({ used, limit }: { used: number; limit: number }) {
  return <span className={cx("tabular-nums", used > limit ? "text-red-400" : "text-zinc-600")}>{used}/{limit}</span>;
}

function ProjectForm({
  bot,
  project,
  onSaved,
  onCancel,
}: {
  bot: Bot;
  project: Project | null;
  onSaved: (project: Project) => void;
  onCancel?: () => void;
}) {
  const [edit, setEdit] = useState<ProjectEdit>(() => startEdit(project));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (project) setEdit((current) => rebase(current, fieldsOf(project)));
  }, [project]);
  const { name, summary, cwd, context } = edit.draft;
  const set = (key: keyof ProjectEdit["draft"]) => (value: string) =>
    setEdit((current) => ({ ...current, draft: { ...current.draft, [key]: value } }));
  const conflict = project ? contextConflict(edit, fieldsOf(project)) : false;

  const save = () => {
    setSaving(true);
    setError(null);
    rpc((c) =>
      project
        ? c["projects.update"]({ projectId: project.id, ...projectUpdate(edit) })
        : c["projects.create"]({ botId: bot.id, name, summary, context, cwd: cwd.trim() ? cwd : null }),
    )
      .then((saved) => {
        setEdit(startEdit(saved));
        onSaved(saved);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setSaving(false));
  };
  /** Drops the user's context edit for the latest context. */
  const takeLatestContext = () =>
    project && setEdit((current) => ({ base: { ...current.base, context: project.context }, draft: { ...current.draft, context: project.context } }));
  /** Keeps the user's context edit, to replace the latest context on save. */
  const keepMyContext = () => project && setEdit((current) => ({ ...current, base: { ...current.base, context: project.context } }));

  return (
    <div className="space-y-3">
      <Field label="Name">
        <input className={inputClass} value={name} onChange={(e) => set("name")(e.target.value)} autoFocus={!project} />
      </Field>
      <Field
        label="Summary"
        hint={
          <>
            One line: what it is and where it stands. It is all {bot.name}'s orchestrator sees of the project.{" "}
            <Counter used={summary.length} limit={PROJECT_SUMMARY_LIMIT} />
          </>
        }
      >
        <input className={inputClass} value={summary} onChange={(e) => set("summary")(e.target.value)} />
      </Field>
      <Field label="Workspace" hint={`Where its sessions work. Empty: the bot's (${bot.cwd}).`}>
        <input className={cx(inputClass, "font-mono text-xs")} value={cwd} onChange={(e) => set("cwd")(e.target.value)} placeholder={bot.cwd} />
      </Field>
      <Field
        label="Context"
        hint={
          <>
            Markdown: goals, decisions, status, where things are. Sessions started in the project get it; agents keep it
            up to date. <Counter used={context.length} limit={PROJECT_CONTEXT_LIMIT} />
          </>
        }
      >
        <textarea
          className={cx(inputClass, "min-h-56 font-mono text-xs leading-relaxed")}
          value={context}
          onChange={(e) => set("context")(e.target.value)}
        />
      </Field>
      {conflict ? (
        <div role="alert" className="space-y-2 rounded-md border border-amber-700/30 bg-amber-950/30 px-2.5 py-2 text-[11px] text-amber-200">
          <div>The context changed while you were editing it (an agent updated it). Saving now would replace that change.</div>
          <div className="flex gap-2">
            <Button size="sm" onClick={takeLatestContext}>
              Use the latest context
            </Button>
            <Button size="sm" variant="ghost" onClick={keepMyContext}>
              Keep my edit
            </Button>
          </div>
        </div>
      ) : null}
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button variant="primary" size="sm" disabled={saving || conflict || (!!project && edited(edit).length === 0)} onClick={save}>
          {project ? "Save" : "Create project"}
        </Button>
      </div>
    </div>
  );
}

function ProjectDetail({
  bot,
  project,
  onBack,
  onNewSession,
  onOpenSession,
}: {
  bot: Bot;
  project: Project;
  onBack: () => void;
  onNewSession: (projectId: ProjectId) => void;
  onOpenSession: (id: SessionId) => void;
}) {
  const sessions = useApp((s) => s.sessions);
  const inside = useMemo(
    () => [...sessions.values()].filter((s) => s.projectId === project.id && s.role !== "reflection").sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, project.id],
  );
  const memories = useProjectMemories(project);
  const [error, setError] = useState<string | null>(null);
  const act = (call: Parameters<typeof rpc>[0]) => rpc(call).catch((e) => setError(errorMessage(e)));
  const archived = project.status === "archived";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <IconButton icon={ArrowLeft} label="All projects" size="sm" onClick={onBack} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-100">{project.name}</span>
        {archived ? <Badge>Archived</Badge> : null}
        <IconButton
          icon={archived ? ArchiveRestore : Archive}
          label={archived ? "Make it active again" : "Archive (done)"}
          size="sm"
          onClick={() => act((c) => c["projects.update"]({ projectId: project.id, status: archived ? "active" : "archived" }))}
        />
        <IconButton
          icon={Trash2}
          label="Delete project"
          size="sm"
          onClick={() => {
            if (!confirm(`Delete ${project.name} and its memories? Its sessions stay, outside any project.`)) return;
            act((c) => c["projects.delete"]({ projectId: project.id })).then(onBack);
          }}
        />
      </div>
      <ErrorText>{error}</ErrorText>

      <section className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Sessions</span>
          <Button size="sm" onClick={() => onNewSession(project.id)} disabled={archived}>
            <SquarePen /> New session
          </Button>
        </div>
        {inside.length === 0 ? (
          <div className="text-xs text-zinc-500">No sessions yet. Start one here, or ask {bot.name} to delegate work to the project.</div>
        ) : (
          inside.map((s) => (
            <button
              key={s.id}
              onClick={() => onOpenSession(s.id)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-zinc-900"
            >
              <ProviderLogo provider={s.provider} size={12} />
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <StatusDot status={s.status} className={s.status === "idle" ? "opacity-0" : ""} />
              <span className="text-[10px] text-zinc-600">{relativeTime(s.updatedAt, Date.now())}</span>
            </button>
          ))
        )}
      </section>

      <section className="space-y-1.5">
        <span className="block text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Project</span>
        <ProjectForm key={project.id} bot={bot} project={project} onSaved={() => {}} />
      </section>

      <section className="space-y-1.5">
        <span className="block text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Memories ({memories.length})</span>
        {memories.length === 0 ? (
          <div className="text-xs text-zinc-500">Facts agents save to the project show up here; only its sessions find them.</div>
        ) : (
          memories.map((m) => (
            <div key={m.id} className="group flex items-start gap-2 rounded-lg border border-zinc-800/80 px-2.5 py-2 text-[12px] text-zinc-300">
              <span className="min-w-0 flex-1 whitespace-pre-wrap">{m.content}</span>
              <span className="opacity-0 transition-opacity group-hover:opacity-100">
                <IconButton icon={Trash2} label="Forget" size="sm" onClick={() => act((c) => c["memory.delete"]({ memoryId: m.id }))} />
              </span>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

/** A bot's projects: long-standing work whose context and memories stay in the project. */
export function ProjectsPanel({
  bot,
  focus,
  onFocus,
  onClose,
  onNewSession,
  onOpenSession,
}: {
  bot: Bot;
  /** The project shown, or null for the list. */
  focus: ProjectId | null;
  onFocus: (id: ProjectId | null) => void;
  onClose: () => void;
  onNewSession: (projectId: ProjectId) => void;
  onOpenSession: (id: SessionId) => void;
}) {
  const projects = useBotProjects(bot.id);
  const sessions = useApp((s) => s.sessions);
  const [creating, setCreating] = useState(false);
  const project = focus ? projects.find((p) => p.id === focus) ?? null : null;

  return (
    <Panel
      name="projects"
      title={<span className="text-[13px] font-semibold text-zinc-100">Projects</span>}
      actions={
        project || creating ? null : (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> New
          </Button>
        )
      }
      onClose={onClose}
    >
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {project ? (
          <ProjectDetail bot={bot} project={project} onBack={() => onFocus(null)} onNewSession={onNewSession} onOpenSession={onOpenSession} />
        ) : creating ? (
          <ProjectForm
            bot={bot}
            project={null}
            onCancel={() => setCreating(false)}
            onSaved={(saved) => {
              setCreating(false);
              onFocus(saved.id);
            }}
          />
        ) : projects.length === 0 ? (
          <EmptyState icon={FolderKanban} title="No projects yet">
            A project holds long-standing work: its context and memories stay in it, {bot.name} knows it by a one-line
            summary, and sessions can be started inside it.
          </EmptyState>
        ) : (
          projects.map((p) => {
            const count = [...sessions.values()].filter((s) => s.projectId === p.id && s.role !== "reflection").length;
            return (
              <button
                key={p.id}
                onClick={() => onFocus(p.id)}
                className={cx(
                  "block w-full rounded-lg border border-zinc-800/80 px-3 py-2.5 text-left transition-colors hover:border-zinc-700 hover:bg-zinc-900/60",
                  p.status === "archived" && "opacity-60",
                )}
              >
                <span className="flex items-center gap-2">
                  <FolderKanban className="size-3.5 shrink-0 text-zinc-500" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-100">{p.name}</span>
                  {p.status === "archived" ? <Badge>Archived</Badge> : null}
                  <span className="text-[10px] text-zinc-600">
                    {count} session{count === 1 ? "" : "s"}
                  </span>
                </span>
                {p.summary ? <span className="mt-1 block text-[12px] leading-relaxed text-zinc-400">{p.summary}</span> : null}
              </button>
            );
          })
        )}
      </div>
    </Panel>
  );
}
