import Svg, { Circle, Line, Path, Rect } from "react-native-svg";

/** Line icons (Lucide shapes, as the desktop app uses) for the phone app. */
type Shape =
  | ["path", { d: string }]
  | ["circle", { cx: string; cy: string; r: string; fill?: string }]
  | ["rect", { x?: string; y?: string; width: string; height: string; rx?: string; ry?: string }]
  | ["line", { x1: string; y1: string; x2: string; y2: string }];

export type IconProps = { size?: number; color: string; strokeWidth?: number };
export type Icon = (props: IconProps) => React.JSX.Element;

const shapes =
  (nodes: ReadonlyArray<Shape>): Icon =>
  ({ size = 20, color, strokeWidth = 2 }) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {nodes.map(([tag, a], i) =>
        tag === "path" ? (
          <Path key={i} d={a.d} />
        ) : tag === "circle" ? (
          <Circle key={i} cx={a.cx} cy={a.cy} r={a.r} fill={a.fill === "currentColor" ? color : "none"} />
        ) : tag === "rect" ? (
          <Rect key={i} x={a.x ?? 0} y={a.y ?? 0} width={a.width} height={a.height} rx={a.rx} ry={a.ry} />
        ) : (
          <Line key={i} x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} />
        ),
      )}
    </Svg>
  );

/** Paths and lines, for the hand-written icons below. */
const icon = (paths: Array<string>, lines: Array<[number, number, number, number]> = []): Icon =>
  shapes([
    ...paths.map((d): Shape => ["path", { d }]),
    ...lines.map(([x1, y1, x2, y2]): Shape => ["line", { x1: `${x1}`, y1: `${y1}`, x2: `${x2}`, y2: `${y2}` }]),
  ]);

export const MicIcon = icon(["M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z", "M19 10v2a7 7 0 0 1-14 0v-2"], [[12, 19, 12, 22]]);
export const WaveIcon = icon(["M2 10v3", "M6 6v11", "M10 3v18", "M14 8v7", "M18 5v13", "M22 10v3"]);
export const SpeakerIcon = icon([
  "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z",
  "M16 9a5 5 0 0 1 0 6",
  "M19.364 18.364a9 9 0 0 0 0-12.728",
]);
export const GearIcon = icon([
  "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
  "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
]);
export const ArchiveIcon = icon(["M3 4h18v4H3z", "M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8", "M10 12h4"]);


// Generated from lucide-react's icon data (same version as the desktop app).
export const LightbulbIcon = shapes([["path",{"d":"M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"}],["path",{"d":"M9 18h6"}],["path",{"d":"M10 22h4"}]]);
export const SquareTerminalIcon = shapes([["path",{"d":"m7 11 2-2-2-2"}],["path",{"d":"M11 13h4"}],["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2","ry":"2"}]]);
export const FileTextIcon = shapes([["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M10 9H8"}],["path",{"d":"M16 13H8"}],["path",{"d":"M16 17H8"}]]);
export const FilePenIcon = shapes([["path",{"d":"M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z"}]]);
export const SearchIcon = shapes([["path",{"d":"m21 21-4.34-4.34"}],["circle",{"cx":"11","cy":"11","r":"8"}]]);
export const GlobeIcon = shapes([["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"}],["path",{"d":"M2 12h20"}]]);
export const AppWindowIcon = shapes([["rect",{"x":"2","y":"4","width":"20","height":"16","rx":"2"}],["path",{"d":"M10 4v4"}],["path",{"d":"M2 8h20"}],["path",{"d":"M6 4v4"}]]);
export const LayoutTemplateIcon = shapes([["rect",{"width":"18","height":"7","x":"3","y":"3","rx":"1"}],["rect",{"width":"9","height":"7","x":"3","y":"14","rx":"1"}],["rect",{"width":"5","height":"7","x":"16","y":"14","rx":"1"}]]);
export const KeyRoundIcon = shapes([["path",{"d":"M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"}],["circle",{"cx":"16.5","cy":"7.5","r":".5","fill":"currentColor"}]]);
export const NetworkIcon = shapes([["rect",{"x":"16","y":"16","width":"6","height":"6","rx":"1"}],["rect",{"x":"2","y":"16","width":"6","height":"6","rx":"1"}],["rect",{"x":"9","y":"2","width":"6","height":"6","rx":"1"}],["path",{"d":"M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"}],["path",{"d":"M12 12V8"}]]);
export const GitBranchIcon = shapes([["path",{"d":"M15 6a9 9 0 0 0-9 9V3"}],["circle",{"cx":"18","cy":"6","r":"3"}],["circle",{"cx":"6","cy":"18","r":"3"}]]);
export const PlugIcon = shapes([["path",{"d":"M12 22v-5"}],["path",{"d":"M15 8V2"}],["path",{"d":"M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z"}],["path",{"d":"M9 8V2"}]]);
export const WrenchIcon = shapes([["path",{"d":"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"}]]);
export const ChevronRightIcon = shapes([["path",{"d":"m9 18 6-6-6-6"}]]);
export const ChevronDownIcon = shapes([["path",{"d":"m6 9 6 6 6-6"}]]);
export const XIcon = shapes([["path",{"d":"M18 6 6 18"}],["path",{"d":"m6 6 12 12"}]]);
export const InfoIcon = shapes([["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 16v-4"}],["path",{"d":"M12 8h.01"}]]);
export const CircleAlertIcon = shapes([["circle",{"cx":"12","cy":"12","r":"10"}],["line",{"x1":"12","x2":"12","y1":"8","y2":"12"}],["line",{"x1":"12","x2":"12.01","y1":"16","y2":"16"}]]);
export const ShieldAlertIcon = shapes([["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"M12 8v4"}],["path",{"d":"M12 16h.01"}]]);
export const CheckIcon = shapes([["path",{"d":"M20 6 9 17l-5-5"}]]);
export const BanIcon = shapes([["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M4.929 4.929 19.07 19.071"}]]);
export const LoaderIcon = shapes([["path",{"d":"M21 12a9 9 0 1 1-6.219-8.56"}]]);
export const ClipboardListIcon = shapes([["rect",{"width":"8","height":"4","x":"8","y":"2","rx":"1","ry":"1"}],["path",{"d":"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"}],["path",{"d":"M12 11h4"}],["path",{"d":"M12 16h4"}],["path",{"d":"M8 11h.01"}],["path",{"d":"M8 16h.01"}]]);
export const ShieldCheckIcon = shapes([["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"m9 12 2 2 4-4"}]]);
export const LockIcon = shapes([["rect",{"width":"18","height":"11","x":"3","y":"11","rx":"2","ry":"2"}],["path",{"d":"M7 11V7a5 5 0 0 1 10 0v4"}]]);
export const SquareIcon = shapes([["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}]]);
export const ArrowUpIcon = shapes([["path",{"d":"m5 12 7-7 7 7"}],["path",{"d":"M12 19V5"}]]);
export const BotIcon = shapes([["path",{"d":"M12 8V4H8"}],["rect",{"width":"16","height":"12","x":"4","y":"8","rx":"2"}],["path",{"d":"M2 14h2"}],["path",{"d":"M20 14h2"}],["path",{"d":"M15 13v2"}],["path",{"d":"M9 13v2"}]]);
