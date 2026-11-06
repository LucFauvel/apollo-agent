import { type ReactNode, useMemo } from "react";
import { Linking, Platform, ScrollView, StyleSheet, Text, type TextStyle, View } from "react-native";
import { colors } from "./theme.ts";

const mono = Platform.OS === "ios" ? "Menlo" : "monospace";

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; text: string }
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
      blocks.push({ type: "code", text: body.join("\n") });
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

/** Inline spans: code, bold, italic, strikethrough and links. */
const renderInline = (text: string, base: TextStyle, keyPrefix = ""): Array<ReactNode> => {
  const out: Array<ReactNode> = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const start = match.index;
    if (start > last) out.push(text.slice(last, start));
    const [token, code, bold, italic, strike, link, url] = match;
    const key = `${keyPrefix}${n++}`;
    if (code) out.push(<Text key={key} style={styles.inlineCode}>{code.slice(1, -1)}</Text>);
    else if (bold) out.push(<Text key={key} style={styles.bold}>{renderInline(bold.slice(2, -2), base, `${key}.`)}</Text>);
    else if (italic) out.push(<Text key={key} style={styles.italic}>{renderInline(italic.slice(1, -1), base, `${key}.`)}</Text>);
    else if (strike) out.push(<Text key={key} style={styles.strike}>{strike.slice(2, -2)}</Text>);
    else if (link) {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(link)!;
      out.push(
        <Text key={key} style={styles.link} onPress={() => void Linking.openURL(m[2]!).catch(() => {})}>
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
  if (last < text.length) out.push(text.slice(last));
  return out;
};

/** Renders an agent's markdown reply with native text. */
export function Markdown({ text, color = colors.textSoft, size = 15 }: { text: string; color?: string; size?: number }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const base: TextStyle = { color, fontSize: size, lineHeight: Math.round(size * 1.45) };
  return (
    <View style={styles.root}>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading":
            return (
              <Text key={i} style={[base, styles.heading, { fontSize: size + Math.max(0, 5 - block.level) * 1.5, color: colors.text }]}>
                {renderInline(block.text, base)}
              </Text>
            );
          case "paragraph":
            return (
              <Text key={i} style={base} selectable>
                {renderInline(block.text, base)}
              </Text>
            );
          case "code":
            return (
              <ScrollView key={i} horizontal style={styles.codeBlock} contentContainerStyle={{ padding: 10 }}>
                <Text style={styles.codeText} selectable>
                  {block.text}
                </Text>
              </ScrollView>
            );
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
                      {renderInline(item.text.replace(/^\[( |x)\]\s*/i, (_, c: string) => (c === " " ? "☐ " : "☑ ")), base)}
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
                          {renderInline(cell, base)}
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
  codeBlock: { backgroundColor: "#000", borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  codeText: { fontFamily: mono, fontSize: 12.5, lineHeight: 18, color: colors.textSoft },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: 10 },
  listItem: { flexDirection: "row", gap: 8 },
  marker: { color: colors.faint, minWidth: 14 },
  table: { borderRadius: 8, borderWidth: 1, borderColor: colors.border },
  tableRow: { flexDirection: "row", borderTopWidth: 1, borderTopColor: colors.border },
  tableHead: { borderTopWidth: 0, backgroundColor: colors.panel },
  tableCell: { minWidth: 90, maxWidth: 220, paddingHorizontal: 8, paddingVertical: 6 },
  rule: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
});
