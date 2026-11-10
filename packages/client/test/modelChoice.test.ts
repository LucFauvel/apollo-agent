import type { ModelOption } from "@apollo/contracts";
import { describe, expect, it } from "vitest";
import { downloadPercent, makeChoiceSync, type ModelChoice, splitModelId, withEffort, withModel } from "../src/index.ts";

const option = (id: string, efforts: ReadonlyArray<string>, isDefault = false): ModelOption => ({
  id,
  label: id.toUpperCase(),
  description: "",
  isDefault,
  efforts,
  defaultEffort: efforts[0] ?? null,
});
const models = [option("a", ["low", "high"], true), option("b", ["high"]), option("c", [])];

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

const harness = () => {
  const sent: Array<{ choice: ModelChoice; reply: ReturnType<typeof deferred<ModelChoice>> }> = [];
  const errors: Array<unknown> = [];
  const sync = makeChoiceSync({
    send: (choice) => {
      const reply = deferred<ModelChoice>();
      sent.push({ choice, reply });
      return reply.promise;
    },
    onChange: () => {},
    onError: (e) => errors.push(e),
  });
  return { sync, sent, errors };
};

describe("model choice", () => {
  it("keeps the effort only when the new model supports it", () => {
    expect(withModel(models, { model: "a", effort: "high" }, "b")).toEqual({ model: "b", effort: "high" });
    expect(withModel(models, { model: "a", effort: "low" }, "b")).toEqual({ model: "b", effort: null });
    expect(withModel(models, { model: "b", effort: "low" }, null)).toEqual({ model: null, effort: "low" });
    expect(withModel(models, { model: "a", effort: "high" }, "custom-id")).toEqual({ model: "custom-id", effort: null });
  });

  it("an effort picked before the model update lands keeps the new model", async () => {
    const { sync, sent } = harness();
    const session = { model: "a", effort: null };
    sync.pick(withModel(models, sync.shown(session), "b"));
    sync.pick(withEffort(sync.shown(session), "high"));
    await flush();
    expect(sent.map((s) => s.choice)).toEqual([{ model: "b", effort: null }]);
    sent[0]!.reply.resolve({ model: "b", effort: null });
    await flush();
    expect(sent.map((s) => s.choice)).toEqual([
      { model: "b", effort: null },
      { model: "b", effort: "high" },
    ]);
    expect(sync.shown(session)).toEqual({ model: "b", effort: "high" });
  });

  it("shows the pick until the session reflects it", async () => {
    const { sync, sent } = harness();
    const before = { model: "a", effort: null };
    sync.pick({ model: "b", effort: null });
    await flush();
    sent[0]!.reply.resolve({ model: "b", effort: null });
    await flush();
    sync.sessionChanged(before);
    expect(sync.shown(before)).toEqual({ model: "b", effort: null });
    const after = { model: "b", effort: null };
    sync.sessionChanged(after);
    expect(sync.shown({ model: "z", effort: null })).toEqual({ model: "z", effort: null });
  });

  it("settles at once when the session already changed before the reply", async () => {
    const { sync, sent } = harness();
    sync.pick({ model: "c", effort: null });
    await flush();
    sync.sessionChanged({ model: "c", effort: null });
    sent[0]!.reply.resolve({ model: "c", effort: null });
    await flush();
    expect(sync.shown({ model: "z", effort: null })).toEqual({ model: "z", effort: null });
  });

  it("falls back to the session and reports a failed update", async () => {
    const { sync, sent, errors } = harness();
    const session = { model: "a", effort: null };
    sync.pick({ model: "b", effort: null });
    await flush();
    sent[0]!.reply.reject(new Error("offline"));
    await flush();
    expect(errors).toHaveLength(1);
    expect(sync.shown(session)).toEqual(session);
  });

  it("names local models and their download progress", () => {
    expect(splitModelId("unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M")).toEqual({ name: "Qwen3-4B-Instruct-2507", author: "unsloth", quant: "Q4_K_M" });
    expect(splitModelId("org/Plain")).toEqual({ name: "Plain", author: "org", quant: null });
    const model = (download: { done: number; total: number } | null) => ({ download }) as unknown as Parameters<typeof downloadPercent>[0];
    expect(downloadPercent(model({ done: 1, total: 3 }))).toBe(33);
    expect(downloadPercent(model(null))).toBe(0);
  });
});
