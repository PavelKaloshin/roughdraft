import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";

/**
 * One WebSocket per browser tab carries every push channel the app needs
 * (open requests, markdown file changes, agent status). Long-lived HTTP/1.1
 * streams count against the browser's six-connections-per-host limit, shared
 * by all tabs; with a few tabs open, saves and comment events queued behind
 * them. WebSockets are not part of that pool.
 *
 * Protocol (JSON text frames):
 * - client → server: `{op: "subscribe", id, channel, ...params}` and
 *   `{op: "unsubscribe", id}`. `id` is chosen by the client and names the
 *   subscription in every server message.
 * - server → client: `{id, event, data}` for channel events, `{id, error,
 *   status}` when a subscription is refused, and `{event: "heartbeat"}` on
 *   an interval so the client can tell a silent dead connection from a quiet
 *   one. The server also pings at the protocol level and drops sockets that
 *   stop answering.
 */
export const LIVE_SOCKET_PATH = "/api/live";
const DEFAULT_HEARTBEAT_MS = 15_000;
const MAX_SUBSCRIPTIONS_PER_SOCKET = 64;
const MAX_MESSAGE_BYTES = 64 * 1024;

export interface LiveChannelSink {
  send(event: string, data: unknown): void;
}

export type LiveChannelOpenResult =
  | { ok: true; close: () => void }
  | { ok: false; status: number; error: string };

/** Opens one channel subscription; params are untrusted client input. */
export type LiveChannelOpener = (
  channel: string,
  params: Record<string, unknown>,
  sink: LiveChannelSink,
) => LiveChannelOpenResult;

interface LiveSocketOptions {
  /** When set, non-loopback connections must present it as `?token=`. */
  token: string | null;
  openChannel: LiveChannelOpener;
  heartbeatMs?: number;
  /** Addresses that need no token. Defaults to loopback. */
  isTrustedAddress?: (address: string | undefined) => boolean;
}

export interface LiveSocketServer {
  /**
   * Handles an HTTP upgrade for the live endpoint. Returns false when the
   * request is for another path, so the caller can reject it.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  connectionCount(): number;
  close(): void;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === "::1" ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.")
  );
}

function tokensMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Browsers let any page open a WebSocket to any host (no CORS), so a page on
 * another site could otherwise subscribe to this machine's file events. A
 * browser always sends Origin on a WebSocket handshake; it must name the host
 * the request was sent to. Non-browser clients send no Origin.
 */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

export function createLiveSocketServer(
  options: LiveSocketOptions,
): LiveSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
  });
  const alive = new WeakMap<WebSocket, boolean>();
  const isTrustedAddress = options.isTrustedAddress ?? isLoopbackAddress;

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
      socket.send(JSON.stringify({ event: "heartbeat" }));
    }
  }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  heartbeat.unref?.();

  wss.on("connection", (socket: WebSocket) => {
    alive.set(socket, true);
    socket.on("pong", () => alive.set(socket, true));

    const subscriptions = new Map<string, () => void>();
    const sendJson = (message: object) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    };
    const unsubscribe = (id: string) => {
      const close = subscriptions.get(id);
      if (!close) return;
      subscriptions.delete(id);
      close();
    };

    socket.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw.toString());
        if (!parsed || typeof parsed !== "object") return;
        message = parsed as Record<string, unknown>;
      } catch {
        return;
      }

      const id = typeof message.id === "string" ? message.id : "";
      if (!id) return;

      if (message.op === "unsubscribe") {
        unsubscribe(id);
        return;
      }
      if (message.op !== "subscribe") return;

      // Re-subscribing an id replaces it (a client re-sending its channels).
      unsubscribe(id);
      if (subscriptions.size >= MAX_SUBSCRIPTIONS_PER_SOCKET) {
        sendJson({ id, status: 429, error: "Too many subscriptions" });
        return;
      }

      const channel =
        typeof message.channel === "string" ? message.channel : "";
      const opened = options.openChannel(channel, message, {
        send: (event, data) => sendJson({ id, event, data }),
      });
      if (!opened.ok) {
        sendJson({ id, status: opened.status, error: opened.error });
        return;
      }
      // The socket may have closed while the channel was opening.
      if (socket.readyState !== socket.OPEN) {
        opened.close();
        return;
      }
      subscriptions.set(id, opened.close);
    });

    socket.on("close", () => {
      for (const id of [...subscriptions.keys()]) unsubscribe(id);
    });
    socket.on("error", () => {
      socket.terminate();
    });
  });

  return {
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== LIVE_SOCKET_PATH) return false;

      if (!isSameOrigin(req)) {
        rejectUpgrade(socket, 403, "Forbidden");
        return true;
      }
      if (
        options.token !== null &&
        !isTrustedAddress(req.socket.remoteAddress) &&
        !tokensMatch(url.searchParams.get("token") ?? "", options.token)
      ) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return true;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return true;
    },
    connectionCount() {
      return wss.clients.size;
    },
    close() {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      wss.close();
    },
  };
}
