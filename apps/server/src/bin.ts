#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const [command, ...rest] = process.argv.slice(2);

if (command === "pair") {
  // Mints a one-time pairing link directly in the database; works whether or not the server runs.
  const { values } = parseArgs({
    args: rest,
    options: { label: { type: "string", default: "" }, url: { type: "string" } },
  });
  const Config = await import("./Config.ts");
  const Database = await import("./Database.ts");
  const { makePairing, pairingUrl, PAIRING_TOKEN_TTL_MS } = await import("./auth/Auth.ts");
  const config = Config.fromEnv();
  mkdirSync(config.dataDir, { recursive: true });
  const db = Database.open(join(config.dataDir, "apollo.db"));
  const { token } = makePairing(db).createPairingToken(values.label);
  db.close();
  process.stdout.write(
    `${pairingUrl(values.url ?? config.publicUrl, token)}\n` +
      `One-time link, valid for ${PAIRING_TOKEN_TTL_MS / 60_000} minutes.\n`,
  );
} else if (command === undefined || command === "serve") {
  const NodeRuntime = await import("@effect/platform-node/NodeRuntime");
  const Layer = await import("effect/Layer");
  const Server = await import("./Server.ts");
  Layer.launch(Server.layer).pipe(NodeRuntime.runMain);
} else {
  process.stderr.write("usage: apollo [serve] | apollo pair [--label <name>] [--url <ui url>]\n");
  process.exitCode = 2;
}
