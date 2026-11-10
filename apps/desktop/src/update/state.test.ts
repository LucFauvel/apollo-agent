import { describe, expect, it } from "vitest";
import { decide, type RunningBuild } from "./policy.ts";
import { EMPTY_STATE, parseState, type UpdaterState, withSkipped } from "./state.ts";
import { manifest, TEAM } from "./testing/fixtures.ts";

const running: RunningBuild = { version: "1.2.0", channel: "release", build: 400, schemaVersion: 20, platform: "darwin", arch: "arm64", osVersion: "15.0" };

/** What the controller does: parse, then save what it parsed (JSON) and parse that again. */
const roundTrip = (s: UpdaterState) => parseState(JSON.stringify(s));

describe("parseState never throws, whatever the file holds", () => {
  const hostile = [
    null,
    "",
    "{",
    "null",
    "[]",
    "42",
    '"text"',
    // The reviewer's case: an object where a string was expected, which String() cannot convert.
    '{"skipped":[{"build":500,"version":{"toString":null}}]}',
    '{"skipped":[{"build":{"valueOf":null}},{"build":"501"},{"build":-3},{"build":1.5},{"build":1e300}]}',
    '{"skipped":{"length":3}}',
    '{"skipped":[null,3,"x",[],{}]}',
    '{"lastCheckAt":{"toString":null},"failures":{"valueOf":null},"retryAt":"soon","notifiedBuild":[1]}',
    '{"__proto__":{"skipped":[500],"failures":3},"constructor":{"prototype":{"x":1}}}',
    '{"skipped":[{"__proto__":{"build":500}}]}',
    `{"skipped":[${"null,".repeat(1000)}500]}`,
  ];

  for (const text of hostile) {
    it(`falls back to clean defaults: ${String(text).slice(0, 60)}`, () => {
      expect(() => parseState(text)).not.toThrow();
      const s = parseState(text);
      expect(Number.isFinite(s.failures)).toBe(true);
      expect(s.skipped.every((b) => Number.isSafeInteger(b) && b > 0)).toBe(true);
      // And what is saved from it reads back the same.
      expect(roundTrip(s)).toEqual(s);
    });
  }

  it("keeps only real build numbers, and nothing from __proto__", () => {
    expect(parseState('{"skipped":[{"build":500,"version":{"toString":null}}]}').skipped).toEqual([500]);
    expect(parseState('{"__proto__":{"skipped":[500],"failures":3}}')).toEqual(EMPTY_STATE);
    expect(parseState('{"skipped":[{"__proto__":{"build":500}}]}').skipped).toEqual([]);
    expect(parseState(`{"skipped":[${"null,".repeat(1000)}500]}`).skipped).toEqual([500]);
  });

  it("reads arrays with holes", () => {
    const sparse: Array<unknown> = [];
    sparse[3] = 501;
    sparse[7] = { build: 502 };
    expect(parseState(JSON.stringify({ skipped: sparse })).skipped).toEqual([501, 502]);
  });

  it("reads skipped builds saved in the first format (objects)", () => {
    expect(parseState('{"skipped":[{"build":502,"version":"1.3.1","at":"","why":""},{"build":500}]}').skipped).toEqual([500, 502]);
  });

  it("parses a huge skipped list", () => {
    const huge = JSON.stringify({ skipped: Array.from({ length: 100_000 }, (_, i) => i + 1) });
    expect(parseState(huge).skipped).toHaveLength(100_000);
  });
});

describe("permanent skips", () => {
  it("never forget a build that can still be offered, however many builds fail", () => {
    let s = EMPTY_STATE;
    for (let build = 500; build <= 1500; build++) s = withSkipped(s, build, running.build);
    s = roundTrip(s);
    for (const build of [500, 501, 1000, 1500]) {
      expect(decide(manifest({ build }), running, { tag: "v1.3.0", teamId: TEAM, skipped: s.skipped, dbSchema: 20 }).kind, String(build)).toBe("skipped");
    }
  });

  it("keeps one entry per build, sorted", () => {
    const s = withSkipped(withSkipped(withSkipped(EMPTY_STATE, 502, 400), 500, 400), 502, 400);
    expect(s.skipped).toEqual([500, 502]);
  });

  it("drops only skips the running build has reached, which the policy can never offer again", () => {
    const s = withSkipped(withSkipped(EMPTY_STATE, 500, 400), 600, 400);
    expect(withSkipped(s, 700, 550).skipped).toEqual([600, 700]);
    expect(decide(manifest({ build: 500 }), { ...running, build: 550 }, { tag: "v1.3.0", teamId: TEAM, skipped: [600, 700], dbSchema: 20 }).kind).toBe("up-to-date");
  });
});
