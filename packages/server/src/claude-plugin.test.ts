import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without types; tests are not type-checked by tsc
import { pickHostPid } from "../../claude-plugin/scripts/lib.mjs";

/**
 * The Claude Code plugin's scripts (packages/claude-plugin), run as Claude
 * Code runs them: a subprocess with hook JSON on stdin. A fake `roughdraft`
 * records how it was called.
 */

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../claude-plugin",
);

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out: ${command} ${args.join(" ")}\n${stderr}`));
    }, options.timeoutMs ?? 10_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

describe("Claude Code plugin scripts", () => {
  let tempDir: string;
  let dataDir: string;
  let binDir: string;
  let callLog: string;

  beforeEach(() => {
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-plugin-")),
    );
    dataDir = path.join(tempDir, "data");
    binDir = path.join(tempDir, "bin");
    callLog = path.join(tempDir, "calls.log");
    fs.mkdirSync(binDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** A fake `roughdraft` on PATH: logs its argv, then runs `body`. */
  function fakeCli(body = "exit 0") {
    const file = path.join(binDir, "roughdraft");
    fs.writeFileSync(
      file,
      `#!/bin/sh\necho "$*" >> ${JSON.stringify(callLog)}\n${body}\n`,
    );
    fs.chmodSync(file, 0o755);
  }

  const calls = (): string[] =>
    fs.existsSync(callLog)
      ? fs.readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean)
      : [];

  /** PATH with node and sh, the fake CLI first, and no real roughdraft. */
  function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      PATH: [binDir, path.dirname(process.execPath), "/usr/bin", "/bin"].join(
        path.delimiter,
      ),
      HOME: tempDir,
      ...extra,
    };
  }

  const rdNode = path.join(pluginRoot, "bin", "rd-node");
  const sessionListen = path.join(pluginRoot, "bin", "session-listen");

  describe("PostToolUse claim hook", () => {
    const hookInput = (filePath: string) =>
      JSON.stringify({
        session_id: "session-1",
        cwd: "/work/project",
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: filePath, content: "# Plan" },
      });

    it("claims a written Markdown file for the session from stdin", async () => {
      fakeCli();
      const result = await run(rdNode, ["claim-on-write.mjs", dataDir], {
        env: baseEnv(),
        stdin: hookInput("/work/project/docs/plan.md"),
      });

      expect(result).toMatchObject({ code: 0, stdout: "" });
      expect(calls()).toEqual([
        `claim /work/project/docs/plan.md --session session-1 --claims-file ${dataDir}/sessions/session-1.json --no-start --quiet`,
      ]);
    });

    it("ignores files that are not Markdown", async () => {
      fakeCli();
      const result = await run(rdNode, ["claim-on-write.mjs", dataDir], {
        env: baseEnv(),
        stdin: hookInput("/work/project/src/index.ts"),
      });

      expect(result.code).toBe(0);
      expect(calls()).toEqual([]);
    });

    it("does nothing when Roughdraft is not installed", async () => {
      const result = await run(rdNode, ["claim-on-write.mjs", dataDir], {
        env: baseEnv(),
        stdin: hookInput("/work/project/plan.md"),
      });

      expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    });
  });

  describe("SessionStart hook", () => {
    const startInput = JSON.stringify({
      session_id: "session-1",
      session_title: "auth refactor",
      cwd: "/work/project",
      hook_event_name: "SessionStart",
      source: "startup",
    });

    it("prints one context line and records the session for the monitor and the UI", async () => {
      fakeCli();
      const result = await run(rdNode, ["session-start.mjs", dataDir], {
        env: baseEnv(),
        stdin: startInput,
      });

      expect(result.code).toBe(0);
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^Roughdraft live review is on: /);
      expect(lines[0]).toContain("roughdraft-live-review skill");
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(dataDir, "sessions", "session-1.json"),
            "utf8",
          ),
        ),
      ).toEqual({
        sessionId: "session-1",
        title: "auth refactor",
        cwd: "/work/project",
        claims: [],
      });
      const byPid = fs.readdirSync(path.join(dataDir, "by-pid"));
      expect(byPid).toHaveLength(1);
    });

    it("keeps the session's claims when it starts again (resume)", async () => {
      fakeCli();
      fs.mkdirSync(path.join(dataDir, "sessions"), { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, "sessions", "session-1.json"),
        JSON.stringify({ claims: ["/work/project/plan.md"] }),
      );
      await run(rdNode, ["session-start.mjs", dataDir], {
        env: baseEnv(),
        stdin: startInput,
      });
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(dataDir, "sessions", "session-1.json"),
            "utf8",
          ),
        ).claims,
      ).toEqual(["/work/project/plan.md"]);
    });

    it("says nothing when Roughdraft is not installed", async () => {
      const result = await run(rdNode, ["session-start.mjs", dataDir], {
        env: baseEnv(),
        stdin: startInput,
      });
      expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    });
  });

  describe("monitor wrapper", () => {
    const fastLoop = {
      ROUGHDRAFT_PLUGIN_BACKOFF_MS: "10",
      ROUGHDRAFT_PLUGIN_BACKOFF_MAX_MS: "20",
      ROUGHDRAFT_PLUGIN_SESSION_POLL_MS: "20",
    };

    it("runs the session listener quietly with the session's claims file, and restarts it when it exits", async () => {
      fakeCli("exit 0");
      const result = await run(sessionListen, [dataDir], {
        env: baseEnv({
          ...fastLoop,
          CLAUDE_CODE_SESSION_ID: "session-1",
          ROUGHDRAFT_PLUGIN_MAX_RUNS: "3",
        }),
      });

      expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
      const listenArgs = `listen --session session-1 --quiet --no-start --max-seconds 600 --fork-asks-after 0 --claims-file ${dataDir}/sessions/session-1.json --monitor-id `;
      expect(calls()).toHaveLength(3);
      for (const call of calls()) {
        expect(call.startsWith(listenArgs), call).toBe(true);
      }
    });

    it("gives every round of one wrapper process the same monitor id, and another process a new one", async () => {
      fakeCli("exit 0");
      const env = baseEnv({
        ...fastLoop,
        CLAUDE_CODE_SESSION_ID: "session-1",
        ROUGHDRAFT_PLUGIN_MAX_RUNS: "3",
      });
      const monitorIds = () =>
        calls().map((call) => call.match(/--monitor-id (\S+)/)?.[1]);

      await run(sessionListen, [dataDir], { env });
      const first = monitorIds();
      expect(first).toHaveLength(3);
      expect(first[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Set(first)).toEqual(new Set([first[0]]));

      // A new Claude Code process (e.g. resumed after exit) runs a new one.
      await run(sessionListen, [dataDir], { env });
      const second = monitorIds().slice(3);
      expect(new Set(second).size).toBe(1);
      expect(second[0]).not.toBe(first[0]);
    });

    it("drops --monitor-id for an older roughdraft that rejects it", async () => {
      fakeCli('case "$*" in *--monitor-id*) exit 2;; esac\nexit 0');
      const result = await run(sessionListen, [dataDir], {
        env: baseEnv({
          ...fastLoop,
          CLAUDE_CODE_SESSION_ID: "session-1",
          ROUGHDRAFT_PLUGIN_MAX_RUNS: "3",
        }),
      });

      expect(result).toMatchObject({ code: 0, stdout: "" });
      expect(calls().map((call) => call.includes("--monitor-id"))).toEqual([
        true,
        false,
        false,
      ]);
    });

    it("passes the listener's lines through and nothing else, even when it fails", async () => {
      fakeCli(
        'echo "[roughdraft] ask c1 file=/work/plan.md seq=3 → roughdraft ack /work/plan.md c1"\necho "boom" >&2\nexit 1',
      );
      const result = await run(sessionListen, [dataDir], {
        env: baseEnv({
          ...fastLoop,
          CLAUDE_CODE_SESSION_ID: "session-1",
          ROUGHDRAFT_PLUGIN_MAX_RUNS: "2",
        }),
      });

      expect(result.stdout).toBe(
        "[roughdraft] ask c1 file=/work/plan.md seq=3 → roughdraft ack /work/plan.md c1\n".repeat(
          2,
        ),
      );
      expect(result.stderr).toBe("");
      expect(calls()).toHaveLength(2);
    });

    it("finds its session from the SessionStart hook when Claude Code does not set CLAUDE_CODE_SESSION_ID", async () => {
      fakeCli("exit 0");
      // Both run as children of the same process here, as hooks and
      // monitors are children of the same Claude Code process.
      await run(rdNode, ["session-start.mjs", dataDir], {
        env: baseEnv(),
        stdin: JSON.stringify({ session_id: "from-hook", cwd: tempDir }),
      });
      const result = await run(sessionListen, [dataDir], {
        env: baseEnv({ ...fastLoop, ROUGHDRAFT_PLUGIN_MAX_RUNS: "1" }),
      });

      expect(result).toMatchObject({ code: 0, stdout: "" });
      expect(calls().at(-1)).toMatch(/^listen --session from-hook /);
    });

    it("exits quietly when Roughdraft is not installed", async () => {
      const result = await run(sessionListen, [dataDir], {
        env: baseEnv({ CLAUDE_CODE_SESSION_ID: "session-1" }),
      });
      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    });
  });

  describe("host process", () => {
    it("prefers the claude process, else the nearest process that is not a shell", () => {
      expect(
        pickHostPid([
          { pid: 30, comm: "/bin/sh" },
          { pid: 20, comm: "/Users/me/.local/bin/claude" },
          { pid: 10, comm: "tmux" },
        ]),
      ).toBe(20);
      // Claude Code run through node: two sessions under one tmux server
      // still resolve to their own node process.
      expect(
        pickHostPid([
          { pid: 31, comm: "-zsh" },
          { pid: 21, comm: "node" },
          { pid: 10, comm: "tmux" },
        ]),
      ).toBe(21);
      expect(pickHostPid([{ pid: 5, comm: "bash" }])).toBeNull();
    });
  });

  it("ships a plugin manifest, a marketplace entry, a monitor and hooks that point at existing scripts", () => {
    const read = (file: string) =>
      JSON.parse(fs.readFileSync(path.join(pluginRoot, file), "utf8"));
    const manifest = read(".claude-plugin/plugin.json");
    const marketplace = read(".claude-plugin/marketplace.json");
    const monitors = read("monitors/monitors.json");
    const hooks = read("hooks/hooks.json").hooks;

    expect(manifest.name).toBe("roughdraft");
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: "roughdraft", source: "./" }),
    ]);
    // Monitor entries are strict: unknown keys stop the plugin from loading.
    for (const monitor of monitors) {
      expect(Object.keys(monitor).sort()).toEqual(
        ["command", "description", "name", "when"].sort(),
      );
      expect(monitor.when).toBe("always");
    }
    expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "SessionStart"]);
    expect(hooks.PostToolUse[0].matcher).toBe("Write|Edit");
    expect(hooks.PostToolUse[0].hooks[0].async).toBe(true);

    const commands = [
      ...monitors.map((monitor: { command: string }) => monitor.command),
      ...Object.values(hooks).flatMap((groups) =>
        (groups as Array<{ hooks: Array<{ command: string }> }>).flatMap(
          (group) => group.hooks.map((hook) => hook.command),
        ),
      ),
    ];
    for (const command of commands) {
      const executable = command.match(/"\$\{CLAUDE_PLUGIN_ROOT\}"(\S+)/)?.[1];
      expect(executable, command).toBeTruthy();
      const file = path.join(pluginRoot, executable ?? "");
      expect(fs.statSync(file).mode & 0o111, file).not.toBe(0);
      const script = command.match(/rd-node (\S+\.mjs)/)?.[1];
      if (script) {
        expect(fs.existsSync(path.join(pluginRoot, "scripts", script))).toBe(
          true,
        );
      }
      // Plugin variables are not exported to monitors: pass data inline.
      expect(command).toContain(`"$\{CLAUDE_PLUGIN_DATA}"`);
    }
  });
});
