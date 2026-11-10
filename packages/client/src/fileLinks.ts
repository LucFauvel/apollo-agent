/**
 * A local file a message points to, as written: absolute, under `~/`, or relative to the
 * session's working directory. The server decides whether it may be opened (see the
 * `/api/files` routes); this only recognizes what looks like a path.
 */
export interface FileReference {
  readonly path: string;
  /** From a `:12`, `:12:3` or `#L12` suffix. */
  readonly line: number | null;
}

const LINE_SUFFIX = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const UNSAFE = /[\s"'<>`|*?{}$\\[\]]/;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
/**
 * First folders of the absolute paths agents mention. Other absolute-looking text in prose
 * or code spans (`/api/auth/session`, `/rpc`) is usually a route, not a file.
 */
const ROOTS = new Set(["Users", "home", "tmp", "private", "var", "opt", "Volumes", "mnt", "srv", "etc", "usr", "Applications", "Library", "root", "workspace", "workspaces"]);

const splitLine = (raw: string): FileReference => {
  const m = LINE_SUFFIX.exec(raw);
  if (!m || m.index === 0) return { path: raw, line: null };
  return { path: raw.slice(0, m.index), line: Number(m[1] ?? m[2]) };
};

const segmentsOf = (path: string) => path.split(/[\\/]/).filter(Boolean);

const isAbsolute = (path: string) => (path.startsWith("/") && !path.startsWith("//")) || path.startsWith("~/") || WINDOWS_ABSOLUTE.test(path);

/** A path written in prose or a code span: stricter than a link's target, since it was not meant as a link. */
const loosePath = (raw: string): FileReference | null => {
  if (!raw || raw.length > 1024 || raw.includes("://")) return null;
  const ref = splitLine(raw);
  const path = ref.path;
  if (WINDOWS_ABSOLUTE.test(path)) {
    if (/[\s"'<>`|*?{}$]/.test(path.slice(3)) || segmentsOf(path).length < 2) return null;
    return ref;
  }
  if (UNSAFE.test(path) || path.includes("//")) return null;
  const segments = segmentsOf(path);
  const last = segments[segments.length - 1] ?? "";
  if (path.startsWith("~/")) return segments.length >= 2 ? ref : null;
  if (path.startsWith("/")) {
    if (segments.length < 2) return null;
    return ROOTS.has(segments[0]!) || EXTENSION.test(last) ? ref : null;
  }
  if (SCHEME.test(path) || path.startsWith("@")) return null;
  const relative = path.startsWith("./") || path.startsWith("../");
  if (!relative && !path.includes("/")) return null;
  // `example.com/page.html` is a site, not a folder.
  if (!relative && /^[^.][^/]*\.[A-Za-z]/.test(segments[0] ?? "")) return null;
  return EXTENSION.test(last) ? ref : null;
};

/** The file a markdown link points to (`file://` URLs and paths), or null for web links, anchors and other schemes. */
export const fileLinkFromHref = (href: string): FileReference | null => {
  const h = href.trim();
  if (!h || h.startsWith("#") || h.startsWith("//") || h.startsWith("?")) return null;
  if (/^file:/i.test(h)) {
    let url: URL;
    try {
      url = new URL(h);
    } catch {
      return null;
    }
    if (url.host && url.host !== "localhost") return null;
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    const line = /^#L(\d+)/.exec(url.hash)?.[1];
    const ref = splitLine(path);
    return { path: ref.path, line: line ? Number(line) : ref.line };
  }
  if (SCHEME.test(h) && !WINDOWS_ABSOLUTE.test(h)) return null;
  const ref = splitLine(h);
  let path = ref.path;
  try {
    path = decodeURIComponent(path);
  } catch {}
  return path && path.length <= 1024 ? { path, line: ref.line } : null;
};

const DESTINATION = String.raw`<[^<>\n]*>|(?:[^()\s<]|\((?:[^()\s]|\([^()\s]*\))*\))+`;

/**
 * An inline Markdown link, `[text](destination)` or `[text](destination "title")`, without
 * capture groups so renderers can embed it in their own patterns. The destination is either
 * `<…>` (may hold spaces) or bare with balanced parentheses, as CommonMark reads them.
 */
export const markdownLinkPattern = String.raw`\[[^\]]+\]\((?:${DESTINATION})(?:\s+"[^"]*")?\)`;

const MARKDOWN_LINK = new RegExp(String.raw`^\[([^\]]+)\]\((${DESTINATION})(?:\s+"[^"]*")?\)$`);

/** A Markdown link's text and destination (angle brackets removed), or null. */
export const parseMarkdownLink = (token: string): { readonly text: string; readonly href: string } | null => {
  const m = MARKDOWN_LINK.exec(token);
  if (!m) return null;
  const destination = m[2]!;
  return { text: m[1]!, href: destination.startsWith("<") ? destination.slice(1, -1) : destination };
};

/** The file an inline code span names (`src/app.ts:12`, `~/notes/plan.md`), or null for other code. */
export const fileLinkFromCode = (code: string): FileReference | null => loosePath(code.trim());

export interface FoundFileLink {
  readonly start: number;
  readonly end: number;
  readonly ref: FileReference;
}

const CANDIDATE = /(^|[\s([{"'])((?:~\/|\/|[A-Za-z]:[\\/]|\.{1,2}\/)?[^\s"'<>`()[\]{}|*]*[\\/][^\s"'<>`()[\]{}|*]*)/g;

/** Paths in prose, with where they are, so they can be shown as links. */
export const findFileLinks = (text: string): Array<FoundFileLink> => {
  const found: Array<FoundFileLink> = [];
  for (const match of text.matchAll(CANDIDATE)) {
    let token = match[2]!;
    const start = match.index + match[1]!.length;
    token = token.replace(/[.,;:!?]+$/, "");
    const ref = loosePath(token);
    if (ref) found.push({ start, end: start + token.length, ref });
  }
  return found;
};

/** Text split into plain runs and file links, for renderers that walk text themselves. */
export const splitFileLinks = (text: string): Array<string | { readonly text: string; readonly ref: FileReference }> => {
  const out: Array<string | { readonly text: string; readonly ref: FileReference }> = [];
  let last = 0;
  for (const link of findFileLinks(text)) {
    if (link.start > last) out.push(text.slice(last, link.start));
    out.push({ text: text.slice(link.start, link.end), ref: link.ref });
    last = link.end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
};

/** The file's name, for titles: its last path segment. */
export const fileLinkName = (path: string) => segmentsOf(path).pop() ?? path;
