import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { commonGitDir, STOP_DEADLINE_MS } from "./git.ts";

/**
 * How a git call settles when stopping it does not go to plan. `git` is replaced, on PATH,
 * by a small Node script; process.kill is intercepted to play a group that cannot be killed.
 */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Puts a fake `git` (a Node script) first on PATH; returns its folder. */
const fakeGit = (script: string) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "apollo-fake-git-")));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "git"), `#!${process.execPath}\nconst root = ${JSON.stringify(root)};\n${script}\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${join(root, "bin")}:${path}`;
  cleanups.push(() => void (process.env.PATH = path));
  return root;
};

/** A fake git that says its pid, then runs until killed. */
const STUCK = `require("fs").writeFileSync(root + "/started", String(process.pid)); setInterval(() => {}, 1000);`;

/** Makes killing the process group `-pid` do `instead` (the real kill is used for everything else). */
const interceptGroupKill = (instead: () => void) => {
  const original = process.kill;
  let target = 0;
  process.kill = ((pid: number, signal?: string | number) => {
    if (target !== 0 && pid === -target) return instead(), true;
    return original(pid, signal);
  }) as typeof process.kill;
  cleanups.push(() => void (process.kill = original));
  return (pid: number) => void (target = pid);
};

/** Settles `promise` within `ms`, or says it is still pending. */
const within = <A,>(promise: Promise<A>, ms: number) =>
  Promise.race([promise.then((value) => ({ value }), (error: Error) => ({ error })), wait(ms).then(() => "pending" as const)]);

describe("git calls always settle", () => {
  it("reports a process group it could not kill, at once", async () => {
    const root = fakeGit(STUCK);
    const target = interceptGroupKill(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });
    const controller = new AbortController();
    const running = commonGitDir(root, controller.signal);
    while (!existsSync(join(root, "started"))) await wait(5);
    const pid = Number(readFileSync(join(root, "started"), "utf8"));
    cleanups.push(() => alive(pid) && process.kill(pid, "SIGKILL"));
    target(pid);
    controller.abort(new Error("Stopped"));
    const outcome = await within(running, 1000);
    expect(outcome).not.toBe("pending");
    const message = (outcome as { error: Error }).error.message;
    expect(message).toContain("Stopped");
    expect(message).toContain(`process group ${pid}) could not be stopped: kill EPERM`);
  });

  it("gives up waiting for a group it cannot confirm gone, naming it", async () => {
    const root = fakeGit(STUCK);
    // The group "kill" succeeds but does nothing: git keeps running.
    const target = interceptGroupKill(() => {});
    const controller = new AbortController();
    const running = commonGitDir(root, controller.signal);
    while (!existsSync(join(root, "started"))) await wait(5);
    const pid = Number(readFileSync(join(root, "started"), "utf8"));
    cleanups.push(() => alive(pid) && process.kill(pid, "SIGKILL"));
    target(pid);
    const stopped = Date.now();
    controller.abort(new Error("Stopped"));
    const outcome = await within(running, STOP_DEADLINE_MS + 2000);
    expect(outcome).not.toBe("pending");
    expect(Date.now() - stopped).toBeLessThan(STOP_DEADLINE_MS + 1000);
    expect((outcome as { error: Error }).error.message).toContain(`process group ${pid}) was not confirmed stopped`);
    expect(alive(pid)).toBe(true); // it really was out of reach
  });

  it("does not wait on output a descendant in another group keeps open after git exits", async () => {
    // git starts a helper in its own group that inherits stdout, prints, and exits.
    const root = fakeGit(`
const cp = require("child_process");
const helper = cp.spawn(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", root + "/helper"], { detached: true, stdio: ["ignore", 1, 2] });
helper.unref();
process.stdout.write("/the/git/dir\\n");`);
    const running = commonGitDir(root);
    while (!existsSync(join(root, "helper"))) await wait(5);
    const helper = Number(readFileSync(join(root, "helper"), "utf8"));
    cleanups.push(() => alive(helper) && process.kill(helper, "SIGKILL"));
    const outcome = await within(running, 2000);
    expect(outcome).toEqual({ value: "/the/git/dir" });
    expect(alive(helper)).toBe(true); // still holding the pipe: not waited for
  });

  it("an abort after git exited, with the pipe still held, settles too", async () => {
    const root = fakeGit(`
const cp = require("child_process");
const helper = cp.spawn(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", root + "/helper"], { detached: true, stdio: ["ignore", 1, 2] });
helper.unref();
setTimeout(() => {}, 5000);`);
    const controller = new AbortController();
    const running = commonGitDir(root, controller.signal);
    while (!existsSync(join(root, "helper"))) await wait(5);
    const helper = Number(readFileSync(join(root, "helper"), "utf8"));
    cleanups.push(() => alive(helper) && process.kill(helper, "SIGKILL"));
    controller.abort(new Error("Stopped"));
    const outcome = await within(running, 1500);
    expect(outcome).not.toBe("pending");
    expect((outcome as { error: Error }).error.message).toContain("Stopped");
  });
});
