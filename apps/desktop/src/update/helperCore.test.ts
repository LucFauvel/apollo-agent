/**
 * The apply step: the real install engine, driven through helperDeps, against a simulated Mac
 * (bundles are directories in a temporary "Applications", a real SQLite database, fake
 * processes, launches, /health and clock). Nothing here touches /Applications or ~/.apollo.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runInstall, type Proc } from "../install/engine.ts";
import { type InstallResult, type LaunchAttempt, realFileOps, realSqliteOps } from "../install/lib.ts";
import { bundlesFor, classifyOutcome, helperDeps, type HelperEffects, JOB_FORMAT, parseJob, stagedProblems, type UpdateJob } from "./helperCore.ts";
import { checkSignature, developerIdRequirement, type Exec, stageFromZip } from "./macos.ts";
import { COMMIT, TEAM } from "./testing/fixtures.ts";

const makeDb = (path: string, version: number) => {
  const db = new DatabaseSync(path);
  db.exec(`create table if not exists t (v integer); pragma user_version = ${version}`);
  db.close();
};

interface Bundle {
  readonly commit: string;
  readonly version: string;
  readonly build: number;
  readonly schema: number;
  /** How the app behaves when launched. */
  readonly health: "good" | "bad";
}

const OLD: Bundle = { commit: "f".repeat(40), version: "1.2.0", build: 400, schema: 20, health: "good" };
const NEW: Bundle = { commit: COMMIT, version: "1.3.0", build: 500, schema: 21, health: "good" };

const world = (o: { readonly next?: Bundle; readonly signature?: string | null; readonly stagedInfo?: Record<string, unknown> } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "updater-apply-"));
  const apps = join(root, "Applications");
  const data = join(root, "data");
  const userData = join(root, "userData");
  for (const d of [apps, data, userData]) mkdirSync(d);
  const bundles = bundlesFor(join(apps, "Apollo.app"));
  const write = (path: string, b: Bundle, info?: Record<string, unknown>) => {
    mkdirSync(join(path, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(path, "Contents", "spec.json"), JSON.stringify(b));
    const buildInfo = { commit: b.commit, dirty: false, branch: null, schemaVersion: b.schema, builtAt: `${b.build}`, version: b.version, channel: "release", bundleVersion: String(b.build), arch: "arm64" };
    writeFileSync(join(path, "Contents", "Resources", "build-info.json"), JSON.stringify({ ...buildInfo, ...info }));
  };
  write(bundles.target, OLD);
  const next = o.next ?? NEW;
  write(bundles.staged, next, o.stagedInfo);
  const dbPath = join(data, "apollo.db");
  makeDb(dbPath, OLD.schema);

  let pid = 100;
  let t = 0;
  const w = {
    bundles,
    dbPath,
    procs: [] as Array<Proc>,
    running: null as Bundle | null,
    launched: [] as Array<string>,
    quits: 0,
    logs: [] as Array<string>,
    start() {
      const spec = JSON.parse(readFileSync(join(bundles.target, "Contents", "spec.json"), "utf8")) as Bundle;
      w.running = spec;
      w.launched.push(spec.version);
      w.procs = [{ pid: pid++, kind: "installed" }, { pid: pid++, kind: "server" }];
      // A build migrates the database when it starts.
      makeDb(dbPath, Math.max(realSqliteOps.inspect(dbPath)?.version ?? 0, spec.schema));
    },
    stop() {
      w.running = null;
      w.procs = [];
    },
  };
  w.start();
  w.launched.length = 0;

  const job: UpdateJob = {
    format: JOB_FORMAT,
    id: "500-1",
    createdAt: 0,
    version: NEW.version,
    build: NEW.build,
    commit: NEW.commit,
    schemaVersion: NEW.schema,
    bundles,
    dataDir: data,
    resultPath: join(userData, "last-result.json"),
    logPath: join(userData, "helper.log"),
    waitTimeoutMs: 60_000,
    teamId: TEAM,
  };
  const fx: HelperEffects = {
    files: realFileOps,
    sqlite: realSqliteOps,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    log: (line) => void w.logs.push(line),
    apollo: () => [...w.procs],
    requestQuit: () => {
      w.quits++;
      w.stop();
    },
    kill: () => w.stop(),
    isInstaller: () => false,
    busy: () => [],
    launch: async (_target, strategy): Promise<LaunchAttempt> => {
      if (!w.running) w.start();
      return { strategy, command: "/usr/bin/open", args: [], status: 0, signal: null, stderr: "", error: null, pid: null, spawned: false };
    },
    healthy: async () => w.running?.health === "good",
    holdSignals: () => {},
    checkSignature: async () => (o.signature === undefined ? null : o.signature),
    pid: 1,
  };
  const installed = () => JSON.parse(readFileSync(join(bundles.target, "Contents", "Resources", "build-info.json"), "utf8")) as { version: string };
  return { w, job, fx, installed, data };
};

