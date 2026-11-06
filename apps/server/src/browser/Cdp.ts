/**
 * A minimal Chrome DevTools Protocol client over one browser-level WebSocket,
 * with targets attached in flat mode (each command names its `sessionId`).
 */

export type CdpListener = (method: string, params: any, sessionId: string | undefined) => void;

export class CdpError extends Error {}

interface Pending {
  readonly resolve: (value: any) => void;
  readonly reject: (error: Error) => void;
  readonly method: string;
}

export class Cdp {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<CdpListener>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => this.shutdown());
    socket.addEventListener("error", () => this.shutdown());
  }

  static connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new CdpError("timed out connecting to the browser"));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new Cdp(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new CdpError("could not connect to the browser"));
      });
    });
  }

  get isClosed() {
    return this.closed;
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError("the browser is not running"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener: CdpListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => void this.closeListeners.delete(listener);
  }

  close() {
    this.socket.close();
    this.shutdown();
  }

  private receive(raw: string) {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new CdpError(message.error.message ?? `${pending.method} failed`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === "string") {
      for (const listener of this.listeners) {
        try {
          listener(message.method, message.params ?? {}, message.sessionId);
        } catch {
          // A failing listener must not break the others.
        }
      }
    }
  }

  private shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new CdpError("the browser closed"));
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }
}
