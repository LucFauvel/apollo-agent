import { describe, expect, it } from "vitest";
import { navigationDecision } from "./navigation.ts";

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
