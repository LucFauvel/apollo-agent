import {
  type Bot,
  CORE_MEMORY_LIMITS,
  type CoreMemory,
  type CoreMemoryTarget,
  coreMemoryUsage,
  type Memory,
  type MemoryKind,
  type Skill,
  type StorageReport,
} from "@apollo/contracts";
import { BookOpen, Brain, Check, Globe, HardDrive, Lightbulb, Pin, Sparkles, Trash2, User } from "lucide-react";
import { MarkdownText } from "./Code.tsx";
import { useEffect, useState } from "react";
import { errorMessage, rpc } from "../rpc.ts";
import { useApp } from "../store.ts";
import { Badge, Button, cx, EmptyState, IconButton, inputClass, Panel } from "./ui.tsx";

function useKnowledge(bot: Bot) {
  const version = useApp((s) => (s.knowledgeVersion.get(bot.id) ?? 0) + (s.knowledgeVersion.get("global") ?? 0));
  const [memories, setMemories] = useState<ReadonlyArray<Memory>>([]);
  const [core, setCore] = useState<CoreMemory>({ user: [], notes: [] });
  const [skills, setSkills] = useState<ReadonlyArray<Skill>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      rpc((c) => c["memory.list"]({ botId: bot.id })),
      rpc((c) => c["skills.list"]({ botId: bot.id })),
      rpc((c) => c["memory.core"]({ botId: bot.id })),
    ])
      .then(([m, s, k]) => {
        if (cancelled) return;
        setMemories(m);
        setSkills(s);
        setCore(k);
      })
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [bot.id, version]);

  return { memories, skills, core, error };
}

const MEMORY_KIND_ICON: Record<MemoryKind, typeof Brain> = {
  fact: BookOpen,
  preference: User,
  lesson: Lightbulb,
};

const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(bytes / 1024 ** 2, 0.1).toFixed(1)} MB`;

/** One core memory list, edited as one entry per line, with its character budget. */
function CoreEditor({ bot, target, entries }: { bot: Bot; target: CoreMemoryTarget; entries: ReadonlyArray<string> }) {
  const saved = entries.join("\n");
  const [text, setText] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(saved), [saved]);

  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const used = coreMemoryUsage(lines);
  const limit = CORE_MEMORY_LIMITS[target];
  const save = () => {
    setError(null);
    rpc((c) => c["memory.setCore"]({ botId: bot.id, target, entries: lines })).catch((e) => setError(errorMessage(e)));
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[11px]">
        {target === "user" ? <User className="size-3 text-zinc-500" /> : <Pin className="size-3 text-zinc-500" />}
        <span className="font-medium text-zinc-300">{target === "user" ? "About you" : `${bot.name}'s notes`}</span>
        <span className="text-zinc-600">{target === "user" ? "all bots" : "this bot"}</span>
        <span className={cx("ml-auto tabular-nums", used > limit ? "text-red-400" : "text-zinc-600")}>
          {used}/{limit}
        </span>
      </div>
      <div className="h-0.5 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={cx("h-full transition-[width]", used > limit ? "bg-red-500" : used > limit * 0.8 ? "bg-amber-500" : "bg-zinc-600")}
          style={{ width: `${Math.min(100, (used / limit) * 100)}%` }}
        />
      </div>
      <textarea
        className={cx(inputClass, "min-h-20 text-xs leading-relaxed")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="One entry per line. Always in every session's prompt."
      />
      {error ? <div className="text-[11px] text-red-400">{error}</div> : null}
      {text !== saved ? (
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setText(saved)}>
            Revert
          </Button>
          <Button size="sm" variant="primary" disabled={used > limit} onClick={save}>
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function StorageFooter() {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    rpc((c) => c["storage.report"]()).then(setReport, () => undefined);
  }, []);
  const compact = () => {
    setBusy(true);
    rpc((c) => c["storage.compact"]())
      .then(setReport, () => undefined)
      .finally(() => setBusy(false));
  };
  if (!report) return null;
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t border-zinc-800/80 px-4 text-[11px] text-zinc-500">
      <HardDrive className="size-3.5" />
      <span title={`${report.memories} memories · ${report.sessions} sessions · ${report.events} events`}>
        Storage {formatBytes(report.databaseBytes)} of {formatBytes(report.budgetBytes)}
      </span>
      <button className="ml-auto hover:text-zinc-200 disabled:opacity-50" disabled={busy} onClick={compact}>
        {busy ? "Compacting…" : "Compact now"}
      </button>
    </div>
  );
}

