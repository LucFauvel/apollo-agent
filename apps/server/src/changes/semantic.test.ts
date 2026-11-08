import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { declarations, MODULE_SCOPE, semanticDiff } from "./semantic.ts";

/** The unified diff git would show between two versions of a file. */
const gitDiff = (before: string, after: string) => {
  const dir = mkdtempSync(join(tmpdir(), "apollo-semantic-"));
  writeFileSync(join(dir, "a.ts"), before);
  writeFileSync(join(dir, "b.ts"), after);
  try {
    return execFileSync("git", ["diff", "--no-index", "-U3", "a.ts", "b.ts"], { cwd: dir, encoding: "utf8" });
  } catch (error) {
    return (error as { stdout: string }).stdout; // exit code 1 means "they differ"
  }
};

const before = `import { a } from "./a.ts";

export class Store {
  constructor(private db: Db) {}

  listBots() {
    return this.db.all("select * from bots");
  }

  getBot(id: string) {
    return this.db.get(id);
  }
}

function legacy() {
  return 1;
}

export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
`;

const after = `import { a } from "./a.ts";
import { b } from "./b.ts";

export class Store {
  constructor(private db: Db) {}

  listBots() {
    return this.db.all("select * from bots order by created_at");
  }

  getBot(id: string) {
    return this.db.get(id);
  }
}

export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function average(xs: number[]) {
  return total(xs) / xs.length;
}
`;

describe("semantic diff", () => {
  it("finds declarations and their nesting", () => {
    expect(declarations(before, "store.ts").map((d) => [d.name, d.kind, d.start, d.end])).toEqual([
      ["Store", "class", 3, 13],
      ["listBots", "method", 6, 8],
      ["getBot", "method", 10, 12],
      ["legacy", "function", 15, 17],
      ["total", "function", 19, 19],
    ]);
  });

  it("files each change under the declaration it touches", () => {
    const symbols = semanticDiff("store.ts", before, after, gitDiff(before, after));
    expect(symbols.map((s) => [s.name, s.kind, s.change, s.additions, s.deletions])).toEqual([
      // The new import, and blank lines between declarations.
      [MODULE_SCOPE, "module", "modified", 2, 1],
      ["Store.listBots", "method", "modified", 1, 1],
      ["legacy", "function", "removed", 0, 3],
      ["average", "function", "added", 3, 0],
    ]);
    // Each piece keeps a little context around the change.
    const listBots = symbols.find((s) => s.name === "Store.listBots")!;
    expect(listBots.hunks[0]!.lines.map((l) => l.kind)).toContain("ctx");
  });

  it("treats Markdown headings as sections", () => {
    const doc = "# Apollo\n\nIntro\n\n## Install\n\nRun it\n\n## Use\n\nType\n";
    const changed = doc.replace("Run it", "Run pnpm install");
    const symbols = semanticDiff("README.md", doc, changed, gitDiff(doc, changed));
    expect(symbols.map((s) => [s.name, s.change])).toEqual([["Apollo.Install", "modified"]]);
  });

  it("marks a new file's declarations as added", () => {
    const symbols = semanticDiff("new.ts", null, after, gitDiff("", after));
    expect(symbols.every((s) => s.change === "added" || s.name === MODULE_SCOPE)).toBe(true);
    expect(symbols.map((s) => s.name)).toContain("Store");
  });
});
