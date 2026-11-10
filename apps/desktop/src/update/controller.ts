/**
 * The in-app updater, wired into Electron's main process (main.ts owns the menus and calls in).
 * All of its state lives under `<userData>/updates/`; the server and the wire protocol know
 * nothing about it.
 *
 *   check (check.ts: signed manifest, policy) → offer (dialog / notification) → user accepts →
 *   download (streamed, size + SHA-256 against the manifest) → unpack + verify the bundle
 *   (macos.ts) in a private directory → start the helper (helper.ts: the install engine) → it
 *   takes the install lock, copies the bundle to the shared staged path, quits Apollo,
 *   swaps, relaunches, checks health, rolls back if needed → the next Apollo to start reads
 *   the outcome (reconcile) and never re-offers a build that was rolled back.
 *
 * macOS updates in place. Windows (P1) checks the same signed manifest, then sends the user to
 * the release page to run the installer: `applyStrategy` is where a silent NSIS hand-off goes.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dialog, Notification, shell } from "electron";
import { isInstallerPid } from "../install/mac.ts";
import { launchEnv, realFileOps } from "../install/lib.ts";
import { checkForUpdate, type CheckResult, type Offer } from "./check.ts";
import { downloadVerified } from "./github.ts";
import { bundlesFor, classifyOutcome, JOB_FORMAT, parseJob, parseProgress, summarizeResult, type UpdateJob } from "./helperCore.ts";
import { RELEASES_REPO, TEAM_ID, trustedKeys, type TrustedKeys } from "./keys.ts";
import { realExec, verifyFromZip } from "./macos.ts";
import type { RunningBuild } from "./policy.ts";
import { afterCheck, nextCheckAt, parseState, type UpdaterState, withSkipped } from "./state.ts";

export type UpdatePhase =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | { readonly kind: "available"; readonly offer: Offer }
  | { readonly kind: "downloading"; readonly percent: number }
  | { readonly kind: "installing" };

export interface UpdaterOptions {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  /** app.getAppPath(): where dist-electron is (inside app.asar when packaged). */
  readonly appPath: string;
  readonly userData: string;
  readonly dataDir: string;
  /** Called whenever the menu label may have changed. */
  readonly onChange: () => void;
  /** Quit the app for the update (the helper asked). */
  readonly quit: () => void;
  /** How many bots are mid-turn now (the update waits for them). */
  readonly busyBots: () => number;
  readonly keys?: TrustedKeys;
}

/** Whether the update helper waits for busy bots before giving up (Apollo then stays as it is). */
const WAIT_FOR_BOTS_MS = 30 * 60_000;
/** The only place an in-place macOS update is done: install:app's location, sharing its lock and marker. */
const MAC_TARGET = "/Applications/Apollo.app";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const log = (line: string) => console.log(`[updater] ${line}`);

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** An own data property, without running getters or reading inherited (`__proto__`) values. */
const own = (o: unknown, key: string): unknown => {
  if (typeof o !== "object" || o === null) return undefined;
  const d = Object.getOwnPropertyDescriptor(o, key);
  return d && "value" in d ? d.value : undefined;
};

/** `pragma user_version` only (a full integrity check on a live database is too slow for the main thread). */
const dbSchema = (path: string): number | null => {
  if (!existsSync(path)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    return (db.prepare("pragma user_version").get() as { user_version: number }).user_version;
  } catch {
    return null;
  } finally {
    db?.close();
  }
};

/** Recursively copies the *.js files of `from` to `to` (Electron's fs reads app.asar; fs.cp may not). */
const copyJs = (from: string, to: string) => {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyJs(join(from, entry.name), join(to, entry.name));
    else if (entry.name.endsWith(".js")) writeFileSync(join(to, entry.name), readFileSync(join(from, entry.name)));
  }
};

export class Updater {
  readonly #o: UpdaterOptions;
  readonly #keys: TrustedKeys;
  readonly #dir: string;
  #phase: UpdatePhase = { kind: "idle" };
  #state: UpdaterState;
  #running: RunningBuild | null;
  #checking: Promise<CheckResult> | null = null;
  #timer: NodeJS.Timeout | null = null;
  #helper: ChildProcess | null = null;
  readonly #notifications = new Set<Notification>();

