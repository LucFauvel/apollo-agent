import { describe, expect, it } from "@effect/vitest";
import * as Database from "../Database.ts";
import { CLIENT_SESSION_TTL_MS, makePairing, PAIRING_TOKEN_TTL_MS } from "./Auth.ts";

const setup = (desktopToken?: string) => {
  const db = Database.open(":memory:");
  return { db, pairing: makePairing(db, { desktopToken }) };
};

describe("pairing", () => {
  it("redeems a pairing token exactly once", () => {
    const { pairing } = setup();
    const { token } = pairing.createPairingToken("Laptop");
    const first = pairing.redeem(token, "Laptop");
    expect(first).not.toBeNull();
    expect(pairing.redeem(token, "Laptop")).toBeNull();
    expect(pairing.authenticate(first!.sessionToken)).toMatchObject({ label: "Laptop", method: "pairing-link" });
  });

  it("prefers the name chosen when the link was created", () => {
    const { pairing } = setup();
    const named = pairing.redeem(pairing.createPairingToken("Work laptop").token, "Chrome on Linux")!;
    const unnamed = pairing.redeem(pairing.createPairingToken("").token, "Chrome on Linux")!;
    expect(pairing.authenticate(named.sessionToken)?.label).toBe("Work laptop");
    expect(pairing.authenticate(unnamed.sessionToken)?.label).toBe("Chrome on Linux");
  });

  it("rejects expired and unknown tokens", () => {
    const { pairing } = setup();
    const now = 1_000_000;
    const { token } = pairing.createPairingToken("Phone", now);
    expect(pairing.redeem(token, "Phone", now + PAIRING_TOKEN_TTL_MS + 1)).toBeNull();
    expect(pairing.redeem("not-a-token", "Phone", now)).toBeNull();
  });

  it("stores only hashes of secrets", () => {
    const { db, pairing } = setup();
    const { token } = pairing.createPairingToken("Laptop");
    const { sessionToken } = pairing.redeem(token, "Laptop")!;
    const dump = JSON.stringify([
      db.prepare("select * from pairing_grants").all(),
      db.prepare("select * from client_sessions").all(),
    ]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(sessionToken);
  });

  it("revokes clients and expires idle sessions", () => {
    const { pairing } = setup();
    const now = 5_000_000;
    const a = pairing.redeem(pairing.createPairingToken("A", now).token, "A", now)!;
    const b = pairing.redeem(pairing.createPairingToken("B", now).token, "B", now)!;
    pairing.revokeClient(a.clientId);
    expect(pairing.authenticate(a.sessionToken, now)).toBeNull();
    expect(pairing.authenticate(b.sessionToken, now + CLIENT_SESSION_TTL_MS + 1)).toBeNull();
    expect(pairing.listClients(now).map((c) => c.label)).toEqual(["B"]);
  });

  it("notifies live connections of their own client's revocation only", () => {
    const { pairing } = setup();
    const a = pairing.redeem(pairing.createPairingToken("A").token, "A")!;
    const b = pairing.redeem(pairing.createPairingToken("B").token, "B")!;
    const fired: Array<string> = [];
    pairing.onRevoked(a.clientId, () => fired.push("a"));
    const unsubscribe = pairing.onRevoked(b.clientId, () => fired.push("b"));
    unsubscribe();
    pairing.revokeClient(b.clientId);
    pairing.revokeClient(a.clientId);
    pairing.revokeClient(a.clientId);
    expect(fired).toEqual(["a"]);
  });

  it("lets the desktop bootstrap token pair repeatedly", () => {
    const { pairing } = setup("desktop-secret");
    const one = pairing.redeem("desktop-secret", "Desktop");
    const two = pairing.redeem("desktop-secret", "Desktop");
    expect(one?.clientId).not.toEqual(two?.clientId);
    expect(pairing.authenticate(two!.sessionToken)).toMatchObject({ method: "desktop" });
    expect(setup().pairing.redeem("desktop-secret", "Desktop")).toBeNull();
  });
});
