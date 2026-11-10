/**
 * The install engine's building blocks live in src/install/lib.ts, so the packaged app's
 * updater (src/update/) runs the same code as install:app. Re-exported here for the scripts.
 */
export * from "../src/install/lib.ts";
