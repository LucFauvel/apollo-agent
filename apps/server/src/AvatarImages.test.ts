import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { avatarKey, cachedKeys, isPng, pruneAvatars } from "./AvatarImages.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("avatar images", () => {
  it("names an image after its avatar", () => {
    expect(avatarKey({ shape: "ghost", color: "grape" })).toBe("ghost-grape");
  });

  it("accepts PNGs only", () => {
    expect(isPng(PNG)).toBe(true);
    expect(isPng(new TextEncoder().encode("<svg onload=alert(1)>"))).toBe(false);
  });

  it("keeps only the images bots use, and ignores other files", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "apollo-avatars-"));
    mkdirSync(join(dataDir, "avatars"));
    for (const name of ["ghost-grape.png", "star-sun.png", "../evil.png", "notes.txt", "blob-plaid.png"]) {
      try {
        writeFileSync(join(dataDir, "avatars", name), PNG);
      } catch {}
    }
    expect(cachedKeys(dataDir).sort()).toEqual(["ghost-grape", "star-sun"]);
    pruneAvatars(dataDir, new Set(["star-sun"]));
    expect(cachedKeys(dataDir)).toEqual(["star-sun"]);
  });
});
