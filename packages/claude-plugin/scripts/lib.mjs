// Shared helpers for the Roughdraft Claude Code plugin scripts. Plain Node,
// no dependencies: the plugin directory is used as-is, without an install.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "tcsh"]);
const MAX_ANCESTORS = 8;

/** The `roughdraft` CLI to run: `ROUGHDRAFT_CLI`, else `roughdraft` on PATH. */
export function findRoughdraftCli(env = process.env) {
  const override = env.ROUGHDRAFT_CLI?.trim();
  const name = override || "roughdraft";
  if (name.includes("/")) return isExecutable(name) ? name : null;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** File-name-safe form of a session id. */
export function safeSessionId(sessionId) {
  return String(sessionId)
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 120);
}

/** `${CLAUDE_PLUGIN_DATA}/sessions/<session>.json`: title, cwd and claims. */
export function sessionFilePath(dataDir, sessionId) {
  return path.join(dataDir, "sessions", `${safeSessionId(sessionId)}.json`);
}

/** Where the SessionStart hook leaves the session id for the monitor. */
export function hostFilePath(dataDir, hostPid) {
  return path.join(dataDir, "by-pid", `${hostPid}.json`);
}

/**
 * The Claude Code process both the hooks and the monitor descend from.
 * `ancestors` is nearest first ({pid, comm}). Prefer a process named
 * `claude`; otherwise (Claude Code run through node) the nearest ancestor
 * that is not a shell. Hooks and monitors both run as `claude → [sh →] script`,
 * so they agree, and two concurrent sessions never share this process.
 */
export function pickHostPid(ancestors) {
  const named = ancestors.find((entry) =>
    /^claude/i.test(path.basename(entry.comm)),
  );
  if (named) return named.pid;
  const nonShell = ancestors.find(
    (entry) => !SHELLS.has(path.basename(entry.comm).replace(/^-/, "")),
  );
  return nonShell?.pid ?? null;
}

/** This process's ancestors, nearest first, via `ps` (macOS and Linux). */
export function listAncestors(startPid = process.ppid) {
  const ancestors = [];
  let pid = startPid;
  for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth += 1) {
    let output;
    try {
      output = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      break;
    }
    const match = output.match(/^(\d+)\s+(.*)$/);
    if (!match) break;
    ancestors.push({ pid, comm: match[2] });
    pid = Number(match[1]);
  }
  return ancestors;
}

export function findHostPid() {
  return pickHostPid(listAncestors());
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Atomic write, so a concurrent reader never sees half a file. */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

/**
 * The monitor's session id: `CLAUDE_CODE_SESSION_ID` when Claude Code sets
 * it for monitors (undocumented), else the file the SessionStart hook wrote
 * for the shared Claude Code process.
 */
export function discoverSessionId(dataDir, env = process.env, hostPid) {
  const fromEnv = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (fromEnv) return fromEnv;
  const pid = hostPid ?? findHostPid();
  if (!pid || !dataDir) return null;
  const record = readJson(hostFilePath(dataDir, pid));
  return typeof record?.sessionId === "string" && record.sessionId
    ? record.sessionId
    : null;
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Hook input arrives as JSON on stdin; give up after `timeoutMs`. */
export function readStdinJson(timeoutMs = 2000) {
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => finish(), timeoutMs);
    timer.unref?.();
    function finish() {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}
