import { describe, expect, it } from "@effect/vitest";
import { isOlder } from "./ProviderVersions.ts";

describe("provider versions", () => {
  it("compares x.y.z numerically", () => {
    expect(isOlder("0.166.0", "0.167.0")).toBe(true);
    expect(isOlder("2.1.318", "2.1.318")).toBe(false);
    expect(isOlder("2.1.9", "2.1.10")).toBe(true);
    expect(isOlder("2.2.0", "2.1.99")).toBe(false);
  });
});
