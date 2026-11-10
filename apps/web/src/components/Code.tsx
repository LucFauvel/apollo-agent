import { codePlainColor, fileLinkFromCode, fileLinkFromHref, highlightCode, splitFileLinks } from "@apollo/client";
import { Check, Copy } from "lucide-react";
import { isValidElement, type ReactNode, useMemo, useState } from "react";
import Markdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileLink } from "./FileLink.tsx";

/** A fenced code block, highlighted, with its language and a copy button. */
/** The text a highlighted code block shows: its lines' spans, a newline between lines. */
const codeText = (lines: ReturnType<typeof highlightCode>) => lines.map((line) => line.map((span) => span.text).join("")).join("\n");

export function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const lines = useMemo(() => highlightCode(code, lang), [code, lang]);
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block group/code relative">
      {/* Chrome, not content: conversation search skips it. */}
      <div className="flex items-center justify-between px-3 pt-1.5 text-[10.5px] text-zinc-500" data-search-skip="">
        <span className="font-mono">{lang ?? ""}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code.replace(/\n$/, ""));
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="flex items-center gap-1 rounded px-1 py-0.5 opacity-0 transition-opacity group-hover/code:opacity-100 hover:text-zinc-300"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre style={{ color: codePlainColor }}>
        <code>
          {lines.map((line, i) => (
            <span key={i}>
              {line.map((span, j) =>
                span.color || span.fontStyle || span.fontWeight ? (
                  <span key={j} style={{ color: span.color, fontStyle: span.fontStyle, fontWeight: span.fontWeight }}>
                    {span.text}
                  </span>
                ) : (
                  span.text
                ),
              )}
              {i < lines.length - 1 ? "\n" : null}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

const components: Components = {
  // Blocks render through CodeBlock (below); this unwraps react-markdown's own <pre>.
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? "");
    const lang = /language-([\w+#.-]+)/.exec(className ?? "")?.[1] ?? null;
    // Inline code: no language and a single line.
    if (!lang && !text.includes("\n")) return <code>{children as ReactNode}</code>;
    return <CodeBlock code={text} lang={lang} />;
  },
  // Links (written or autolinked bare URLs) open in the user's browser, never in place of the
  // app: a new tab on the web, the system browser on desktop (its window-open handler).
  // Only in-page anchors (footnotes) stay in place.
  // Local files (linked, or paths in text and code spans) open through FileLink.
  a: ({ node: _node, href, children, ...props }) => {
    const file = href ? fileLinkFromHref(href) : null;
    if (file) return <FileLink file={file}>{children}</FileLink>;
    return href?.startsWith("#") ? (
      <a {...props} href={href}>
        {children}
      </a>
    ) : (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: Array<MdNode>;
}

const NO_LINKS = new Set(["link", "linkReference", "definition", "code", "html", "image", "imageReference"]);

/** Turns paths in text and inline code into links, for the `a` component to open as files. */
const linkPaths = (node: MdNode) => {
  if (!node.children) return;
  const out: Array<MdNode> = [];
  for (const child of node.children) {
    if (NO_LINKS.has(child.type)) out.push(child);
    else if (child.type === "inlineCode" && child.value && fileLinkFromCode(child.value)) out.push({ type: "link", url: child.value.trim(), children: [child] });
    else if (child.type === "text" && child.value) {
      for (const part of splitFileLinks(child.value)) {
        out.push(typeof part === "string" ? { type: "text", value: part } : { type: "link", url: part.text, children: [{ type: "text", value: part.text }] });
      }
    } else {
      linkPaths(child);
      out.push(child);
    }
  }
  node.children = out;
};

const remarkFileLinks = () => (tree: MdNode) => linkPaths(tree);

/** Keeps file links (`file:` URLs and Windows paths look like unsafe schemes to the default). */
const urlTransform = (url: string) => (fileLinkFromHref(url) ? url : defaultUrlTransform(url));

const remarkPlugins = [remarkGfm, remarkFileLinks];

/** Markdown as Apollo shows it in conversations: GitHub-flavored, with highlighted code. */
export function MarkdownText({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={remarkPlugins} components={components} urlTransform={urlTransform}>
      {children}
    </Markdown>
  );
}

// The components above use no hooks, so they can be called to see what they render.
const plainComponents = new Set<unknown>(Object.values(components));

/**
 * The text `MarkdownText` puts on the page (its text nodes, in order, joined), without what
 * conversation search skips (a code block's language and copy button). Computed from the
 * very element tree React renders, so search counts exactly what is shown: no link targets,
 * image alt text or markdown syntax, entities decoded, code kept literally.
 */
export const markdownShownText = (markdown: string): string => {
  const out: Array<string> = [];
  const walk = (node: ReactNode): void => {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") {
      out.push(String(node));
      return;
    }
    if (typeof node === "object" && Symbol.iterator in node) {
      for (const child of node as Iterable<ReactNode>) walk(child);
      return;
    }
    if (!isValidElement(node)) return;
    const props = node.props as { children?: ReactNode; code?: string; lang?: string | null };
    if (node.type === CodeBlock) out.push(codeText(highlightCode(props.code ?? "", props.lang ?? null)));
    else if (plainComponents.has(node.type)) walk((node.type as (props: unknown) => ReactNode)(props));
    else walk(props.children);
  };
  walk(Markdown({ children: markdown, remarkPlugins, components, urlTransform }));
  return out.join("");
};
