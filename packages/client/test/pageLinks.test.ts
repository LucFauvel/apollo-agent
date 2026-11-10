import { describe, expect, it } from "vitest";
import { pageNavigation, TAP_WINDOW_MS } from "../src/pageLinks.ts";

const nav = (url: string, fields: { isTopFrame?: boolean; navigationType?: string } = {}) => ({
  url,
  isTopFrame: fields.isTopFrame ?? true,
  navigationType: fields.navigationType ?? "click",
});
const NOW = 100_000;

describe("pageNavigation", () => {
  it("loads the page's own document and anchors", () => {
    expect(pageNavigation(nav("about:blank", { navigationType: "other" }), null, NOW, "ios")).toBe("load");
    expect(pageNavigation(nav("about:blank#section"), null, NOW, "ios")).toBe("load");
    expect(pageNavigation(nav("data:text/html,hi"), null, NOW, "android")).toBe("load");
  });

  it("opens a web link the user just tapped", () => {
    expect(pageNavigation(nav("https://example.com"), NOW - 200, NOW, "ios")).toBe("external");
    expect(pageNavigation(nav("mailto:a@example.com"), NOW - 200, NOW, "ios")).toBe("external");
    expect(pageNavigation(nav("http://example.com", { navigationType: "other" }), NOW - 200, NOW, "android")).toBe("external");
  });

  it("never follows a script redirect, without a recent touch", () => {
    expect(pageNavigation(nav("https://example.com", { navigationType: "other" }), null, NOW, "ios")).toBe("block");
    expect(pageNavigation(nav("https://example.com"), null, NOW, "ios")).toBe("block");
    expect(pageNavigation(nav("https://example.com"), NOW - TAP_WINDOW_MS - 1, NOW, "android")).toBe("block");
    expect(pageNavigation(nav("https://example.com"), NOW + 50, NOW, "android")).toBe("block");
  });

  it("on iOS, needs a link activation even right after a touch", () => {
    expect(pageNavigation(nav("https://example.com", { navigationType: "other" }), NOW - 100, NOW, "ios")).toBe("block");
    expect(pageNavigation(nav("https://example.com", { navigationType: "formsubmit" }), NOW - 100, NOW, "ios")).toBe("block");
  });

  it("never launches other apps, even on a tap", () => {
    for (const url of ["shortcuts://run-shortcut?name=x", "tel:123", "sms:123", "itms-apps://x", "javascript:alert(1)", "file:///etc/hosts", "not a url"]) {
      expect(pageNavigation(nav(url), NOW - 100, NOW, "ios")).toBe("block");
    }
  });

  it("loads web subframes inside the page, and nothing else", () => {
    expect(pageNavigation(nav("https://example.com/embed", { isTopFrame: false, navigationType: "other" }), null, NOW, "ios")).toBe("load");
    expect(pageNavigation(nav("shortcuts://x", { isTopFrame: false, navigationType: "other" }), null, NOW, "ios")).toBe("block");
  });
});
