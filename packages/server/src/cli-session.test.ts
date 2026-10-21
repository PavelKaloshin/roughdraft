import fs from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCliDependencies, runCli } from "./cli";
import { createApp } from "./index";

/**
 * `roughdraft listen --session`, `claim` and `sessions` against a real
 * server (ADR 0007). The plugin's monitor runs `listen --session`; its
 * PostToolUse hook runs `claim`.
 */

const FAKE_PID = 434_343;

function doc(title: string, id: string, question: string): string {
  return [
    `# ${title}`,
    "",
    `Text {==here==}{>>${question}<<}{#${id}}.`,
    "",
    "---",
    "comments:",
    `  ${id}:`,
    "    by: pavel",
    '    at: "2026-10-18T12:00:00.000Z"',
    "    intent: ask",
    "",
  ].join("\n");
}

interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

/** Listens on both loopback families so `http://localhost:<port>` resolves. */
async function startServer(
  projectDir: string,
  port = 0,
): Promise<RunningServer> {
  const { app } = createApp({
    staticDirPath: projectDir,
    agentListenerGraceMs: 200,
  });
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

describe("session CLI commands", () => {
  let tempDir: string;
  let projectA: string;
  let projectB: string;
  let stateDir: string;
  let planPath: string;
  let notesPath: string;
  let server: RunningServer;

  function writeState(port: number) {
    fs.writeFileSync(
      path.join(stateDir, "server.json"),
      JSON.stringify({
        port,
        pid: FAKE_PID,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${port}`,
      }),
    );
  }

  beforeEach(async () => {
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-session-cli-")),
    );
    // Two projects: a session listens across all of them.
    projectA = path.join(tempDir, "project-a");
    projectB = path.join(tempDir, "project-b");
    stateDir = path.join(tempDir, "state");
    for (const dir of [projectA, projectB, stateDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    planPath = path.join(projectA, "plan.md");
    notesPath = path.join(projectB, "notes.md");
    fs.writeFileSync(planPath, doc("Plan", "c1", "What is included?"));
    fs.writeFileSync(notesPath, doc("Notes", "n1", "Why Friday?"));
    server = await startServer(projectA);
    writeState(server.port);
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeDeps(options: { sessionId?: string; cwd?: string } = {}) {
    const logs: string[] = [];
    const errors: string[] = [];
    let spawned = 0;
    const deps = createCliDependencies({
      env: {
        PATH: process.env.PATH,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: path.join(tempDir, "none.json"),
        // Without a state file the CLI probes its default port (7373); keep
        // it on this test's own server so a developer's running Roughdraft
        // is never found.
        ROUGHDRAFT_PORT: String(server.port),
        ...(options.sessionId
          ? { CLAUDE_CODE_SESSION_ID: options.sessionId }
          : {}),
      },
      cwd: options.cwd ?? projectA,
      isProcessRunning: (pid) => pid === FAKE_PID,
      spawnServerProcess: () => {
        spawned += 1;
        throw new Error("tests must reuse the running server");
      },
      readStdin: async () => "",
      resolveUpdateStatus: async () => {
        throw new Error("no update checks in tests");
      },
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    });
    return { deps, logs, errors, spawnedCount: () => spawned };
  }

  function postAsk(projectPath: string, file: string, commentId: string) {
    return fetch(`http://127.0.0.1:${server.port}/api/review-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath,
        path: file,
        type: "comment.ask",
        commentId,
      }),
    });
  }

  async function waitFor<T>(
    read: () => T | undefined | null | false,
    what: string,
    timeoutMs = 3_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  /** Polls GET /api/sessions until the session owns `count` documents. */
  async function waitForOwned(port: number, sessionId: string, count: number) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const body = await fetch(`http://127.0.0.1:${port}/api/sessions`)
        .then((response) => response.json())
        .catch(() => null);
      const session = body?.sessions?.find(
        (candidate: { sessionId: string }) => candidate.sessionId === sessionId,
      );
      if (session?.documents?.length === count) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`${sessionId} never owned ${count} documents`);
  }

  const claimsFile = () => path.join(tempDir, "sessions", "session-a.json");
  const readClaims = (): string[] =>
    JSON.parse(fs.readFileSync(claimsFile(), "utf8")).claims;

  it("claims a file for the session and records it in the claims file", async () => {
    const { deps, logs, errors } = makeDeps({ sessionId: "session-a" });
    const code = await runCli(
      ["claim", planPath, "--claims-file", claimsFile()],
      deps,
    );

    expect(errors).toEqual([]);
    expect(code).toBe(0);
    expect(logs).toEqual([
      `[roughdraft] claimed ${planPath} for session session-a`,
    ]);
    expect(readClaims()).toEqual([planPath]);
  });

  it("does not take a file from a live session unless forced", async () => {
    const a = makeDeps();
    const listening = runCli(
      ["listen", "--session", "session-a", "--max-seconds", "1.2"],
      a.deps,
    );
    await waitFor(
      () => a.logs.find((line) => line.includes("listening for session")),
      "session A to listen",
    );
    await runCli(
      ["claim", planPath, "--session", "session-a"],
      makeDeps().deps,
    );

    const b = makeDeps();
    expect(
      await runCli(["claim", planPath, "--session", "session-b"], b.deps),
    ).toBe(0);
    expect(b.logs).toEqual([
      `[roughdraft] ${planPath} stays with live session session-a; pass --force to take it over`,
    ]);

    const forced = makeDeps();
    await runCli(
      ["claim", planPath, "--session", "session-b", "--force"],
      forced.deps,
    );
    expect(forced.logs).toEqual([
      `[roughdraft] claimed ${planPath} for session session-b (was session-a)`,
    ]);

    await listening;
    expect(a.logs).toContain(
      `[roughdraft] released ${planPath}: reassigned to another session → stop handling its comments; the other session answers them now`,
    );
  });

  it("listens for every file the session owns, across projects, with file= on each line", async () => {
    const { deps, logs, errors } = makeDeps();
    await runCli(["claim", planPath, "--session", "session-a"], deps);
    await runCli(["claim", notesPath, "--session", "session-a"], deps);
    logs.length = 0;

    const code = await runCli(
      ["listen", "--session", "session-a", "--max-seconds", "0.8"],
      deps,
    );

    expect(errors).toEqual([]);
    expect(code).toBe(0);
    const lines = logs.filter((line) => /^\[roughdraft\] ask /.test(line));
    // Both files' unanswered asks come back from the files themselves.
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          new RegExp(`^\\[roughdraft\\] ask c1 file=${planPath} seq=\\d+ → `),
        ),
        expect.stringMatching(
          new RegExp(`^\\[roughdraft\\] ask n1 file=${notesPath} seq=\\d+ → `),
        ),
      ]),
    );
    // Its claims were announced to the session as they happened.
    expect(
      logs.filter((line) => line.startsWith("[roughdraft] claimed")),
    ).toEqual([
      `[roughdraft] claimed ${planPath} → Ask/Change comments on it now come to this session; no action needed`,
      `[roughdraft] claimed ${notesPath} → Ask/Change comments on it now come to this session; no action needed`,
    ]);
    expect(logs.at(0)).toBe(
      "[roughdraft] listening for session session-a (2 files)",
    );
    expect(logs.at(-1)).toBe(
      "[roughdraft] listen expired; re-arm with: roughdraft listen --session session-a",
    );
  });

  it("re-sends the claims file when it connects, prints nothing else in --quiet mode, and drops a file reassigned away", async () => {
    fs.mkdirSync(path.dirname(claimsFile()), { recursive: true });
    fs.writeFileSync(
      claimsFile(),
      JSON.stringify({ title: "auth refactor", claims: [planPath, notesPath] }),
    );
    // Answer both asks first so the quiet listener has nothing to say.
    for (const [file, id] of [
      [planPath, "c1"],
      [notesPath, "n1"],
    ] as const) {
      await runCli(
        ["reply", file, id, "--body", "Done."],
        makeDeps({ cwd: path.dirname(file) }).deps,
      );
    }

    const { deps, logs } = makeDeps();
    const listening = runCli(
      [
        "listen",
        "--session",
        "session-a",
        "--claims-file",
        claimsFile(),
        "--quiet",
        "--max-seconds",
        "1.5",
      ],
      deps,
    );
    await waitForOwned(server.port, "session-a", 2);

    // The user connects notes.md to another session from the UI.
    await fetch(`http://127.0.0.1:${server.port}/api/sessions/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-b",
        documentPath: notesPath,
        force: true,
      }),
    });
    expect(await listening).toBe(0);

    expect(logs).toEqual([
      `[roughdraft] released ${notesPath}: reassigned to another session → stop handling its comments; the other session answers them now`,
    ]);
    expect(readClaims()).toEqual([planPath]);
    const owner = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions`,
    ).then((response) => response.json());
    expect(owner.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "session-a",
          title: "auth refactor",
          documents: [planPath],
        }),
      ]),
    );
  });

  it("keeps listening across a server restart without starting a server itself", async () => {
    const port = server.port;
    const { deps, logs, spawnedCount } = makeDeps();
    await runCli(
      [
        "claim",
        planPath,
        "--session",
        "session-a",
        "--claims-file",
        claimsFile(),
      ],
      deps,
    );
    await runCli(["reply", planPath, "c1", "--body", "Done."], deps);
    logs.length = 0;

    const listening = runCli(
      [
        "listen",
        "--session",
        "session-a",
        "--claims-file",
        claimsFile(),
        "--no-start",
        "--quiet",
        "--max-seconds",
        "4",
      ],
      deps,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await server.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    // A new server process: ownership is gone from memory.
    server = await startServer(projectA, port);

    // The listener re-sends its claims, so a new ask still reaches it.
    fs.writeFileSync(planPath, doc("Plan", "c9", "And now?"));
    await waitForOwned(port, "session-a", 1);
    await postAsk(projectA, "plan.md", "c9");
    await waitFor(
      () => logs.find((line) => line.startsWith("[roughdraft] ask c9 ")),
      "the ask after restart",
    );
    await listening;
    expect(spawnedCount()).toBe(0);
  });

  it("waits quietly when no server runs and --no-start is set", async () => {
    await server.close();
    fs.rmSync(path.join(stateDir, "server.json"));
    const { deps, logs, errors, spawnedCount } = makeDeps();

    const code = await runCli(
      [
        "listen",
        "--session",
        "session-a",
        "--no-start",
        "--quiet",
        "--max-seconds",
        "0.5",
      ],
      deps,
    );

    expect(code).toBe(0);
    expect(logs).toEqual([]);
    expect(errors).toEqual([]);
    expect(spawnedCount()).toBe(0);
    server = await startServer(projectA);
  });

  it("records a claim for later when no server runs and --no-start is set", async () => {
    await server.close();
    fs.rmSync(path.join(stateDir, "server.json"));
    const { deps, logs, spawnedCount } = makeDeps({ sessionId: "session-a" });

    const code = await runCli(
      ["claim", planPath, "--claims-file", claimsFile(), "--no-start"],
      deps,
    );

    expect(code).toBe(0);
    expect(spawnedCount()).toBe(0);
    expect(readClaims()).toEqual([planPath]);
    expect(logs).toEqual([
      `[roughdraft] Roughdraft is not running; ${planPath} is claimed for session session-a when its listener connects`,
    ]);
    server = await startServer(projectA);
  });

  it("without a claude CLI, says so once per session (not per file or per round) and still prints every Ask", async () => {
    const { deps } = makeDeps();
    for (const file of [planPath, notesPath]) {
      await runCli(
        [
          "claim",
          file,
          "--session",
          "session-a",
          "--claims-file",
          claimsFile(),
          "--quiet",
        ],
        deps,
      );
    }
    // The plugin's listener, with no claude to fork to.
    const pluginRound = async () => {
      const round = makeDeps();
      const code = await runCli(
        [
          "listen",
          "--session",
          "session-a",
          "--claims-file",
          claimsFile(),
          "--quiet",
          "--no-start",
          "--max-seconds",
          "0.8",
          "--fork-asks-after",
          "0",
          "--claude",
          path.join(tempDir, "no-such-claude"),
        ],
        round.deps,
      );
      expect(code).toBe(0);
      expect(round.errors).toEqual([]);
      return round.logs;
    };
    const notice = (line: string) =>
      line.startsWith("[roughdraft] claude CLI not found");
    const askIds = (logs: string[]) =>
      logs
        .filter((line) => line.startsWith("[roughdraft] ask "))
        .map((line) => line.split(" ")[2])
        .sort();

    const first = await pluginRound();
    expect(first.filter(notice)).toHaveLength(1);
    expect(askIds(first)).toEqual(["c1", "n1"]);

    // The wrapper restarts listen: the Asks come again, the notice does not.
    const second = await pluginRound();
    expect(second.filter(notice)).toEqual([]);
    expect(askIds(second)).toEqual(["c1", "n1"]);
    expect(readClaims().sort()).toEqual([notesPath, planPath].sort());
  });

  it("prints each line once per monitor, and again after a server restart", async () => {
    const port = server.port;
    const { deps } = makeDeps();
    await runCli(
      ["claim", planPath, "--session", "session-a", "--quiet"],
      deps,
    );
    const round = async (monitorId: string) => {
      const listener = makeDeps();
      const code = await runCli(
        [
          "listen",
          "--session",
          "session-a",
          "--quiet",
          "--no-start",
          "--max-seconds",
          "0.8",
          "--monitor-id",
          monitorId,
        ],
        listener.deps,
      );
      expect(listener.errors).toEqual([]);
      expect(code).toBe(0);
      return listener.logs.map((line) => line.split(" ").slice(0, 3).join(" "));
    };

    expect(await round("m1")).toEqual([
      `[roughdraft] claimed ${planPath}`,
      "[roughdraft] ask c1",
    ]);
    expect(await round("m1")).toEqual([]);

    // The server forgets what it printed: better twice than never.
    await server.close();
    server = await startServer(projectA, port);
    await runCli(
      ["claim", planPath, "--session", "session-a", "--quiet"],
      deps,
    );
    expect(await round("m1")).toContain("[roughdraft] ask c1");
  });

  it("lists live sessions", async () => {
    const listener = makeDeps();
    const listening = runCli(
      [
        "listen",
        "--session",
        "session-a",
        "--title",
        "auth refactor",
        "--quiet",
        "--max-seconds",
        "0.8",
      ],
      listener.deps,
    );
    await runCli(
      ["claim", planPath, "--session", "session-a"],
      makeDeps().deps,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    const json = makeDeps();
    expect(await runCli(["sessions", "--json"], json.deps)).toBe(0);
    expect(JSON.parse(json.logs.join("\n"))).toMatchObject({
      running: true,
      sessions: [
        {
          sessionId: "session-a",
          title: "auth refactor",
          cwd: projectA,
          documents: [planPath],
        },
      ],
    });

    const text = makeDeps();
    await runCli(["sessions"], text.deps);
    expect(text.logs[0]).toMatch(
      new RegExp(`^session-a  auth refactor  ${projectA}  active .+ ago$`),
    );
    expect(text.logs[1]).toBe(`  ${planPath}`);
    await listening;
  });

  it("claims the file for the calling session on open, without stealing it", async () => {
    const opener = makeDeps({ sessionId: "session-a" });
    expect(await runCli(["open", planPath, "--print-url"], opener.deps)).toBe(
      0,
    );
    await waitForOwnerOf(planPath, "session-a");

    // Another session opening it does not take it from session A while A
    // is live (A just polled).
    await runCli(
      ["listen", "--session", "session-a", "--quiet", "--max-seconds", "0"],
      makeDeps().deps,
    );
    await runCli(
      ["open", planPath, "--print-url"],
      makeDeps({ sessionId: "session-b" }).deps,
    );
    await waitForOwnerOf(planPath, "session-a");
  });

  async function waitForOwnerOf(documentPath: string, sessionId: string) {
    const query = new URLSearchParams({
      projectPath: path.dirname(documentPath),
      path: path.basename(documentPath),
    });
    const body = await fetch(
      `http://127.0.0.1:${server.port}/api/agent/status?${query}`,
    ).then((response) => response.json());
    expect(body.owner?.sessionId).toBe(sessionId);
  }

  it("prints the plugin install commands for setup claude", async () => {
    const { deps, logs } = makeDeps();
    expect(await runCli(["setup", "claude"], deps)).toBe(0);
    const pluginDir = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../claude-plugin",
    );
    expect(logs).toContain(`  claude plugin marketplace add ${pluginDir}`);
    expect(logs).toContain("  claude plugin install roughdraft@roughdraft");
  });

  it("keeps listen <file> --session a per-file listener that claims the file", async () => {
    const perFile = makeDeps();
    expect(
      await runCli(
        ["listen", planPath, "--session", "session-a", "--max-seconds", "0.2"],
        perFile.deps,
      ),
    ).toBe(0);
    expect(perFile.logs[0]).toMatch(
      /^\[roughdraft\] listening on .*plan\.md \(session session-a\)/,
    );
    await waitForOwnerOf(planPath, "session-a");
  });

  it("rejects claim without a session", async () => {
    const none = makeDeps();
    expect(await runCli(["claim", planPath], none.deps)).toBe(2);
    expect(none.errors.join("\n")).toContain("--session");
  });
});
