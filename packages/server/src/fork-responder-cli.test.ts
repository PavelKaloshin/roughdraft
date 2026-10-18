import fs from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractRoughdraftReviewIndex } from "@roughdraft/rfm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCliDependencies, runCli } from "./cli";
import { createApp } from "./index";

/**
 * `roughdraft answer-fork` and `listen --fork-asks-after` against a real
 * local server, with a fake `claude` on PATH. The fake records how it was
 * started, then runs the ack and reply commands from its prompt verbatim
 * through a real Roughdraft CLI (`rdfake`, the "dev wrapper" name), as the
 * real headless fork would.
 */

/**
 * The server runs in this test process, so the CLI subprocesses (which use
 * the real process check) see the state file's server as alive.
 */
const FAKE_PID = process.pid;
const CLI_NAME = "rdfake";
const SERVER_SRC = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SERVER_SRC, "../../..");
const TSX = path.join(REPO_ROOT, "node_modules/.bin/tsx");

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

/** Records argv/cwd/stdin and the thread status it saw, then obeys the prompt. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const { execSync } = require("node:child_process");
process.on("uncaughtException", (error) => {
  fs.writeFileSync(process.env.FAKE_RECORD + ".err", String(error.stack));
  process.exit(1);
});
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", async () => {
  const record = {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    prompt,
    parentSessionEnv: process.env.CLAUDE_CODE_SESSION_ID ?? null,
  };
  const server = JSON.parse(fs.readFileSync(process.env.ROUGHDRAFT_STATE_DIR + "/server.json", "utf8"));
  const query = new URLSearchParams({ projectPath: process.env.FAKE_PROJECT, path: "plan.md" });
  const status = await fetch(server.url + "/api/agent/status?" + query).then((r) => r.json());
  record.statusAtStart = status.threadDetails;
  fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify(record));
  if (process.env.FAKE_MODE === "hang") { setTimeout(() => {}, 60000); return; }
  const ack = prompt.match(/^\\d\\. Run: (.+)$/m)[1];
  const run = (command, input) => {
    try {
      execSync(command, { input, stdio: "pipe" });
    } catch (error) {
      throw new Error(command + " failed (" + error.status + "): " + String(error.stdout) + String(error.stderr));
    }
  };
  run(ack, "");
  const reply = prompt.match(/^ {3}(\\S+ reply .+ --stdin) <<'EOF'$/m)[1];
  run(reply, "The **code word** is PLUM.\\n");
  process.stdout.write(JSON.stringify({ type: "result", total_cost_usd: 0.25 }));
});
`;

interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

async function startServer(projectDir: string): Promise<RunningServer> {
  const { app } = createApp({ staticDirPath: projectDir });
  const servers: Server[] = [];
  let boundPort = 0;
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

describe("headless fork answers", () => {
  let tempDir: string;
  let projectDir: string;
  let stateDir: string;
  let binDir: string;
  let recordPath: string;
  let documentPath: string;
  let server: RunningServer;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-fork-cli-"));
    projectDir = path.join(tempDir, "project");
    stateDir = path.join(tempDir, "state");
    binDir = path.join(tempDir, "bin");
    recordPath = path.join(tempDir, "claude-record.json");
    for (const dir of [projectDir, stateDir, binDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    documentPath = path.join(projectDir, "plan.md");
    fs.writeFileSync(documentPath, PLAN);

    fs.writeFileSync(path.join(binDir, "claude"), FAKE_CLAUDE, {
      mode: 0o755,
    });
    const entry = path.join(tempDir, "cli-entry.mts");
    fs.writeFileSync(
      entry,
      `import { runCli } from ${JSON.stringify(path.join(SERVER_SRC, "cli.ts"))};\nprocess.exit(await runCli(process.argv.slice(2)));\n`,
    );
    // Like vitest's alias: the CLI runs from source, without a built rfm.
    const tsconfig = path.join(tempDir, "tsconfig.json");
    fs.writeFileSync(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          baseUrl: "/",
          paths: {
            "@roughdraft/rfm": [
              path.join(REPO_ROOT, "packages/rfm/src/index.ts"),
            ],
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(binDir, CLI_NAME),
      `#!/bin/sh\nexec ${JSON.stringify(TSX)} --tsconfig ${JSON.stringify(tsconfig)} ${JSON.stringify(entry)} "$@"\n`,
      { mode: 0o755 },
    );

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

  function makeDeps(extraEnv: Record<string, string> = {}) {
    const logs: string[] = [];
    const errors: string[] = [];
    const deps = createCliDependencies({
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: process.env.HOME,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: path.join(tempDir, "none.json"),
        ROUGHDRAFT_DEV_WRAPPER_NAME: CLI_NAME,
        CLAUDE_CODE_SESSION_ID: "parent-session",
        FAKE_RECORD: recordPath,
        FAKE_PROJECT: projectDir,
        ...extraEnv,
      },
      cwd: projectDir,
      isProcessRunning: (pid) => pid === FAKE_PID,
      spawnServerProcess: () => {
        throw new Error("tests must reuse the running server");
      },
      readStdin: async () => "",
      resolveUpdateStatus: async () => {
        throw new Error("no update checks in tests");
      },
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    });
    return { deps, logs, errors };
  }

  async function threadStatus(id: string): Promise<string | undefined> {
    const query = new URLSearchParams({
      projectPath: projectDir,
      path: "plan.md",
    });
    const payload = (await fetch(
      `http://127.0.0.1:${server.port}/api/agent/status?${query}`,
    ).then((response) => response.json())) as {
      threads: Record<string, string>;
    };
    return payload.threads[id];
  }

  function aiReplies() {
    return extractRoughdraftReviewIndex(
      fs.readFileSync(documentPath, "utf8"),
    ).items.filter((item) => item.kind === "reply" && item.author === "AI");
  }

  /** The fake claude's own crash, so a broken fake fails specifically. */
  function fakeError(): string {
    const file = `${recordPath}.err`;
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  }

  function readRecord() {
    return JSON.parse(fs.readFileSync(recordPath, "utf8")) as {
      argv: string[];
      cwd: string;
      prompt: string;
      parentSessionEnv: string | null;
      statusAtStart: Record<string, { status: string; delegatedTo?: string }>;
    };
  }

  it("answer-fork resumes a fork of the session, which acks and replies in the thread", async () => {
    const { deps, logs, errors } = makeDeps();

    const exitCode = await runCli(
      ["answer-fork", documentPath, "c1", "--session", "sess-1"],
      deps,
    );

    expect(fakeError()).toBe("");
    expect(errors).toEqual([]);
    expect(exitCode).toBe(0);
    const record = readRecord();
    expect(record.argv.slice(0, 4)).toEqual([
      "-p",
      "--resume",
      "sess-1",
      "--fork-session",
    ]);
    const allowedAt = record.argv.indexOf("--allowedTools");
    expect(record.argv.slice(allowedAt + 1, allowedAt + 4)).toEqual([
      "Read",
      `Bash(${CLI_NAME} ack:*)`,
      `Bash(${CLI_NAME} reply:*)`,
    ]);
    expect(record.argv[allowedAt + 4]).toBe("--disallowedTools");
    expect(fs.realpathSync(record.cwd)).toBe(fs.realpathSync(projectDir));
    expect(record.parentSessionEnv).toBeNull();
    expect(record.prompt).toContain("What is included?");
    // The UI showed "Passed to a forked Claude" before the fork ran.
    expect(record.statusAtStart.c1).toMatchObject({
      status: "delegated",
      delegatedTo: "fork-process",
    });

    expect(await threadStatus("c1")).toBe("answered");
    expect(aiReplies().map((reply) => reply.text)).toEqual([
      "The **code word** is PLUM.",
    ]);
    // Nothing but the reply was written.
    const after = fs.readFileSync(documentPath, "utf8");
    expect(after.split("\n---\n")[0]).toBe(PLAN.split("\n---\n")[0]);
    expect(logs.at(-1)).toBe(
      `[roughdraft] a headless Claude answered c1 in ${documentPath} (cost $0.25)`,
    );
  }, 30_000);

  it("puts the thread back in the queue when the fork times out", async () => {
    const { deps, errors } = makeDeps({ FAKE_MODE: "hang" });

    const exitCode = await runCli(
      [
        "answer-fork",
        documentPath,
        "c1",
        "--session",
        "sess-1",
        "--timeout",
        "1",
      ],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("timed out after 1s");
    expect(await threadStatus("c1")).toBe("queued");
    expect(aiReplies()).toEqual([]);
  }, 30_000);

  it("refuses a Change thread and reports a missing claude without starting anything", async () => {
    const { deps, errors } = makeDeps();

    expect(
      await runCli(
        ["answer-fork", documentPath, "c2", "--session", "sess-1"],
        deps,
      ),
    ).toBe(1);
    expect(
      await runCli(
        [
          "answer-fork",
          documentPath,
          "c1",
          "--session",
          "sess-1",
          "--claude",
          path.join(tempDir, "no-claude"),
        ],
        deps,
      ),
    ).toBe(1);

    expect(errors.join("\n")).toContain("c2 is not an Ask thread");
    expect(errors.join("\n")).toContain("claude CLI not found");
    expect(fs.existsSync(recordPath)).toBe(false);
    expect(await threadStatus("c1")).toBeUndefined();
  });

  it("tells the session to leave a thread a fork already has", async () => {
    const { deps, logs } = makeDeps();
    await fetch(`http://127.0.0.1:${server.port}/api/agent/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: projectDir,
        path: "plan.md",
        commentId: "c1",
        delegated: true,
        delegatedTo: "fork-process",
      }),
    });

    expect(await runCli(["ack", documentPath, "c1", "--delegated"], deps)).toBe(
      0,
    );

    expect(logs).toEqual([
      `[roughdraft] c1 is now delegated (to a headless fork; leave it) in ${documentPath}`,
    ]);
  });

  it("listen --fork-asks-after forks an Ask the busy session left queued", async () => {
    const { deps, logs, errors } = makeDeps();

    const exitCode = await runCli(
      [
        "listen",
        documentPath,
        "--max-seconds",
        "1",
        "--fork-asks-after",
        "0.3",
      ],
      deps,
    );

    expect(errors).toEqual([]);
    expect(exitCode).toBe(0);
    const lines = logs.map((line) => line.split(" ").slice(0, 3).join(" "));
    expect(lines).toEqual([
      "[roughdraft] listening on",
      "[roughdraft] ask c1",
      "[roughdraft] change c2",
      "[roughdraft] forked c1",
      "[roughdraft] listen expired;",
    ]);
    expect(readRecord().argv.slice(0, 3)).toEqual([
      "-p",
      "--resume",
      "parent-session",
    ]);
    // The listener waited for the running fork before exiting.
    expect(await threadStatus("c1")).toBe("answered");
    expect(await threadStatus("c2")).toBe("queued");
  }, 30_000);
});
