import { AVATAR_COLORS, AVATAR_SHAPES, type BotAvatar, randomAvatar } from "@apollo/contracts";
import { Shuffle } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cx } from "./ui.tsx";

type Shape = BotAvatar["shape"];
type Color = BotAvatar["color"];

/** Gradient stops (light top-left to deep bottom-right) per color. */
export const AVATAR_GRADIENTS: Record<Color, readonly [string, string]> = {
  coral: ["#fdba74", "#f43f5e"],
  sky: ["#7dd3fc", "#6366f1"],
  mint: ["#6ee7b7", "#0d9488"],
  grape: ["#c4b5fd", "#c026d3"],
  sun: ["#fde68a", "#f97316"],
  ocean: ["#67e8f9", "#2563eb"],
  rose: ["#fbcfe8", "#e11d48"],
  lime: ["#d9f99d", "#16a34a"],
};

const star = (() => {
  const points: Array<string> = [];
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const radius = i % 2 === 0 ? 12 : 6.4;
    points.push(`${(16 + radius * Math.cos(angle)).toFixed(2)},${(17 + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return points.join(" ");
})();

/** Each shape on a 32×32 canvas, and where its eyes sit. */
const SHAPES: Record<Shape, { body: (fill: string) => ReactNode; eyes: number }> = {
  blob: {
    eyes: 15,
    body: (fill) => <path fill={fill} d="M16 3c6.5 0 12 4.6 12.6 11.2.7 7.3-4.4 14.3-12.3 14.3S3 23.6 3.5 15.6C4 8.4 9.4 3 16 3z" />,
  },
  squircle: {
    eyes: 15,
    body: (fill) => <path fill={fill} d="M16 3.5c9 0 12.5 3.5 12.5 12.5S25 28.5 16 28.5 3.5 25 3.5 16 7 3.5 16 3.5z" />,
  },
  ghost: {
    eyes: 14,
    body: (fill) => (
      <path
        fill={fill}
        d="M5 15C5 8.4 9.9 3.5 16 3.5S27 8.4 27 15v12.2c0 1-1.1 1.5-1.9.9l-2.2-1.7-2.5 2a1.5 1.5 0 0 1-1.9 0L16 26.2l-2.5 2.2a1.5 1.5 0 0 1-1.9 0l-2.5-2-2.2 1.7c-.8.6-1.9.1-1.9-.9z"
      />
    ),
  },
  bean: {
    eyes: 15,
    body: (fill) => (
      <path
        fill={fill}
        d="M9.5 5.5c4-3.4 10.2-2.7 13.5 1.2 2.2 2.6 1.8 5.3 3.5 8.3 2.3 4.1.6 9.9-4.3 12.4-5.7 2.9-13.4 1.2-16.6-4.7-2.9-5.4-.6-13.2 3.9-17.2z"
      />
    ),
  },
  flower: {
    eyes: 16,
    body: (fill) => (
      <g fill={fill}>
        <circle cx="16" cy="8.5" r="6.5" />
        <circle cx="23.5" cy="16" r="6.5" />
        <circle cx="16" cy="23.5" r="6.5" />
        <circle cx="8.5" cy="16" r="6.5" />
        <circle cx="16" cy="16" r="8" />
      </g>
    ),
  },
  cloud: {
    eyes: 18,
    body: (fill) => (
      <g fill={fill}>
        <circle cx="11" cy="16.5" r="6.5" />
        <circle cx="19" cy="12.5" r="8" />
        <rect x="3.5" y="15" width="25" height="12" rx="6" />
      </g>
    ),
  },
  star: {
    eyes: 17,
    body: (fill) => <polygon points={star} fill={fill} stroke={fill} strokeWidth="4.5" strokeLinejoin="round" />,
  },
  drop: {
    eyes: 19,
    body: (fill) => <path fill={fill} d="M16 3.5c3.5 4.5 11 10 11 16.2C27 25.5 22 29 16 29S5 25.5 5 19.7C5 13.5 12.5 8 16 3.5z" />,
  },
};

const SIZES = { xs: 16, sm: 20, md: 24, lg: 36, xl: 56 } as const;

/** A bot's blob avatar: a soft shape in a gradient, with two little eyes. */
export function BlobAvatar({
  avatar,
  size = "md",
  className,
}: {
  avatar: BotAvatar;
  size?: keyof typeof SIZES | number;
  className?: string;
}) {
  const id = useId();
  const px = typeof size === "number" ? size : SIZES[size];
  const [from, to] = AVATAR_GRADIENTS[avatar.color];
  const shape = SHAPES[avatar.shape];
  const fill = `url(#${CSS.escape(id)}g)`;
  return (
    <svg width={px} height={px} viewBox="0 0 32 32" aria-hidden className={cx("shrink-0 drop-shadow-sm", className)}>
      <defs>
        <linearGradient id={`${id}g`} x1="4" y1="3" x2="28" y2="29" gradientUnits="userSpaceOnUse">
          <stop stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
      </defs>
      {shape.body(fill)}
      {/* soft highlight */}
      <ellipse cx="11" cy={shape.eyes - 5.5} rx="3.2" ry="1.6" fill="#fff" opacity=".28" transform={`rotate(-20 11 ${shape.eyes - 5.5})`} />
      <ellipse cx="12.6" cy={shape.eyes} rx="1.5" ry="2.1" fill="#18181b" opacity=".85" />
      <ellipse cx="19.4" cy={shape.eyes} rx="1.5" ry="2.1" fill="#18181b" opacity=".85" />
      <circle cx="13.1" cy={shape.eyes - 0.8} r=".5" fill="#fff" opacity=".9" />
      <circle cx="19.9" cy={shape.eyes - 0.8} r=".5" fill="#fff" opacity=".9" />
    </svg>
  );
}

/** The avatar as a button; clicking opens a picker of shapes and colors. */
export function AvatarPicker({ value, onChange }: { value: BotAvatar; onChange: (avatar: BotAvatar) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const option = "flex items-center justify-center rounded-lg transition-colors hover:bg-zinc-800";
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        title="Change avatar"
        aria-label="Change avatar"
        onClick={() => setOpen(!open)}
        className={cx(
          "group relative flex rounded-xl p-0.5 transition-transform hover:scale-105 active:scale-95",
          open && "bg-zinc-800",
        )}
      >
        <BlobAvatar avatar={value} size="lg" className="transition-transform group-hover:rotate-[-6deg]" />
      </button>
      {open ? (
        <div className="animate-pop-in absolute top-full left-0 z-20 mt-2 w-64 space-y-3 rounded-xl border border-zinc-800 bg-zinc-950 p-3 shadow-2xl shadow-black/60">
          <div>
            <div className="mb-1.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">Shape</div>
            <div className="grid grid-cols-4 gap-1">
              {AVATAR_SHAPES.map((shape) => (
                <button
                  key={shape}
                  type="button"
                  title={shape}
                  onClick={() => onChange({ ...value, shape })}
                  className={cx(option, "h-12", value.shape === shape && "bg-zinc-800 ring-1 ring-zinc-600")}
                >
                  <BlobAvatar avatar={{ ...value, shape }} size={32} />
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">Color</div>
            <div className="grid grid-cols-8 gap-1">
              {AVATAR_COLORS.map((color) => {
                const [from, to] = AVATAR_GRADIENTS[color];
                return (
                  <button
                    key={color}
                    type="button"
                    title={color}
                    onClick={() => onChange({ ...value, color })}
                    className={cx(
                      "size-6 rounded-full transition-transform hover:scale-110",
                      value.color === color && "ring-2 ring-zinc-200 ring-offset-2 ring-offset-zinc-950",
                    )}
                    style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
                  />
                );
              })}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onChange(randomAvatar())}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-800 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-900"
          >
            <Shuffle className="size-3.5" /> Surprise me
          </button>
        </div>
      ) : null}
    </div>
  );
}
