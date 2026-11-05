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
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { errorMessage, rpc } from "../rpc.ts";
import { useApp } from "../store.ts";
import { Button, cx, inputClass } from "./ui.tsx";

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
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="font-medium text-zinc-300">{target === "user" ? "About you" : `${bot.name}'s notes`}</span>
        <span className="text-zinc-600">{target === "user" ? "all bots" : "this bot"}</span>
        <span className={cx("ml-auto tabular-nums", used > limit ? "text-red-400" : "text-zinc-500")}>
          {used}/{limit}
        </span>
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
    <div className="flex items-center gap-2 border-t border-zinc-800/80 px-3 py-2 text-[11px] text-zinc-500">
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
        "rounded-lg border p-2.5",
        skill.status === "proposed" ? "border-violet-700/50 bg-violet-950/20" : "border-zinc-800",
        skill.status === "archived" && "opacity-50",
      )}
    >
      <button className="w-full text-left" onClick={() => setOpen(!open)}>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-zinc-100">{skill.name}</span>
          <span className="text-[10px] text-zinc-500">v{skill.version}</span>
          {skill.botId === null ? <span className="text-[10px] text-zinc-500">global</span> : null}
          <span
            className={cx(
              "ml-auto text-[10px] uppercase",
              skill.status === "proposed" ? "text-violet-300" : "text-zinc-500",
            )}
          >
            {skill.status}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-zinc-400">{skill.description}</div>
      </button>
      {open ? (
        <div className="markdown mt-2 max-h-64 overflow-auto border-t border-zinc-800 pt-2 text-xs text-zinc-300">
          <Markdown remarkPlugins={[remarkGfm]}>{skill.body}</Markdown>
        </div>
      ) : null}
      <div className="mt-2 flex gap-1.5">
        {skill.status !== "active" ? (
          <Button size="sm" variant="primary" onClick={() => rpc((c) => c["skills.setStatus"]({ skillId: skill.id, status: "active" }))}>
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
    <aside className="flex w-96 shrink-0 flex-col border-l border-zinc-800/80 bg-zinc-950">
      <div className="flex h-12 items-center gap-1 border-b border-zinc-800/80 px-3">
        {(["memory", "skills"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cx(
              "rounded-md px-2.5 py-1 text-xs font-medium capitalize",
              tab === t ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            {t}
            {t === "skills" && proposals > 0 ? (
              <span className="ml-1.5 rounded bg-violet-500/20 px-1 text-[10px] text-violet-300">{proposals}</span>
            ) : null}
          </button>
        ))}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          ✕
        </Button>
      </div>
      {error ? <div className="px-3 py-2 text-xs text-red-400">{error}</div> : null}

      {tab === "memory" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-3 border-b border-zinc-800/80 p-3">
            <div className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">Core memory</div>
            <CoreEditor bot={bot} target="user" entries={core.user} />
            <CoreEditor bot={bot} target="notes" entries={core.notes} />
          </div>
          <div className="space-y-2 border-b border-zinc-800/80 p-3">
            <div className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">
              Archive <span className="font-normal normal-case">· searched on demand</span>
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
            {memories.map((m) => (
              <div key={m.id} className="group rounded-md border border-zinc-800/80 px-2.5 py-2">
                <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
                  <span className="uppercase">{m.kind}</span>
                  {m.botId === null ? <span>· global</span> : null}
                  <span className="ml-auto flex gap-2 opacity-0 group-hover:opacity-100">
                    <button className="hover:text-red-300" onClick={() => rpc((c) => c["memory.delete"]({ memoryId: m.id }))}>
                      forget
                    </button>
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-zinc-200">{m.content}</div>
              </div>
            ))}
            {memories.length === 0 ? <p className="text-xs text-zinc-500">No archived memories yet.</p> : null}
          </div>
          <StorageFooter />
        </div>
      ) : (
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {skills.map((s) => (
            <SkillCard key={s.id} skill={s} />
          ))}
          {skills.length === 0 ? (
            <p className="text-xs text-zinc-500">
              No skills yet. Sessions propose skills when they work out reusable procedures; approve them here.
            </p>
          ) : null}
        </div>
      )}
    </aside>
  );
}
