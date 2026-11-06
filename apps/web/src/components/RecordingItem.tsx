import { Pause, Play, RotateCcw, Video } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptItem } from "../transcript.ts";
import { cx, IconButton } from "./ui.tsx";

type Item = Extract<TranscriptItem, { kind: "recording" }>;

const frameUrl = (id: string, n: number) => `/api/recordings/${id}/${String(n).padStart(4, "0")}.jpg`;

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A browser recording an agent made: frames played back at their real pace, with a scrubber. */
export function RecordingItem({ item }: { item: Item }) {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const step = item.frames > 1 ? item.durationMs / item.frames : 250;
  const last = Math.max(item.frames - 1, 0);
  const preloaded = useRef<Array<HTMLImageElement>>([]);

  // Load every frame once, so playback does not stutter.
  useEffect(() => {
    let left = item.frames;
    preloaded.current = Array.from({ length: item.frames }, (_, i) => {
      const img = new Image();
      img.onload = img.onerror = () => {
        if (--left === 0) setLoaded(true);
      };
      img.src = frameUrl(item.recordingId, i);
      return img;
    });
  }, [item.recordingId, item.frames]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setFrame((f) => {
        if (f >= last) {
          setPlaying(false);
          return f;
        }
        return f + 1;
      });
    }, step);
    return () => clearInterval(timer);
  }, [playing, step, last]);

  const toggle = () => {
    if (frame >= last) setFrame(0);
    setPlaying(!playing);
  };
  const aspect = useMemo(() => (item.width && item.height ? `${item.width} / ${item.height}` : "16 / 10"), [item.width, item.height]);
  const portrait = item.height > item.width;

  return (
    <figure className="animate-fade-up overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950">
      <figcaption className="flex h-9 items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/40 pr-1.5 pl-3 text-xs">
        <Video className="size-3.5 shrink-0 text-orange-300" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate font-medium text-zinc-300">{item.title}</span>
        <span className="shrink-0 text-[11px] text-zinc-500 tabular-nums">{clock(item.durationMs)}</span>
      </figcaption>
      <button
        type="button"
        onClick={toggle}
        className={cx("relative block w-full bg-black", portrait ? "mx-auto max-w-xs" : "")}
        style={{ aspectRatio: aspect }}
        aria-label={playing ? "Pause" : "Play"}
      >
        <img src={frameUrl(item.recordingId, frame)} alt="" className="absolute inset-0 size-full object-contain" draggable={false} />
        {!playing ? (
          <span className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-90 transition-opacity hover:opacity-100">
            <span className="flex size-12 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur">
              {frame >= last && frame > 0 ? <RotateCcw className="size-5" /> : <Play className="ml-0.5 size-5" />}
            </span>
          </span>
        ) : null}
      </button>
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <IconButton icon={playing ? Pause : Play} label={playing ? "Pause" : "Play"} size="sm" onClick={toggle} disabled={!loaded && !playing} />
        <input
          type="range"
          min={0}
          max={last}
          value={frame}
          onChange={(e) => {
            setPlaying(false);
            setFrame(Number(e.target.value));
          }}
          className="h-1 min-w-0 flex-1 cursor-pointer accent-orange-400"
          aria-label="Position"
        />
        <span className="w-20 shrink-0 text-right text-[11px] text-zinc-500 tabular-nums">
          {clock(frame * step)} / {clock(item.durationMs)}
        </span>
      </div>
    </figure>
  );
}
