import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  extractRoughdraftReviewIndex,
  markRoughdraftResolved,
} from "@roughdraft/rfm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index";

const PLAN = [
  "# Plan",
  "",
  "We deploy on Fridays. Cold start takes {==about four seconds==}{>>What is included in that time?<<}{#c1} on a fresh deploy.",
  "",
  "Tighten {==this paragraph==}{>>Make it one sentence.<<}{#c2}.",
  "",
  "---",
  "comments:",
  "  c1:",
  "    by: pavel",
  '    at: "2026-10-18T12:00:00.000Z"',
  "    intent: ask",
  "  c2:",
  "    by: pavel",
  '    at: "2026-10-18T12:00:05.000Z"',
  "    intent: change",
  "",
].join("\n");

describe("agent comment events", () => {
  let projectDir: string;
  let documentPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-agent-"));
    documentPath = path.join(projectDir, "plan.md");
    fs.writeFileSync(documentPath, PLAN);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  function makeApp(options: { agentListenerGraceMs?: number } = {}) {
    return createApp({ staticDirPath: projectDir, ...options }).app;
  }

  const target = () => ({ projectPath: projectDir, path: "plan.md" });

  function postEvent(
    app: ReturnType<typeof makeApp>,
    type: string,
    commentId?: string,
  ) {
    return request(app)
      .post("/api/review-events")
      .send({ ...target(), type, ...(commentId ? { commentId } : {}) });
  }

  function watchComments(
    app: ReturnType<typeof makeApp>,
    extra: Record<string, unknown> = {},
  ) {
    return request(app)
      .post("/api/review-events/watch")
      .send({
        ...target(),
        types: ["comment.ask", "comment.change", "comment.followup"],
        fromNow: false,
        afterSequence: 0,
        timeoutSeconds: 0,
        batchWindowSeconds: 0,
        ...extra,
      });
  }

  function appendUserReply(id: string, parent: string, body: string) {
    fs.appendFileSync(
      documentPath,
      [
        `  ${id}:`,
        `    body: ${body}`,
        "    by: pavel",
        '    at: "2026-10-18T12:05:00.000Z"',
        `    re: ${parent}`,
        "",
      ].join("\n"),
    );
  }

  it("enriches an ask event from the saved file", async () => {
    const app = makeApp();

    const response = await postEvent(app, "comment.ask", "c1");

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      duplicate: false,
      agent: { listening: false },
      event: {
        type: "comment.ask",
        documentPath,
        relativePath: "plan.md",
        commentId: "c1",
        threadRootId: "c1",
        intent: "ask",
        anchorText: "about four seconds",
        body: "What is included in that time?",
        author: "pavel",
        contextBefore: "# Plan We deploy on Fridays. Cold start takes",
        contextAfter: "on a fresh deploy. Tighten this paragraph.",
        replies: [],
        latestReplyId: null,
      },
    });
    expect(response.body.event.sequence).toEqual(expect.any(Number));
  });

  it("emits an ask about code in a fenced block and answers it in the thread", async () => {
    const app = makeApp();
    fs.writeFileSync(
      documentPath,
      [
        "# Setup",
        "",
        "```sh",
        "roughdraft {==open --print-url==}{>>Why print instead of opening?<<}{#c1} plan.md",
        "```",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: pavel",
        '    at: "2026-10-18T12:00:00.000Z"',
        "    intent: ask",
        "",
      ].join("\n"),
    );

    const event = await postEvent(app, "comment.ask", "c1");
    expect(event.status).toBe(201);
    expect(event.body.event).toMatchObject({
      commentId: "c1",
      intent: "ask",
      anchorText: "open --print-url",
      body: "Why print instead of opening?",
    });

    const reply = await request(app)
      .post("/api/comments/reply")
      .send({ ...target(), commentId: "c1", body: "An agent has no browser." });
    expect(reply.status).toBe(201);
    const resolve = await request(app)
      .post("/api/comments/resolve")
      .send({ ...target(), commentId: "c1" });
    expect(resolve.status).toBe(200);

    const items = extractRoughdraftReviewIndex(
      fs.readFileSync(documentPath, "utf8"),
    ).items;
    expect(items).toMatchObject([
      { id: "c1", status: "resolved", anchorText: "open --print-url" },
      { id: reply.body.replyId, parentId: "c1", author: "AI" },
    ]);
  });

  it("re-queues unanswered ask/change threads from the file when the first listener attaches", async () => {
    // Events live in memory, so an Ask posted before a server restart (or
    // while no server ran) is gone. The file still has the thread; a fresh
    // server finds threads whose last word is the user's and queues them.
    fs.writeFileSync(
      documentPath,
      [
        "# Plan",
        "",
        "A {==one==}{>>Why?<<}{#c1}, B {==two==}{>>Shorter.<<}{#c2},",
        "C {==three==}{>>Source?<<}{#c3}, D {==four==}{>>Old?<<}{#c5},",
        "E {==five==}{>>Plain note.<<}{#c6}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: pavel",
        '    at: "2026-10-18T12:00:00.000Z"',
        "    intent: ask",
        "  c2:",
        "    by: pavel",
        '    at: "2026-10-18T12:00:01.000Z"',
        "    intent: change",
        "  c3:",
        "    by: pavel",
        '    at: "2026-10-18T12:00:02.000Z"',
        "    intent: ask",
        "  c5:",
        "    by: pavel",
        '    at: "2026-10-18T12:00:03.000Z"',
        "    intent: ask",
        "    status: resolved",
        "  c6:",
        "    by: pavel",
        '    at: "2026-10-18T12:00:04.000Z"',
        "  c7:",
        "    body: Done.",
        "    by: AI",
        '    at: "2026-10-18T12:01:00.000Z"',
        "    re: c2",
        "  c8:",
        "    body: From the 2025 report.",
        "    by: AI",
        '    at: "2026-10-18T12:01:01.000Z"',
        "    re: c3",
        "  c9:",
        "    body: Which page?",
        "    by: pavel",
        '    at: "2026-10-18T12:02:00.000Z"',
        "    re: c3",
        "",
      ].join("\n"),
    );
    const app = makeApp();

    // A Done Reviewing-only watcher (`roughdraft open`) does not trigger it.
    const doneOnly = await request(app)
      .post("/api/review-events/watch")
      .send({ ...target(), fromNow: false, timeoutSeconds: 0 });
    expect(doneOnly.body.latestSequence).toBe(0);

    const first = await watchComments(app);
    expect(
      first.body.events.map((event: { type: string; commentId: string }) => [
        event.type,
        event.commentId,
      ]),
    ).toEqual([
      ["comment.ask", "c1"],
      ["comment.followup", "c9"],
    ]);
    const status = await request(app).get("/api/agent/status").query(target());
    expect(status.body.threads).toEqual({ c1: "pending", c3: "pending" });

    // The tab re-posting the same Ask is a duplicate, and a second listener
    // round does not queue anything again.
    expect((await postEvent(app, "comment.ask", "c1")).status).toBe(200);
    const again = await watchComments(app, {
      afterSequence: first.body.nextSequence - 1,
    });
    expect(again.body.events).toEqual([]);
    expect(again.body.latestSequence).toBe(first.body.latestSequence);
  });

  it("rejects comment events for missing, misplaced, or malformed targets", async () => {
    const app = makeApp();
    appendUserReply("c3", "c1", "And the cache?");

    expect((await postEvent(app, "comment.ask", "c99")).status).toBe(404);
    expect((await postEvent(app, "comment.ask")).status).toBe(400);
    expect((await postEvent(app, "comment.ask", "c3")).status).toBe(400);
    expect((await postEvent(app, "comment.shout", "c1")).status).toBe(400);
    const outside = await request(app).post("/api/review-events").send({
      projectPath: projectDir,
      path: "../x.md",
      type: "comment.ask",
      commentId: "c1",
    });
    expect(outside.status).toBe(404);
  });

  it("does not emit the same ask twice, but does emit a follow-up after a new reply", async () => {
    const app = makeApp();

    const first = await postEvent(app, "comment.ask", "c1");
    const again = await postEvent(app, "comment.ask", "c1");
    appendUserReply("c3", "c1", "And does it include the cache?");
    const followup = await postEvent(app, "comment.followup", "c3");
    const followupAgain = await postEvent(app, "comment.followup", "c3");

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      duplicate: true,
      event: { sequence: first.body.event.sequence },
    });
    expect(followup.status).toBe(201);
    expect(followup.body.event).toMatchObject({
      type: "comment.followup",
      commentId: "c3",
      threadRootId: "c1",
      intent: "ask",
      body: "And does it include the cache?",
      rootBody: "What is included in that time?",
      latestReplyId: "c3",
      replies: [{ id: "c3", author: "pavel" }],
    });
    expect(followupAgain.body.duplicate).toBe(true);

    // The listener attaching also queues c2, an unanswered change request
    // in the file that was never posted; c1's ask/follow-up are not repeated.
    const watched = await watchComments(app);
    expect(
      watched.body.events.map(
        (event: { type: string; commentId: string }) =>
          `${event.type} ${event.commentId}`,
      ),
    ).toEqual(["comment.ask c1", "comment.followup c3", "comment.change c2"]);
  });

  it("keeps the default watch on Done Reviewing only", async () => {
    const app = makeApp();
    await postEvent(app, "comment.ask", "c1");

    const response = await request(app)
      .post("/api/review-events/watch")
      .send({
        ...target(),
        fromNow: false,
        timeoutSeconds: 0,
        batchWindowSeconds: 0,
      });

    expect(response.body).toMatchObject({ timedOut: true, events: [] });
    const status = await request(app)
      .get("/api/review-events/status")
      .query(target());
    expect(status.body.watching).toBe(false);
  });

  it("answers a cursor from an earlier server process immediately so it can be reset", async () => {
    const app = makeApp();
    await postEvent(app, "comment.ask", "c1");

    const ahead = await watchComments(app, {
      afterSequence: 40,
      timeoutSeconds: 30,
    });
    const otherInstance = await watchComments(app, {
      instanceId: "previous-server",
      timeoutSeconds: 30,
    });

    // latestSequence 2: attaching also queued c2's unanswered change request.
    for (const response of [ahead, otherInstance]) {
      expect(response.body).toMatchObject({
        events: [],
        cursorReset: true,
        latestSequence: 2,
        instanceId: expect.any(String),
      });
    }
  });

  it("rejects unknown watch types", async () => {
    const app = makeApp();

    const response = await watchComments(app, { types: ["comment.nope"] });

    expect(response.status).toBe(400);
  });

  it("tracks thread status through pending, working, and answered", async () => {
    const app = makeApp();
    const status = async () =>
      (await request(app).get("/api/agent/status").query(target())).body;

    await postEvent(app, "comment.ask", "c1");
    expect((await status()).threads).toEqual({ c1: "pending" });

    const ack = await request(app)
      .post("/api/agent/ack")
      .send({ ...target(), commentId: "c1" });
    expect(ack.status).toBe(200);
    expect((await status()).threads).toEqual({ c1: "working" });

    const reply = await request(app)
      .post("/api/comments/reply")
      .send({
        ...target(),
        commentId: "c1",
        body: "Two parts:\n- cache warm-up\n- model load",
      });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({
      threadRootId: "c1",
      replyId: "c3",
      status: "answered",
    });
    expect((await status()).threads).toEqual({ c1: "answered" });

    const items = extractRoughdraftReviewIndex(
      fs.readFileSync(documentPath, "utf8"),
    ).items;
    expect(items.find((item) => item.id === "c3")).toMatchObject({
      kind: "reply",
      parentId: "c1",
      author: "AI",
      text: "Two parts:\n- cache warm-up\n- model load",
    });
    expect(items.find((item) => item.id === "c1")?.intent).toBe("ask");
  });

  it("records applied status and replies to the thread root when given a reply id", async () => {
    const app = makeApp();
    appendUserReply("c3", "c2", "Keep the numbers.");

    const reply = await request(app)
      .post("/api/comments/reply")
      .send({
        ...target(),
        commentId: "c3",
        body: "Merged into one sentence.",
        status: "applied",
      });

    expect(reply.body).toMatchObject({ threadRootId: "c2", status: "applied" });
    const status = await request(app).get("/api/agent/status").query(target());
    expect(status.body.threads).toEqual({ c2: "applied" });
    const items = extractRoughdraftReviewIndex(
      fs.readFileSync(documentPath, "utf8"),
    ).items;
    expect(items.find((item) => item.id === reply.body.replyId)?.parentId).toBe(
      "c2",
    );
  });

  it("rejects replies with a stale expected version without touching the file", async () => {
    const app = makeApp();

    const response = await request(app)
      .post("/api/comments/reply")
      .send({
        ...target(),
        commentId: "c1",
        body: "Answer",
        expectedVersion: "stale",
      });

    expect(response.status).toBe(409);
    expect(fs.readFileSync(documentPath, "utf8")).toBe(PLAN);
  });

  it("rejects empty replies, unknown statuses, and missing comments", async () => {
    const app = makeApp();
    const reply = (body: Record<string, unknown>) =>
      request(app)
        .post("/api/comments/reply")
        .send({ ...target(), ...body });

    expect((await reply({ commentId: "c1", body: "  " })).status).toBe(400);
    expect(
      (await reply({ commentId: "c1", body: "x", status: "done" })).status,
    ).toBe(400);
    expect((await reply({ commentId: "c9", body: "x" })).status).toBe(404);
    expect(fs.readFileSync(documentPath, "utf8")).toBe(PLAN);
  });

  it("resolves the thread root in the file", async () => {
    const app = makeApp();

    const response = await request(app)
      .post("/api/comments/resolve")
      .send({ ...target(), commentId: "c2", summary: "Done." });

    expect(response.status).toBe(200);
    const root = extractRoughdraftReviewIndex(
      fs.readFileSync(documentPath, "utf8"),
    ).items.find((item) => item.id === "c2");
    expect(root).toMatchObject({ status: "resolved", intent: "change" });
  });

  it("skips already-answered events for a re-armed listener", async () => {
    const app = makeApp();
    await postEvent(app, "comment.ask", "c1");
    await postEvent(app, "comment.change", "c2");
    const delivered = await watchComments(app, {
      listener: { id: "listener-1" },
    });
    expect(delivered.body.events).toHaveLength(2);

    await request(app)
      .post("/api/comments/reply")
      .send({ ...target(), commentId: "c1", body: "Answered." });

    const rearmed = await watchComments(app, {
      listener: { id: "listener-2" },
      skipHandled: true,
    });
    expect(
      rearmed.body.events.map(
        (event: { commentId: string }) => event.commentId,
      ),
    ).toEqual(["c2"]);
    expect(rearmed.body).toMatchObject({
      instanceId: expect.any(String),
      latestSequence: 2,
    });
  });

  it("reports a listener while its long-poll is open and for a grace period after", async () => {
    const app = makeApp({ agentListenerGraceMs: 50 });
    const status = async () =>
      (await request(app).get("/api/agent/status").query(target())).body;

    expect(await status()).toMatchObject({ listening: false });

    const waiting = watchComments(app, {
      timeoutSeconds: 0.2,
      listener: { id: "listener-1", sessionId: "session-abc" },
    }).then((response) => response);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(await status()).toMatchObject({
      listening: true,
      listenerCount: 1,
      sessionId: "session-abc",
      since: expect.any(String),
    });
    const ask = await postEvent(app, "comment.ask", "c1");
    expect(ask.body.agent).toEqual({
      listening: true,
      sessionId: "session-abc",
    });

    await waiting;
    expect((await status()).listening).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await status()).listening).toBe(false);
  });

  it("does not hand a listener an ask the user resolved before it was delivered", async () => {
    const app = makeApp();
    await postEvent(app, "comment.ask", "c1");
    // The user resolves the thread in the tab (autosave writes the status).
    fs.writeFileSync(
      documentPath,
      markRoughdraftResolved(fs.readFileSync(documentPath, "utf8"), {
        targetId: "c1",
      }),
    );

    const response = await watchComments(app, {
      skipHandled: true,
      listener: { id: "listener-1" },
    });

    const threadIds = (
      response.body.events as Array<{ threadRootId: string }>
    ).map((event) => event.threadRootId);
    expect(threadIds).not.toContain("c1");
  });

  it("keeps a listener present for the grace it declares between waits", async () => {
    // MCP agents call a bounded wait, then work for a while (editing the
    // file) before the next call; they declare a longer grace than `listen`.
    const app = makeApp({ agentListenerGraceMs: 50 });
    const status = async () =>
      (await request(app).get("/api/agent/status").query(target())).body;

    await watchComments(app, {
      timeoutSeconds: 0.05,
      listener: { id: "mcp-1", graceSeconds: 0.3 },
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect((await status()).listening).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await status()).listening).toBe(false);
  });

  it("streams agent status changes over SSE", async () => {
    const app = makeApp({ agentListenerGraceMs: 50 });
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const query = new URLSearchParams(target()).toString();
    const abort = new AbortController();

    try {
      const response = await fetch(`${base}/api/agent/events?${query}`, {
        signal: abort.signal,
      });
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("no body");
      const decoder = new TextDecoder();
      let buffer = "";
      const nextStatus = async () => {
        for (;;) {
          const match = buffer.match(/event: status\ndata: (.*)\n\n/);
          if (match?.index !== undefined) {
            buffer = buffer.slice(match.index + match[0].length);
            return JSON.parse(match[1] ?? "{}");
          }
          const chunk = await reader.read();
          if (chunk.done) throw new Error("stream ended");
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      };

      // The snapshot names the server process, so the tab can tell a restart
      // (in-memory thread status gone) from a reconnect.
      const { instanceId } = (await (
        await fetch(`${base}/api/agent/status?${query}`)
      ).json()) as { instanceId: string };
      expect(await nextStatus()).toMatchObject({
        listening: false,
        threads: {},
        instanceId,
      });

      await fetch(`${base}/api/review-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...target(),
          type: "comment.ask",
          commentId: "c1",
        }),
      });
      expect(await nextStatus()).toMatchObject({
        threads: { c1: "pending" },
        instanceId,
      });

      await fetch(`${base}/api/agent/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...target(), commentId: "c1" }),
      });
      expect(await nextStatus()).toMatchObject({ threads: { c1: "working" } });
    } finally {
      abort.abort();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
