import type { ArtifactKind, ArtifactRef } from "@apollo/contracts";
import { Download, ExternalLink, File, FileCode2, FileText, Image, LayoutTemplate, Loader2, Maximize2, Minimize2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { TranscriptItem } from "../transcript.ts";
import { CodeBlock, MarkdownText } from "./Code.tsx";
import { cx, IconButton } from "./ui.tsx";
import { openHtmlWindow, useSandboxedPage } from "./VisualItem.tsx";

type Item = Extract<TranscriptItem, { kind: "visual" }>;

export const artifactUrl = (a: ArtifactRef, download = false) =>
  `/api/artifacts/${a.botId}/${a.artifactId}/${a.version}${download ? "?download=1" : ""}`;

const ICONS: Record<ArtifactKind, typeof File> = {
  html: LayoutTemplate,
  markdown: FileText,
  code: FileCode2,
  text: FileText,
  image: Image,
  file: File,
};

const MAX_TEXT = 400 * 1024;
const LONG_TEXT = 4000;

/** The server's fallback HTML is the page itself for HTML artifacts up to this size. */
const FALLBACK_IS_PAGE = 512 * 1024;

const size = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function useArtifactText(a: ArtifactRef, enabled: boolean) {
  const [state, setState] = useState<{ text: string | null; error: string | null }>({ text: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch(artifactUrl(a), { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "This artifact is no longer on disk." : `Could not load it (${res.status}).`);
        const text = await res.text();
        if (!cancelled) setState({ text, error: null });
      })
      .catch((error: Error) => {
        if (!cancelled) setState({ text: null, error: error.message });
      });
    return () => {
      cancelled = true;
    };
  }, [a.botId, a.artifactId, a.version, enabled]);
  return state;
}

/** A file a bot saved with apollo_artifact_save, shown by kind, with open and download. */
export function ArtifactItem({ item, artifact: a }: { item: Item; artifact: ArtifactRef }) {
  const pageInline = a.kind === "html" && a.size <= FALLBACK_IS_PAGE;
  const textual = a.kind === "markdown" || a.kind === "code" || a.kind === "text" || (a.kind === "html" && !pageInline);
  const { text, error } = useArtifactText(a, textual);

  if (error) return <Frame artifact={a} body={<p className="px-3 py-2.5 text-xs text-zinc-500">{error}</p>} />;
  if (a.kind === "html") {
    const html = pageInline ? item.html : text;
    return html === null ? <Frame artifact={a} body={<Loading />} /> : <PageArtifact artifact={a} html={html} id={item.key} />;
  }
  if (a.kind === "image")
    return (
      <Frame
        artifact={a}
        onOpen={() => window.open(artifactUrl(a), "_blank", "noopener")}
        body={<img src={artifactUrl(a)} alt={a.title} className="mx-auto block max-h-[720px] max-w-full object-contain p-2" loading="lazy" />}
      />
    );
  if (a.kind === "file")
    return (
      <Frame
        artifact={a}
        body={
          <a href={artifactUrl(a, true)} className="flex items-center gap-2 px-3 py-2.5 text-xs text-zinc-400 hover:text-zinc-200">
            <Download className="size-3.5" /> Download {a.name} ({size(a.size)})
          </a>
        }
      />
    );
  return text === null ? <Frame artifact={a} body={<Loading />} /> : <TextArtifact artifact={a} text={text} />;
}

function PageArtifact({ artifact: a, html, id }: { artifact: ArtifactRef; html: string; id: string }) {
  const { toggle, page } = useSandboxedPage(html, id, null);
  return <Frame artifact={a} toggle={toggle} onOpen={() => openHtmlWindow(html, a.title || a.name)} body={page(a.title || a.name)} />;
}

function TextArtifact({ artifact: a, text }: { artifact: ArtifactRef; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const shown = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  const toggle =
    text.length > LONG_TEXT || text.split("\n").length > 26 ? (
      <IconButton icon={expanded ? Minimize2 : Maximize2} label={expanded ? "Collapse" : "Show all"} size="sm" onClick={() => setExpanded(!expanded)} />
    ) : null;
  return (
    <Frame
      artifact={a}
      toggle={toggle}
      onOpen={() => window.open(artifactUrl(a), "_blank", "noopener")}
      body={
        <div className={cx("overflow-auto", !expanded && "max-h-[520px]")}>
          {a.kind === "markdown" ? (
            <div className="px-4 py-3">
              <MarkdownText>{shown}</MarkdownText>
            </div>
          ) : (
            <CodeBlock code={shown} lang={a.kind === "code" ? (a.language ?? null) : null} />
          )}
          {shown.length < text.length ? (
            <p className="px-3 pb-2.5 text-xs text-zinc-500">Only the first {size(MAX_TEXT)} are shown; download it for the rest.</p>
          ) : null}
        </div>
      }
    />
  );
}

function Frame({ artifact: a, body, toggle, onOpen }: { artifact: ArtifactRef; body: ReactNode; toggle?: ReactNode; onOpen?: () => void }) {
  const Icon = ICONS[a.kind];
  const title = a.title || a.name;
  return (
    <figure className="animate-fade-up overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950">
      <figcaption className="flex h-9 items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/40 pr-1.5 pl-3 text-xs">
        <Icon className="size-3.5 shrink-0 text-teal-300" strokeWidth={1.75} />
        <span className="min-w-0 truncate font-medium text-zinc-300">{title}</span>
        <span className="min-w-0 flex-1 truncate text-zinc-500" title={`${a.name} · version ${a.version}`}>
          {a.name !== title ? `${a.name} · ` : ""}v{a.version}
        </span>
        {toggle}
        {onOpen ? <IconButton icon={ExternalLink} label="Open in a new window" size="sm" onClick={onOpen} /> : null}
        <a
          href={artifactUrl(a, true)}
          title="Download"
          aria-label="Download"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800/70 hover:text-zinc-100"
        >
          <Download className="size-3.5" />
        </a>
      </figcaption>
      {body}
    </figure>
  );
}

function Loading() {
  return (
    <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-zinc-500">
      <Loader2 className="size-3.5 animate-spin" /> Loading…
    </div>
  );
}