  /** Never throws: whatever is on disk, a broken updater must not keep Apollo from starting. */
  constructor(o: UpdaterOptions) {
    this.#o = o;
    this.#dir = join(o.userData, "updates");
    let keys: TrustedKeys;
    try {
      keys = o.keys ?? trustedKeys();
    } catch (error) {
      keys = { configured: false, reason: message(error) };
    }
    this.#keys = keys;
    // parseState never throws; runningBuild reads only exact types.
    this.#state = parseState(this.#read("state.json"));
    let running: RunningBuild | null = null;
    try {
      running = this.#runningBuild();
    } catch (error) {
      log(`cannot read build-info.json: ${message(error)}`);
    }
    this.#running = running;
  }

  get phase(): UpdatePhase {
    return this.#phase;
  }

  /** The label of the menu / tray entry. */
  menuLabel(): string {
    const p = this.#phase;
    if (p.kind === "checking") return "Checking for Updates…";
    if (p.kind === "available") return `Install Apollo ${p.offer.manifest.version}…`;
    if (p.kind === "downloading") return `Downloading Update… ${p.percent}%`;
    if (p.kind === "installing") return "Installing Update…";
    return "Check for Updates…";
  }

  menuEnabled(): boolean {
    return this.#phase.kind === "idle" || this.#phase.kind === "available";
  }

