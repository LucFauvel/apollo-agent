import { createContext, type ReactNode, useContext, useMemo } from "react";
import { Linking, Platform, ScrollView, StyleSheet, Text, type TextStyle, View } from "react-native";
import { codePlainColor, type FileReference, fileLinkFromCode, fileLinkFromHref, highlightCode, splitFileLinks } from "@apollo/client";
import { colors } from "./theme.ts";

const mono = Platform.OS === "ios" ? "Menlo" : "monospace";

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; text: string; lang: string | null }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; items: Array<{ text: string; indent: number; marker: string }> }
  | { type: "table"; rows: Array<Array<string>> }
  | { type: "rule" };

const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const tableRow = /^\s*\|.*\|\s*$/;
const tableDivider = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Splits markdown into blocks. Covers what agents write: headings, lists, code, quotes, tables. */
const parseBlocks = (source: string): Array<Block> => {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Array<Block> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      const body: Array<string> = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence (or end while streaming)
      blocks.push({ type: "code", text: body.join("\n"), lang: /^\s*```\s*([\w+#.-]*)/.exec(line)?.[1] || null });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2]!.replace(/\s+#+\s*$/, "") });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    if (tableRow.test(line) && i + 1 < lines.length && tableDivider.test(lines[i + 1]!)) {
      const rows: Array<Array<string>> = [];
      const cells = (l: string) =>
        l
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
      rows.push(cells(line));
      i += 2;
      while (i < lines.length && tableRow.test(lines[i]!)) rows.push(cells(lines[i++]!));
      blocks.push({ type: "table", rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: Array<string> = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      blocks.push({ type: "quote", text: body.join("\n") });
      continue;
    }
    if (listItem.test(line)) {
      const first = listItem.exec(line)!;
      const ordered = /\d/.test(first[2]!);
      const items: Array<{ text: string; indent: number; marker: string }> = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = listItem.exec(l);
        if (m) {
          items.push({ indent: Math.floor(m[1]!.replace(/\t/g, "  ").length / 2), marker: m[2]!, text: m[3]! });
          i++;
        } else if (l.trim() && /^\s+/.test(l) && items.length) {
          items[items.length - 1]!.text += ` ${l.trim()}`; // wrapped continuation line
          i++;
        } else break;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const body: Array<string> = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^\s*```/.test(lines[i]!) &&
      !/^#{1,6}\s/.test(lines[i]!) &&
      !/^\s*>/.test(lines[i]!) &&
      !listItem.test(lines[i]!)
    )
      body.push(lines[i++]!.trim());
    blocks.push({ type: "paragraph", text: body.join("\n") });
  }
  return blocks;
};

const inlinePattern = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)]+)/g;

/**
 * Opens a local file a message links to (see LocalFileViewer); without one, as in artifacts
 * and skills, paths stay plain text.
 */
export const FileLinkContext = createContext<((file: FileReference) => void) | null>(null);

type OnFile = ((file: FileReference) => void) | null;

/** Plain text, with the paths in it as file links. */
const withFileLinks = (text: string, onFile: OnFile, key: string): Array<ReactNode> => {
  if (!onFile) return [text];
  return splitFileLinks(text).map((part, i) =>
    typeof part === "string" ? (
      part
    ) : (
      <Text key={`${key}f${i}`} style={styles.link} onPress={() => onFile(part.ref)}>
        {part.text}
      </Text>
    ),
  );
};

/** Inline spans: code, bold, italic, strikethrough and links. */
const renderInline = (text: string, base: TextStyle, onFile: OnFile, keyPrefix = ""): Array<ReactNode> => {
  const out: Array<ReactNode> = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const start = match.index;
    if (start > last) out.push(...withFileLinks(text.slice(last, start), onFile, `${keyPrefix}${n}`));
    const [token, code, bold, italic, strike, link, url] = match;
    const key = `${keyPrefix}${n++}`;
    if (code) {
      const file = onFile ? fileLinkFromCode(code.slice(1, -1)) : null;
      out.push(
        <Text key={key} style={file ? [styles.inlineCode, styles.link] : styles.inlineCode} onPress={file ? () => onFile!(file) : undefined}>
          {code.slice(1, -1)}
        </Text>,
      );
    } else if (bold) out.push(<Text key={key} style={styles.bold}>{renderInline(bold.slice(2, -2), base, onFile, `${key}.`)}</Text>);
    else if (italic) out.push(<Text key={key} style={styles.italic}>{renderInline(italic.slice(1, -1), base, onFile, `${key}.`)}</Text>);
    else if (strike) out.push(<Text key={key} style={styles.strike}>{strike.slice(2, -2)}</Text>);
    else if (link) {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(link)!;
      const file = fileLinkFromHref(m[2]!);
      if (file && !onFile) out.push(m[1]);
      else
        out.push(
          <Text key={key} style={styles.link} onPress={() => (file ? onFile!(file) : void Linking.openURL(m[2]!).catch(() => {}))}>
            {m[1]}
          </Text>,
        );
    } else if (url) {
      out.push(
        <Text key={key} style={styles.link} onPress={() => void Linking.openURL(url).catch(() => {})}>
          {url}
        </Text>,
      );
    } else out.push(token);
    last = start + token.length;
  }
  if (last < text.length) out.push(...withFileLinks(text.slice(last), onFile, `${keyPrefix}${n}`));
  return out;
};

