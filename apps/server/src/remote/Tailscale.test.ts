import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromEnv, ServerConfig } from "../Config.ts";
import { Store } from "../Store.ts";
import * as Tailscale from "./Tailscale.ts";

// The computer's names: `os.hostname()` (follows the network on macOS) and the Sharing name.
const names = vi.hoisted(() => ({ host: "mac-lan", local: "DEVOLUTIONS652", localReads: 0 }));
vi.mock("node:os", async (original) => ({ ...(await original<typeof import("node:os")>()), hostname: () => names.host }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: (file: string, args: ReadonlyArray<string>) => {
    expect([file, ...args]).toEqual(["/usr/sbin/scutil", "--get", "LocalHostName"]);
    names.localReads++;
    return names.local;
  },
}));

const HOSTNAME_SETTING = "remote.tailscale.hostname";
const root = mkdtempSync(join(tmpdir(), "apollo-tailscale-test-"));
const addonPath = join(root, "fake.node");
writeFileSync(addonPath, "never loaded: process.dlopen is replaced below");

/** The native node, faked: what its state dir says it last announced, and each `start`. */
let node: {
  savedHostname: string | null | "fail";
  starts: Array<string>;
  dnsName: string | null;
  status?: { listening: boolean; needsHttps?: boolean };
};
let settings: Map<string, string>;
/** Every value written to the machine-name setting, in order. */
let nameWrites: Array<string>;
const platform = process.platform;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  Object.assign(names, { host: "mac-lan", local: "DEVOLUTIONS652", localReads: 0 });
  settings = new Map([["remote.tailscale", "on"]]);
  nameWrites = [];
  node = { savedHostname: null, starts: [], dnsName: null };
  vi.spyOn(process, "dlopen").mockImplementation((module: object) => {
    (module as { exports: unknown }).exports = {
      callSync: () => "null",
      call: async (method: string, json: string) => {
        const args = JSON.parse(json) as { dir?: string; hostname?: string };
        if (method === "savedHostname") {
          expect(args.dir).toBe(join(root, "tailnet-node"));
          return JSON.stringify(node.savedHostname === "fail" ? { error: "unknown method" } : { hostname: node.savedHostname });
        }
        if (method === "start") {
          node.starts.push(args.hostname!);
          // Tailscale renames the machine to the name it announces.
          node.savedHostname = args.hostname!;
          node.dnsName = `${args.hostname}.example.ts.net`;
        }
        return JSON.stringify({
          state: "Running",
          authUrl: null,
          nodeId: "nMac",
          userId: "1",
          loginName: "owner@example.com",
          dnsName: node.dnsName,
          listening: true,
          error: null,
          ...node.status,
        });
      },
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: platform });
});

const store = {
  getSetting: (key: string) => Effect.sync(() => settings.get(key) ?? null),
  setSetting: (key: string, value: string | null) =>
    Effect.sync(() => {
      if (key === HOSTNAME_SETTING && value !== null) nameWrites.push(value);
      void (value === null ? settings.delete(key) : settings.set(key, value));
    }),
};

/** Builds the real service, lets its automatic startup start the node, and reads it. */
const startApollo = () => {
  const before = node.starts.length;
  const deps = Layer.mergeAll(
    Layer.succeed(Store, store as unknown as Store["Service"]),
    Layer.succeed(ServerConfig, fromEnv({ APOLLO_DATA_DIR: root, APOLLO_TAILNET_ADDON: addonPath })),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Tailscale.Tailscale;
      while (node.starts.length === before) yield* Effect.yieldNow;
      return yield* service.read;
    }).pipe(Effect.provide(Tailscale.layer.pipe(Layer.provide(deps))), Effect.scoped),
  );
};

