import { describe, expect, it } from "vitest";
import { nodeHostname } from "./Tailscale.ts";

describe("nodeHostname", () => {
  it("turns a computer name into a tailnet machine name", () => {
    expect(nodeHostname("Luc's MacBook.local")).toBe("apollo-luc-s-macbook");
    expect(nodeHostname("DEVOLUTIONS652")).toBe("apollo-devolutions652");
    expect(nodeHostname("DEVOLUTIONS652.LOCAL")).toBe("apollo-devolutions652");
    expect(nodeHostname("---")).toBe("apollo-desktop");
  });
});
