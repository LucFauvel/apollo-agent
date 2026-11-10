/** What `ChatScroll` needs of the transcript's scrolling element. */
export type Scroller = {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollTo: (options: ScrollToOptions) => void;
};

/** Within this of the bottom counts as at the latest message. */
export const NEAR_BOTTOM = 80;
/** Longest a smooth scroll of ours to the latest message takes (browsers: ~300–500 ms). */
export const OWN_SCROLL_MS = 700;

const fromBottom = (el: Scroller) => el.scrollHeight - el.scrollTop - el.clientHeight;

/**
 * Following the latest message in a chat. Scroll events can't tell our scrolling from the
 * user's, so: scroll events from our own scroll to the bottom never turn following off
 * half-way; the user's input (wheel, keys, a press on the transcript or its scrollbar)
 * ends our scroll at once; and nothing scrolls the transcript while it is pressed.
 */
export class ChatScroll {
  following = true;
  private ownUntil = 0;
  private pressed = false;
  private lastHeight = 0;
  /** A scroll of ours skipped while pressed, retried on release: "auto" if any was. */
  private skipped: ScrollBehavior | null = null;
  /** Where a press stopped our smooth scroll: the scroll event that stop fires is not the user's. */
  private stoppedAt: number | null = null;

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A conversation opens: follow from the bottom again. */
  reset() {
    this.following = true;
    this.ownUntil = 0;
    this.lastHeight = 0;
    this.skipped = null;
    this.stoppedAt = null;
  }

  /** Scrolls to the latest message and follows from there; while pressed, waits for the release. */
  toLatest(el: Scroller, behavior: ScrollBehavior): boolean {
    if (this.pressed) {
      this.skipped = this.skipped === "auto" || behavior === "auto" ? "auto" : behavior;
      return false;
    }
    this.skipped = null;
    this.following = true;
    this.ownUntil = this.now() + OWN_SCROLL_MS;
    this.lastHeight = el.scrollHeight;
    el.scrollTo({ top: el.scrollHeight, behavior });
    return true;
  }

  /**
   * The content changed: keeps up with it while following. More than a screen at once
   * (history arriving, a long block) jumps instead of gliding a long way.
   */
  contentChanged(el: Scroller, instant = false) {
    const grew = el.scrollHeight - this.lastHeight;
    this.lastHeight = el.scrollHeight;
    if (!this.following) return;
    this.toLatest(el, instant || grew > el.clientHeight ? "auto" : "smooth");
  }

  /** A scroll event. Returns whether it sits far enough up to offer a way back. */
  scrolled(el: Scroller): boolean {
    const gap = fromBottom(el);
    if (this.stoppedAt !== null && el.scrollTop === this.stoppedAt) {
      this.stoppedAt = null;
    } else if (this.now() < this.ownUntil) {
      if (gap <= NEAR_BOTTOM) this.ownUntil = 0;
    } else {
      this.following = gap <= NEAR_BOTTOM;
    }
    return gap > Math.max(240, el.clientHeight / 2);
  }

  /** The user scrolls (wheel, keys): ours stops; going up stops following at once. */
  userScroll(up: boolean) {
    this.ownUntil = 0;
    if (up) this.following = false;
  }

  /**
   * The user presses on the transcript (a drag, the scrollbar, a selection): a smooth scroll
   * of ours stops where it is, to finish on release. Letting go catches up with what was
   * skipped meanwhile, unless their scrolling stopped following. Returns whether it scrolled.
   */
  press(el: Scroller, down: boolean): boolean {
    if (down) {
      if (!this.pressed && this.now() < this.ownUntil) {
        this.stoppedAt = el.scrollTop;
        el.scrollTo({ top: el.scrollTop, behavior: "auto" });
        this.skipped = "smooth";
      }
      this.pressed = true;
      this.ownUntil = 0;
      return false;
    }
    if (!this.pressed) return false;
    this.pressed = false;
    this.stoppedAt = null;
    const skipped = this.skipped;
    this.skipped = null;
    return skipped !== null && this.following && this.toLatest(el, skipped);
  }

  /** We scroll somewhere else (a message, a search match): stop following. */
  leave() {
    this.following = false;
    this.ownUntil = 0;
    this.skipped = null;
  }
}

/** Keys that scroll a focused scrolling element, and whether they go up. */
export const scrollKey = (e: { readonly key: string; readonly shiftKey: boolean }): "up" | "down" | null => {
  switch (e.key) {
    case "ArrowUp":
    case "PageUp":
    case "Home":
      return "up";
    case "ArrowDown":
    case "PageDown":
    case "End":
      return "down";
    case " ":
      return e.shiftKey ? "up" : "down";
    default:
      return null;
  }
};
