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
    // Attaching queued both unanswered threads from the file, so the posted
    // ask is the same event (seq 1), and the change follows it.
    const seq = posted.event.sequence;
    expect(seq).toBe(1);
    const instanceId = logs.at(-1)?.match(/--instance (\S+)$/)?.[1];
    expect(instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(logs).toEqual([
      `[roughdraft] listening on ${documentPath} (session session-abc) since=0`,
      `[roughdraft] ask c1 seq=1 → roughdraft ack ${documentPath} c1 --delegated, hand to a forked subagent that acks without --delegated and answers without editing the file: roughdraft reply ${documentPath} c1 --stdin | by=pavel anchor="about \\"four\\" seconds" text="What is included?\\nAnd why \\"four\\"?"`,
      `[roughdraft] change c2 seq=2 → roughdraft ack ${documentPath} c2, edit the file, then: roughdraft reply ${documentPath} c2 --status applied --stdin | by=pavel anchor="this paragraph" text="One sentence please."`,
      `[roughdraft] listen expired; re-arm with: roughdraft listen ${documentPath} --since 2 --instance ${instanceId}`,
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
    const since = Number(rearm.match(/--since (\d+)/)?.[1]);
    expect(
      first.logs.some((line) => line.startsWith("[roughdraft] ask c1")),
    ).toBe(true);

    // Nobody is listening while the user follows up in the change thread.
    fs.appendFileSync(
      documentPath,
      [
        "  c3:",
        "    body: Keep the numbers.",
        "    by: pavel",
        '    at: "2026-10-18T12:05:00.000Z"',
        "    re: c2",
        "",
      ].join("\n"),
    );
    await postEvent("comment.followup", "c3");

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
      /^\[roughdraft\] followup c2 reply=c3 intent=change seq=\d+ → roughdraft ack .* c2, edit the file, then: roughdraft reply .* c2 --status applied --stdin \| /,
    );
  });

  it("reports Done Reviewing as a line, but not a completion from before it started", async () => {
    const postCompleted = () =>
      fetch(`http://127.0.0.1:${server.port}/api/review-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath: projectDir, path: "plan.md" }),
      });
    // An old review session finished before this listener existed.
    await postCompleted();

    const { deps, logs } = makeDeps();
    const listening = runCli(
      ["listen", documentPath, "--max-seconds", "1"],
      deps,
    );
    await waitForLog(logs, (line) => line.includes("listening on"));
    await postCompleted();
    await listening;

    const doneLines = logs.filter((line) =>
      line.startsWith("[roughdraft] done"),
    );
    expect(doneLines).toHaveLength(1);
    expect(doneLines[0]).toMatch(
      new RegExp(
        `^\\[roughdraft\\] done seq=\\d+ file=${documentPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} comments=2 unresolved=2 → the user clicked Done Reviewing: read the file and handle any remaining feedback`,
      ),
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
      // Leaves room for reconnect backoff (0.5s, 1s, 2s…) on a loaded machine.
      ["listen", documentPath, "--max-seconds", "5"],
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

    // The restarted server lost its queue, but re-reads the unanswered
    // threads from the file when the listener reattaches: the ask posted
    // before the restart comes back. Sequences start over, and whether the
    // tab's post or the reattach comes first is a race, so ignore order.
    await waitForLog(
      logs,
      (line) => /^\[roughdraft\] change c2 seq=[12] /.test(line),
      4_500,
    );
    const deadline = Date.now() + 2_000;
    const askLines = () =>
      logs.filter((line) => line.startsWith("[roughdraft] ask c1 "));
    while (askLines().length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(askLines()).toHaveLength(2);
    expect(await listening).toBe(0);
  }, 12_000);

  it("re-arming with the printed command after a server restart loses nothing", async () => {
    const first = makeDeps();
    await runCli(["listen", documentPath, "--max-seconds", "0.3"], first.deps);
    const rearm = first.logs.at(-1) ?? "";
    const rearmArgs = rearm
      .slice(rearm.lastIndexOf(" listen ") + " listen ".length)
      .split(" ")
      .filter((arg) => arg !== documentPath);

    // The server restarts and the tab posts exactly as many events as the
    // old cursor had seen, so the cursor alone cannot reveal the restart.
    const port = server.port;
    await server.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    server = await startServer(projectDir, port);
    await postEvent("comment.ask", "c1");
    await postEvent("comment.change", "c2");

    const second = makeDeps();
    await runCli(
      ["listen", documentPath, ...rearmArgs, "--max-seconds", "0.3"],
      second.deps,
    );

    const eventLines = second.logs.filter((line) =>
      /^\[roughdraft\] (ask|change) /.test(line),
    );
    expect(eventLines.map((line) => line.split(" ")[1])).toEqual([
      "ask",
      "change",
    ]);
  }, 12_000);

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

  it("marks a thread as handed to a subagent with ack --delegated", async () => {
    const { deps, logs } = makeDeps();
    const threads = async () =>
      (
        await fetch(
          `http://127.0.0.1:${server.port}/api/agent/status?${new URLSearchParams({ projectPath: projectDir, path: "plan.md" })}`,
        ).then((response) => response.json())
      ).threads;

    expect(await runCli(["ack", documentPath, "c1", "--delegated"], deps)).toBe(
      0,
    );
    expect(await threads()).toEqual({ c1: "delegated" });

    // The subagent acks without the flag once it starts.
    expect(await runCli(["ack", documentPath, "c1"], deps)).toBe(0);
    expect(await threads()).toEqual({ c1: "working" });
    expect(logs).toEqual([
      `[roughdraft] c1 is now delegated in ${documentPath}`,
      `[roughdraft] c1 is now working in ${documentPath}`,
    ]);
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
    await runCli(["help", "ack"], deps);

    const output = logs.join("\n");
    for (const command of [
      "listen <file.md>",
      "reply <file.md> <id>",
      "roughdraft ack <file.md> <commentId> [--delegated]",
    ]) {
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
    expect(line).toContain(`text="${"x".repeat(300)}…"`);
    expect(line).toContain("(truncated; read comment c1 in the file)");
    expect(line).toContain("roughdraft reply '/docs/my plan.md' c1 --stdin");
  });

  it("hands an ask follow-up to a subagent with the command first", () => {
    const line = formatListenEventLine(
      {
        ...baseEvent,
        type: "comment.followup",
        commentId: "c3",
        threadRootId: "c1",
        body: "And the cache?",
      },
      { cliName: "roughdraft", documentPath: "/docs/plan.md" },
    );

    expect(line).toBe(
      '[roughdraft] followup c1 reply=c3 intent=ask seq=7 → roughdraft ack /docs/plan.md c1 --delegated, hand to a forked subagent that acks without --delegated and answers without editing the file: roughdraft reply /docs/plan.md c1 --stdin | by=pavel text="And the cache?"',
    );
  });

  it("names an Ask's non-default model, and leaves the fast default out", () => {
    const options = { cliName: "roughdraft", documentPath: "/docs/plan.md" };

    expect(
      formatListenEventLine({ ...baseEvent, model: "balanced" }, options),
    ).toMatch(/^\[roughdraft\] ask c1 seq=7 model=balanced → /);
    expect(
      formatListenEventLine(
        {
          ...baseEvent,
          type: "comment.followup",
          commentId: "c3",
          model: "session",
        },
        options,
      ),
    ).toMatch(/ intent=ask seq=7 model=session → /);
    expect(formatListenEventLine(baseEvent, options)).not.toContain("model=");
  });

  it("keeps the instructions of an ask well inside Monitor's line budget", () => {
    // Monitor truncates around 480 characters; the part before "|" (what to
    // do) must survive even with a long path.
    const documentPath = `/Users/someone/git_repos/project/.context/${"deep/".repeat(6)}plan.md`;
    const line = formatListenEventLine(
      { ...baseEvent, documentPath },
      { cliName: "roughdraft", documentPath },
    );

    expect(line.indexOf(" | ")).toBeLessThan(400);
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
      '[roughdraft] followup c2 reply=c4 intent=change seq=7 → roughdraft-dev-x ack /docs/plan.md c2, edit the file, then: roughdraft-dev-x reply /docs/plan.md c2 --status applied --stdin | by=pavel text="Also keep the numbers."',
    );
  });
});
