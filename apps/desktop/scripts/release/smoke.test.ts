import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const smoke = join(dirname(fileURLToPath(import.meta.url)), "smoke.ts");

describe("smoke.ts never hands a path to a shell (review P2-3)", () => {
  it("has no shell: true and starts the installer through runSilentInstall", () => {
    const source = readFileSync(smoke, "utf8");
    expect(source).not.toMatch(/shell:\s*true/);
    expect(source).toMatch(/runSilentInstall\(/);
  });
});
