import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "./ui.tsx";

/**
 * A rail of ticks beside the conversation, one per message the user sent: ticks for the
 * messages on screen are lit, hovering one previews the message and the start of its
 * answer, clicking jumps there. Messages are found by their `data-turn` attribute.
 */

export interface RailTurn {
  /** The user message's key (its `data-turn`). */
  readonly key: string;
  readonly text: string;
  /** The start of the answer, if there is one yet. */
  readonly reply: string | null;
  readonly at: number | undefined;
}

const TICK = 2;

export function MessageRail({
  turns,
  scrollRef,
  onJump,
}: {
  turns: ReadonlyArray<RailTurn>;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Scrolls to a message (opening its day first when folded). */
  onJump: (key: string) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [visible, setVisible] = useState<ReadonlySet<string>>(new Set());
  const [hover, setHover] = useState<{ turn: RailTurn; top: number } | null>(null);

  // The rail's height sets the spacing between ticks.
  useLayoutEffect(() => {
    const el = rail.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    setHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  // Which messages are on screen.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const shown = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.turn;
          if (!key) continue;
          if (entry.isIntersecting) shown.add(key);
          else shown.delete(key);
        }
        setVisible(new Set(shown));
      },
      { root, threshold: 0 },
    );
    // Messages appear later too (a folded day opens, new turns): watch them as they mount.
    const observeAll = () => root.querySelectorAll<HTMLElement>("[data-turn]").forEach((el) => observer.observe(el));
    observeAll();
    let frame = 0;
    const mutations = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(observeAll);
    });
    mutations.observe(root, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      observer.disconnect();
    };
  }, [scrollRef, turns]);

  // Spread the ticks over most of the rail, between 2 and 8 px apart.
  const gap = turns.length > 1 ? Math.max(2, Math.min(8, (height * 0.8) / turns.length - TICK)) : 0;

  return (
    <div ref={rail} className="pointer-events-none absolute inset-y-0 left-2 z-10 flex w-8 items-center">
      <div className="pointer-events-auto flex max-h-full flex-col overflow-hidden py-2" style={{ gap }} onMouseLeave={() => setHover(null)}>
        {turns.map((turn) => {
          const lit = visible.has(turn.key);
          const hovered = hover?.turn.key === turn.key;
          return (
            <button
              key={turn.key}
              type="button"
              aria-label={`Go to: ${turn.text.slice(0, 80)}`}
              onClick={() => onJump(turn.key)}
              onMouseEnter={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                const railBox = rail.current!.getBoundingClientRect();
                setHover({ turn, top: box.top - railBox.top + box.height / 2 });
              }}
              // A taller hit area than the tick itself.
              className="group flex h-[6px] w-8 shrink-0 items-center -my-[2px]"
            >
              <span
                className={cx(
                  "h-[2px] rounded-full transition-all duration-150",
                  hovered ? "w-6 bg-zinc-100" : lit ? "w-4 bg-zinc-300" : "w-2.5 bg-zinc-700 group-hover:bg-zinc-500",
                )}
              />
            </button>
          );
        })}
      </div>
      {hover ? <Preview turn={hover.turn} top={hover.top} /> : null}
    </div>
  );
}

function Preview({ turn, top }: { turn: RailTurn; top: number }) {
  const time = turn.at ? new Date(turn.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div
      key={turn.key}
      className="animate-fade-in pointer-events-none absolute left-9 z-20 w-80 -translate-y-1/2 rounded-xl border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 shadow-2xl shadow-black/70"
      style={{ top }}
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-100">{turn.text}</span>
        {time ? <span className="shrink-0 text-[10.5px] text-zinc-600 tabular-nums">{time}</span> : null}
      </div>
      {turn.reply ? <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-zinc-500">{turn.reply}</p> : null}
    </div>
  );
}
