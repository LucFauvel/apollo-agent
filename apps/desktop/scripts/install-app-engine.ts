/**
 * The install state machine lives in src/install/engine.ts, so the packaged app's updater
 * (src/update/helper.ts) runs the same engine as install:app. Re-exported here for the scripts.
 */
export * from "../src/install/engine.ts";
