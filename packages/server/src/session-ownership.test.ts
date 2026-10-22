import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index";

/**
 * Document ownership (ADR 0007): exactly one Claude Code session receives a
 * document's Ask/Change/follow-up/Done events. These tests drive the HTTP
 * contract the CLI (`listen --session`, `claim`, `sessions`) and the UI use.
 */

const PLAN = [
  "# Plan",
  "",
  "Cold start takes {==about four seconds==}{>>What is included?<<}{#c1}.",
  "",
  "Tighten {==this paragraph==}{>>One sentence please.<<}{#c2}.",
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

const NOTES = [
  "# Notes",
  "",
  "Ship {==on Friday==}{>>Why Friday?<<}{#n1}.",
  "",
  "---",
  "comments:",
  "  n1:",
  "    by: pavel",
  '    at: "2026-10-18T12:00:00.000Z"',
  "    intent: ask",
  "",
].join("\n");

type App = ReturnType<typeof createApp>["app"];

interface SessionListenBody {
  events: Array<{ type: string; threadRootId?: string; documentPath: string }>;
  notices: Array<{ type: string; documentPath: string; reason: string }>;
  nextSequence: number;
  noticeCursor: number;
  instanceId: string;
  documents: string[];
}

describe("document ownership", () => {
  let projectDir: string;
  let planPath: string;
  let notesPath: string;

  beforeEach(() => {
    // realpath: macOS tmpdir is a symlink and the server resolves paths.
    projectDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-owner-")),
    );
    planPath = path.join(projectDir, "plan.md");
    notesPath = path.join(projectDir, "notes.md");
    fs.writeFileSync(planPath, PLAN);
    fs.writeFileSync(notesPath, NOTES);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  function makeApp(options: { agentListenerGraceMs?: number } = {}): App {
    return createApp({ staticDirPath: projectDir, ...options }).app;
  }

  function claim(
    app: App,
    sessionId: string,
    documentPath: string,
    extra: Record<string, unknown> = {},
  ) {
    return request(app)
      .post("/api/sessions/claim")
      .send({ sessionId, documentPath, ...extra });
  }

  function sessionListen(
    app: App,
    sessionId: string,
    extra: Record<string, unknown> = {},
  ): Promise<SessionListenBody> {
    return request(app)
      .post("/api/sessions/listen")
      .send({
        sessionId,
        listenerId: `listener-${sessionId}`,
        afterSequence: 0,
        afterNotice: 0,
        timeoutSeconds: 0,
        batchWindowSeconds: 0,
        ...extra,
      })
      .then((response) => {
        expect(response.status).toBe(200);
        return response.body as SessionListenBody;
      });
  }

  function postAsk(app: App, file: string, commentId: string) {
    return request(app).post("/api/review-events").send({
      projectPath: projectDir,
      path: file,
      type: "comment.ask",
      commentId,
    });
  }

  function status(app: App, file = "plan.md") {
    return request(app)
      .get("/api/agent/status")
      .query({ projectPath: projectDir, path: file })
      .then((response) => response.body);
  }

  const wait = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("delivers a document's events only to the session that owns it", async () => {
    const app = makeApp();
    // Both sessions are live (they just polled) and both want plan.md.
    await sessionListen(app, "session-a");
    await sessionListen(app, "session-b");

    expect((await claim(app, "session-a", planPath)).body).toMatchObject({
      claimed: true,
      owner: { sessionId: "session-a" },
    });
    expect((await claim(app, "session-b", planPath)).body).toMatchObject({
      claimed: false,
      owner: { sessionId: "session-a" },
    });

    // Session A drains the claim notice and the asks already in the file.
    const drained = await sessionListen(app, "session-a");
    expect(drained.notices).toEqual([
      expect.objectContaining({ type: "claimed", documentPath: planPath }),
    ]);
    const listenA = sessionListen(app, "session-a", {
      timeoutSeconds: 1,
      afterSequence: drained.nextSequence - 1,
      afterNotice: drained.noticeCursor,
    });
    const listenB = sessionListen(app, "session-b", { timeoutSeconds: 0.4 });
    await wait(30);
    // A fresh question in the owned file.
    fs.writeFileSync(
      planPath,
      PLAN.replace("{#c1}", "{#c1} {==fresh==}{>>New question<<}{#c3}").replace(
        "  c2:",
        '  c3:\n    by: pavel\n    at: "2026-10-18T12:10:00.000Z"\n    intent: ask\n  c2:',
      ),
    );
    await postAsk(app, "plan.md", "c3");

    const a = await listenA;
    const b = await listenB;
    expect(a.events.map((event) => event.threadRootId)).toEqual(["c3"]);
    expect(b.events).toEqual([]);
  });

  it("never lets an automatic claim take a document from a live owner, even through a per-file listener", async () => {
    const app = makeApp();
    const listenA = sessionListen(app, "session-a", {
      timeoutSeconds: 0.6,
      claims: [planPath],
    });
    await wait(30);

    // Session B runs the old per-file `listen plan.md`.
    const fileListenB = request(app)
      .post("/api/review-events/watch")
      .send({
        projectPath: projectDir,
        path: "plan.md",
        types: ["comment.ask", "comment.change", "comment.followup"],
        fromNow: false,
        afterSequence: 0,
        timeoutSeconds: 0.3,
        batchWindowSeconds: 0,
        skipHandled: true,
        listener: { id: "file-listener-b", sessionId: "session-b" },
      });
    await wait(30);
    await postAsk(app, "plan.md", "c1");

    expect((await fileListenB).body.events).toEqual([]);
    expect((await listenA).events.map((e) => e.threadRootId)).toContain("c1");
    expect(await status(app)).toMatchObject({
      listening: true,
      sessionId: "session-a",
      owner: { sessionId: "session-a", live: true },
    });
  });

  it("reassigns on force, tells the previous owner, and routes the next ask to the new owner", async () => {
    const app = makeApp();
    // Drain the requeued asks first so the rounds below only see new events.
    const first = await sessionListen(app, "session-a", { claims: [planPath] });
    const cursor = first.nextSequence - 1;

    const listenA = sessionListen(app, "session-a", {
      timeoutSeconds: 1,
      afterSequence: cursor,
      afterNotice: first.noticeCursor,
    });
    await wait(30);

    // The UI's "Connect session" uses projectPath + path.
    const forced = await request(app).post("/api/sessions/claim").send({
      sessionId: "session-b",
      projectPath: projectDir,
      path: "plan.md",
      force: true,
    });
    expect(forced.body).toMatchObject({
      claimed: true,
      owner: { sessionId: "session-b" },
      previousOwner: "session-a",
    });

    const a = await listenA;
    expect(a.notices).toEqual([
      expect.objectContaining({
        type: "released",
        documentPath: planPath,
        reason: "reassigned",
      }),
    ]);

    const b = await sessionListen(app, "session-b");
    expect(b.notices).toEqual([
      expect.objectContaining({ type: "claimed", documentPath: planPath }),
    ]);
    // Unanswered work on the document moves with it.
    expect(b.events.map((event) => event.threadRootId).sort()).toEqual([
      "c1",
      "c2",
    ]);
    expect(b.documents).toEqual([planPath]);
  });

  it("lets the next claim win once the owner is gone", async () => {
    const app = makeApp({ agentListenerGraceMs: 30 });
    await sessionListen(app, "session-a", { claims: [planPath] });
    await wait(80);

    expect(await status(app)).toMatchObject({
      listening: false,
      owner: { sessionId: "session-a", live: false },
    });
    expect((await claim(app, "session-b", planPath)).body).toMatchObject({
      claimed: true,
      owner: { sessionId: "session-b" },
    });
  });

  it("restores claims a listener re-sends after the server restarted", async () => {
    // A fresh app is a restarted server: no ownership in memory.
    const app = makeApp();
    expect((await status(app)).owner).toBeNull();

    const listen = await sessionListen(app, "session-a", {
      claims: [planPath, notesPath, path.join(projectDir, "missing.md")],
    });
    expect(listen.documents.sort()).toEqual([notesPath, planPath].sort());
    // Restored claims are not news: no "claimed" lines after a restart.
    expect(listen.notices).toEqual([]);
    // Unanswered asks in both owned files come back from the files.
    expect(
      listen.events
        .map(
          (event) =>
            `${path.basename(event.documentPath)}:${event.threadRootId}`,
        )
        .sort(),
    ).toEqual(["notes.md:n1", "plan.md:c1", "plan.md:c2"]);
  });

  it("lists live sessions with their title, folder and documents", async () => {
    const app = makeApp();
    const listen = sessionListen(app, "session-a", {
      timeoutSeconds: 0.3,
      claims: [planPath],
      title: "auth refactor",
      cwd: projectDir,
    });
    await wait(30);

    const sessions = await request(app).get("/api/sessions");
    expect(sessions.body.sessions).toEqual([
      expect.objectContaining({
        sessionId: "session-a",
        title: "auth refactor",
        cwd: projectDir,
        live: true,
        documents: [planPath],
        lastActiveAt: expect.any(String),
      }),
    ]);
    expect(await status(app)).toMatchObject({
      owner: {
        sessionId: "session-a",
        title: "auth refactor",
        cwd: projectDir,
      },
      sessions: [expect.objectContaining({ sessionId: "session-a" })],
    });
    await listen;
  });

  it("keeps an unowned document's events flowing to any listener, as before", async () => {
    const app = makeApp();
    await postAsk(app, "plan.md", "c1");
    const response = await request(app)
      .post("/api/review-events/watch")
      .send({
        projectPath: projectDir,
        path: "plan.md",
        types: ["comment.ask"],
        fromNow: false,
        afterSequence: 0,
        timeoutSeconds: 0,
        batchWindowSeconds: 0,
        listener: { id: "anonymous" },
      });
    expect(
      response.body.events.map((e: { threadRootId: string }) => e.threadRootId),
    ).toContain("c1");
    expect((await status(app)).owner).toBeNull();
  });

  it("rejects claims without a session or for non-Markdown files", async () => {
    const app = makeApp();
    expect((await claim(app, "", planPath)).status).toBe(400);
    const txt = path.join(projectDir, "notes.txt");
    fs.writeFileSync(txt, "x");
    expect((await claim(app, "session-a", txt)).status).toBe(404);
  });
});
