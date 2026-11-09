import { describe, expect, it } from "vitest";
import { peMachine } from "./pe.ts";

const image = (machine: number, peOffset = 0x80) => {
  const b = new Uint8Array(peOffset + 24);
  b[0] = 0x4d;
  b[1] = 0x5a;
  new DataView(b.buffer).setUint32(0x3c, peOffset, true);
  b.set([0x50, 0x45, 0, 0], peOffset);
  new DataView(b.buffer).setUint16(peOffset + 4, machine, true);
  return b;
};

describe("peMachine", () => {
  it("reads x64, arm64 and ia32", () => {
    expect(peMachine(image(0x8664))).toBe("x64");
    expect(peMachine(image(0xaa64))).toBe("arm64");
    expect(peMachine(image(0x014c))).toBe("ia32");
  });
  it("rejects non-PE data and unknown machines", () => {
    expect(peMachine(new Uint8Array(200))).toBeNull();
    expect(peMachine(new TextEncoder().encode("#!/bin/sh\n".padEnd(100)))).toBeNull();
    expect(peMachine(image(0x1234))).toBeNull();
    const truncated = image(0x8664).slice(0, 0x60);
    expect(peMachine(truncated)).toBeNull();
    const badSig = image(0x8664);
    badSig[0x80] = 0;
    expect(peMachine(badSig)).toBeNull();
  });
});