describe("the tailnet machine name", () => {
  it("keeps the name an already-paired node announces when Apollo is updated", async () => {
    node.savedHostname = "apollo-mac-lan";
    node.dnsName = "apollo-mac-lan.example.ts.net";
    const remote = await startApollo();
    expect(node.starts).toEqual(["apollo-mac-lan"]);
    expect(remote.dnsName).toBe("apollo-mac-lan.example.ts.net");
    expect(settings.get(HOSTNAME_SETTING)).toBe("apollo-mac-lan");
    expect(names.localReads).toBe(0);
  });

  it("names a new node after the computer's Sharing name, not its network name", async () => {
    await startApollo();
    expect(node.starts).toEqual(["apollo-devolutions652"]);
    expect(settings.get(HOSTNAME_SETTING)).toBe("apollo-devolutions652");
  });

  it("starts with the saved name, whatever the node or the computer is called now", async () => {
    settings.set(HOSTNAME_SETTING, "apollo-kept");
    node.savedHostname = "apollo-something-else";
    names.host = "other-network";
    names.local = "Renamed-Mac";
    await startApollo();
    expect(node.starts).toEqual(["apollo-kept"]);
    expect(names.localReads).toBe(0);
  });

  it("does not follow the network across restarts", async () => {
    await startApollo();
    names.host = "other-network";
    names.local = "Renamed-Mac";
    node.savedHostname = "apollo-renamed-elsewhere";
    await startApollo();
    expect(node.starts).toEqual(["apollo-devolutions652", "apollo-devolutions652"]);
  });

  it("keeps a padded announced name, trimmed, instead of choosing a new one", async () => {
    for (const padded of [" apollo-mac-lan", "apollo-mac-lan\n", "\tapollo-mac-lan  "]) {
      settings.delete(HOSTNAME_SETTING);
      nameWrites = [];
      node.savedHostname = padded;
      await startApollo();
      expect(node.starts.at(-1)).toBe("apollo-mac-lan");
      expect(nameWrites).toEqual(["apollo-mac-lan"]);
    }
  });

  it("when the existing name cannot be read, starts as before and decides next time", async () => {
    node.savedHostname = "fail";
    await startApollo();
    expect(node.starts).toEqual(["apollo-mac-lan"]);
    expect(settings.has(HOSTNAME_SETTING)).toBe(false);
    // The node now announces apollo-mac-lan (set by the fake start); the next start adopts it.
    names.host = "other-network";
    await startApollo();
    expect(node.starts).toEqual(["apollo-mac-lan", "apollo-mac-lan"]);
    expect(settings.get(HOSTNAME_SETTING)).toBe("apollo-mac-lan");
  });
});

describe("a malformed machine name", () => {
  const malformed = ["bad name 🐱", "a".repeat(64), "apollo-tail-", "   ", "Apollo-UPPER", "-apollo"];

  it("announced by the node is never kept: a new node name is chosen and saved instead", async () => {
    for (const bad of malformed) {
      settings.delete(HOSTNAME_SETTING);
      nameWrites = [];
      node.savedHostname = bad;
      await startApollo();
      expect(node.starts.at(-1)).toBe("apollo-devolutions652");
      expect(nameWrites).toEqual(["apollo-devolutions652"]);
    }
  });

  it("saved by an earlier run is replaced by the node's valid name", async () => {
    for (const bad of malformed) {
      settings.set(HOSTNAME_SETTING, bad);
      nameWrites = [];
      node.savedHostname = "apollo-mac-lan";
      await startApollo();
      expect(node.starts.at(-1)).toBe("apollo-mac-lan");
      expect(nameWrites).toEqual(["apollo-mac-lan"]);
    }
  });

  it("does not stick once the node's state is repaired", async () => {
    // An earlier build saved a bad name the node announced; the node is then repaired.
    settings.set(HOSTNAME_SETTING, "bad name 🐱");
    node.savedHostname = "fail";
    await startApollo();
    expect(node.starts).toEqual(["apollo-mac-lan"]);
    node.savedHostname = "apollo-mac-lan";
    names.host = "other-network";
    await startApollo();
    expect(node.starts).toEqual(["apollo-mac-lan", "apollo-mac-lan"]);
    expect(settings.get(HOSTNAME_SETTING)).toBe("apollo-mac-lan");
  });
});

describe("a tailnet with HTTPS certificates off", () => {
  it("asks the user to turn them on instead of reporting an error", async () => {
    node.status = { listening: false, needsHttps: true };
    const remote = await startApollo();
    expect(remote.tailscale).toBe("running");
    expect(remote.needsHttps).toBe(true);
    expect(remote.url).toBeNull();
    expect(remote.error).toBeNull();
  });

  it("publishes Apollo once the certificate is in hand", async () => {
    node.status = { listening: true, needsHttps: false };
    const remote = await startApollo();
    expect(remote.needsHttps).toBe(false);
    expect(remote.url).toBe("https://apollo-devolutions652.example.ts.net:8443");
  });

  it("reads an older addon without the field as HTTPS being fine", async () => {
    node.status = { listening: false };
    expect((await startApollo()).needsHttps).toBe(false);
  });
});

describe("nodeHostname", () => {
  it("turns a computer name into a tailnet machine name", () => {
    expect(Tailscale.nodeHostname("Luc's MacBook.local")).toBe("apollo-luc-s-macbook");
    expect(Tailscale.nodeHostname("DEVOLUTIONS652")).toBe("apollo-devolutions652");
    expect(Tailscale.nodeHostname("DEVOLUTIONS652.LOCAL")).toBe("apollo-devolutions652");
    expect(Tailscale.nodeHostname("---")).toBe("apollo-desktop");
  });

  it("always makes a valid machine name", () => {
    for (const name of ["Luc's MacBook.local", "Élodie 🐱", "🐱", "a".repeat(100), `${"a".repeat(39)}-z`, "-x-"]) {
      expect(Tailscale.isMachineName(Tailscale.nodeHostname(name)), name).toBe(true);
    }
    expect(Tailscale.nodeHostname(`${"a".repeat(39)}-z`)).toBe(`apollo-${"a".repeat(39)}`);
  });
});
