/**
 * Opening a conversation replays its whole history (`sessions.events` from seq 0), then
 * follows live events, with nothing on the wire saying where one ends and the other
 * starts. Applying and rendering each event as it arrives re-renders the conversation once
 * per event: the screen freezes while it loads. This hands events over in batches (at most
 * one per `flushMs`) and says when the replay has caught up: once events stop coming for
 * `quietMs` (history arrives in a burst), after `maxMs` of events in any case (a session
 * working while it opens never goes quiet), or after `emptyMs` with no event at all.
 */
export type ReplayTiming = {
  readonly flushMs: number;
  readonly quietMs: number;
  readonly maxMs: number;
  readonly emptyMs: number;
};

export const replayTiming: ReplayTiming = { flushMs: 16, quietMs: 150, maxMs: 2000, emptyMs: 3000 };

export type ReplayBuffer<E> = {
  readonly push: (event: E) => void;
  readonly dispose: () => void;
};

export const replayBuffer = <E>(options: {
  readonly onBatch: (events: ReadonlyArray<E>) => void;
  /** Called once, after the batch holding the last replayed event. */
  readonly onCaughtUp: () => void;
  readonly timing?: Partial<ReplayTiming>;
  readonly now?: () => number;
}): ReplayBuffer<E> => {
  const timing = { ...replayTiming, ...options.timing };
  const now = options.now ?? Date.now;
  let pending: Array<E> = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let firstAt: number | null = null;
  let caughtUp = false;
  let disposed = false;

  const flush = () => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (disposed || pending.length === 0) return;
    const batch = pending;
    pending = [];
    options.onBatch(batch);
  };
  const catchUp = () => {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = undefined;
    if (caughtUp || disposed) return;
    caughtUp = true;
    flush();
    options.onCaughtUp();
  };
  const settleIn = (ms: number) => {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = setTimeout(catchUp, ms);
  };

  settleIn(timing.emptyMs);
  return {
    push: (event) => {
      if (disposed) return;
      pending.push(event);
      if (!caughtUp) {
        firstAt ??= now();
        if (now() - firstAt >= timing.maxMs) return catchUp();
        settleIn(timing.quietMs);
      }
      flushTimer ??= setTimeout(flush, timing.flushMs);
    },
    dispose: () => {
      disposed = true;
      pending = [];
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
    },
  };
};
