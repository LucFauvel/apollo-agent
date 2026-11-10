import { describe, expect, it } from "vitest";
import { ChatScroll, OWN_SCROLL_MS, scrollKey } from "./chatScroll.ts";

const scroller = (scrollHeight: number, clientHeight = 500) => {
  const calls: Array<ScrollToOptions> = [];
  const el = {
    scrollTop: Math.max(0, scrollHeight - clientHeight),
    scrollHeight,
    clientHeight,
    scrollTo: (options: ScrollToOptions) => void calls.push(options),
  };
  return { el, calls };
};

const clock = () => {
  const c = { t: 1000, now: () => c.t };
  return c;
};

describe("ChatScroll", () => {
  it("keeps following through its own smooth scroll's intermediate scroll events", () => {
    const c = clock();
    const follow = new ChatScroll(c.now);
    const { el, calls } = scroller(1000);
    follow.contentChanged(el);
    el.scrollHeight = 1200;
    follow.contentChanged(el);
    expect(calls.at(-1)).toEqual({ top: 1200, behavior: "smooth" });
    el.scrollTop = 520;
    c.t += 50;
    follow.scrolled(el);
    expect(follow.following).toBe(true);
    el.scrollHeight = 1300;
    follow.contentChanged(el);
    expect(calls.at(-1)).toEqual({ top: 1300, behavior: "smooth" });
  });

  it("lets the user's scroll take over at once, going up stops following", () => {
    const c = clock();
    const follow = new ChatScroll(c.now);
    const { el, calls } = scroller(1000);
    follow.toLatest(el, "smooth");
    follow.userScroll(true);
    expect(follow.following).toBe(false);
    const before = calls.length;
    el.scrollHeight = 1100;
    follow.contentChanged(el);
    expect(calls.length).toBe(before);
  });

  it("after its own scroll, scroll events are the user's again", () => {
    const c = clock();
    const follow = new ChatScroll(c.now);
    const { el } = scroller(1000);
    follow.toLatest(el, "smooth");
    c.t += OWN_SCROLL_MS + 1;
    el.scrollTop = 100;
    follow.scrolled(el);
    expect(follow.following).toBe(false);
  });

  it("does not scroll while the transcript is pressed, and catches up after", () => {
    const follow = new ChatScroll(clock().now);
    const { el, calls } = scroller(1000);
    follow.press(true);
    el.scrollHeight = 1100;
    follow.contentChanged(el);
    expect(calls).toEqual([]);
    follow.press(false);
    el.scrollHeight = 1150;
    follow.contentChanged(el);
    expect(calls.at(-1)).toEqual({ top: 1150, behavior: "smooth" });
  });

  it("jumps instead of gliding when more than a screen arrives at once", () => {
    const follow = new ChatScroll(clock().now);
    const { el, calls } = scroller(1000);
    follow.contentChanged(el);
    el.scrollHeight = 3000;
    follow.contentChanged(el);
    expect(calls.at(-1)).toEqual({ top: 3000, behavior: "auto" });
  });

  it("leaving for a message stops following until back at the bottom", () => {
    const c = clock();
    const follow = new ChatScroll(c.now);
    const { el, calls } = scroller(1000);
    follow.toLatest(el, "smooth");
    follow.leave();
    el.scrollTop = 100;
    follow.scrolled(el);
    el.scrollHeight = 1100;
    follow.contentChanged(el);
    expect(calls.length).toBe(1);
    el.scrollTop = 1100 - 500 - 10;
    follow.scrolled(el);
    expect(follow.following).toBe(true);
  });

  it("says when it sits far enough up to offer a way back", () => {
    const c = clock();
    const follow = new ChatScroll(c.now);
    const { el } = scroller(3000);
    el.scrollTop = 3000 - 500 - 200;
    expect(follow.scrolled(el)).toBe(false);
    el.scrollTop = 1000;
    expect(follow.scrolled(el)).toBe(true);
  });
});

describe("scrollKey", () => {
  it("knows which keys scroll up or down", () => {
    expect(scrollKey({ key: "PageUp", shiftKey: false })).toBe("up");
    expect(scrollKey({ key: " ", shiftKey: true })).toBe("up");
    expect(scrollKey({ key: "End", shiftKey: false })).toBe("down");
    expect(scrollKey({ key: "a", shiftKey: false })).toBe(null);
  });
});
