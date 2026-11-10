import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { type FileRoots, resolveLocalFile } from "./localFiles.ts";

let dir: string;
let roots: FileRoots;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "apollo-local-files-")));
  for (const d of ["session", "workspace", "projects/app", "home", "secret"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "session", "notes.md"), "# Notes");
  writeFileSync(join(dir, "workspace", "report.pdf"), "%PDF");
  writeFileSync(join(dir, "projects/app", "main.ts"), "export {}");
  writeFileSync(join(dir, "secret", "key.txt"), "nope");
  writeFileSync(join(dir, "home", "outside.txt"), "nope");
  roots = { sessionCwd: join(dir, "session"), roots: [join(dir, "workspace"), join(dir, "projects")], home: join(dir, "home") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveLocalFile", () => {
  it("finds files in the session's folder, the workspace and project folders", () => {
    expect(resolveLocalFile("notes.md", roots)).toMatchObject({ ok: true, info: { path: join(dir, "session", "notes.md"), kind: "markdown", size: 7 } });
    expect(resolveLocalFile(join(dir, "workspace", "report.pdf"), roots)).toMatchObject({ ok: true, info: { name: "report.pdf", mime: "application/pdf" } });
    expect(resolveLocalFile(pathToFileURL(join(dir, "projects/app/main.ts")).href, roots)).toMatchObject({ ok: true, info: { kind: "code", language: "ts" } });
    expect(resolveLocalFile(join(dir, "projects"), roots)).toMatchObject({ ok: true, info: { directory: true } });
  });

  it("refuses files outside them, through `..`, `~` or symlinks", () => {
    expect(resolveLocalFile("../secret/key.txt", roots)).toEqual({ ok: false, reason: "outside" });
    expect(resolveLocalFile(join(dir, "secret", "key.txt"), roots)).toEqual({ ok: false, reason: "outside" });
    expect(resolveLocalFile("~/outside.txt", roots)).toEqual({ ok: false, reason: "outside" });
    symlinkSync(join(dir, "secret", "key.txt"), join(dir, "workspace", "link.txt"));
    expect(resolveLocalFile(join(dir, "workspace", "link.txt"), roots)).toEqual({ ok: false, reason: "outside" });
    expect(resolveLocalFile(join(dir, "projects-other", "x"), roots)).toEqual({ ok: false, reason: "outside" });
    expect(resolveLocalFile(join(dir, "secret", "gone.txt"), roots)).toEqual({ ok: false, reason: "outside" });
  });

  it("says when a file is not there", () => {
    expect(resolveLocalFile("gone.md", roots)).toEqual({ ok: false, reason: "missing" });
    expect(resolveLocalFile("", roots)).toEqual({ ok: false, reason: "missing" });
  });
});
