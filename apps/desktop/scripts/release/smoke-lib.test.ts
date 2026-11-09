import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, open, SCHEMA_VERSION } from "../../../server/src/Database.ts";
import { checkMigratedDatabase, seedOldDatabase } from "./smoke-lib.ts";

const fresh = () => join(mkdtempSync(join(tmpdir(), "smoke-lib-")), "apollo.db");
const versionOf = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("pragma user_version").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
};

describe("seedOldDatabase + the server's own migrations", () => {
  it.each([1, Math.max(1, SCHEMA_VERSION - 1)])("seeded at schema %i, open() migrates it and keeps the seed", (version) => {
    const path = fresh();
    seedOldDatabase(path, MIGRATIONS, version);
    expect(versionOf(path)).toBe(version);
    expect(checkMigratedDatabase(path, version)).toEqual([]);
    open(path).close();
    expect(checkMigratedDatabase(path, SCHEMA_VERSION)).toEqual([]);
  });

  it("reports a database that was not migrated", () => {
    const path = fresh();
    seedOldDatabase(path, MIGRATIONS, 1);
    expect(checkMigratedDatabase(path, SCHEMA_VERSION)).toEqual(SCHEMA_VERSION === 1 ? [] : [`schema version 1, expected ${SCHEMA_VERSION}`]);
  });

  it("reports lost rows", () => {
    const path = fresh();
    seedOldDatabase(path, MIGRATIONS, 1);
    const db = new DatabaseSync(path);
    db.exec("pragma foreign_keys = on; delete from memories; delete from bots;");
    db.close();
    const problems = checkMigratedDatabase(path, 1);
    expect(problems).toContain("the seeded bot is gone");
    expect(problems).toContain("the seeded memory is gone");
    expect(problems).toContain("the seeded skill is gone");
  });

  it("refuses versions outside the migrations", () => {
    expect(() => seedOldDatabase(fresh(), MIGRATIONS, 0)).toThrow();
    expect(() => seedOldDatabase(fresh(), MIGRATIONS, MIGRATIONS.length + 1)).toThrow();
  });
});
