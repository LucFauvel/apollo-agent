import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isReference, OnePassword } from "./OnePassword.ts";

// A fake `op` that answers like the real CLI (JSON output), including secret values.
const dir = mkdtempSync(join(tmpdir(), "apollo-op-"));
const fake = join(dir, "op");
writeFileSync(
  fake,
  `#!/bin/sh
case "$1 $2" in
  "account list") echo '[{"email":"me@example.com"}]' ;;
  "item list") echo '[{"id":"i1","title":"GitHub","vault":{"id":"v1","name":"Private"},"category":"LOGIN","additional_information":"octocat","urls":[{"href":"https://github.com"}]},{"id":"i2","title":"Stripe","vault":{"id":"v2","name":"Work"},"category":"API_CREDENTIAL"}]' ;;
  "item get") echo '{"id":"i1","fields":[{"id":"username","type":"STRING","purpose":"USERNAME","label":"username","value":"octocat","reference":"op://Private/GitHub/username"},{"id":"password","type":"CONCEALED","purpose":"PASSWORD","label":"password","value":"hunter2","reference":"op://Private/GitHub/password"},{"id":"notesPlain","type":"STRING","purpose":"NOTES","label":"notes","value":"x","reference":"op://Private/GitHub/notesPlain"},{"id":"tok","type":"CONCEALED","label":"token","value":"ghp_secret","section":{"id":"s","label":"API"},"reference":"op://Private/GitHub/API/token"}]}' ;;
  "read --no-newline")
    if [ "$3" = "op://Private/GitHub/password" ]; then printf 'hunter2'; else echo "[ERROR] 2026/11/05 10:00:00 could not read secret" >&2; exit 1; fi ;;
  *) echo "[ERROR] 2026/11/05 10:00:00 You are not currently signed in." >&2; exit 1 ;;
esac
`,
);
chmodSync(fake, 0o755);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("1Password", () => {
  const op = new OnePassword(fake);

  it("reports a signed-in account", async () => {
    expect(await op.status()).toEqual({ installed: true, ready: true, message: null });
    expect((await new OnePassword(null).status()).installed).toBe(false);
  });

  it("searches titles, subtitles and URLs", async () => {
    expect((await op.search("git")).map((i) => i.title)).toEqual(["GitHub"]);
    expect((await op.search("github.com")).map((i) => i.title)).toEqual(["GitHub"]);
    expect((await op.search("work")).map((i) => i.title)).toEqual(["Stripe"]);
    expect(await op.search("")).toHaveLength(2);
  });

  it("lists fields without their values", async () => {
    const fields = await op.fields("i1", "v1");
    expect(fields.map((f) => f.label)).toEqual(["username", "password", "token"]);
    expect(fields[2]!.section).toBe("API");
    expect(JSON.stringify(fields)).not.toMatch(/hunter2|octocat"|ghp_secret/);
  });

  it("reads only well-formed references", async () => {
    expect(await op.read("op://Private/GitHub/password")).toBe("hunter2");
    await expect(op.read("--help")).rejects.toThrow(/not a 1Password secret reference/);
    await expect(op.read("op://Private/GitHub/missing")).rejects.toThrow(/could not read secret/);
    expect(isReference("op://Private/My Login/password")).toBe(true);
    expect(isReference("op://Private")).toBe(false);
  });

  it("explains a locked or signed-out 1Password", async () => {
    await expect(op.fields("unknown-command", "x").then(() => op.read("op://a/b/c"))).rejects.toThrow();
    const locked = new OnePassword(fake);
    // Unknown subcommands answer "not signed in" in the fake.
    await expect((locked as any).run(["whoami"])).rejects.toThrow(/locked or not signed in/);
  });
});