describe("applying an update with the install engine", () => {
  it("swaps in the verified build, relaunches it, and keeps it once healthy", async () => {
    const { w, job, fx, installed } = world();
    const result = await runInstall(helperDeps(job, fx));
    expect(result.status).toBe("ok");
    expect(installed().version).toBe("1.3.0");
    expect(existsSync(job.bundles.previous)).toBe(false);
    expect(existsSync(job.bundles.staged)).toBe(false);
    expect(w.quits).toBe(1);
    expect(w.launched).toEqual(["1.3.0"]);
    expect(classifyOutcome(job, result, 500, false)).toEqual({ kind: "updated" });
  });

  it("rolls back to the previous build and database when the new build fails its health check, and skips that build", async () => {
    const { w, job, fx, installed } = world({ next: { ...NEW, health: "bad" } });
    const result = await runInstall(helperDeps(job, fx));
    expect(result.status).toBe("rolled-back");
    expect(installed().version).toBe("1.2.0");
    // The failed build is kept aside to look at; the database is back at the old schema.
    expect(existsSync(job.bundles.failed)).toBe(true);
    expect(realSqliteOps.inspect(w.dbPath)?.version).toBe(20);
    // One launch of the new build, one of the previous: no loop.
    expect(w.launched).toEqual(["1.3.0", "1.2.0"]);
    const outcome = classifyOutcome(job, result, 400, false);
    expect(outcome).toMatchObject({ kind: "failed", skip: true });
  });

  it("refuses a staged bundle that is not the signed release, before stopping Apollo", async () => {
    for (const stagedInfo of [{ commit: "e".repeat(40) }, { bundleVersion: "499" }, { channel: "nightly" }, { schemaVersion: 22 }]) {
      const { w, job, fx, installed } = world({ stagedInfo });
      const result = await runInstall(helperDeps(job, fx));
      expect(result.status, JSON.stringify(stagedInfo)).toBe("failed");
      expect(result.stage).toBe("build");
      expect(installed().version).toBe("1.2.0");
      expect(w.quits).toBe(0);
      expect(existsSync(job.bundles.staged)).toBe(false);
    }
  });

  it("refuses a staged bundle whose code signature does not check out", async () => {
    const { w, job, fx, installed } = world({ signature: "codesign: a sealed resource is missing or invalid" });
    const result = await runInstall(helperDeps(job, fx));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/code signature/);
    expect(installed().version).toBe("1.2.0");
    expect(w.quits).toBe(0);
  });

  it("refuses to install a build that cannot read the database (schema gate)", async () => {
    const { job, fx, installed, data } = world();
    makeDb(join(data, "apollo.db"), 25);
    const result = await runInstall(helperDeps(job, fx));
    expect(result.status).toBe("aborted");
    expect(installed().version).toBe("1.2.0");
  });
});

describe("parseJob", () => {
  const { job } = world();

  it("round-trips a valid job", () => {
    expect(parseJob(JSON.stringify(job))).toEqual(job);
  });

  it("refuses bundle paths other than the four fixed names next to the app", () => {
    expect(() => parseJob(JSON.stringify({ ...job, bundles: { ...job.bundles, previous: "/tmp/elsewhere.app" } }))).toThrow(/bundles/);
    expect(() => parseJob(JSON.stringify({ ...job, bundles: bundlesFor("/Users/x/Evil.app") }))).toThrow(/bundles.target/);
    expect(() => parseJob(JSON.stringify({ ...job, dataDir: "relative" }))).toThrow(/dataDir/);
    expect(() => parseJob(JSON.stringify({ ...job, commit: "abc" }))).toThrow(/commit/);
  });
});

describe("classifyOutcome", () => {
  const job = { build: 500, commit: COMMIT, createdAt: Date.parse("2026-11-09T10:00:00Z") };
  const result = (over: Partial<InstallResult>): InstallResult => ({
    status: "ok",
    stage: "healthy",
    build: { commit: COMMIT, dirty: false, branch: null, schemaVersion: 21, builtAt: "x" },
    startedAt: "2026-11-09T10:00:01Z",
    finishedAt: null,
    error: null,
    manual: null,
    log: null,
    pid: 1,
    snapshot: null,
    launches: [],
    ...over,
  });

  it("waits while the helper runs", () => {
    expect(classifyOutcome(job, null, 400, true)).toEqual({ kind: "pending" });
  });

  it("is postponed (not skipped) when the install never started (bots busy, lock held)", () => {
    expect(classifyOutcome(job, result({ status: "aborted", stage: "wait-idle", error: "Bots still busy" }), 400, false)).toEqual({ kind: "postponed", reason: "Bots still busy" });
  });

  it("does not hold a failure before the swap against the build", () => {
    expect(classifyOutcome(job, result({ status: "failed", stage: "quit" }), 400, false)).toMatchObject({ kind: "failed", skip: false });
    expect(classifyOutcome(job, result({ status: "failed", stage: "reopen" }), 400, false)).toMatchObject({ kind: "failed", skip: false });
  });

  it("does not blame the build when the run only recovered an earlier interrupted install", () => {
    expect(classifyOutcome(job, result({ status: "rolled-back", stage: "recovered", build: null }), 400, false)).toMatchObject({ kind: "failed", skip: false });
  });

  it("ignores a result older than the job", () => {
    expect(classifyOutcome(job, result({ startedAt: "2026-11-08T00:00:00Z" }), 400, false)).toMatchObject({ kind: "failed", skip: false });
  });

  it("skips the build when the helper died after the swap and the old build runs", () => {
    expect(classifyOutcome(job, result({ status: "running", stage: "relaunch" }), 400, false)).toMatchObject({ kind: "failed", skip: true });
    expect(classifyOutcome(job, result({ status: "running", stage: "relaunch" }), 500, false)).toEqual({ kind: "updated" });
  });
});