/** Width of one character of the code font, to size lines so they scroll instead of wrapping. */
const CODE_FONT_SIZE = 12.5;
const CODE_CHAR_WIDTH = CODE_FONT_SIZE * 0.61;

/**
 * A fenced code block: highlighted, its language on top, and long lines that scroll
 * sideways (sized to the longest line, so nothing wraps).
 */
export function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const lines = useMemo(() => highlightCode(code, lang), [code, lang]);
  const longest = useMemo(() => lines.reduce((n, line) => Math.max(n, line.reduce((m, s) => m + s.text.length, 0)), 0), [lines]);
  return (
    <View style={styles.codeBlock}>
      {lang ? <Text style={styles.codeLang}>{lang}</Text> : null}
      <ScrollView
        horizontal
        nestedScrollEnabled
        directionalLockEnabled
        showsHorizontalScrollIndicator={longest * CODE_CHAR_WIDTH > 280}
        contentContainerStyle={{ paddingHorizontal: 10, paddingTop: lang ? 2 : 10, paddingBottom: 10 }}
      >
        <Text style={[styles.codeText, { width: Math.ceil(longest * CODE_CHAR_WIDTH) + 8 }]} selectable>
          {lines.map((line, i) => (
            <Text key={i}>
              {line.map((span, j) => (
                <Text
                  key={j}
                  style={span.color || span.fontStyle || span.fontWeight ? { color: span.color, fontStyle: span.fontStyle, fontWeight: span.fontWeight } : undefined}
                >
                  {span.text}
                </Text>
              ))}
              {i < lines.length - 1 ? "\n" : ""}
            </Text>
          ))}
        </Text>
      </ScrollView>
    </View>
  );
}

/** Renders an agent's markdown reply with native text. */
export function Markdown({ text, color = colors.textSoft, size = 15 }: { text: string; color?: string; size?: number }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const onFile = useContext(FileLinkContext);
  const base: TextStyle = { color, fontSize: size, lineHeight: Math.round(size * 1.45) };
  return (
    <View style={styles.root}>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading":
            return (
              <Text key={i} style={[base, styles.heading, { fontSize: size + Math.max(0, 5 - block.level) * 1.5, color: colors.text }]}>
                {renderInline(block.text, base, onFile)}
              </Text>
            );
          case "paragraph":
            return (
              <Text key={i} style={base} selectable>
                {renderInline(block.text, base, onFile)}
              </Text>
            );
          case "code":
            return <CodeBlock key={i} code={block.text} lang={block.lang} />;
          case "quote":
            return (
              <View key={i} style={styles.quote}>
                <Markdown text={block.text} color={colors.muted} size={size} />
              </View>
            );
          case "list":
            return (
              <View key={i} style={{ gap: 4 }}>
                {block.items.map((item, j) => (
                  <View key={j} style={[styles.listItem, { paddingLeft: item.indent * 16 }]}>
                    <Text style={[base, styles.marker]}>{block.ordered ? item.marker : item.indent ? "◦" : "•"}</Text>
                    <Text style={[base, { flex: 1 }]} selectable>
                      {renderInline(item.text.replace(/^\[( |x)\]\s*/i, (_, c: string) => (c === " " ? "☐ " : "☑ ")), base, onFile)}
                    </Text>
                  </View>
                ))}
              </View>
            );
          case "table":
            return (
              <ScrollView key={i} horizontal style={styles.table}>
                <View>
                  {block.rows.map((row, r) => (
                    <View key={r} style={[styles.tableRow, r === 0 && styles.tableHead]}>
                      {row.map((cell, c) => (
                        <Text key={c} style={[base, styles.tableCell, r === 0 && styles.bold, { fontSize: size - 2 }]}>
                          {renderInline(cell, base, onFile)}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            );
          case "rule":
            return <View key={i} style={styles.rule} />;
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  heading: { fontWeight: "700", marginTop: 4 },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through" },
  link: { color: colors.accent, textDecorationLine: "underline" },
  inlineCode: { fontFamily: mono, fontSize: 13, color: "#e4e4e7", backgroundColor: colors.panel },
  codeBlock: { backgroundColor: "#0d0d10", borderRadius: 10, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  codeLang: { color: colors.faint, fontSize: 10.5, fontFamily: mono, paddingHorizontal: 10, paddingTop: 7 },
  codeText: { fontFamily: mono, fontSize: CODE_FONT_SIZE, lineHeight: 18, color: codePlainColor },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: 10 },
  listItem: { flexDirection: "row", gap: 8 },
  marker: { color: colors.faint, minWidth: 14 },
  table: { borderRadius: 8, borderWidth: 1, borderColor: colors.border },
  tableRow: { flexDirection: "row", borderTopWidth: 1, borderTopColor: colors.border },
  tableHead: { borderTopWidth: 0, backgroundColor: colors.panel },
  tableCell: { minWidth: 90, maxWidth: 220, paddingHorizontal: 8, paddingVertical: 6 },
  rule: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
});
