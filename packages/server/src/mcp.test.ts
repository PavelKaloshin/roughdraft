import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { extractRoughdraftReviewIndex } from "@roughdraft/rfm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index";
import { callTool } from "./mcp";

describe("mcp", () => {
  let tempDir: string;
  let stateFile: string;
  let projectDir: string;
  let documentPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-mcp-"));
    projectDir = path.join(tempDir, "project");
    stateFile = path.join(tempDir, "state", "server.json");
    documentPath = path.join(projectDir, "draft.md");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ url: "http://localhost:7373", port: 7373 }),
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("watches in bounded rounds from a pinned cursor and honors the caller's timeout", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      requestBodies.push(body);
      const payload = body.fromNow
        ? { events: [], timedOut: true, nextSequence: 4 }
        : {
            events: [{ type: "review.completed", sequence: 4 }],
            timedOut: false,
            nextSequence: 5,
          };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );
    expect(requestBodies).toMatchObject([
      {
        projectPath: projectDir,
        path: "draft.md",
        batchWindowSeconds: 0.25,
        fromNow: true,
        timeoutSeconds: 0,
      },
      { fromNow: false, afterSequence: 3, timeoutSeconds: 50 },
    ]);

    requestBodies.length = 0;
    await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir, timeoutSeconds: 5 },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );
    expect(requestBodies[1]?.timeoutSeconds).toBeLessThanOrEqual(5);
  });

  it("returns overall comments from review watch events unchanged", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          events: [
            {
              documentPath,
              type: "review.completed",
              overallComment: "Please prioritize the CLI contract.",
            },
          ],
          timedOut: false,
          nextSequence: 2,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );

    const result = await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(result).toMatchObject({
      events: [
        {
          overallComment: "Please prioritize the CLI contract.",
        },
      ],
    });
  });

  it("does not write a reply when the message contains a CriticMarkup close delimiter", async () => {
    const original =
      '# Draft\n\n{>>Needs proof<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}\n';
    fs.writeFileSync(documentPath, original);

    await expect(
      callTool(
        "roughdraft_reply_to_comment",
        {
          documentPath,
          parentId: "c1",
          message: "This closes early <<} and breaks parsing.",
        },
        { ROUGHDRAFT_STATE_FILE: stateFile },
      ),
    ).rejects.toThrow(/CriticMarkup close delimiter/);

    expect(fs.readFileSync(documentPath, "utf8")).toBe(original);
  });
});

