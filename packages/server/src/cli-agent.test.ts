import fs from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { extractRoughdraftReviewIndex } from "@roughdraft/rfm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatListenEventLine } from "./agent-cli";
import { createCliDependencies, runCli } from "./cli";
import { createApp } from "./index";
import type { CommentEvent } from "./review-events";

const FAKE_PID = 424_242;

const PLAN = [
  "# Plan",
  "",
  'Cold start takes {==about "four" seconds==}{>>What is included?\nAnd why "four"?<<}{#c1}.',
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

interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

/** Listens on both loopback families so `http://localhost:<port>` resolves. */
async function startServer(
  projectDir: string,
  port = 0,
): Promise<RunningServer> {
  const { app } = createApp({ staticDirPath: projectDir });
  const servers: Server[] = [];
  let boundPort = port;
  for (const host of ["127.0.0.1", "::1"]) {
    const server = createHttpServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL") {
          resolve();
          return;
        }
        reject(error);
      });
      server.listen(boundPort, host, () => resolve());
    });
    if (server.listening) {
      servers.push(server);
      boundPort = (server.address() as AddressInfo).port;
    }
  }
  return {
    port: boundPort,
    close: async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections?.();
              server.close(() => resolve());
            }),
        ),
      );
    },
  };
}

