import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { deviceProofMessage } from "@apollo/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Database from "../Database.ts";
import type { TailnetPeer } from "../remote/TailnetPeer.ts";
import { makePairing, type RequestContext } from "./Auth.ts";
import { makeProofVerifier, parseDeviceKey, PROOF_WINDOW_MS } from "./DeviceProof.ts";

const phone: TailnetPeer = {
  nodeId: "nPhone1CNTRL",
  userId: "1012587865151273",
  loginName: "owner@example.com",
  nodeName: "apollo-iphone.tail1234.ts.net",
  os: "iOS",
};
const otherDevice: TailnetPeer = { ...phone, nodeId: "nOther1CNTRL", nodeName: "laptop.tail1234.ts.net" };

/** A device key like the phone's Secure Enclave key: P-256, exported as an uncompressed point. */
const deviceKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  const proof = (method: string, path: string, now = Date.now(), nonce = randomBytes(16).toString("base64url")) => {
    const signature = sign("sha256", Buffer.from(deviceProofMessage(method, path, String(now), nonce)), {
      key: privateKey,
      dsaEncoding: "der",
    });
    return `${now}.${nonce}.${signature.toString("base64url")}`;
  };
  return { publicKey: point.toString("base64url"), proof };
};

const context = (peer: TailnetPeer | null, proof?: string, path = "/rpc", method = "GET"): RequestContext => ({
  peer,
  method,
  path,
  proof,
});

const setup = () => makePairing(Database.open(":memory:"));

describe("tailnet pairing", () => {
  it("waits for someone at the computer, then binds the session to that device", async () => {
    const pairing = setup();
    const { token } = pairing.createPairingToken("");
    const waiting = pairing.requestPairing(token, "iPhone", phone, null)!;
    expect(pairing.listPending()).toMatchObject([{ label: "iPhone", nodeName: phone.nodeName, os: "iOS" }]);
    // The token is burned the moment the request arrives.
    expect(pairing.requestPairing(token, "iPhone", phone, null)).toBeNull();
    expect(pairing.decidePairing(pairing.listPending()[0]!.id, true)).toBe(true);
    const session = (await waiting)!;
    expect(pairing.listPending()).toEqual([]);
    expect(pairing.authorize(session.sessionToken, context(phone))).toMatchObject({ ok: true });
    expect(pairing.authorize(session.sessionToken, context(otherDevice))).toMatchObject({ ok: false });
    // A copied token is useless on this computer too.
    expect(pairing.authorize(session.sessionToken, context(null))).toMatchObject({ ok: false });
    expect(pairing.listClients()[0]).toMatchObject({ nodeName: phone.nodeName, deviceKey: false });
  });

  it("gives nothing to a denied device", async () => {
    const pairing = setup();
    const waiting = pairing.requestPairing(pairing.createPairingToken("").token, "iPhone", phone, null)!;
    pairing.decidePairing(pairing.listPending()[0]!.id, false);
    expect(await waiting).toBeNull();
    expect(pairing.listClients()).toEqual([]);
  });

  it("refuses unbound sessions over the tailnet", () => {
    const pairing = setup();
    const local = pairing.redeem(pairing.createPairingToken("").token, "Browser")!;
    expect(pairing.authorize(local.sessionToken, context(null))).toMatchObject({ ok: true });
    expect(pairing.authorize(local.sessionToken, context(phone))).toMatchObject({ ok: false });
  });

  it("never accepts the desktop bootstrap token from the tailnet", () => {
    const pairing = makePairing(Database.open(":memory:"), { desktopToken: "desktop-secret" });
    expect(pairing.requestPairing("desktop-secret", "x", phone, null)).toBeNull();
  });
});

describe("device keys", () => {
  it("requires every request to be signed by the paired device's key", async () => {
    const pairing = setup();
    const key = deviceKey();
    expect(pairing.verifyNewDeviceKey(key.publicKey, context(phone, key.proof("POST", "/api/auth/pair"), "/api/auth/pair", "POST"))).toBe(true);
    const waiting = pairing.requestPairing(pairing.createPairingToken("").token, "iPhone", phone, key.publicKey)!;
    pairing.decidePairing(pairing.listPending()[0]!.id, true);
    const { sessionToken } = (await waiting)!;

    expect(pairing.authorize(sessionToken, context(phone, key.proof("GET", "/rpc")))).toMatchObject({ ok: true });
    expect(pairing.authorize(sessionToken, context(phone))).toMatchObject({ ok: false });
    // Signed for another path, or by another key.
    expect(pairing.authorize(sessionToken, context(phone, key.proof("GET", "/api/push/register")))).toMatchObject({ ok: false });
    expect(pairing.authorize(sessionToken, context(phone, deviceKey().proof("GET", "/rpc")))).toMatchObject({ ok: false });
    // Replayed.
    const proof = key.proof("GET", "/rpc");
    expect(pairing.authorize(sessionToken, context(phone, proof))).toMatchObject({ ok: true });
    expect(pairing.authorize(sessionToken, context(phone, proof))).toMatchObject({ ok: false });
  });

  it("refuses stale proofs and malformed keys", () => {
    const verify = makeProofVerifier();
    const key = deviceKey();
    const parsed = parseDeviceKey(key.publicKey)!;
    const now = 10_000_000;
    expect(verify(key.proof("GET", "/rpc", now - PROOF_WINDOW_MS - 1), parsed, { method: "GET", path: "/rpc" }, now)).toBe(false);
    expect(verify(key.proof("GET", "/rpc", now), parsed, { method: "GET", path: "/rpc" }, now)).toBe(true);
    expect(parseDeviceKey("not-a-key")).toBeNull();
    // A point that is not on the curve.
    expect(parseDeviceKey(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url"))).toBeNull();
  });
});
