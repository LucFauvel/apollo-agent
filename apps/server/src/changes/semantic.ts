/**
 * A semantic view of a file's diff, computed without any model: the declarations in the
 * old and new file (functions, classes, types, methods, Markdown sections, ...) found with
 * per-language patterns, each with its extent by indentation; every changed line is then
 * filed under the innermost declaration around it, and each declaration is marked added,
 * removed or modified. Changes outside any declaration go under "Module scope".
 */

export type SymbolKind = "function" | "method" | "class" | "type" | "constant" | "section" | "module";
export type SymbolChange = "added" | "removed" | "modified";

export interface DiffLine {
  readonly kind: "add" | "del" | "ctx";
  readonly text: string;
  readonly oldNo: number | null;
  readonly newNo: number | null;
}

export interface Hunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: ReadonlyArray<DiffLine>;
}

export interface SemanticSymbol {
  /** Qualified by its enclosing declarations: `Store.listBots`. */
  readonly name: string;
  readonly kind: SymbolKind;
  readonly change: SymbolChange;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: ReadonlyArray<Hunk>;
}

export const MODULE_SCOPE = "Module scope";

// --- parsing the unified diff ------------------------------------------------

export const parseHunks = (diff: string): Array<Hunk> => {
  const hunks: Array<Hunk> = [];
  let current: { oldStart: number; newStart: number; lines: Array<DiffLine> } | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      hunks.push(current);
      oldNo = current.oldStart;
      newNo = current.newStart;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) current.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
    else if (line.startsWith("-")) current.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
    else if (line.startsWith(" ")) current.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    // "\ No newline at end of file" and blank trailing lines carry no content.
  }
  return hunks;
};

// --- declarations --------------------------------------------------------------

interface Declaration {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly start: number; // 1-based, inclusive
  readonly end: number;
  readonly indent: number;
}

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else", "do", "try", "with", "new", "typeof", "await"]);

type Pattern = { readonly re: RegExp; readonly kind: SymbolKind; readonly topOnly?: boolean };