function SkillCard({ skill }: { skill: Skill }) {
  const [open, setOpen] = useState(skill.status === "proposed");
  return (
    <div
      className={cx(
        "rounded-xl border p-3",
        skill.status === "proposed" ? "border-violet-700/50 bg-violet-950/20" : "border-zinc-800/80 bg-zinc-900/30",
        skill.status === "archived" && "opacity-50",
      )}
    >
      <button className="w-full text-left" onClick={() => setOpen(!open)}>
        <div className="flex items-center gap-2">
          <Sparkles className={cx("size-3.5 shrink-0", skill.status === "proposed" ? "text-violet-300" : "text-zinc-500")} />
          <span className="truncate font-mono text-xs font-medium text-zinc-100">{skill.name}</span>
          <span className="text-[10px] text-zinc-600">v{skill.version}</span>
          {skill.botId === null ? (
            <Badge>
              <Globe className="size-2.5" />
              global
            </Badge>
          ) : null}
          <span className="ml-auto">
            {skill.status === "proposed" ? <Badge tone="violet">Proposed</Badge> : skill.status === "archived" ? <Badge>Archived</Badge> : null}
          </span>
        </div>
        <div className="mt-1 text-xs leading-relaxed text-zinc-400">{skill.description}</div>
      </button>
      {open ? (
        <div className="markdown mt-2 max-h-64 overflow-auto border-t border-zinc-800 pt-2 text-xs text-zinc-300">
          <MarkdownText>{skill.body}</MarkdownText>
        </div>
      ) : null}
      <div className="mt-2.5 flex gap-1.5">
        {skill.status !== "active" ? (
          <Button size="sm" variant="primary" onClick={() => rpc((c) => c["skills.setStatus"]({ skillId: skill.id, status: "active" }))}>
            {skill.status === "proposed" ? <Check /> : null}
            {skill.status === "proposed" ? "Approve" : "Restore"}
          </Button>
        ) : (
          <Button size="sm" onClick={() => rpc((c) => c["skills.setStatus"]({ skillId: skill.id, status: "archived" }))}>
            Archive
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => rpc((c) => c["skills.delete"]({ skillId: skill.id }))}>
          {skill.status === "proposed" ? "Reject" : "Delete"}
        </Button>
      </div>
    </div>
  );
}

export function KnowledgePanel({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const { memories, skills, core, error } = useKnowledge(bot);
  const [tab, setTab] = useState<"memory" | "skills">("memory");
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<MemoryKind>("fact");
  const proposals = skills.filter((s) => s.status === "proposed").length;

  const addMemory = () => {
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    void rpc((c) => c["memory.create"]({ botId: bot.id, kind, content, tags: [] }));
  };

  return (
    <Panel
      onClose={onClose}
      title={
        <div className="-ml-2 flex rounded-lg bg-zinc-900 p-0.5">
          {(["memory", "skills"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cx(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                tab === t ? "bg-zinc-800 text-zinc-100 shadow-sm" : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              {t === "memory" ? <Brain className="size-3.5" /> : <Sparkles className="size-3.5" />}
              {t}
              {t === "skills" && proposals > 0 ? (
                <span className="rounded bg-violet-500/25 px-1 text-[10px] text-violet-200 tabular-nums">{proposals}</span>
              ) : null}
            </button>
          ))}
        </div>
      }
    >
      {error ? <div className="px-3 py-2 text-xs text-red-400">{error}</div> : null}

      {tab === "memory" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-4 border-b border-zinc-800/80 p-4">
            <div className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
              Core memory <span className="font-normal tracking-normal normal-case">· always in the prompt</span>
            </div>
            <CoreEditor bot={bot} target="user" entries={core.user} />
            <CoreEditor bot={bot} target="notes" entries={core.notes} />
          </div>
          <div className="space-y-2 border-b border-zinc-800/80 p-4">
            <div className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
              Archive <span className="font-normal tracking-normal normal-case">· searched on demand</span>
            </div>
            <textarea
              className={cx(inputClass, "min-h-14 text-xs")}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={`Teach ${bot.name} something…`}
            />
            <div className="flex gap-2">
              <select className={cx(inputClass, "w-auto text-xs")} value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
                <option value="fact">fact</option>
                <option value="preference">preference</option>
                <option value="lesson">lesson</option>
              </select>
              <Button size="sm" variant="primary" className="ml-auto" disabled={!draft.trim()} onClick={addMemory}>
                Remember
              </Button>
            </div>
          </div>
          <div className="flex-1 space-y-1.5 overflow-y-auto p-3">
            {memories.map((m) => {
              const KindIcon = MEMORY_KIND_ICON[m.kind];
              return (
                <div key={m.id} className="group flex gap-2.5 rounded-lg px-2 py-2 hover:bg-zinc-900/60">
                  <KindIcon className="mt-0.5 size-3.5 shrink-0 text-zinc-500" strokeWidth={1.75} />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs leading-relaxed text-zinc-200">{m.content}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-zinc-600">
                      <span className="capitalize">{m.kind}</span>
                      {m.botId === null ? <span>· global</span> : null}
                    </div>
                  </div>
                  <IconButton
                    icon={Trash2}
                    label="Forget"
                    size="sm"
                    className="opacity-0 group-hover:opacity-100 hover:text-red-300"
                    onClick={() => rpc((c) => c["memory.delete"]({ memoryId: m.id }))}
                  />
                </div>
              );
            })}
            {memories.length === 0 ? (
              <EmptyState icon={Brain} title="No archived memories yet">
                Memories saved by sessions, reflections or you show up here.
              </EmptyState>
            ) : null}
          </div>
          <StorageFooter />
        </div>
      ) : (
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {skills.map((s) => (
            <SkillCard key={s.id} skill={s} />
          ))}
          {skills.length === 0 ? (
            <EmptyState icon={Sparkles} title="No skills yet">
              Sessions propose skills when they work out reusable procedures. Approve them here.
            </EmptyState>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
