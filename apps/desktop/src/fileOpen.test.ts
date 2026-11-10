import { describe, expect, it } from "vitest";
import { fileOpenAction } from "./fileOpen.ts";

const file = (path: string, executable = false, directory = false) => ({ path, executable, directory });

describe("fileOpenAction", () => {
  it("opens documents, source files and folders", () => {
    expect(fileOpenAction(file("/Users/me/report.pdf"), false, "darwin")).toBe("open");
    expect(fileOpenAction(file("/Users/me/tool.py"), false, "darwin")).toBe("open");
    expect(fileOpenAction(file("/Users/me/git/app", true, true), false, "darwin")).toBe("open");
    expect(fileOpenAction(file("C:\\dev\\Program.cs"), false, "win32")).toBe("open");
  });

  it("shows what would run something instead of opening it", () => {
    for (const path of ["/Users/me/run.command", "/Users/me/Evil.app", "/Users/me/a.sh"]) {
      expect(fileOpenAction(file(path, false, path.endsWith(".app")), false, "darwin")).toBe("reveal");
    }
    for (const path of ["C:\\dev\\setup.EXE", "C:\\dev\\x.lnk", "C:\\dev\\x.js", "C:\\dev\\x.py"]) {
      expect(fileOpenAction(file(path), false, "win32")).toBe("reveal");
    }
    expect(fileOpenAction(file("/Users/me/tool", true), false, "darwin")).toBe("reveal");
    expect(fileOpenAction(file("/home/me/x.desktop"), false, "linux")).toBe("reveal");
  });

  it("reveals when asked", () => {
    expect(fileOpenAction(file("/Users/me/report.pdf"), true, "darwin")).toBe("reveal");
  });
});
