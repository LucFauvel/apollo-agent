/**
 * Minimal push-based AsyncIterable. Used to feed user messages into SDKs that
 * consume an `AsyncIterable` prompt (Claude Agent SDK streaming input).
 */
export interface AsyncInbox<T> extends AsyncIterable<T> {
  readonly push: (value: T) => void;
  readonly close: () => void;
}

export const makeAsyncInbox = <T>(): AsyncInbox<T> => {
  const buffer: Array<T> = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  const push = (value: T) => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) waiter({ value, done: false });
    else buffer.push(value);
  };

  const close = () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
  };

  return {
    push,
    close,
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const value = buffer.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve));
      },
      return: () => {
        close();
        return Promise.resolve({ value: undefined, done: true });
      },
    }),
  };
};
