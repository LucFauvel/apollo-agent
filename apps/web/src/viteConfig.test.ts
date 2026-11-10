import { describe, expect, it } from "vitest";
import config from "../vite.config.ts";

describe("web build", () => {
  it("bundles the search worker with the DOM-free entity decoder (workers have no document)", async () => {
    const plugins = (config.worker as { plugins: () => Array<{ resolveId: (...args: Array<unknown>) => Promise<{ id: string } | null> }> }).plugins();
    const resolveId = plugins[0]!.resolveId;
    const context = { resolve: async () => ({ id: "/x/node_modules/decode-named-character-reference/index.dom.js" }) };
    expect(await resolveId.call(context, "decode-named-character-reference", "/x/micromark.js", {})).toMatchObject({
      id: "/x/node_modules/decode-named-character-reference/index.js",
    });
    expect(await resolveId.call(context, "react", "/x/a.js", {})).toBeNull();
  });
});
