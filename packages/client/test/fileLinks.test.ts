import { describe, expect, it } from "vitest";
import { fileLinkFromCode, fileLinkFromHref, findFileLinks, splitFileLinks } from "../src/index.ts";

describe("fileLinkFromHref", () => {
  it("reads file URLs, absolute and relative paths", () => {
    expect(fileLinkFromHref("file:///Users/me/report%20final.pdf")).toEqual({ path: "/Users/me/report final.pdf", line: null });
    expect(fileLinkFromHref("file:///C:/dev/app.cs#L40")).toEqual({ path: "C:/dev/app.cs", line: 40 });
    expect(fileLinkFromHref("/Users/me/notes.md")).toEqual({ path: "/Users/me/notes.md", line: null });
    expect(fileLinkFromHref("src/app.ts:12")).toEqual({ path: "src/app.ts", line: 12 });
    expect(fileLinkFromHref("C:\\dev\\app.cs")).toEqual({ path: "C:\\dev\\app.cs", line: null });
    expect(fileLinkFromHref("README.md")).toEqual({ path: "README.md", line: null });
  });

  it("leaves web links, anchors and other schemes alone", () => {
    for (const href of ["https://example.com/a.md", "mailto:a@b.c", "#fn-1", "//cdn.example.com/x.js", "javascript:alert(1)", "file://server/share/a.txt", ""]) {
      expect(fileLinkFromHref(href)).toBeNull();
    }
  });
});

describe("fileLinkFromCode", () => {
  it("recognizes paths", () => {
    expect(fileLinkFromCode("apps/desktop/src/navigation.ts:12")).toEqual({ path: "apps/desktop/src/navigation.ts", line: 12 });
    expect(fileLinkFromCode("~/Apollo/io/plan.md")).toEqual({ path: "~/Apollo/io/plan.md", line: null });
    expect(fileLinkFromCode("/Users/me/git/apollo")).toEqual({ path: "/Users/me/git/apollo", line: null });
    expect(fileLinkFromCode("./build.sh")).toEqual({ path: "./build.sh", line: null });
    expect(fileLinkFromCode("C:\\dev\\RDM\\Program.cs")).toEqual({ path: "C:\\dev\\RDM\\Program.cs", line: null });
  });

  it("ignores code that is not a path", () => {
    for (const code of ["pnpm test", "effect/Effect", "@apollo/client", "src/**/*.ts", "/api/auth/session", "/rpc", "text/plain", "a.b", "example.com/page.html", "http://x.y/a.md", "1.5/2.0"]) {
      expect(fileLinkFromCode(code)).toBeNull();
    }
  });
});

describe("findFileLinks", () => {
  it("finds paths in prose, without the punctuation around them", () => {
    const text = "See /Users/me/report.pdf, and (src/app.ts:12). Not https://x.com/a.md or and/or.";
    expect(findFileLinks(text).map((l) => text.slice(l.start, l.end))).toEqual(["/Users/me/report.pdf", "src/app.ts:12"]);
  });

  it("splits text around them", () => {
    expect(splitFileLinks("open ~/a/b.txt now")).toEqual(["open ", { text: "~/a/b.txt", ref: { path: "~/a/b.txt", line: null } }, " now"]);
    expect(splitFileLinks("no paths here")).toEqual(["no paths here"]);
  });
});