describe("agent CLI commands", () => {
  let tempDir: string;
  let projectDir: string;
  let stateDir: string;
  let documentPath: string;
  let server: RunningServer;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-agent-cli-"));
    projectDir = path.join(tempDir, "project");
    stateDir = path.join(tempDir, "state");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    documentPath = path.join(projectDir, "plan.md");
    fs.writeFileSync(documentPath, PLAN);
    server = await startServer(projectDir);
    fs.writeFileSync(
      path.join(stateDir, "server.json"),
      JSON.stringify({
        port: server.port,
        pid: FAKE_PID,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${server.port}`,
      }),
    );
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeDeps(options: { stdin?: string; sessionId?: string } = {}) {
    const logs: string[] = [];
    const errors: string[] = [];
    const deps = createCliDependencies({
      env: {
        PATH: process.env.PATH,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: path.join(tempDir, "none.json"),
        ...(options.sessionId
          ? { CLAUDE_CODE_SESSION_ID: options.sessionId }
          : {}),
      },
      cwd: projectDir,
      isProcessRunning: (pid) => pid === FAKE_PID,
      spawnServerProcess: () => {
        throw new Error("tests must reuse the running server");
      },
      readStdin: async () => options.stdin ?? "",
      resolveUpdateStatus: async () => {
        throw new Error("no update checks in tests");
      },
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    });
    return { deps, logs, errors };
  }

  function postEvent(type: string, commentId: string) {
    return fetch(`http://127.0.0.1:${server.port}/api/review-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: projectDir,
        path: "plan.md",
        type,
        commentId,
      }),
    }).then((response) => response.json());
  }

  async function waitForLog(
    logs: string[],
    predicate: (line: string) => boolean,
    timeoutMs = 3_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const line = logs.find(predicate);
      if (line) return line;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`log line not found in:\n${logs.join("\n")}`);
  }

  it("prints a listening line, one self-contained line per ask, and a re-arm line on expiry", async () => {
    const { deps, logs, errors } = makeDeps({ sessionId: "session-abc" });

    const listening = runCli(
      ["listen", documentPath, "--max-seconds", "1.5"],
      deps,
    );
    await waitForLog(logs, (line) => line.includes("listening on"));
    const posted = (await postEvent("comment.ask", "c1")) as {
      event: { sequence: number };
    };
    const exitCode = await listening;

    expect(errors).toEqual([]);
    expect(exitCode).toBe(0);
    const seq = posted.event.sequence;
    expect(logs).toEqual([
      `[roughdraft] listening on ${documentPath} (session session-abc) since=0`,
      `[roughdraft] ask c1 seq=${seq} file=${documentPath} by=pavel anchor="about \\"four\\" seconds" text="What is included?\\nAnd why \\"four\\"?" → roughdraft ack ${documentPath} c1, then answer without editing the file: roughdraft reply ${documentPath} c1 --stdin`,
      `[roughdraft] listen expired; re-arm with: roughdraft listen ${documentPath} --since ${seq}`,
    ]);
  });

  it("resumes with --since without losing events posted between listens", async () => {
    const first = makeDeps();
    const firstRun = runCli(
      ["listen", documentPath, "--max-seconds", "0.3"],
      first.deps,
    );
    await waitForLog(first.logs, (line) => line.includes("listening on"));
    await postEvent("comment.ask", "c1");
    await firstRun;
    const rearm = first.logs.at(-1) ?? "";
    const since = Number(rearm.match(/--since (\d+)$/)?.[1]);
    expect(
      first.logs.some((line) => line.startsWith("[roughdraft] ask c1")),
    ).toBe(true);

    // Nobody is listening while this change request is posted.
    await postEvent("comment.change", "c2");

    const second = makeDeps();
    const secondRun = runCli(
      [
        "listen",
        documentPath,
        "--since",
        String(since),
        "--max-seconds",
        "0.3",
      ],
      second.deps,
    );
    await secondRun;

    const eventLines = second.logs.filter((line) =>
      /^\[roughdraft\] (ask|change|followup) /.test(line),
    );
    expect(eventLines).toHaveLength(1);
    expect(eventLines[0]).toMatch(
      /^\[roughdraft\] change c2 seq=\d+ .* → roughdraft ack .* c2, then edit the file and summarize the change: roughdraft reply .* c2 --status applied --stdin$/,
    );
  });

  it("replays only unanswered events when started without --since", async () => {
    await postEvent("comment.ask", "c1");
    await postEvent("comment.change", "c2");
    const replier = makeDeps({ stdin: "Cache warm-up and model load.\n" });
    expect(
      await runCli(["reply", documentPath, "c1", "--stdin"], replier.deps),
    ).toBe(0);

    const { deps, logs } = makeDeps();
    await runCli(["listen", documentPath, "--max-seconds", "0.3"], deps);

    expect(
      logs
        .filter((line) => /^\[roughdraft\] (ask|change) /.test(line))
        .map((line) => line.split(" ").slice(1, 3).join(" ")),
    ).toEqual(["change c2"]);
  });

  it("keeps listening across a server restart", async () => {
    const { deps, logs } = makeDeps();
    const listening = runCli(
      ["listen", documentPath, "--max-seconds", "3"],
      deps,
    );
    await waitForLog(logs, (line) => line.includes("listening on"));
    await postEvent("comment.ask", "c1");
    await waitForLog(logs, (line) => line.startsWith("[roughdraft] ask c1"));

    const port = server.port;
    await server.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    server = await startServer(projectDir, port);
    await postEvent("comment.change", "c2");

    await waitForLog(
      logs,
      (line) => line.startsWith("[roughdraft] change c2 seq=1 "),
      3_000,
    );
    expect(await listening).toBe(0);
  }, 10_000);

  it("writes a multiline reply from stdin through the server", async () => {
    const body = "Two parts:\n- cache warm-up\n- `model.load()`\n";
    const { deps, logs, errors } = makeDeps({ stdin: body });

    const exitCode = await runCli(
      ["reply", documentPath, "c1", "--stdin"],
      deps,
    );

    expect(errors).toEqual([]);
    expect(exitCode).toBe(0);
    expect(logs).toEqual([
      `[roughdraft] replied to c1 in ${documentPath} (reply c3, status answered)`,
    ]);
    const reply = extractRoughdraftReviewIndex(
      fs.readFileSync(documentPath, "utf8"),
    ).items.find((item) => item.id === "c3");
    expect(reply).toMatchObject({
      kind: "reply",
      parentId: "c1",
      author: "AI",
      text: "Two parts:\n- cache warm-up\n- `model.load()`",
    });
  });

  it("accepts a --body that starts with a dash and records applied status", async () => {
    const { deps } = makeDeps();

    const exitCode = await runCli(
      [
        "reply",
        documentPath,
        "c2",
        "--body",
        "- merged into one sentence",
        "--status",
        "applied",
      ],
      deps,
    );

    expect(exitCode).toBe(0);
    const status = await fetch(
      `http://127.0.0.1:${server.port}/api/agent/status?${new URLSearchParams({ projectPath: projectDir, path: "plan.md" })}`,
    ).then((response) => response.json());
    expect(status.threads).toEqual({ c2: "applied" });
  });

  it("acks and resolves a thread", async () => {
    const { deps, logs } = makeDeps();

    expect(await runCli(["ack", documentPath, "c1"], deps)).toBe(0);
    const status = await fetch(
      `http://127.0.0.1:${server.port}/api/agent/status?${new URLSearchParams({ projectPath: projectDir, path: "plan.md" })}`,
    ).then((response) => response.json());
    expect(status.threads).toEqual({ c1: "working" });

    expect(
      await runCli(
        ["resolve", documentPath, "c1", "--summary", "Answered."],
        deps,
      ),
    ).toBe(0);
    const root = extractRoughdraftReviewIndex(
      fs.readFileSync(documentPath, "utf8"),
    ).items.find((item) => item.id === "c1");
    expect(root).toMatchObject({ status: "resolved", intent: "ask" });
    expect(logs).toEqual([
      `[roughdraft] c1 is now working in ${documentPath}`,
      `[roughdraft] resolved c1 in ${documentPath}`,
    ]);
  });

  it("reports missing comments and bad usage without touching the file", async () => {
    const missing = makeDeps();
    expect(
      await runCli(["reply", documentPath, "c9", "--body", "x"], missing.deps),
    ).toBe(1);
    expect(missing.errors).toEqual([
      "Failed to reply to c9: Comment not found: c9",
    ]);

    const both = makeDeps({ stdin: "x" });
    expect(
      await runCli(
        ["reply", documentPath, "c1", "--stdin", "--body", "y"],
        both.deps,
      ),
    ).toBe(2);
    const neither = makeDeps();
    expect(await runCli(["reply", documentPath, "c1"], neither.deps)).toBe(2);
    const badStatus = makeDeps();
    expect(
      await runCli(
        ["reply", documentPath, "c1", "--body", "x", "--status", "done"],
        badStatus.deps,
      ),
    ).toBe(2);
    expect(fs.readFileSync(documentPath, "utf8")).toBe(PLAN);
  });

  it("documents the agent commands in help", async () => {
    const { deps, logs } = makeDeps();

    await runCli(["help"], deps);
    await runCli(["help", "listen"], deps);

    const output = logs.join("\n");
    for (const command of ["listen <file.md>", "reply <file.md> <id>"]) {
      expect(output).toContain(command);
    }
    expect(output).toContain("--max-seconds <seconds>");
    expect(output).toContain("default 1740");
  });
});

