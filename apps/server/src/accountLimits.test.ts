import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { UsageLimits } from "@apollo/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Database from "./Database.ts";
import * as Store from "./Store.ts";

const reading = (usedPercent: number, at: number): UsageLimits => ({
  meters: [{ label: "Session", usedPercent, resetsAt: null, severity: null, headline: true }],
  at,
});

describe("account plan limits", () => {
  it("the migration keeps each account's newest reading its sessions had, and clears the sessions'", () => {
    const path = join(mkdtempSync(join(tmpdir(), "apollo-account-limits-db-")), "apollo.db");
    const before = Database.MIGRATIONS.findIndex((m) => m.includes("create table account_limits"));
    expect(before).toBeGreaterThan(0);
    const db = new DatabaseSync(path);
    for (let v = 0; v < before; v++) db.exec(Database.MIGRATIONS[v]!);
    db.exec(`pragma user_version = ${before}`);
    const bot = db.prepare(
      `insert into bots (id, name, instructions, cwd, main_provider, worker_provider, runtime_mode, auto_learn,
         main_session_id, created_at, updated_at, claude_account_id) values (?, ?, '', '/tmp', 'claude', 'codex', 'full-access', 0, ?, 1, 1, ?)`,
    );
    bot.run("bot-a", "Atlas", "s-a1", null);
    bot.run("bot-b", "Io", "s-b1", "acct_work");
    const session = db.prepare(
      `insert into sessions (id, bot_id, role, title, provider, cwd, status, created_at, updated_at, limits)
         values (?, ?, 'main', '', ?, '/tmp', 'idle', 1, 1, ?)`,
    );
    session.run("s-a1", "bot-a", "claude", JSON.stringify(reading(10, 100)));
    session.run("s-a2", "bot-a", "claude", JSON.stringify(reading(40, 300))); // newest of the local login
    session.run("s-b1", "bot-b", "claude", JSON.stringify(reading(70, 200)));
    session.run("s-b2", "bot-b", "codex", JSON.stringify(reading(5, 50))); // the bot's Codex: this machine's login
    session.run("s-b3", "bot-b", "claude", null);
    db.close();

    const migrated = Database.open(path);
    const rows = migrated.prepare("select account, limits, at from account_limits order by account").all();
    const left = migrated.prepare("select count(*) as n from sessions where limits is not null").get();
    migrated.close();
    expect(rows.map((r) => ({ account: r.account, usedPercent: (JSON.parse(r.limits as string) as UsageLimits).meters[0]!.usedPercent, at: r.at }))).toEqual([
      { account: "claude:acct_work", usedPercent: 70, at: 200 },
      { account: "claude:local", usedPercent: 40, at: 300 },
      { account: "codex:local", usedPercent: 5, at: 50 },
    ]);
    expect(left).toEqual({ n: 0 });
  });

  it.effect("keeps the newest reading of each account, and clears one on request", () =>
    Effect.gen(function* () {
      const store = yield* Store.Store;
      expect(yield* store.setAccountLimits("claude:local", reading(10, 200))).toBe(true);
      // A session reporting a reading older than the kept one does not roll it back.
      expect(yield* store.setAccountLimits("claude:local", reading(90, 100))).toBe(false);
      expect(yield* store.setAccountLimits("codex:local", reading(30, 150))).toBe(true);
      expect(yield* store.listAccountLimits).toEqual([
        { account: "claude:local", limits: reading(10, 200) },
        { account: "codex:local", limits: reading(30, 150) },
      ]);
      expect(yield* store.setAccountLimits("claude:local", null)).toBe(true);
      expect(yield* store.setAccountLimits("claude:local", null)).toBe(false);
      expect(yield* store.listAccountLimits).toEqual([{ account: "codex:local", limits: reading(30, 150) }]);
    }).pipe(Effect.provide(Store.layer), Effect.provide(Database.layerMemory)),
  );
});
