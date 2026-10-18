/**
 * One WebSocket per tab for every live update from the local server (open
 * requests, markdown file changes, agent status). Long-lived HTTP streams
 * (EventSource) each hold one of the browser's six HTTP/1.1 connections per
 * host, shared by all tabs, so a few open tabs starved saves and comment
 * events. A WebSocket is outside that pool.
 *
 * Channels survive reconnects: after the socket drops, it reconnects with
 * backoff and re-sends every active subscription, asking each channel for
 * its current parameters (the file channel re-sends the version the tab
 * already has, so a write during the outage is reported, not lost).
 */

export type LiveEventHandler = (event: string, data: unknown) => void;

/** The subset of the browser WebSocket this module uses (tests fake it). */
export interface LiveSocket {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

interface LiveConnectionOptions {
  url: () => string;
  createSocket?: (url: string) => LiveSocket;
  /** Reconnect delay after the first failure; doubles up to `maxRetryMs`. */
  initialRetryMs?: number;
  maxRetryMs?: number;
  /**
   * The server sends a heartbeat every 15 s; without any message for this
   * long the connection is treated as dead and replaced.
   */
  silenceTimeoutMs?: number;
  /** How long an unused socket stays open (React remounts resubscribe). */
  idleCloseMs?: number;
}

interface Channel {
  channel: string;
  params: () => Record<string, unknown>;
  onEvent: LiveEventHandler;
}

const SOCKET_OPEN = 1;

export class LiveConnection {
  private readonly options: Required<LiveConnectionOptions>;
  private readonly channels = new Map<string, Channel>();
  private socket: LiveSocket | null = null;
  private nextId = 1;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LiveConnectionOptions) {
    this.options = {
      createSocket: (url) => new WebSocket(url) as unknown as LiveSocket,
      initialRetryMs: 500,
      maxRetryMs: 10_000,
      silenceTimeoutMs: 40_000,
      idleCloseMs: 1_000,
      ...options,
    };
  }

  /**
   * Subscribes to a server channel. `params` is read on every (re)subscribe.
   * Returns the unsubscribe function.
   */
  subscribe(
    channel: string,
    params: () => Record<string, unknown>,
    onEvent: LiveEventHandler,
  ): () => void {
    const id = `s${this.nextId}`;
    this.nextId += 1;
    this.channels.set(id, { channel, params, onEvent });
    this.cancelIdleClose();

    if (this.socket?.readyState === SOCKET_OPEN) {
      this.sendSubscribe(id);
    } else if (!this.socket && !this.retryTimer) {
      this.connect();
    }

    return () => {
      if (!this.channels.delete(id)) return;
      if (this.socket?.readyState === SOCKET_OPEN) {
        this.socket.send(JSON.stringify({ op: "unsubscribe", id }));
      }
      if (this.channels.size === 0) this.scheduleIdleClose();
    };
  }

  private connect(): void {
    this.retryTimer = null;
    let socket: LiveSocket;
    try {
      socket = this.options.createSocket(this.options.url());
    } catch (error) {
      console.error("Could not open the Roughdraft live connection:", error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.failures = 0;
      this.resetSilenceTimer();
      for (const id of this.channels.keys()) this.sendSubscribe(id);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.resetSilenceTimer();
      this.handleMessage(event.data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearSilenceTimer();
      if (this.channels.size > 0) this.scheduleReconnect();
    };
    // A failed socket also fires `close`, which handles the retry.
    socket.onerror = () => {};
  }

  private sendSubscribe(id: string): void {
    const channel = this.channels.get(id);
    if (!channel || this.socket?.readyState !== SOCKET_OPEN) return;
    this.socket.send(
      JSON.stringify({
        ...channel.params(),
        op: "subscribe",
        id,
        channel: channel.channel,
      }),
    );
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let message: {
      id?: unknown;
      event?: unknown;
      data?: unknown;
      error?: unknown;
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id !== "string") return;
    const channel = this.channels.get(message.id);
    if (!channel) return;
    if (typeof message.error === "string") {
      console.error(
        `Roughdraft live channel ${channel.channel} was refused:`,
        message.error,
      );
      return;
    }
    if (typeof message.event !== "string") return;
    try {
      channel.onEvent(message.event, message.data);
    } catch (error) {
      console.error(`Failed to handle ${channel.channel} event:`, error);
    }
  }

  private scheduleReconnect(): void {
    if (this.retryTimer) return;
    const delay = Math.min(
      this.options.initialRetryMs * 2 ** this.failures,
      this.options.maxRetryMs,
    );
    this.failures += 1;
    this.retryTimer = setTimeout(() => {
      if (this.channels.size > 0) this.connect();
      else this.retryTimer = null;
    }, delay);
  }

  private resetSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      // Half-open connections never fire `close` on their own.
      const socket = this.socket;
      if (!socket) return;
      this.socket = null;
      socket.close();
      this.scheduleReconnect();
    }, this.options.silenceTimeoutMs);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  private scheduleIdleClose(): void {
    this.cancelIdleClose();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.channels.size > 0) return;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.clearSilenceTimer();
      const socket = this.socket;
      this.socket = null;
      socket?.close();
    }, this.options.idleCloseMs);
  }

  private cancelIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function liveSocketUrl(): string {
  const location = window.location;
  const url = new URL("/api/live", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  // Non-loopback servers with ROUGHDRAFT_TOKEN require it (ADR 0004); the
  // CLI puts it in the page URL.
  const token = new URLSearchParams(location.search).get("token")?.trim();
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

let sharedConnection: LiveConnection | null = null;

/** The tab's single live connection to the server it was loaded from. */
export function getLiveConnection(): LiveConnection {
  sharedConnection ??= new LiveConnection({ url: liveSocketUrl });
  return sharedConnection;
}
