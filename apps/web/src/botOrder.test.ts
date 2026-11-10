import { type Bot, type BotId, sortBots } from "@apollo/contracts";
import { describe, expect, it } from "vitest";
import { gapAt, moveToGap, rollBack, withOrder } from "./botOrder.ts";

const bot = (id: string, position: number): Bot => ({ id: id as BotId, position, createdAt: 0 }) as unknown as Bot;
const map = (...bots: Array<Bot>) => new Map(bots.map((b) => [b.id, b]));
const names = (bots: ReadonlyMap<BotId, Bot>) => sortBots(bots.values()).map((b) => b.id);
const id = (s: string) => s as BotId;

describe("moveToGap", () => {
  const ids = ["a", "b", "c", "d"];
  it("moves down into a later gap", () => expect(moveToGap(ids, 0, 3)).toEqual(["b", "c", "a", "d"]));
  it("moves to the end", () => expect(moveToGap(ids, 1, 4)).toEqual(["a", "c", "d", "b"]));
  it("moves up to the start", () => expect(moveToGap(ids, 3, 0)).toEqual(["d", "a", "b", "c"]));
  it("leaves the list alone for the gaps around the item", () => {
    expect(moveToGap(ids, 2, 2)).toBe(ids);
    expect(moveToGap(ids, 2, 3)).toBe(ids);
  });
  it("ignores out-of-range input", () => {
    expect(moveToGap(ids, -1, 0)).toBe(ids);
    expect(moveToGap(ids, 0, 9)).toBe(ids);
  });
});

describe("gapAt", () => {
  const rows = [
    { top: 0, bottom: 40 },
    { top: 48, bottom: 88 },
    { top: 96, bottom: 200 },
  ];
  it("picks the gap by row midpoints", () => {
    expect(gapAt(rows, -50)).toBe(0);
    expect(gapAt(rows, 19)).toBe(0);
    expect(gapAt(rows, 21)).toBe(1);
    expect(gapAt(rows, 70)).toBe(2);
    expect(gapAt(rows, 150)).toBe(3);
    expect(gapAt(rows, 999)).toBe(3);
  });
});

describe("optimistic reorder", () => {
  const before = map(bot("a", 0), bot("b", 1), bot("c", 2));

  it("applies the new order at once, keeping bots it does not list after the rest", () => {
    expect(names(withOrder(before, [id("c"), id("a"), id("b")]))).toEqual(["c", "a", "b"]);
    expect(names(withOrder(before, [id("c"), id("gone")]))).toEqual(["c", "a", "b"]);
  });

  it("rolls back to the previous order when the server refuses", () => {
    const optimistic = withOrder(before, [id("c"), id("b"), id("a")]);
    expect(names(rollBack(optimistic, optimistic, before))).toEqual(["a", "b", "c"]);
  });

  it("keeps positions the server pushed in the meantime, and bots created meanwhile", () => {
    const optimistic = withOrder(before, [id("c"), id("b"), id("a")]);
    const current = new Map(optimistic).set(id("a"), bot("a", 7)).set(id("d"), bot("d", 3));
    const after = rollBack(current, optimistic, before);
    expect(after.get(id("a"))!.position).toBe(7);
    expect(after.get(id("b"))!.position).toBe(1);
    expect(after.get(id("c"))!.position).toBe(2);
    expect(after.get(id("d"))!.position).toBe(3);
  });
});