// The agent-thread tools talk to a real in-process server, so they exercise
// the same endpoints, thread status, and event queue the browser uses.
describe("mcp agent threads against a running server", () => {
  const PLAN = [
    "# Plan",
    "",
    "Cold start takes {==four seconds==}{>>Why?<<}{#c1}.",
    "",
    "Tighten {==this==}{>>One sentence.<<}{#c2}.",
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

  let tempDir: string;
  let projectDir: string;
  let documentPath: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-mcp-agent-"));
    projectDir = path.join(tempDir, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    documentPath = path.join(projectDir, "plan.md");
    fs.writeFileSync(documentPath, PLAN);

    const { app } = createApp({ staticDirPath: projectDir });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    const stateFile = path.join(tempDir, "server.json");
    fs.writeFileSync(stateFile, JSON.stringify({ url: baseUrl, port }));
    env = { ROUGHDRAFT_STATE_FILE: stateFile };
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const postEvent = (body: Record<string, unknown>) =>
    fetch(`${baseUrl}/api/review-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: projectDir,
        path: "plan.md",
        ...body,
      }),
    });

  const threads = async () => {
    const response = await fetch(
      `${baseUrl}/api/agent/status?projectPath=${encodeURIComponent(projectDir)}&path=plan.md`,
    );
    return ((await response.json()) as { threads: Record<string, string> })
      .threads;
  };

  it("acks, replies to, and resolves a thread through the server", async () => {
    await postEvent({ type: "comment.ask", commentId: "c1" });

    const ack = await callTool(
      "roughdraft_ack_thread",
      { documentPath, commentId: "c1" },
      env,
      fetch,
    );
    expect(ack).toMatchObject({ threadRootId: "c1", status: "working" });
    expect(await threads()).toEqual({ c1: "working" });

    const reply = await callTool(
      "roughdraft_reply_to_thread",
      { documentPath, commentId: "c1", body: "- cache warm-up\n- model load" },
      env,
      fetch,
    );
    expect(reply).toMatchObject({ threadRootId: "c1", status: "answered" });
    expect(await threads()).toEqual({ c1: "answered" });

    const applied = await callTool(
      "roughdraft_reply_to_thread",
      { documentPath, commentId: "c2", body: "Done.", status: "applied" },
      env,
      fetch,
    );
    expect(applied).toMatchObject({ threadRootId: "c2", status: "applied" });

    const resolved = await callTool(
      "roughdraft_resolve_thread",
      { documentPath, commentId: "c1", summary: "Explained." },
      env,
      fetch,
    );
    expect(resolved).toMatchObject({ threadRootId: "c1", status: "resolved" });

    const items = extractRoughdraftReviewIndex(
      fs.readFileSync(documentPath, "utf8"),
    ).items;
    expect(items.find((item) => item.id === "c1")).toMatchObject({
      status: "resolved",
      intent: "ask",
    });
    expect(
      items.filter((item) => item.parentId === "c1").map((item) => item.text),
    ).toEqual(["- cache warm-up\n- model load"]);
  });

  it("reports a server error for an unknown comment instead of writing", async () => {
    await expect(
      callTool(
        "roughdraft_reply_to_thread",
        { documentPath, commentId: "c9", body: "x" },
        env,
        fetch,
      ),
    ).rejects.toThrow(/c9|not found/i);
    expect(fs.readFileSync(documentPath, "utf8")).toBe(PLAN);
  });

  it("waits for comment events in bounded calls and resumes from the cursor", async () => {
    const sentTimeouts: number[] = [];
    const recordingFetch: typeof fetch = (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        timeoutSeconds?: number;
      };
      if (typeof body.timeoutSeconds === "number") {
        sentTimeouts.push(body.timeoutSeconds);
      }
      return fetch(input, init);
    };
    // A Done Reviewing from before the agent started waiting is stale news.
    await postEvent({});
    await postEvent({ type: "comment.ask", commentId: "c1" });

    type WaitResult = {
      events: Array<{ type: string; commentId?: string }>;
      cursor: number;
      instanceId: string;
      timedOut: boolean;
    };
    const first = (await callTool(
      "roughdraft_wait_comment_events",
      { documentPath, timeoutSeconds: 600 },
      env,
      recordingFetch,
    )) as WaitResult;
    expect(first.events).toMatchObject([
      { type: "comment.ask", commentId: "c1" },
    ]);
    expect(first.timedOut).toBe(false);
    expect(Math.max(...sentTimeouts)).toBeLessThanOrEqual(50);

    const quiet = (await callTool(
      "roughdraft_wait_comment_events",
      {
        documentPath,
        cursor: first.cursor,
        instanceId: first.instanceId,
        timeoutSeconds: 0.2,
      },
      env,
      fetch,
    )) as WaitResult;
    expect(quiet).toMatchObject({ events: [], timedOut: true });

    setTimeout(() => {
      void postEvent({ type: "comment.change", commentId: "c2" });
    }, 100);
    const next = (await callTool(
      "roughdraft_wait_comment_events",
      {
        documentPath,
        cursor: quiet.cursor,
        instanceId: quiet.instanceId,
        types: ["change"],
        timeoutSeconds: 5,
      },
      env,
      fetch,
    )) as WaitResult;
    expect(next.events).toMatchObject([
      { type: "comment.change", commentId: "c2" },
    ]);
    expect(next.cursor).toBeGreaterThan(quiet.cursor);
  });

  it("keeps watching for Done Reviewing when the wait outlives the client's headers timeout", async () => {
    // Node's fetch (undici) fails a response that sends no headers within
    // `headersTimeout` (300s). The MCP watch used to be one unbounded
    // long-poll, so a slow reviewer turned into a tool error. Scale the
    // client limit down to keep the test fast (same technique as cli.test).
    const CLIENT_HEADERS_TIMEOUT_MS = 200;
    const fetchWithHeadersTimeout: typeof fetch = async (input, init) => {
      const headersTimeout = new AbortController();
      const timer = setTimeout(
        () => headersTimeout.abort(),
        CLIENT_HEADERS_TIMEOUT_MS,
      );
      try {
        return await fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, headersTimeout.signal])
            : headersTimeout.signal,
        });
      } catch (error) {
        if (!headersTimeout.signal.aborted) throw error;
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("Headers Timeout Error"), {
            name: "HeadersTimeoutError",
            code: "UND_ERR_HEADERS_TIMEOUT",
          }),
        });
      } finally {
        clearTimeout(timer);
      }
    };

    const watching = callTool(
      "roughdraft_watch_review_events",
      { documentPath },
      env,
      fetchWithHeadersTimeout,
    ).then(
      (result) => ({ result, error: null as unknown }),
      (error: unknown) => ({ result: null, error }),
    );

    await new Promise((resolve) =>
      setTimeout(resolve, CLIENT_HEADERS_TIMEOUT_MS * 3),
    );
    await postEvent({});

    const { result, error } = await watching;
    expect(error).toBeNull();
    expect(result).toMatchObject({
      timedOut: false,
      events: [{ type: "review.completed", documentPath }],
    });
  });
});
