import type { BotAvatar } from "@apollo/contracts";
import { type ReactNode, useId } from "react";
import Svg, { Circle, Defs, Ellipse, G, LinearGradient, Path, Polygon, Rect, Stop } from "react-native-svg";

type Shape = BotAvatar["shape"];
type Color = BotAvatar["color"];

/** Gradient stops (light top-left to deep bottom-right) per color. Same as the desktop app. */
const GRADIENTS: Record<Color, readonly [string, string]> = {
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
    body: (fill) => <Path fill={fill} d="M16 3c6.5 0 12 4.6 12.6 11.2.7 7.3-4.4 14.3-12.3 14.3S3 23.6 3.5 15.6C4 8.4 9.4 3 16 3z" />,
  },
  squircle: {
    eyes: 15,
    body: (fill) => <Path fill={fill} d="M16 3.5c9 0 12.5 3.5 12.5 12.5S25 28.5 16 28.5 3.5 25 3.5 16 7 3.5 16 3.5z" />,
  },
  ghost: {
    eyes: 14,
    body: (fill) => (
      <Path
        fill={fill}
        d="M5 15C5 8.4 9.9 3.5 16 3.5S27 8.4 27 15v12.2c0 1-1.1 1.5-1.9.9l-2.2-1.7-2.5 2a1.5 1.5 0 0 1-1.9 0L16 26.2l-2.5 2.2a1.5 1.5 0 0 1-1.9 0l-2.5-2-2.2 1.7c-.8.6-1.9.1-1.9-.9z"
      />
    ),
  },
  bean: {
    eyes: 15,
    body: (fill) => (
      <Path
        fill={fill}
        d="M9.5 5.5c4-3.4 10.2-2.7 13.5 1.2 2.2 2.6 1.8 5.3 3.5 8.3 2.3 4.1.6 9.9-4.3 12.4-5.7 2.9-13.4 1.2-16.6-4.7-2.9-5.4-.6-13.2 3.9-17.2z"
      />
    ),
  },
  flower: {
    eyes: 16,
    body: (fill) => (
      <G fill={fill}>
        <Circle cx="16" cy="8.5" r="6.5" />
        <Circle cx="23.5" cy="16" r="6.5" />
        <Circle cx="16" cy="23.5" r="6.5" />
        <Circle cx="8.5" cy="16" r="6.5" />
        <Circle cx="16" cy="16" r="8" />
      </G>
    ),
  },
  cloud: {
    eyes: 18,
    body: (fill) => (
      <G fill={fill}>
        <Circle cx="11" cy="16.5" r="6.5" />
        <Circle cx="19" cy="12.5" r="8" />
        <Rect x="3.5" y="15" width="25" height="12" rx="6" />
      </G>
    ),
  },
  star: {
    eyes: 17,
    body: (fill) => <Polygon points={star} fill={fill} stroke={fill} strokeWidth="4.5" strokeLinejoin="round" />,
  },
  drop: {
    eyes: 19,
    body: (fill) => <Path fill={fill} d="M16 3.5c3.5 4.5 11 10 11 16.2C27 25.5 22 29 16 29S5 25.5 5 19.7C5 13.5 12.5 8 16 3.5z" />,
  },
};

/** A bot's blob avatar: a soft shape in a gradient, with two little eyes. */
export function BlobAvatar({ avatar, size = 40 }: { avatar: BotAvatar; size?: number }) {
  const id = `g${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [from, to] = GRADIENTS[avatar.color] ?? GRADIENTS.sky;
  const shape = SHAPES[avatar.shape] ?? SHAPES.blob;
  const eyes = shape.eyes;
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Defs>
        <LinearGradient id={id} x1="4" y1="3" x2="28" y2="29" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={from} />
          <Stop offset="1" stopColor={to} />
        </LinearGradient>
      </Defs>
      {shape.body(`url(#${id})`)}
      <Ellipse cx="11" cy={eyes - 5.5} rx="3.2" ry="1.6" fill="#fff" opacity={0.28} rotation={-20} origin={`11, ${eyes - 5.5}`} />
      <Ellipse cx="12.6" cy={eyes} rx="1.5" ry="2.1" fill="#18181b" opacity={0.85} />
      <Ellipse cx="19.4" cy={eyes} rx="1.5" ry="2.1" fill="#18181b" opacity={0.85} />
      <Circle cx="13.1" cy={eyes - 0.8} r="0.5" fill="#fff" opacity={0.9} />
      <Circle cx="19.9" cy={eyes - 0.8} r="0.5" fill="#fff" opacity={0.9} />
    </Svg>
  );
}
