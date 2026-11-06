import { ExternalLink, LayoutTemplate, Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptItem } from "../transcript.ts";
import { cx, IconButton } from "./ui.tsx";

const MAX_HEIGHT = 900;

/**
 * Agent-written pages run in an opaque-origin sandbox (scripts, no same-origin),
 * so they cannot reach Apollo's cookies, storage or RPC. A small script reports
 * the content height so the frame fits it; dark defaults apply with zero
 * specificity, so the page's own styles win.
 */
const prepare = (html: string, id: string) => {
  const base = `<style>:where(html){color-scheme:dark;color:#e4e4e7;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}:where(body){margin:0;padding:12px}</style>`;
  const sizer = `<script>(()=>{const post=()=>parent.postMessage({apolloVisual:${JSON.stringify(id)},height:(()=>{const b=document.body;if(!b)return 0;const s=getComputedStyle(b);return Math.ceil(b.scrollHeight+parseFloat(s.marginTop)+parseFloat(s.marginBottom))})()},"*");new ResizeObserver(post).observe(document.body||document.documentElement);addEventListener("load",post);post();})()</script>`;
  const withBase = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => m + base)
    : /<html[^>]*>/i.test(html)
      ? html.replace(/<html[^>]*>/i, (m) => `${m}<head>${base}</head>`)
      : /^\s*<!doctype/i.test(html)
        ? html.replace(/^\s*<!doctype[^>]*>/i, (m) => m + base)
        : base + html;
  return withBase + sizer;
};

export function VisualItem({ item }: { item: Extract<TranscriptItem, { kind: "visual" }> }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(item.height ?? 240);
  const [expanded, setExpanded] = useState(false);
  const srcDoc = useMemo(() => prepare(item.html, item.key), [item.html, item.key]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.data?.apolloVisual !== item.key) return;
      const next = Number(e.data.height);
      if (Number.isFinite(next) && next > 0) setHeight(Math.max(next, 60));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [item.key]);

  const shown = expanded ? height : Math.min(height, MAX_HEIGHT);
  const openWindow = () => {
    // A blob URL has Apollo's origin, so the page itself must not run there:
    // the window holds a script-free wrapper, and the page stays in a sandboxed frame.
    const escaped = item.html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const wrapper = `<!doctype html><meta charset="utf-8"><title>${(item.title || "Visual").replace(/</g, "&lt;")}</title><style>html,body{margin:0;height:100%;background:#09090b}iframe{border:0;width:100%;height:100%}</style><iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" srcdoc="${escaped}"></iframe>`;
    const url = URL.createObjectURL(new Blob([wrapper], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <figure className="animate-fade-up overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950">
      <figcaption className="flex h-9 items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/40 pr-1.5 pl-3 text-xs">
        <LayoutTemplate className="size-3.5 shrink-0 text-teal-300" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate font-medium text-zinc-300">{item.title || "Visual"}</span>
        {height > MAX_HEIGHT ? (
          <IconButton icon={expanded ? Minimize2 : Maximize2} label={expanded ? "Collapse" : "Show all"} size="sm" onClick={() => setExpanded(!expanded)} />
        ) : null}
        <IconButton icon={ExternalLink} label="Open in a new window" size="sm" onClick={openWindow} />
      </figcaption>
      <iframe
        ref={frame}
        title={item.title || "Visual"}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcDoc}
        style={{ height: shown }}
        className={cx("block w-full border-0 bg-transparent transition-[height] duration-300 ease-out")}
      />
    </figure>
  );
}
