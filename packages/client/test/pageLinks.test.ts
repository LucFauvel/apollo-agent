import { describe, expect, it } from "vitest";
import { externalTarget, pageNavigation } from "../src/pageLinks.ts";

const nav = (url: string, isTopFrame = true) => ({ url, isTopFrame });

describe("pageNavigation", () => {
  it("loads the page's own document and anchors", () => {
    expect(pageNavigation(nav("about:blank"))).toBe("load");
    expect(pageNavigation(nav("about:blank#section"))).toBe("load");
    expect(pageNavigation(nav("data:text/html,hi"))).toBe("load");
  });

  it("never opens a web or mail link by itself: the user is asked", () => {
    // A tapped link, a script redirect and a script's click() on a hidden anchor look alike.
    expect(pageNavigation(nav("https://example.com"))).toBe("ask");
    expect(pageNavigation(nav("http://example.com/x"))).toBe("ask");
    expect(pageNavigation(nav("mailto:a@example.com"))).toBe("ask");
  });

  it("never launches other apps", () => {
    for (const url of ["shortcuts://run-shortcut?name=x", "tel:123", "sms:123", "itms-apps://x", "javascript:alert(1)", "file:///etc/hosts", "not a url"]) {
      expect(pageNavigation(nav(url))).toBe("block");
    }
  });

  it("loads web subframes inside the page, and nothing else", () => {
    expect(pageNavigation(nav("https://example.com/embed", false))).toBe("load");
    expect(pageNavigation(nav("shortcuts://x", false))).toBe("block");
  });
});

describe("externalTarget", () => {
  it("names the host or the mail address", () => {
    expect(externalTarget("https://docs.example.com/a?b=c")).toBe("docs.example.com");
    expect(externalTarget("http://localhost:5173/")).toBe("localhost:5173");
    expect(externalTarget("mailto:a@example.com?subject=hi")).toBe("a@example.com");
    expect(externalTarget("mailto:a%40example.com,b@example.com")).toBe("a@example.com");
    expect(externalTarget("mailto:?subject=hi")).toBe("a new email");
  });

  it("refuses what may not open", () => {
    expect(externalTarget("shortcuts://x")).toBeNull();
    expect(externalTarget("tel:123")).toBeNull();
    expect(externalTarget("nonsense")).toBeNull();
  });
});
