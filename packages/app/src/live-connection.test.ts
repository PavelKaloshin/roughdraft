import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiBackend } from "./api-backend";
import type { AgentStatusSnapshot } from "./comment-agent";
import { LiveConnection, type LiveSocket } from "./live-connection";
import type { MarkdownFileChangeEvent } from "./storage";

/** A scripted stand-in for the browser WebSocket. */
class FakeSocket implements LiveSocket {
  readyState = 0;
  onopen: LiveSocket["onopen"] = null;
  onmessage: LiveSocket["onmessage"] = null;
  onclose: LiveSocket["onclose"] = null;
  onerror: LiveSocket["onerror"] = null;
  readonly sent: Array<Record<string, unknown>> = [];

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.drop();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }

  subscribes() {
    return this.sent.filter((message) => message.op === "subscribe");
  }
}

describe("LiveConnection", () => {
  let sockets: FakeSocket[];

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function connection() {
    return new LiveConnection({
      url: () => "ws://roughdraft.test/api/live",
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      initialRetryMs: 100,
      maxRetryMs: 1_000,
      silenceTimeoutMs: 5_000,
    });
  }

  const latest = () => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error("no socket opened");
    return socket;
  };

  function backend(live: LiveConnection) {
    return new ApiBackend(
      { kind: "local-files", label: "Local files", projectPath: "/work" },
      live,
    );
  }

  it("shares one socket between every channel of the tab", () => {
    const live = connection();
    const api = backend(live);
    api.watchMarkdownFile("plan.md", () => {}, "v1");
    api.watchAgentStatus("plan.md", () => {});
    live.subscribe(
      "open-requests",
      () => ({ path: "/work/plan.md" }),
      () => {},
    );
    latest().open();

    expect(sockets).toHaveLength(1);
    expect(latest().subscribes()).toEqual([
      expect.objectContaining({
        channel: "markdown-file",
        projectPath: "/work",
        path: "plan.md",
        version: "v1",
      }),
      expect.objectContaining({ channel: "agent-status", path: "plan.md" }),
      expect.objectContaining({
        channel: "open-requests",
        path: "/work/plan.md",
      }),
    ]);
  });

  it("routes each server event to its own channel", () => {
    const live = connection();
    const api = backend(live);
    const changes: MarkdownFileChangeEvent[] = [];
    const statuses: AgentStatusSnapshot[] = [];
    api.watchMarkdownFile("plan.md", (change) => changes.push(change), "v1");
    api.watchAgentStatus("plan.md", (status) => statuses.push(status));
    latest().open();
    const [fileSub, statusSub] = latest().subscribes();

    latest().receive({
      id: statusSub?.id,
      event: "status",
      data: { listening: true, listenerCount: 1, threads: { c1: "working" } },
    });
    latest().receive({
      id: fileSub?.id,
      event: "change",
      data: { path: "plan.md", exists: true, version: "v2" },
    });

    expect(changes).toEqual([{ path: "plan.md", exists: true, version: "v2" }]);
    expect(statuses).toEqual([
      { listening: true, listenerCount: 1, threads: { c1: "working" } },
    ]);
  });

  it("reconnects after a drop and re-subscribes with the newest known file version", () => {
    const live = connection();
    const api = backend(live);
    api.watchMarkdownFile("plan.md", () => {}, "v1");
    api.watchAgentStatus("plan.md", () => {});
    latest().open();
    const fileId = latest().subscribes()[0]?.id;
    latest().receive({
      id: fileId,
      event: "change",
      data: { path: "plan.md", exists: true, version: "v2" },
    });

    latest().drop();
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
    latest().open();

    // A write while the socket was down is newer than v2, so the server
    // reports it as soon as the file channel is back.
    expect(latest().subscribes()).toEqual([
      expect.objectContaining({ channel: "markdown-file", version: "v2" }),
      expect.objectContaining({ channel: "agent-status" }),
    ]);
  });

  it("backs off between failed reconnects and resets once connected", () => {
    const live = connection();
    live.subscribe(
      "open-requests",
      () => ({}),
      () => {},
    );

    latest().drop();
    vi.advanceTimersByTime(99);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    latest().drop();
    vi.advanceTimersByTime(199);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    latest().open();
    latest().drop();
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(4);
  });

  it("replaces a connection that has gone silent", () => {
    const live = connection();
    live.subscribe(
      "open-requests",
      () => ({}),
      () => {},
    );
    latest().open();

    vi.advanceTimersByTime(4_000);
    latest().receive({ event: "heartbeat" });
    vi.advanceTimersByTime(4_000);
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.readyState).toBe(3);
  });

  it("unsubscribes on the open socket and closes it once nothing listens", () => {
    const live = connection();
    const stopFile = backend(live).watchMarkdownFile("plan.md", () => {}, "v1");
    latest().open();
    const fileId = latest().subscribes()[0]?.id;

    stopFile();
    expect(latest().sent.at(-1)).toEqual({ op: "unsubscribe", id: fileId });

    vi.advanceTimersByTime(1_000);
    expect(latest().readyState).toBe(3);
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
  });
});
