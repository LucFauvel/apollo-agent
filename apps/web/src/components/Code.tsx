import { codePlainColor, highlightCode } from "@apollo/client";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** A fenced code block, highlighted, with its language and a copy button. */
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
};

/** Markdown as Apollo shows it in conversations: GitHub-flavored, with highlighted code. */
export function MarkdownText({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </Markdown>
  );
}
