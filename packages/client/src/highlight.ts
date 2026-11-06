import "./prismGlobal.ts";
// Languages agents use a lot that prism-react-renderer's bundle leaves out.
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-diff.js";
import "prismjs/components/prism-docker.js";
import "prismjs/components/prism-toml.js";
import { normalizeTokens, Prism, type PrismThemeEntry, themes } from "prism-react-renderer";

/**
 * Syntax highlighting for code in conversations, shared by the desktop and phone apps:
 * code in, lines of colored spans out (each app renders them its own way).
 */

export interface CodeSpan {
  readonly text: string;
  readonly color?: string;
  readonly fontStyle?: "italic" | "normal";
  readonly fontWeight?: "bold" | "normal";
}

const ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  shellsession: "bash",
  py: "python",
  yml: "yaml",
  rs: "rust",
  md: "markdown",
  html: "markup",
  xml: "markup",
  svg: "markup",
  jsonc: "json",
  json5: "json",
  dockerfile: "docker",
  "c++": "cpp",
  objc: "objectivec",
  kt: "kotlin",
  golang: "go",
  patch: "diff",
};

/** The Prism grammar name for a fence's language tag, or null when unknown. */
export const codeLanguage = (tag: string | null | undefined): string | null => {
  const name = (tag ?? "").trim().toLowerCase().split(/[\s{]/)[0] ?? "";
  if (!name) return null;
  const resolved = ALIASES[name] ?? name;
  return Prism.languages[resolved] ? resolved : null;
};

/** One Dark, which sits well on Apollo's near-black backgrounds. */
const theme = themes.oneDark;
export const codePlainColor = theme.plain.color ?? "#d4d4d8";
const byType = new Map<string, PrismThemeEntry>();
for (const entry of theme.styles) for (const type of entry.types) byType.set(type, { ...byType.get(type), ...entry.style });

const styleOf = (types: ReadonlyArray<string>): Omit<CodeSpan, "text"> => {
  let style: PrismThemeEntry = {};
  for (const type of types) style = { ...style, ...byType.get(type) };
  return {
    ...(style.color ? { color: style.color } : {}),
    ...(style.fontStyle === "italic" ? { fontStyle: "italic" as const } : {}),
    ...(style.fontWeight === "bold" ? { fontWeight: "bold" as const } : {}),
  };
};

/** Very long blocks are shown plain: tokenizing them on every streamed update is slow. */
const MAX_HIGHLIGHT = 20_000;

/** The code as lines of spans; plain spans when the language is unknown. */
export const highlightCode = (code: string, tag: string | null | undefined): ReadonlyArray<ReadonlyArray<CodeSpan>> => {
  const source = code.replace(/\n$/, "");
  const language = codeLanguage(tag);
  if (!language || source.length > MAX_HIGHLIGHT) return source.split("\n").map((line) => [{ text: line }]);
  const lines = normalizeTokens(Prism.tokenize(source, Prism.languages[language]!));
  return lines.map((line) => {
    const spans = line.filter((t) => !t.empty).map((t) => ({ text: t.content, ...styleOf(t.types) }));
    return spans.length > 0 ? spans : [{ text: "" }];
  });
};
