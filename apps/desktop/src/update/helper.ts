/**
 * The updater's helper process: `<Apollo.app>/Contents/MacOS/apollo <runner>/update/helper.js
 * <job.json>` with ELECTRON_RUN_AS_NODE=1, detached (its own session), started by the app once
 * the release is downloaded, verified and staged. It runs the install engine (helperCore.ts) and
 * exits. Its files are copied out of app.asar into `<userData>/updates/apollo-update-helper/`
 * first, so the bundle it came from can be moved while it runs; that directory name is also how
 * the shared install lock recognizes it (src/install/mac.ts INSTALLER_MARKERS).
 *
 * It must not import electron: it runs as plain Node.
 */
import { readFileSync } from "node:fs";
import { runInstall } from "../install/engine.ts";
import { launchInstalled, realFileOps, realSqliteOps } from "../install/lib.ts";
import { busySessions, classifyApollo, installedHealthy, isInstallerPid, processes } from "../install/mac.ts";
import { helperDeps, parseJob, type HelperEffects } from "./helperCore.ts";
import { checkSignature, realExec } from "./macos.ts";

const log = (line: string) => console.log(line);

const main = async () => {
  const jobPath = process.argv[2];
  if (!jobPath) throw new Error("usage: helper.js <job.json>");
  const job = parseJob(readFileSync(jobPath, "utf8"));
  log(`Apollo updater helper ${process.pid}: installing ${job.version} (build ${job.build}, ${job.commit.slice(0, 10)}) at ${job.bundles.target}`);
  let holding = false;
  const fx: HelperEffects = {
    files: realFileOps,
    sqlite: realSqliteOps,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
    apollo: () => classifyApollo(processes(), job.bundles, { self: process.pid }),
    requestQuit: (procs) => {
      // The app that started us listens on the IPC channel; otherwise SIGTERM, which Electron
      // handles as a normal quit. Stragglers are SIGKILLed by the engine after its grace period.
      let asked = false;
      if (process.connected && process.send) {
        try {
          process.send({ type: "apollo-update-quit" });
          asked = true;
        } catch {
          asked = false;
        }
      }
      if (!asked) {
        for (const p of procs.filter((p) => p.kind === "installed")) {
          try {
            process.kill(p.pid, "SIGTERM");
          } catch {
            // gone
          }
        }
      }
    },
    kill: (pid) => process.kill(pid, "SIGKILL"),
    isInstaller: (pid) => isInstallerPid(pid),
    busy: busySessions,
    launch: (target, strategy) => launchInstalled(target, strategy),
    healthy: installedHealthy,
    holdSignals: () => {
      if (holding) return;
      holding = true;
      for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, () => log(`  (${signal} ignored: the update is under way)`));
    },
    checkSignature: (bundle, teamId) => checkSignature(realExec, bundle, teamId),
    pid: process.pid,
  };
  const result = await runInstall(helperDeps(job, fx));
  log(`Done: ${result.status} at stage ${result.stage}${result.error ? `: ${result.error}` : ""}`);
  process.disconnect?.();
  process.exit(result.status === "ok" ? 0 : 1);
};

// The IPC channel (if any) must not keep us alive or tie us to the app.
process.channel?.unref();
process.on("disconnect", () => log("  (the app closed its channel)"));
main().catch((error: unknown) => {
  log(`Updater helper failed before installing anything: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(2);
});