const CODE: ReadonlyArray<Pattern> = [
  // TypeScript / JavaScript
  { re: /^(\s*)(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^(\s*)(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^(\s*)(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  { re: /^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, kind: "function" },
  { re: /^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: "constant", topOnly: true },
  { re: /^(\s+)(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{=]+)?\{\s*$/, kind: "method" },
  { re: /^(\s+)([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind: "method" },
  // Python
  { re: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
  { re: /^(\s*)class\s+([A-Za-z_]\w*)/, kind: "class" },
  // Go
  { re: /^()func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
  { re: /^()type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, kind: "type" },
  // Rust
  { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
  { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+([A-Za-z_]\w*)/, kind: "type" },
  { re: /^(\s*)impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_][\w:]*)/, kind: "class" },
  // Swift, Kotlin, Java, C#
  { re: /^(\s*)(?:(?:public|private|internal|fileprivate|open|static|final|override|class|mutating|@\w+)\s+)*(?:func|fun)\s+([A-Za-z_]\w*)/, kind: "function" },
  { re: /^(\s*)(?:(?:public|private|internal|fileprivate|open|final|abstract|sealed|data|static|partial)\s+)*(?:class|struct|protocol|extension|object|record|interface|enum)\s+([A-Za-z_][\w.]*)/, kind: "class" },
];

const indentOf = (line: string) => {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
};

const isBlank = (line: string) => line.trim() === "";
const closes = (line: string) => /^\s*[}\])]|^\s*end\b/.test(line);

/** Where a declaration at `index` ends: the last line before the code returns to its indentation. */
const extent = (lines: ReadonlyArray<string>, index: number, indent: number) => {
  let end = index;
  for (let j = index + 1; j < lines.length; j++) {
    const line = lines[j]!;
    if (isBlank(line)) continue;
    const d = indentOf(line);
    if (d > indent) end = j;
    else if (d === indent && closes(line)) {
      end = j;
      break;
    } else break;
  }
  return end;
};

const markdownSections = (lines: ReadonlyArray<string>): Array<Declaration> => {
  const headings: Array<{ level: number; name: string; index: number }> = [];
  let fence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const match = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) headings.push({ level: match[1]!.length, name: match[2]!, index });
  });
  return headings.map((h, i) => {
    const next = headings.slice(i + 1).find((other) => other.level <= h.level);
    return { name: h.name, kind: "section" as const, start: h.index + 1, end: next ? next.index : lines.length, indent: h.level };
  });
};

/** Declarations in a file, with their extents. */
export const declarations = (content: string, path: string): Array<Declaration> => {
  const lines = content.split("\n");
  if (/\.(md|mdx|markdown)$/i.test(path)) return markdownSections(lines);
  const found: Array<Declaration> = [];
  lines.forEach((line, index) => {
    for (const pattern of CODE) {
      const match = pattern.re.exec(line);
      if (!match) continue;
      const indent = indentOf(match[1] ?? "");
      const name = match[2]!;
      if (KEYWORDS.has(name) || (pattern.topOnly && indent > 0)) break;
      found.push({ name, kind: pattern.kind, start: index + 1, end: extent(lines, index, indent) + 1, indent });
      break;
    }
  });
  return found;
};

/** The innermost declaration around each line, by its qualified name. */
const qualify = (decls: ReadonlyArray<Declaration>) => {
  const named = decls.map((d) => {
    const parents = decls.filter((p) => p !== d && p.start <= d.start && p.end >= d.end && (p.start < d.start || p.end > d.end));
    parents.sort((a, b) => a.start - b.start);
    return { ...d, qualified: [...parents.map((p) => p.name), d.name].join(".") };
  });
  return (line: number) => {
    let best: (typeof named)[number] | null = null;
    for (const d of named) if (d.start <= line && line <= d.end && (!best || d.end - d.start <= best.end - best.start)) best = d;
    return best;
  };
};

// --- the semantic diff -----------------------------------------------------------

/** Groups a file's hunks by the declarations they change. */
export const semanticDiff = (path: string, oldContent: string | null, newContent: string | null, diff: string): Array<SemanticSymbol> => {
  const hunks = parseHunks(diff);
  const oldDecls = oldContent === null ? [] : declarations(oldContent, path);
  const newDecls = newContent === null ? [] : declarations(newContent, path);
  const inOld = qualify(oldDecls);
  const inNew = qualify(newDecls);
  const oldNames = new Set(oldDecls.map((d) => inOld(d.start)?.qualified));
  const newNames = new Set(newDecls.map((d) => inNew(d.start)?.qualified));

  const symbols = new Map<string, { kind: SymbolKind; order: number; hunks: Array<{ oldStart: number; newStart: number; lines: Array<DiffLine> }> }>();
  const symbolOf = (line: DiffLine) => {
    const d = line.kind === "del" ? inOld(line.oldNo!) : inNew(line.newNo!);
    return d ? { name: d.qualified, kind: d.kind, order: d.start } : { name: MODULE_SCOPE, kind: "module" as const, order: 0 };
  };

  const CONTEXT = 3;
  for (const hunk of hunks) {
    // Runs of changed lines under one declaration, with the context lines between them.
    type Run = { name: string; changed: Array<DiffLine> };
    const runs: Array<Run> = [];
    const gaps: Array<Array<DiffLine>> = [[]]; // gaps[i] precedes runs[i]; the last one trails
    for (const line of hunk.lines) {
      if (line.kind === "ctx") {
        gaps[gaps.length - 1]!.push(line);
        continue;
      }
      const owner = symbolOf(line);
      if (!symbols.has(owner.name)) symbols.set(owner.name, { kind: owner.kind, order: owner.order, hunks: [] });
      const last = runs.at(-1);
      if (last && last.name === owner.name && gaps.at(-1)!.length === 0) {
        last.changed.push(line);
      } else if (last && last.name === owner.name) {
        // Same declaration after some context: keep it in one piece.
        last.changed.push(...gaps.pop()!, line);
        gaps.push([]);
      } else {
        runs.push({ name: owner.name, changed: [line] });
        gaps.push([]);
      }
    }
    // Each run takes up to 3 context lines from the gap before it and the gap after it.
    runs.forEach((run, i) => {
      const before = gaps[i]!;
      const after = gaps[i + 1]!;
      const lines = [...before.slice(-CONTEXT), ...run.changed, ...after.slice(0, CONTEXT)];
      const first = lines[0]!;
      symbols.get(run.name)!.hunks.push({ oldStart: first.oldNo ?? 0, newStart: first.newNo ?? 0, lines });
    });
  }

  return [...symbols.entries()]
    .map(([name, s]) => {
      const lines = s.hunks.flatMap((h) => h.lines);
      const additions = lines.filter((l) => l.kind === "add").length;
      const deletions = lines.filter((l) => l.kind === "del").length;
      const change: SymbolChange =
        name === MODULE_SCOPE ? "modified" : !oldNames.has(name) ? "added" : !newNames.has(name) ? "removed" : "modified";
      return { name, kind: s.kind, change, additions, deletions, hunks: s.hunks, order: s.order };
    })
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map(({ order: _order, ...symbol }) => symbol);
};
