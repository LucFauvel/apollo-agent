import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { blake2b512 } from "./blake2b.ts";
import { BACKUP_PUBLIC_KEY, PRIMARY_PUBLIC_KEY, trustedKeys } from "./keys.ts";
import { parsePublicKey, verifyMinisign } from "./minisign.ts";
import { makeKey, minisign } from "./testing/fixtures.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("blake2b512", () => {
  it("matches RFC 7693's test vector", () => {
    expect(hex(blake2b512(Buffer.from("abc")))).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
  });

  it("matches Node's blake2b512 at every block boundary and beyond", () => {
    for (const n of [0, 1, 127, 128, 129, 255, 256, 257, 1000, 4096, 10_001]) {
      const data = randomBytes(n);
      expect(hex(blake2b512(data)), `length ${n}`).toBe(createHash("blake2b512").update(data).digest("hex"));
    }
  });
});

const COMMENT = "apollo-update version=1.2.3 build=42 commit=0123456789abcdef0123456789abcdef01234567";

describe("verifyMinisign", () => {
  const key = makeKey();
  const data = Buffer.from('{"format":2}\n');

  it("accepts a signature from a trusted key and returns its trusted comment", () => {
    const v = verifyMinisign(data, minisign(data, key, COMMENT), [parsePublicKey(key.publicLine)]);
    expect(v).toEqual({ ok: true, keyId: expect.any(String), trustedComment: COMMENT });
  });

  it("accepts with either of several trusted keys (primary + backup)", () => {
    const other = makeKey();
    const keys = [parsePublicKey(other.publicLine), parsePublicKey(key.publicLine)];
    expect(verifyMinisign(data, minisign(data, key, COMMENT), keys).ok).toBe(true);
  });

  it("refuses a tampered file", () => {
    const sig = minisign(data, key, COMMENT);
    const tampered = Buffer.from('{"format":3}\n');
    expect(verifyMinisign(tampered, sig, [parsePublicKey(key.publicLine)])).toEqual({ ok: false, reason: "the signature does not match the file" });
  });

  it("refuses a signature by a key that is not trusted", () => {
    const stranger = makeKey();
    const v = verifyMinisign(data, minisign(data, stranger, COMMENT), [parsePublicKey(key.publicLine)]);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toMatch(/does not trust/);
  });

  it("refuses a stranger's signature relabelled with a trusted key id", () => {
    const stranger = makeKey();
    const v = verifyMinisign(data, minisign(data, stranger, COMMENT, { keyId: key.id }), [parsePublicKey(key.publicLine)]);
    expect(v).toEqual({ ok: false, reason: "the signature does not match the file" });
  });

  it("refuses a trusted comment that was changed after signing", () => {
    const sig = minisign(data, key, COMMENT).replace("build=42", "build=43");
    expect(verifyMinisign(data, sig, [parsePublicKey(key.publicLine)])).toEqual({ ok: false, reason: "the trusted comment signature does not match" });
  });

  it("refuses legacy (non-prehashed) signatures, even valid ones", () => {
    const v = verifyMinisign(data, minisign(data, key, COMMENT, { algorithm: "Ed" }), [parsePublicKey(key.publicLine)]);
    expect(v).toEqual({ ok: false, reason: "legacy (non-prehashed) minisign signatures are not accepted" });
  });

  it("refuses malformed signature files and never throws", () => {
    const keys = [parsePublicKey(key.publicLine)];
    for (const text of ["", "garbage", "untrusted comment: x\n!!!\ntrusted comment: y\nzzz\n", minisign(data, key, COMMENT).split("\n").slice(0, 3).join("\n")]) {
      expect(verifyMinisign(data, text, keys).ok).toBe(false);
    }
  });

  it("refuses everything with no keys", () => {
    expect(verifyMinisign(data, minisign(data, key, COMMENT), []).ok).toBe(false);
  });

  it("verifies a signature made by the real minisign 0.12 CLI (interop fixture, throwaway key)", () => {
    const pub = "untrusted comment: minisign public key 1B258D8BC3B8F200\nRWQA8rjDi40lG9j6Cla42HgXKPg5jS6w2iwcwsuXOc8fZayEeevoWDr/\n";
    const sig = [
      "untrusted comment: signature from minisign secret key",
      "RUQA8rjDi40lGwO/A08rjxlKGP6fsS3Bd36fHEKK9hQeAoecYXC52TkGO4r4gxR4YsQsdNvlrgO70fg7f/0uLzgLe/fgbbiR0QM=",
      `trusted comment: ${COMMENT}`,
      "fyL2bW72GzA4U9dhljc2Ln5lsmMbBAMB2I3ZpjsPH/jGhzig8qDN6z88W86dDGfK+iKTnhDv93DpbNxX+PqlCw==",
      "",
    ].join("\n");
    const key = parsePublicKey(pub);
    expect(key.id).toBe("1B258D8BC3B8F200");
    expect(verifyMinisign(Buffer.from('{"hello":"apollo"}\n'), sig, [key])).toEqual({ ok: true, keyId: "1B258D8BC3B8F200", trustedComment: COMMENT });
    expect(verifyMinisign(Buffer.from('{"hello":"apollo!"}\n'), sig, [key]).ok).toBe(false);
  });
});

