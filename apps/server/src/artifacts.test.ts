import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEvent, type BotId, type SessionId } from "@apollo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { classify, fallbackHtml, findArtifact, listArtifacts, removeArtifacts, saveArtifact } from "./artifacts.ts";
import { artifactBytes } from "./mcp/ArtifactTools.ts";

const bot = "bot_0123456789abcdef0123" as BotId;
const other = "bot_ffffffffffffffffffff" as BotId;
const session = "ses_0123456789abcdef0123" as SessionId;
const text = (s: string) => new TextEncoder().encode(s);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apollo-artifacts-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("artifacts", () => {
  it("saves a file on disk and finds it again", () => {
    const saved = saveArtifact(dir, { botId: bot, sessionId: session, name: "notes.md", bytes: text("# Hi") })!;
    expect(saved).toMatchObject({ botId: bot, version: 1, name: "notes.md", title: "notes.md", kind: "markdown", size: 4 });
    expect(saved.path.startsWith(join(dir, "artifacts", bot, saved.artifactId))).toBe(true);
    expect(readFileSync(saved.path, "utf8")).toBe("# Hi");
    expect(findArtifact(dir, bot, saved.artifactId)).toEqual(saved);
  });

  it("adds versions and keeps the earlier ones unchanged", () => {
    const first = saveArtifact(dir, { botId: bot, sessionId: session, name: "page.html", title: "Report", bytes: text("<p>1</p>") })!;
    const second = saveArtifact(dir, { botId: bot, sessionId: session, artifactId: first.artifactId, bytes: text("<p>2</p>") })!;
    expect(second).toMatchObject({ artifactId: first.artifactId, version: 2, name: "page.html", title: "Report", kind: "html" });
    expect(readFileSync(findArtifact(dir, bot, first.artifactId, 1)!.path, "utf8")).toBe("<p>1</p>");
    expect(findArtifact(dir, bot, first.artifactId)!.version).toBe(2);
    expect(listArtifacts(dir, bot)).toMatchObject([{ artifactId: first.artifactId, latestVersion: 2, title: "Report" }]);
  });

  it("belong to their bot", () => {
    const saved = saveArtifact(dir, { botId: bot, sessionId: session, name: "a.txt", bytes: text("a") })!;
    expect(findArtifact(dir, other, saved.artifactId)).toBeNull();
    expect(saveArtifact(dir, { botId: other, sessionId: session, artifactId: saved.artifactId, bytes: text("b") })).toBeNull();
    expect(listArtifacts(dir, other)).toEqual([]);
    removeArtifacts(dir, bot);
    expect(findArtifact(dir, bot, saved.artifactId)).toBeNull();
  });

  it("refuses ids and names that would leave the folder", () => {
    expect(findArtifact(dir, bot, "../../etc")).toBeNull();
    expect(findArtifact(dir, "../x", "art_000000000000")).toBeNull();
    const saved = saveArtifact(dir, { botId: bot, sessionId: session, name: "../../evil.sh", bytes: text("x") })!;
    expect(saved.name).toBe("evil.sh");
    expect(saved.path.startsWith(join(dir, "artifacts", bot))).toBe(true);
  });

  it("are shown by their extension, or as text when they look like text", () => {
    expect(classify("a.ts", text("x"))).toMatchObject({ kind: "code", language: "ts" });
    expect(classify("a.png", new Uint8Array([137, 80]))).toMatchObject({ kind: "image", mime: "image/png" });
    expect(classify("a.pdf", text("%PDF"))).toMatchObject({ kind: "file", mime: "application/pdf" });
    expect(classify("LICENSE", text("MIT"))).toMatchObject({ kind: "text" });
    expect(classify("blob", new Uint8Array([0, 1, 2]))).toMatchObject({ kind: "file" });
  });

  it("tell large binary files from large text cut mid-character", () => {
    // Invalid UTF-8 past the 64 KB sample size is still binary.
    expect(classify("payload.bin", new Uint8Array(64 * 1024 + 1).fill(0xff))).toMatchObject({ kind: "file" });
    // Text whose sample ends inside a multi-byte character ("é" is 2 bytes) is still text.
    const big = text("a".repeat(64 * 1024 - 1) + "é".repeat(10));
    expect(classify("notes", big)).toMatchObject({ kind: "text" });
  });

  it("give older clients a fallback rendering", () => {
    const page = saveArtifact(dir, { botId: bot, sessionId: session, name: "p.html", bytes: text("<b>x</b>") })!;
    expect(fallbackHtml(page, text("<b>x</b>"))).toBe("<b>x</b>");
    const md = saveArtifact(dir, { botId: bot, sessionId: session, name: "n.md", bytes: text("<script>") })!;
    expect(fallbackHtml(md, text("<script>"))).toContain("&lt;script&gt;");
    const pdf = saveArtifact(dir, { botId: bot, sessionId: session, name: "f.pdf", bytes: text("%PDF") })!;
    expect(fallbackHtml(pdf, text("%PDF"))).toContain("f.pdf");
  });

  it("read their bytes from content or an absolute path", () => {
    expect(artifactBytes("hé", undefined)).toEqual(text("hé"));
    const file = join(dir, "img.png");
    writeFileSync(file, new Uint8Array([1, 2, 3]));
    expect(artifactBytes(undefined, file)).toEqual(new Uint8Array([1, 2, 3]));
    expect(artifactBytes(undefined, "relative.png")).toMatchObject({ code: "invalid" });
    expect(artifactBytes("x", file)).toMatchObject({ code: "invalid" });
    expect(artifactBytes(undefined, undefined)).toMatchObject({ code: "invalid" });
    expect(artifactBytes(undefined, dir)).toMatchObject({ code: "invalid" });
  });

  it("reach clients built before them as a plain Visual", () => {
    const saved = saveArtifact(dir, { botId: bot, sessionId: session, name: "n.md", bytes: text("# Hi") })!;
    const { path: _path, ...artifact } = saved;
    const event = { _tag: "Visual", visualId: "v", title: "n.md", html: "<pre># Hi</pre>", height: null, artifact } as const;
    const encoded = Schema.encodeSync(AgentEvent)(event);
    const OldVisual = Schema.TaggedStruct("Visual", {
      visualId: Schema.String,
      title: Schema.String,
      html: Schema.String,
      height: Schema.NullOr(Schema.Number),
    });
    expect(Schema.decodeUnknownSync(OldVisual)(encoded)).toEqual({ _tag: "Visual", visualId: "v", title: "n.md", html: "<pre># Hi</pre>", height: null });
    expect(Schema.decodeUnknownSync(AgentEvent)(encoded)).toEqual(event);
  });
});