describe("macOS bundle checks", () => {
  const fakeExec = (handler: (cmd: string, args: ReadonlyArray<string>) => { status: number; stdout?: string; stderr?: string }): { exec: Exec; calls: Array<string> } => {
    const calls: Array<string> = [];
    return {
      calls,
      exec: async (cmd, args) => {
        calls.push(`${cmd} ${args.join(" ")}`);
        const r = handler(cmd, args);
        return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      },
    };
  };

  it("pins the Developer ID requirement to the team", async () => {
    const { exec, calls } = fakeExec(() => ({ status: 0 }));
    expect(await checkSignature(exec, "/x/Apollo.app", TEAM)).toBeNull();
    expect(calls[0]).toContain(`-R=${developerIdRequirement(TEAM)}`);
    expect(developerIdRequirement(TEAM)).toContain(`certificate leaf[subject.OU] = "${TEAM}"`);
    expect(await checkSignature(fakeExec(() => ({ status: 3, stderr: "test-requirement: code failed to satisfy specified code requirement(s)" })).exec, "/x", TEAM)).toMatch(/failed to satisfy/);
    expect(await checkSignature(exec, "/x", 'X" or true')).toMatch(/invalid team/);
  });

  it("stages only one Apollo.app of this release, and cleans up what it staged on failure", async () => {
    const { job } = world();
    const work = mkdtempSync(join(tmpdir(), "updater-stage-"));
    const app = (out: string) => join(out, "Apollo.app");
    const unzipWith = (info: Record<string, unknown>, extra = false) =>
      fakeExec((cmd, args) => {
        if (cmd === "/usr/bin/ditto" && args[0] === "-x") {
          const out = args[3]!;
          mkdirSync(join(app(out), "Contents", "Resources"), { recursive: true });
          writeFileSync(join(app(out), "Contents", "Resources", "build-info.json"), JSON.stringify({ commit: COMMIT, version: "1.3.0", bundleVersion: "500", schemaVersion: 21, channel: "release", ...info }));
          if (extra) mkdirSync(join(out, "Other.app"));
          return { status: 0 };
        }
        if (cmd === "/usr/bin/plutil") return { status: 0, stdout: args[1] === "CFBundleIdentifier" ? "dev.apollo.desktop\n" : "500\n" };
        if (cmd === "/usr/bin/ditto") {
          mkdirSync(args[1]!, { recursive: true });
          return { status: 0 };
        }
        return { status: 0 };
      });
    realFileOps.remove(job.bundles.staged);
    await stageFromZip({ zip: "z", workDir: work, job, exec: unzipWith({}).exec, files: realFileOps });
    expect(existsSync(job.bundles.staged)).toBe(true);

    realFileOps.remove(job.bundles.staged);
    await expect(stageFromZip({ zip: "z", workDir: work, job, exec: unzipWith({}, true).exec, files: realFileOps })).rejects.toThrow(/not just Apollo.app/);
    await expect(stageFromZip({ zip: "z", workDir: work, job, exec: unzipWith({ commit: "e".repeat(40) }).exec, files: realFileOps })).rejects.toThrow(/not release 1.3.0/);
    expect(existsSync(job.bundles.staged)).toBe(false);
  });
});

describe("stagedProblems", () => {
  it("lists every disagreement", () => {
    expect(stagedProblems(null, NEW as never)).toHaveLength(1);
    expect(stagedProblems({ commit: COMMIT, version: "1.3.0", bundleVersion: "500", schemaVersion: 21, channel: "release" }, { version: "1.3.0", build: 500, commit: COMMIT, schemaVersion: 21 })).toEqual([]);
  });
});

describe("helper.ts", () => {
  it("never imports electron, directly or through its imports (it runs as plain Node)", () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      for (const [, spec] of text.matchAll(/^import [^;]*?from "([^"]+)";/gms)) {
        expect(spec, `${file} imports ${spec}`).not.toBe("electron");
        if (spec!.startsWith(".")) visit(join(file, "..", spec!));
      }
    };
    visit(join(import.meta.dirname, "helper.ts"));
    expect([...seen].map((f) => f.split("/src/")[1])).toEqual(expect.arrayContaining(["update/helper.ts", "install/engine.ts", "install/lib.ts", "install/mac.ts", "update/helperCore.ts", "update/macos.ts"]));
  });
});
