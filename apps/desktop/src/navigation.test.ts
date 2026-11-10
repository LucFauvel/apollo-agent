import { describe, expect, it } from "vitest";
import { navigationDecision, windowOpenDecision } from "./navigation.ts";

const app = ["http://127.0.0.1:5733", "http://127.0.0.1:41234"];

describe("main window navigation", () => {
  it("keeps the app's own pages in the window", () => {
    expect(navigationDecision("http://127.0.0.1:41234/pair#token=x", app)).toBe("allow");
    expect(navigationDecision("http://127.0.0.1:5733/", app)).toBe("allow");
    expect(navigationDecision("http://127.0.0.1:41234/api/attachments/s/a", app)).toBe("allow");
  });

  it("sends web and mail links to the system browser", () => {
    expect(navigationDecision("https://github.com/org/repo/pull/1", app)).toBe("external");
    expect(navigationDecision("http://example.com", app)).toBe("external");
    expect(navigationDecision("mailto:someone@example.com", app)).toBe("external");
    // Same host, another port: not the app.
    expect(navigationDecision("http://127.0.0.1:8080/", app)).toBe("external");
    expect(navigationDecision("http://localhost:41234/", app)).toBe("external");
  });

  it("drops other schemes and junk", () => {
    expect(navigationDecision("file:///etc/passwd", app)).toBe("block");
    expect(navigationDecision("javascript:alert(1)", app)).toBe("block");
    expect(navigationDecision("data:text/html,hi", app)).toBe("block");
    expect(navigationDecision("apollo-desktop://show", app)).toBe("block");
    expect(navigationDecision("not a url", app)).toBe("block");
  });
});

describe("main window: new windows", () => {
  it("reviewer round 1 repro: an app-origin _blank link never reaches the external browser, whatever its fragment or query", () => {
    for (const target of [
      "http://127.0.0.1:41234/pair#token=FAKE",
      "HTTP://127.0.0.1:41234/pair#token=FAKE",
      "http://127.0.0.1:41234/x?token=FAKE",
      "http://127.0.0.1:5733/api/attachments/s/a",
    ]) {
      expect(windowOpenDecision(target, app)).not.toBe("external");
    }
  });

  it("keeps sending external links to the system browser, and shows the window when asked", () => {
    expect(windowOpenDecision("https://github.com/org/repo/pull/1", app)).toBe("external");
    expect(windowOpenDecision("mailto:someone@example.com", app)).toBe("external");
    expect(windowOpenDecision("http://evil.com/?x=http://127.0.0.1:41234", app)).toBe("external");
    expect(windowOpenDecision("http://127.0.0.1:41234@evil.com/", app)).toBe("external");
    expect(windowOpenDecision("apollo-desktop://show", app)).toBe("show");
  });

  it("opens the app's own pages and blobs in an app window, and drops other schemes", () => {
    expect(windowOpenDecision("http://127.0.0.1:41234/pair#token=FAKE", app)).toBe("in-app");
    expect(windowOpenDecision("http://127.0.0.1:41234/api/attachments/s/a", app)).toBe("in-app");
    expect(windowOpenDecision("blob:http://127.0.0.1:41234/2f1c-uuid", app)).toBe("in-app");
    expect(windowOpenDecision("blob:https://evil.com/2f1c-uuid", app)).toBe("block");
    expect(windowOpenDecision("file:///etc/passwd", app)).toBe("block");
    expect(windowOpenDecision("javascript:alert(1)", app)).toBe("block");
    expect(windowOpenDecision("not a url", app)).toBe("block");
  });
});
