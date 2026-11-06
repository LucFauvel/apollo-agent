import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { OnePasswordField, OnePasswordItem, OnePasswordStatus } from "@apollo/contracts";

/**
 * 1Password through its CLI (`op`). Apollo lists items and their field labels
 * so the user can pick one, then reads only the chosen field's value, on the
 * server. Values are never sent to the UI or to agents. With the 1Password
 * desktop app's CLI integration, reads prompt the user to unlock as usual.
 */

const COMMON_PATHS = ["/opt/homebrew/bin/op", "/usr/local/bin/op", "/usr/bin/op"];
const LIST_CACHE_MS = 60_000;

export class OnePasswordError extends Error {}

export const findOp = (override: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null => {
  if (override) return existsSync(override) ? override : null;
  const name = process.platform === "win32" ? "op.exe" : "op";
  const onPath = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, name))
    .find((candidate) => existsSync(candidate));
  return onPath ?? COMMON_PATHS.find((candidate) => existsSync(candidate)) ?? null;
};

/** `op://Vault/Item/field` or `op://Vault/Item/section/field` (names may contain spaces). */
const REFERENCE = /^op:\/\/[^/\n]+\/[^/\n]+(\/[^/\n]+){1,2}$/;
export const isReference = (value: string) => REFERENCE.test(value.trim());

const friendly = (stderr: string) => {
  const text = stderr.replace(/^\[ERROR\]\s*\S+\s+\S+\s*/m, "").trim();
  if (/not (currently )?signed in|no accounts configured|authorization prompt dismissed|session expired/i.test(text)) {
    return "1Password is locked or not signed in: unlock the 1Password app (with CLI integration on) or run `op signin`.";
  }
  return text.split("\n")[0] || "the 1Password CLI failed";
};

export class OnePassword {
  private readonly executable: string | null;
  private cache: { at: number; items: ReadonlyArray<OnePasswordItem> } | null = null;

  constructor(executable: string | null) {
    this.executable = executable;
  }

  private run(args: ReadonlyArray<string>, timeoutMs = 90_000): Promise<string> {
    const executable = this.executable;
    if (!executable) return Promise.reject(new OnePasswordError("The 1Password CLI (`op`) is not installed."));
    return new Promise((resolve, reject) => {
      execFile(
        executable,
        [...args],
        // Generous timeout: the desktop app may be waiting for Touch ID or a password.
        { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, OP_FORMAT: "json" } },
        (error, stdout, stderr) => {
          if (error) reject(new OnePasswordError(error.killed ? "1Password did not answer in time" : friendly(String(stderr || error.message))));
          else resolve(stdout);
        },
      );
    });
  }

  async status(): Promise<OnePasswordStatus> {
    if (!this.executable) {
      return { installed: false, ready: false, message: "Install the 1Password CLI (`op`) to fill secrets from 1Password." };
    }
    try {
      const accounts = JSON.parse((await this.run(["account", "list", "--format", "json"], 15_000)) || "[]") as Array<unknown>;
      return accounts.length > 0
        ? { installed: true, ready: true, message: null }
        : { installed: true, ready: false, message: "Sign in to 1Password: turn on CLI integration in the app, or run `op account add`." };
    } catch (error) {
      return { installed: true, ready: false, message: (error as Error).message };
    }
  }

  async search(query: string): Promise<ReadonlyArray<OnePasswordItem>> {
    if (!this.cache || Date.now() - this.cache.at > LIST_CACHE_MS) {
      const raw = JSON.parse((await this.run(["item", "list", "--format", "json"])) || "[]") as Array<any>;
      const items = raw.map(
        (item): OnePasswordItem => ({
          id: String(item.id),
          title: String(item.title ?? ""),
          vaultId: String(item.vault?.id ?? ""),
          vault: String(item.vault?.name ?? ""),
          category: String(item.category ?? ""),
          subtitle: typeof item.additional_information === "string" && item.additional_information ? item.additional_information : null,
          ...(Array.isArray(item.urls) ? { urls: item.urls.map((u: any) => String(u.href ?? "")) } : {}),
        }),
      );
      this.cache = { at: Date.now(), items };
    }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.cache.items
      .filter((item) => {
        const haystack = [item.title, item.subtitle, item.vault, ...((item as { urls?: Array<string> }).urls ?? [])].join(" ").toLowerCase();
        return words.every((w) => haystack.includes(w));
      })
      .slice(0, 30)
      .map(({ id, title, vaultId, vault, category, subtitle }) => ({ id, title, vaultId, vault, category, subtitle }));
  }

  /** The item's fields, labels only: values are dropped here and never leave the server. */
  async fields(itemId: string, vaultId: string): Promise<ReadonlyArray<OnePasswordField>> {
    const item = JSON.parse(await this.run(["item", "get", itemId, "--vault", vaultId, "--format", "json"])) as any;
    return (Array.isArray(item.fields) ? item.fields : [])
      .filter((f: any) => typeof f.reference === "string" && f.reference && f.purpose !== "NOTES" && f.type !== "REFERENCE")
      .map(
        (f: any): OnePasswordField => ({
          label: String(f.label || f.id || "field"),
          type: String(f.type ?? "STRING"),
          section: typeof f.section?.label === "string" && f.section.label ? f.section.label : null,
          reference: String(f.reference),
        }),
      );
  }

  async read(reference: string): Promise<string> {
    if (!isReference(reference)) throw new OnePasswordError("not a 1Password secret reference (op://vault/item/field)");
    const value = await this.run(["read", "--no-newline", reference.trim()]);
    if (!value) throw new OnePasswordError("that 1Password field is empty");
    return value;
  }
}
