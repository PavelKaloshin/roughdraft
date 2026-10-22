import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { activeFileWatchCount, fileVersionFromFile } from "./file-watch";
import { createApp } from "./index";
import { createLiveSocketServer, type LiveSocketServer } from "./live-socket";

interface LiveMessage {
  id?: string;
  event?: string;
  data?: Record<string, unknown>;
  status?: number;
  error?: string;
}

/** A real WebSocket client that records every message it receives. */
class LiveClient {
  readonly messages: LiveMessage[] = [];
  closed = false;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      this.messages.push(JSON.parse(raw.toString()) as LiveMessage);
    });
    socket.on("close", () => {
      this.closed = true;
    });
  }

  static async connect(
    url: string,
    options?: WebSocket.ClientOptions,
  ): Promise<LiveClient> {
    const socket = new WebSocket(url, options);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new LiveClient(socket);
  }

  send(message: object): void {
    this.socket.send(JSON.stringify(message));
  }

  async next(
    matches: (message: LiveMessage) => boolean,
    timeoutMs = 2000,
  ): Promise<LiveMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(matches);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `no matching message; got ${JSON.stringify(this.messages)}`,
        );
      }
      await sleep(10);
    }
  }

  close(): void {
    this.socket.close();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(10);
  }
}

/** Resolves with the HTTP status a refused handshake answered with. */
function handshakeStatus(
  url: string,
  options?: WebSocket.ClientOptions,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      socket.terminate();
    });
    socket.once("open", () => {
      resolve(101);
      socket.close();
    });
    socket.once("error", (error) => {
      if (!socket.readyState) reject(error);
    });
  });
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// The browser tab gets file changes, agent status and open requests over one
// WebSocket. These tests drive the real server, real filesystem watcher and a
// real WebSocket client.
describe("live socket channels", () => {
  let projectDir: string;
  let documentPath: string;
  let server: Server;
  let host: string;
  let liveUrl: string;
  let clients: LiveClient[];
  let liveSocket: LiveSocketServer;

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-live-"));
    documentPath = path.join(projectDir, "plan.md");
    fs.writeFileSync(documentPath, "# Plan\n");
    const created = createApp({
      staticDirPath: projectDir,
      liveSocketHeartbeatMs: 50,
    });
    liveSocket = created.liveSocket;
    server = createServer(created.app);
    const attachLiveSocket = created.attachLiveSocket;
    attachLiveSocket(server);
    host = await listen(server);
    liveUrl = `ws://${host}/api/live`;
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.socket.terminate();
    // Let the server finish closing this test's channels (and their file
    // watchers) so the next test's watcher baseline is its own.
    await waitFor(() => liveSocket.connectionCount() === 0);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  async function connect(options?: WebSocket.ClientOptions) {
    const client = await LiveClient.connect(liveUrl, options);
    clients.push(client);
    return client;
  }

  const document = () => ({ projectPath: projectDir, path: "plan.md" });
  const isEvent = (id: string, event: string) => (message: LiveMessage) =>
    message.id === id && message.event === event;

  it("reports an external write to a subscribed file with its new version", async () => {
    const client = await connect();
    client.send({
      op: "subscribe",
      id: "f1",
      channel: "markdown-file",
      ...document(),
    });
    // A second channel's reply proves the file subscription is in place.
    client.send({
      op: "subscribe",
      id: "s1",
      channel: "agent-status",
      ...document(),
    });
    await client.next(isEvent("s1", "status"));

    fs.writeFileSync(documentPath, "# Plan\n\nAgent edit.\n");

    const change = await client.next(isEvent("f1", "change"));
    expect(change.data).toEqual({
      path: "plan.md",
      exists: true,
      version: fileVersionFromFile(documentPath),
    });
  });

  it("reports a write the tab missed when it subscribes with an older known version", async () => {
    const loadedVersion = fileVersionFromFile(documentPath);
    fs.writeFileSync(documentPath, "# Plan\n\nWritten while reconnecting.\n");

    const client = await connect();
    client.send({
      op: "subscribe",
      id: "f1",
      channel: "markdown-file",
      ...document(),
      version: loadedVersion,
    });

    const change = await client.next(isEvent("f1", "change"));
    expect(change.data?.version).toBe(fileVersionFromFile(documentPath));
  });

  it("stays quiet when the tab subscribes with the current version", async () => {
    const client = await connect();
    client.send({
      op: "subscribe",
      id: "f1",
      channel: "markdown-file",
      ...document(),
      version: fileVersionFromFile(documentPath),
    });
    // Messages are handled in order: a newer-version event would be sent
    // before this snapshot.
    client.send({
      op: "subscribe",
      id: "s1",
      channel: "agent-status",
      ...document(),
    });
    await client.next(isEvent("s1", "status"));

    expect(client.messages.filter((m) => m.id === "f1")).toEqual([]);
  });

  it("sends an agent status snapshot, then an update when a listener attaches", async () => {
    const client = await connect();
    client.send({
      op: "subscribe",
      id: "s1",
      channel: "agent-status",
      ...document(),
    });
    const snapshot = await client.next(isEvent("s1", "status"));
    expect(snapshot.data).toMatchObject({ listening: false, threads: {} });
    expect(typeof snapshot.data?.instanceId).toBe("string");

    const watch = await fetch(`http://${host}/api/review-events/watch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...document(),
        types: ["comment.ask"],
        timeoutSeconds: 0,
        listener: { id: "test-listener", sessionId: "abcd1234-0000" },
      }),
    });
    expect(watch.ok).toBe(true);

    const update = await client.next(
      (m) => isEvent("s1", "status")(m) && m.data?.listening === true,
    );
    expect(update.data).toMatchObject({ sessionId: "abcd1234-0000" });
  });

  it("delivers an open request to the tab registered for that path", async () => {
    const client = await connect();
    client.send({
      op: "subscribe",
      id: "o1",
      channel: "open-requests",
      path: documentPath,
    });
    await client.next(isEvent("o1", "connected"));

    const response = await fetch(`http://${host}/api/open-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: documentPath, url: "/?path=next.md" }),
    });
    expect(await response.json()).toEqual({ delivered: true });

    const request = await client.next(isEvent("o1", "open-request"));
    expect(request.data).toEqual({ path: documentPath, url: "/?path=next.md" });
  });

  it("refuses a channel for a file outside the project or missing", async () => {
    const client = await connect();
    client.send({
      op: "subscribe",
      id: "f1",
      channel: "markdown-file",
      projectPath: projectDir,
      path: "../outside.md",
    });
    client.send({ op: "subscribe", id: "x1", channel: "nope" });

    expect(await client.next((m) => m.id === "f1")).toMatchObject({
      status: 404,
    });
    expect(await client.next((m) => m.id === "x1")).toMatchObject({
      status: 400,
    });
  });

  it("closes file watchers on unsubscribe and when the socket goes away", async () => {
    const baseline = activeFileWatchCount();
    const client = await connect();
    client.send({
      op: "subscribe",
      id: "f1",
      channel: "markdown-file",
      ...document(),
    });
    client.send({
      op: "subscribe",
      id: "f2",
      channel: "markdown-file",
      ...document(),
    });
    await waitFor(() => activeFileWatchCount() === baseline + 2);

    client.send({ op: "unsubscribe", id: "f1" });
    await waitFor(() => activeFileWatchCount() === baseline + 1);

    client.close();
    await waitFor(() => activeFileWatchCount() === baseline);
  });

  it("re-subscribing the same id replaces the channel instead of leaking it", async () => {
    const baseline = activeFileWatchCount();
    const client = await connect();
    for (let round = 0; round < 3; round += 1) {
      client.send({
        op: "subscribe",
        id: "f1",
        channel: "markdown-file",
        ...document(),
      });
    }
    client.send({
      op: "subscribe",
      id: "s1",
      channel: "agent-status",
      ...document(),
    });
    await client.next(isEvent("s1", "status"));

    expect(activeFileWatchCount()).toBe(baseline + 1);
  });

  it("sends heartbeats and drops a socket that stops answering pings", async () => {
    const baseline = activeFileWatchCount();
    const healthy = await connect();
    await healthy.next((m) => m.event === "heartbeat");

    // A client that never answers pings looks like a dead network peer.
    const dead = await connect({ autoPong: false });
    dead.send({
      op: "subscribe",
      id: "f1",
      channel: "markdown-file",
      ...document(),
    });
    await waitFor(() => activeFileWatchCount() === baseline + 1);

    await waitFor(() => dead.closed, 2000);
    await waitFor(() => activeFileWatchCount() === baseline);
    expect(healthy.closed).toBe(false);
  });

  it("accepts loopback tabs without a token even when one is configured", async () => {
    const { app, attachLiveSocket } = createApp({
      staticDirPath: projectDir,
      remoteDocumentToken: "s3cret",
    });
    const tokenServer = createServer(app);
    attachLiveSocket(tokenServer);
    const tokenHost = await listen(tokenServer);
    try {
      expect(await handshakeStatus(`ws://${tokenHost}/api/live`)).toBe(101);
    } finally {
      tokenServer.closeAllConnections();
      await new Promise((resolve) => tokenServer.close(resolve));
    }
  });

  it("rejects a handshake from another site's page", async () => {
    expect(
      await handshakeStatus(liveUrl, { origin: "http://evil.example" }),
    ).toBe(403);
    expect(await handshakeStatus(liveUrl, { origin: `http://${host}` })).toBe(
      101,
    );
  });
});

describe("live socket token", () => {
  let server: Server;
  let live: LiveSocketServer;
  let url: string;

  beforeEach(async () => {
    // Treat every peer as remote, as on a Tailscale/LAN binding.
    live = createLiveSocketServer({
      token: "s3cret",
      openChannel: () => ({ ok: true, close: () => {} }),
      isTrustedAddress: () => false,
    });
    server = createServer();
    server.on("upgrade", (req, socket, head) => {
      if (!live.handleUpgrade(req, socket, head)) socket.destroy();
    });
    url = `ws://${await listen(server)}/api/live`;
  });

  afterEach(async () => {
    live.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("requires the configured token from non-loopback peers", async () => {
    expect(await handshakeStatus(url)).toBe(401);
    expect(await handshakeStatus(`${url}?token=wrong`)).toBe(401);
    expect(await handshakeStatus(`${url}?token=s3cret`)).toBe(101);
  });
});
