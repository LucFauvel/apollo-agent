import { describe, expect, it } from "vitest";
import { codeLanguage, highlightCode } from "../src/highlight.ts";

describe("highlightCode", () => {
  it("colors known languages, including bash and diff", () => {
    const lines = highlightCode("const x = 1;\nexport default x;", "ts");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.map((s) => s.text).join("")).toBe("const x = 1;");
    expect(lines[0]!.find((s) => s.text === "const")?.color).toBeDefined();
    expect(highlightCode("echo $HOME | grep x", "sh")[0]!.some((s) => s.color)).toBe(true);
    expect(highlightCode("+added\n-removed", "diff").every((line) => line.some((s) => s.color))).toBe(true);
  });

  it("keeps unknown languages and blank lines as plain text", () => {
    expect(codeLanguage("brainfuck")).toBeNull();
    expect(highlightCode("a\n\nb\n", "brainfuck")).toEqual([[{ text: "a" }], [{ text: "" }], [{ text: "b" }]]);
    expect(highlightCode("x = 1\n\ny = 2", "python")[1]!.map((s) => s.text).join("")).toBe("");
  });
});
