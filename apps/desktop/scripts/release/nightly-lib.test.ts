import { describe, expect, it } from "vitest";
import { makeKey } from "../../src/update/testing/fixtures.ts";
import { nightliesToPrune, nightlyKeyProblems, nightlyManifestProblems, nightlyTag } from "./nightly-lib.ts";

const release = makeKey();
const backup = makeKey();
const nightly = makeKey();
const embedded = { primary: release.publicLine, backup: "", nightly: nightly.publicLine };

describe("nightlyKeyProblems", () => {
  it("accepts a distinct nightly key that the apps embed", () => {
    expect(nightlyKeyProblems({ nightly: nightly.publicLine, releaseVariable: release.publicLine, embedded })).toEqual({ problems: [], warnings: [] });
  });

  it("refuses a missing or invalid nightly key", () => {
    expect(nightlyKeyProblems({ nightly: "", releaseVariable: release.publicLine, embedded }).problems).toEqual(["NIGHTLY_MINISIGN_PUBLIC_KEY is not set"]);
    expect(nightlyKeyProblems({ nightly: "RWnope", releaseVariable: release.publicLine, embedded }).problems).toHaveLength(1);
  });

  it("refuses a nightly key that is any release key: the variable's, the embedded primary or backup", () => {
    expect(nightlyKeyProblems({ nightly: release.publicLine, releaseVariable: "", embedded }).problems[0]).toMatch(/same as a release key/);
    const other = makeKey();
    expect(nightlyKeyProblems({ nightly: other.publicLine, releaseVariable: other.publicLine, embedded }).problems[0]).toMatch(/same as a release key/);
    expect(nightlyKeyProblems({ nightly: backup.publicLine, releaseVariable: "", embedded: { ...embedded, backup: backup.publicLine } }).problems[0]).toMatch(/same as a release key/);
  });

  it("warns when the apps of this commit do not embed this nightly key", () => {
    expect(nightlyKeyProblems({ nightly: nightly.publicLine, releaseVariable: "", embedded: { ...embedded, nightly: "" } }).warnings[0]).toMatch(/embed no nightly key/);
    expect(nightlyKeyProblems({ nightly: nightly.publicLine, releaseVariable: "", embedded: { ...embedded, nightly: makeKey().publicLine } }).warnings[0]).toMatch(/will refuse this nightly/);
  });
});

describe("nightlyManifestProblems", () => {
  const commit = "c".repeat(40);
  const version = "1.2.4-nightly.20261110.42";
  it("requires this run's nightly", () => {
    expect(nightlyManifestProblems({ channel: "nightly", version, commit }, { version, commit })).toEqual([]);
    expect(nightlyManifestProblems({ channel: "release", version, commit }, { version, commit })).toHaveLength(1);
    expect(nightlyManifestProblems({ channel: "nightly", version: "1.2.4", commit }, { version: "1.2.4", commit })).toHaveLength(1);
    expect(nightlyManifestProblems({ channel: "nightly", version, commit: "d".repeat(40) }, { version, commit })).toHaveLength(1);
  });
  it("tags nightlies outside the v* release namespace", () => {
    expect(nightlyTag(version)).toBe("nightly-1.2.4-nightly.20261110.42");
  });
});

describe("nightliesToPrune", () => {
  const r = (tagName: string, createdAt: string, o: { isPrerelease?: boolean; isDraft?: boolean } = {}) => ({ tagName, createdAt, isPrerelease: o.isPrerelease ?? true, isDraft: o.isDraft ?? false });
  it("keeps the newest n nightlies and never touches anything else", () => {
    const list = [
      r("nightly-a", "2026-11-01T00:00:00Z"),
      r("nightly-c", "2026-11-03T00:00:00Z"),
      r("v1.2.3", "2026-10-01T00:00:00Z"),
      r("v1.3.0", "2026-10-02T00:00:00Z", { isPrerelease: true }),
      r("nightly-b", "2026-11-02T00:00:00Z"),
      r("nightly-draft", "2026-10-01T00:00:00Z", { isDraft: true }),
      r("nightly-stable?", "2026-10-01T00:00:00Z", { isPrerelease: false }),
    ];
    expect(nightliesToPrune(list, 2)).toEqual(["nightly-a"]);
    expect(nightliesToPrune(list, 10)).toEqual([]);
    expect(() => nightliesToPrune(list, 0)).toThrow();
  });
});
