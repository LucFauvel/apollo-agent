/**
 * macOS-only steps around the engine: checking a bundle's code signature against the pinned
 * Developer ID team, and turning the verified zip into the staged bundle next to the app.
 * Commands run through an injectable `exec`, so the checks are tested without real bundles.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { FileOps } from "../install/lib.ts";
import { stagedProblems, type UpdateJob } from "./helperCore.ts";

export type Exec = (command: string, args: ReadonlyArray<string>) => Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>;

/** Asynchronous: the app's main process stays responsive while ditto and codesign run. */
export const realExec: Exec = (command, args) =>
  new Promise((resolve) => {
    execFile(command, [...args], { encoding: "utf8", timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolve({ status: error ? (typeof code === "number" ? code : null) : 0, stdout: stdout ?? "", stderr: stderr || (error ? error.message : "") });
    });
  });

export const BUNDLE_ID = "dev.apollo.desktop";

/**
 * A Developer ID Application signature (Apple-anchored, issued under the Developer ID CA) from
 * exactly this team. Ad-hoc and Apple Development signatures fail it.
 */
export const developerIdRequirement = (teamId: string) =>
  `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamId}"`;

/** null when `bundle` is validly signed (deep, strict) by Developer ID of `teamId`; else why not. */
export const checkSignature = async (exec: Exec, bundle: string, teamId: string): Promise<string | null> => {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) return `invalid team id ${teamId}`;
  const r = await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", `-R=${developerIdRequirement(teamId)}`, bundle]);
  return r.status === 0 ? null : `codesign: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${r.status}`}`;
};

const plistValue = async (exec: Exec, app: string, key: string): Promise<string | null> => {
  const r = await exec("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", join(app, "Contents", "Info.plist")]);
  return r.status === 0 ? r.stdout.trim() : null;
};

/**
 * Unpacks the verified zip into `workDir` (fresh, the app's private directory) and checks what
 * came out is one Apollo.app of this release (bundle id, CFBundleVersion, build-info.json,
 * Developer ID signature of the team). Returns its path. It never writes the shared staged
 * path next to the app: only the helper does, under the install lock (helperCore.ts).
 * Throws on the first problem; the caller cleans `workDir`.
 */
export const verifyFromZip = async (o: {
  readonly zip: string;
  readonly workDir: string;
  readonly job: Pick<UpdateJob, "version" | "build" | "commit" | "schemaVersion" | "teamId">;
  readonly exec: Exec;
  readonly files: FileOps;
}): Promise<string> => {
  const { exec, files, job } = o;
  const out = join(o.workDir, "unpacked");
  files.remove(out);
  files.mkdir(out);
  const unzip = await exec("/usr/bin/ditto", ["-x", "-k", o.zip, out]);
  if (unzip.status !== 0) throw new Error(`could not unpack the update: ${unzip.stderr.trim()}`);
  const entries = files.list(out).filter((e) => e !== "__MACOSX");
  if (entries.length !== 1 || entries[0] !== "Apollo.app") throw new Error(`the update holds ${entries.join(", ") || "nothing"}, not just Apollo.app`);
  const app = join(out, "Apollo.app");
  if ((await plistValue(exec, app, "CFBundleIdentifier")) !== BUNDLE_ID) throw new Error(`the update is not ${BUNDLE_ID}`);
  const bundleVersion = await plistValue(exec, app, "CFBundleVersion");
  if (bundleVersion !== String(job.build)) throw new Error(`the update's CFBundleVersion is ${bundleVersion}, the manifest says ${job.build}`);
  let info: unknown = null;
  try {
    info = JSON.parse(files.readText(join(app, "Contents", "Resources", "build-info.json"))) as unknown;
  } catch {
    info = null;
  }
  const problems = stagedProblems(info, job);
  if (problems.length > 0) throw new Error(`the update is not release ${job.version}: ${problems.join("; ")}`);
  const signature = await checkSignature(exec, app, job.teamId);
  if (signature) throw new Error(`the update's code signature is not valid: ${signature}`);
  return app;
};

/** The helper's bundle copy: ditto keeps symlinks, permissions and signatures. */
export const copyBundle = async (exec: Exec, from: string, to: string): Promise<void> => {
  const r = await exec("/usr/bin/ditto", [from, to]);
  if (r.status !== 0) throw new Error(`could not copy ${from} to ${to}: ${r.stderr.trim() || `exit ${r.status}`}`);
};