describe("parsePublicKey", () => {
  it("parses the real embedded release key (RELEASE_MINISIGN_PUBLIC_KEY) as a minisign Ed25519 key", () => {
    expect(PRIMARY_PUBLIC_KEY).toBe("RWRIjaaHrGmFOQ5a1wL9XapMvpa4up75SUWrz3CobBGOESeNy8l0n4WH");
    const key = parsePublicKey(PRIMARY_PUBLIC_KEY);
    expect(key.id).toBe("398569AC87A68D48");
    expect(key.key.asymmetricKeyType).toBe("ed25519");
  });

  it("refuses what is not a minisign Ed25519 public key", () => {
    for (const text of ["", "PLACEHOLDER", "RWQ", Buffer.alloc(42).toString("base64"), randomBytes(32).toString("base64")]) {
      expect(() => parsePublicKey(text), text).toThrow();
    }
  });
});

describe("trustedKeys (embedded key slots)", () => {
  const backup = makeKey().publicLine;

  it("trusts the embedded primary key; the unfilled backup slot is ignored", () => {
    expect(BACKUP_PUBLIC_KEY).toBe("");
    const t = trustedKeys();
    expect(t.configured).toBe(true);
    expect(t.configured && t.keys.map((k) => k.id)).toEqual(["398569AC87A68D48"]);
  });

  it("an empty or placeholder backup slot can never match a signature", () => {
    const signer = makeKey();
    const data = Buffer.from("x");
    for (const slot of ["", "   ", "PLACEHOLDER-BACKUP-MINISIGN-PUBLIC-KEY"]) {
      const t = trustedKeys(PRIMARY_PUBLIC_KEY, slot);
      expect(t.configured && t.keys).toHaveLength(1);
      expect(t.configured && verifyMinisign(data, minisign(data, signer, COMMENT), t.keys).ok).toBe(false);
    }
  });

  it("trusts a filled backup slot as a second key", () => {
    const t = trustedKeys(PRIMARY_PUBLIC_KEY, backup);
    expect(t.configured && t.keys).toHaveLength(2);
  });

  it("fails closed: no primary key, a broken key, or the same key twice", () => {
    expect(trustedKeys("", backup).configured).toBe(false);
    expect(trustedKeys("PLACEHOLDER-PRIMARY", backup).configured).toBe(false);
    expect(trustedKeys(PRIMARY_PUBLIC_KEY, "RWQnot-a-key").configured).toBe(false);
    expect(trustedKeys(PRIMARY_PUBLIC_KEY, PRIMARY_PUBLIC_KEY).configured).toBe(false);
  });
});