describe("formatListenEventLine", () => {
  const baseEvent: CommentEvent = {
    type: "comment.ask",
    sequence: 7,
    createdAt: "2026-10-18T12:00:00.000Z",
    documentPath: "/docs/my plan.md",
    projectPath: "/docs",
    relativePath: "my plan.md",
    version: "v1",
    commentId: "c1",
    threadRootId: "c1",
    intent: "ask",
    anchorText: null,
    body: "Why?",
    author: "pavel",
    contextBefore: "",
    contextAfter: "",
    rootBody: "Why?",
    replies: [],
    latestReplyId: null,
  };

  it("quotes paths with spaces and truncates long text with a hint", () => {
    const line = formatListenEventLine(
      { ...baseEvent, body: `${"x".repeat(450)}\n\tend` },
      { cliName: "roughdraft", documentPath: baseEvent.documentPath },
    );

    expect(line).not.toContain("\n");
    expect(line).toContain("file='/docs/my plan.md'");
    expect(line).toContain(`text="${"x".repeat(400)}…"`);
    expect(line).toContain("(truncated; read comment c1 in the file)");
    expect(line).toContain("roughdraft reply '/docs/my plan.md' c1 --stdin");
  });

  it("describes a follow-up with its thread intent and the change action", () => {
    const line = formatListenEventLine(
      {
        ...baseEvent,
        type: "comment.followup",
        commentId: "c4",
        threadRootId: "c2",
        intent: "change",
        body: "Also keep the numbers.",
      },
      { cliName: "roughdraft-dev-x", documentPath: "/docs/plan.md" },
    );

    expect(line).toBe(
      '[roughdraft] followup c2 reply=c4 intent=change seq=7 file=/docs/plan.md by=pavel text="Also keep the numbers." → roughdraft-dev-x ack /docs/plan.md c2, then edit the file and summarize the change: roughdraft-dev-x reply /docs/plan.md c2 --status applied --stdin',
    );
  });
});