  /** Background checks only when everything needed is there: keys, a packaged app, a build number. */
  get #automatic(): boolean {
    return this.#keys.configured && this.#o.isPackaged && this.#running?.build != null && (process.platform === "darwin" || process.platform === "win32");
  }

  /** Never throws (see the constructor). */
  start() {
    try {
      if (!this.#keys.configured) log(`inert: ${this.#keys.reason}`);
      else for (const note of this.#keys.notes) log(note);
      this.#reconcile();
      if (this.#automatic) this.#schedule(true);
    } catch (error) {
      log(`could not start: ${message(error)}`);
    }
  }

  /** The menu entry was clicked. */
  menuClicked() {
    if (this.#phase.kind === "available") void this.#offer(this.#phase.offer);
    else if (this.#phase.kind === "idle") void this.check(true);
  }

  // -------------------------------------------------------------------------------------
  // Checking

  #schedule(startup: boolean) {
    if (this.#timer) clearTimeout(this.#timer);
    const at = nextCheckAt(this.#state, Date.now(), Math.random(), startup);
    this.#timer = setTimeout(() => void this.check(false), Math.max(0, at - Date.now()));
    this.#timer.unref();
  }

  /** One check (single-flight). Manual checks always report; background ones only offer. */
  async check(manual: boolean): Promise<CheckResult | null> {
    if (!manual && !this.#automatic) return null;
    if (manual) {
      const why = this.#cannotCheck();
      if (why) {
        await this.#info(why.title, why.detail);
        return null;
      }
    }
    if (this.#phase.kind === "downloading" || this.#phase.kind === "installing") return null;
    this.#checking ??= this.#doCheck().finally(() => {
      this.#checking = null;
    });
    const result = await this.#checking;
    if (manual) await this.#report(result);
    else if (result.kind === "available" && this.#state.notifiedBuild !== result.offer.manifest.build) this.#notifyAvailable(result.offer);
    return result;
  }

  #cannotCheck(): { title: string; detail: string } | null {
    if (!this.#keys.configured) return { title: "Updates are not configured yet", detail: `This build of Apollo can't verify releases: ${this.#keys.reason}.` };
    if (!this.#o.isPackaged) return { title: "Updates are only available in the installed app", detail: "This is a development run." };
    if (!this.#running) return { title: "Can't check for updates", detail: "This build does not say what version it is (build-info.json is missing)." };
    if (this.#running.build === null) return { title: "This build is not updated automatically", detail: `Apollo ${this.#running.version} is a local build without a build number. Install a release from ${`https://github.com/${RELEASES_REPO}/releases`}.` };
    return null;
  }

  async #doCheck(): Promise<CheckResult> {
    const previous = this.#phase;
    this.#setPhase({ kind: "checking" });
    const result = await checkForUpdate({
      fetchFn: (input, init) => fetch(input, init),
      keys: this.#keys,
      running: this.#running!,
      teamId: TEAM_ID,
      skipped: this.#state.skipped,
      dbSchema: dbSchema(join(this.#o.dataDir, "apollo.db")),
      now: Date.now(),
    });
    log(`check: ${result.kind}${result.kind === "refused" ? ` (${result.reason})` : result.kind === "error" ? ` (${result.message})` : result.kind === "available" ? ` ${result.offer.manifest.version}` : ""}`);
    this.#saveState(afterCheck(this.#state, result, Date.now()));
    this.#setPhase(result.kind === "available" ? { kind: "available", offer: result.offer } : previous.kind === "available" && result.kind === "error" ? previous : { kind: "idle" });
    if (this.#automatic) this.#schedule(false);
    return result;
  }

  async #report(r: CheckResult) {
    const current = this.#running?.version ?? "?";
    switch (r.kind) {
      case "available":
        return this.#offer(r.offer);
      case "not-configured":
        return this.#info("Updates are not configured yet", r.reason);
      case "no-release":
        return this.#info("No release yet", `No stable release of Apollo has been published yet. You have ${current}.`);
      case "up-to-date":
        return this.#info("Apollo is up to date", `You have ${current}${r.latest ? `; the latest release is ${r.latest}` : ""}.`);
      case "skipped":
        return this.#info("No update offered", `Apollo ${r.version} failed its health check on this computer and was rolled back, so it is not offered again. The next release will be.`);
      case "rate-limited":
        return this.#info("Try again later", `GitHub's limit for anonymous requests was reached. Try again after ${new Date(r.retryAt).toLocaleTimeString()}.`);
      case "refused":
        return this.#info("Update not installed", `A release was found, but it can't be installed: ${r.reason}.`, "warning");
      case "error":
        return this.#info("Couldn't check for updates", r.message, "warning");
    }
  }

  // -------------------------------------------------------------------------------------
  // Offering and installing

  #notifyAvailable(offer: Offer) {
    this.#saveState({ ...this.#state, notifiedBuild: offer.manifest.build });
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: `Apollo ${offer.manifest.version} is available`, body: "Click to see the update." });
    this.#notifications.add(n);
    n.on("click", () => {
      this.#notifications.delete(n);
      if (this.#phase.kind === "available") void this.#offer(this.#phase.offer);
    });
    n.on("close", () => this.#notifications.delete(n));
    n.show();
  }

  /** Where to update: in place (macOS, from /Applications), or by hand from the release page. */
  #applyStrategy(): { kind: "in-place"; target: string } | { kind: "manual"; why: string } {
    if (process.platform === "win32") return { kind: "manual", why: "Installing updates automatically is not available on Windows yet: download the installer and run it." };
    if (process.platform !== "darwin") return { kind: "manual", why: `Updates are not installed automatically on ${process.platform}.` };
    const target = process.execPath.slice(0, process.execPath.indexOf(".app/") + 4);
    if (target !== MAC_TARGET) return { kind: "manual", why: `Apollo updates itself only when it runs from ${MAC_TARGET} (this one runs from ${target || process.execPath}). Move it there, or install the update by hand.` };
    try {
      accessSync(dirname(target), constants.W_OK);
    } catch {
      return { kind: "manual", why: `Apollo can't write to ${dirname(target)}. Install the update by hand.` };
    }
    return { kind: "in-place", target };
  }

  async #offer(offer: Offer) {
    const m = offer.manifest;
    const strategy = this.#applyStrategy();
    const page = `https://github.com/${RELEASES_REPO}/releases/tag/${encodeURIComponent(offer.release.tag)}`;
    const notes = m.notes.trim() ? `\n\n${m.notes.trim().slice(0, 1500)}` : "";
    if (strategy.kind === "manual") {
      const { response } = await dialog.showMessageBox({
        type: "info",
        message: `Apollo ${m.version} is available`,
        detail: `You have ${this.#running?.version}. ${strategy.why}${notes}`,
        buttons: ["Open Download Page", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) void shell.openExternal(page);
      return;
    }
    const busy = this.#o.busyBots();
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: `Apollo ${m.version} is available`,
      detail:
        `You have ${this.#running?.version}. Apollo downloads ${Math.round(offer.asset.size / 1e6)} MB, checks it, then restarts into the new version. ` +
        `If the new version doesn't start properly, Apollo goes back to this one.` +
        (busy > 0 ? `\n\n${busy} bot${busy === 1 ? " is" : "s are"} working: the restart waits until they finish (up to ${WAIT_FOR_BOTS_MS / 60_000} minutes).` : "") +
        notes,
      buttons: ["Install and Restart", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
    await this.#install(offer, strategy.target);
  }

  async #install(offer: Offer, target: string) {
    if (this.#phase.kind === "downloading" || this.#phase.kind === "installing") return;
    const m = offer.manifest;
    const id = `${m.build}-${Date.now()}`;
    const work = join(this.#dir, "work", id);
    const job: UpdateJob = {
      format: JOB_FORMAT,
      id,
      createdAt: Date.now(),
      version: m.version,
      build: m.build,
      commit: m.commit,
      schemaVersion: m.schemaVersion,
      bundles: bundlesFor(target),
      dataDir: this.#o.dataDir,
      resultPath: join(this.#dir, "last-result.json"),
      // The verified bundle stays in this private directory; only the helper, holding the
      // install lock, copies it to the shared staged path (helperCore.ts).
      source: join(work, "unpacked", "Apollo.app"),
      progressPath: join(this.#dir, "progress.json"),
      logPath: join(this.#dir, "logs", `helper-${id}.log`),
      waitTimeoutMs: WAIT_FOR_BOTS_MS,
      teamId: TEAM_ID,
    };
    // An earlier job not reconciled yet (its helper may still run from its work directory).
    if (existsSync(join(this.#dir, "job.json"))) {
      await this.#info("An update is already under way", "Apollo will tell you when it is done.");
      return;
    }
    try {
      // Leftovers of earlier attempts (no job is pending, so nothing uses them).
      realFileOps.remove(join(this.#dir, "work"));
      mkdirSync(work, { recursive: true });
      const zip = join(work, offer.asset.name);
      let last = -1;
      this.#setPhase({ kind: "downloading", percent: 0 });
      await downloadVerified({
        fetchFn: (input, init) => fetch(input, init),
        url: offer.url,
        path: zip,
        expected: { size: offer.asset.size, sha256: offer.asset.sha256 },
        onProgress: (received, total) => {
          const percent = Math.floor((received / total) * 100);
          if (percent !== last) {
            last = percent;
            this.#setPhase({ kind: "downloading", percent });
          }
        },
      });
      this.#setPhase({ kind: "installing" });
      const source = await verifyFromZip({ zip, workDir: work, job, exec: realExec, files: realFileOps });
      if (source !== job.source) throw new Error(`verified bundle at ${source}, expected ${job.source}`);
      realFileOps.remove(zip);
      this.#startHelper(job);
    } catch (error) {
      // Only our private directory: the shared staged path belongs to whoever holds the lock.
      realFileOps.remove(work);
      log(`install failed: ${message(error)}`);
      this.#setPhase({ kind: "available", offer });
      await this.#info("The update could not be installed", `${message(error)}\n\nNothing was changed.`, "warning");
    }
  }

  #startHelper(job: UpdateJob) {
    const runner = join(this.#dir, "apollo-update-helper");
    realFileOps.remove(runner);
    copyJs(join(this.#o.appPath, "dist-electron"), runner);
    writeFileSync(join(runner, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
    mkdirSync(dirname(job.logPath), { recursive: true });
    realFileOps.remove(job.resultPath);
    realFileOps.remove(job.progressPath);
    const jobPath = join(this.#dir, "job.json");
    realFileOps.writeText(jobPath, `${JSON.stringify(job, null, 2)}\n`);
    const logFd = openSync(job.logPath, "a");
    const child = spawn(process.execPath, [join(runner, "update", "helper.js"), jobPath], {
      detached: true,
      cwd: "/",
      stdio: ["ignore", logFd, logFd, "ipc"],
      env: { ...launchEnv(process.env), ELECTRON_RUN_AS_NODE: "1" },
    });
    this.#helper = child;
    if (child.pid) realFileOps.writeText(join(this.#dir, "helper.pid"), `${child.pid}\n`);
    log(`helper ${child.pid} started; log ${job.logPath}`);
    child.on("message", (msg: unknown) => {
      if ((msg as { type?: string } | null)?.type === "apollo-update-quit") {
        log("the helper asks Apollo to quit for the update");
        this.#o.quit();
      }
    });
    child.on("error", (error) => {
      // It could not start (an exit may never come): read what is there, so the job is cleared.
      log(`helper error: ${message(error)}`);
      if (this.#helper !== child) return;
      this.#helper = null;
      this.#setPhase({ kind: "idle" });
      this.#reconcile();
    });
    // Still running when it exits: it gave up before stopping Apollo (busy bots, lock, bad bundle).
    child.on("exit", () => {
      if (this.#helper !== child) return;
      this.#helper = null;
      this.#setPhase({ kind: "idle" });
      this.#reconcile();
    });
    child.unref();
  }

  // -------------------------------------------------------------------------------------
  // After an update: what happened, told once

  #reconcile() {
    try {
      this.#reconcileJob();
    } catch (error) {
      log(`could not read the last update's outcome: ${message(error)}`);
    }
  }

  #reconcileJob() {
    const jobPath = join(this.#dir, "job.json");
    const text = readText(jobPath);
    if (text === null) return;
    let job: UpdateJob;
    try {
      job = parseJob(text);
    } catch (error) {
      // Damaged: nothing can be attributed to a build. Clear it so updates can go on.
      log(`discarding a damaged job file: ${message(error)}`);
      for (const file of [jobPath, join(this.#dir, "helper.pid")]) realFileOps.remove(file);
      return;
    }
    const pid = Number(this.#read("helper.pid") ?? NaN);
    let alive = this.#helper !== null;
    if (!alive && Number.isSafeInteger(pid) && pid > 0) {
      try {
        alive = isInstallerPid(pid);
      } catch {
        alive = true; // cannot tell: look again later
      }
    }
    const result = summarizeResult(readText(job.resultPath));
    const progress = parseProgress(readText(job.progressPath), job.id);
    const outcome = classifyOutcome(job, result, progress, this.#running?.build ?? null, alive);
    if (outcome.kind === "pending") {
      setTimeout(() => this.#reconcile(), 10_000).unref();
      return;
    }
    log(`update ${job.version} (build ${job.build}): ${outcome.kind}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
    if (outcome.kind === "updated") this.#notify(`Apollo was updated to ${job.version}`, "The new version passed its health check.");
    else if (outcome.kind === "postponed") this.#notify("The update was postponed", `${outcome.reason}. Apollo was not changed.`);
    else {
      if (outcome.skip) this.#saveState(withSkipped(this.#state, job.build, this.#running?.build ?? null));
      this.#notify(
        `The update to ${job.version} did not work`,
        outcome.skip ? `Apollo went back to the previous version and won't offer ${job.version} again. ${outcome.reason}` : `${outcome.reason}. Details: ${job.logPath}`,
      );
    }
    for (const file of [jobPath, join(this.#dir, "helper.pid"), job.progressPath]) realFileOps.remove(file);
    realFileOps.remove(join(this.#dir, "work"));
    realFileOps.remove(join(this.#dir, "apollo-update-helper"));
  }

  // -------------------------------------------------------------------------------------

  #runningBuild(): RunningBuild | null {
    let info: unknown;
    try {
      info = JSON.parse(readText(join(this.#o.resourcesPath, "build-info.json")) ?? "null");
    } catch {
      return null;
    }
    const version = own(info, "version");
    const schemaVersion = own(info, "schemaVersion");
    const channel = own(info, "channel");
    const bundleVersion = own(info, "bundleVersion");
    const arch = own(info, "arch");
    if (typeof version !== "string" || typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion)) return null;
    const build = typeof bundleVersion === "string" && /^[1-9]\d{0,15}$/.test(bundleVersion) ? Number(bundleVersion) : null;
    return {
      version,
      channel: channel === "release" || channel === "nightly" ? channel : "local",
      build: build !== null && Number.isSafeInteger(build) ? build : null,
      schemaVersion,
      platform: process.platform,
      arch: typeof arch === "string" && arch ? arch : process.arch,
      osVersion: process.getSystemVersion(),
    };
  }

  #read(name: string): string | null {
    try {
      return readFileSync(join(this.#dir, name), "utf8");
    } catch {
      return null;
    }
  }

  #saveState(state: UpdaterState) {
    this.#state = state;
    try {
      mkdirSync(this.#dir, { recursive: true });
      realFileOps.writeText(join(this.#dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    } catch (error) {
      log(`could not save state: ${message(error)}`);
    }
  }

  #setPhase(phase: UpdatePhase) {
    this.#phase = phase;
    this.#o.onChange();
  }

  async #info(title: string, detail: string, type: "info" | "warning" = "info") {
    await dialog.showMessageBox({ type, message: title, detail, buttons: ["OK"] });
  }

  #notify(title: string, body: string) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    this.#notifications.add(n);
    n.on("close", () => this.#notifications.delete(n));
    n.on("click", () => this.#notifications.delete(n));
    n.show();
  }
}
