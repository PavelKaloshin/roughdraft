// Plugin monitor body: runs `roughdraft listen --session <id> --quiet` for
// the whole Claude Code session and restarts it whenever it exits (expiry,
// server restart, crash), with backoff. Prints only what `listen` prints,
// which in --quiet mode is one line per event or ownership change.
// Usage: session-listen.mjs <CLAUDE_PLUGIN_DATA>
import { spawn } from "node:child_process";
import {
  discoverSessionId,
  findHostPid,
  findRoughdraftCli,
  sessionFilePath,
} from "./lib.mjs";

const env = process.env;
const numberFromEnv = (name, fallback) => {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

/** Short rounds, so a new session id (after /clear) is picked up soon. */
const LISTEN_MAX_SECONDS = numberFromEnv(
  "ROUGHDRAFT_PLUGIN_LISTEN_SECONDS",
  600,
);
const BACKOFF_MIN_MS = numberFromEnv("ROUGHDRAFT_PLUGIN_BACKOFF_MS", 1000);
const BACKOFF_MAX_MS = numberFromEnv(
  "ROUGHDRAFT_PLUGIN_BACKOFF_MAX_MS",
  60_000,
);
const SESSION_POLL_MS = numberFromEnv(
  "ROUGHDRAFT_PLUGIN_SESSION_POLL_MS",
  1000,
);
/**
 * Seconds before a queued Ask goes to a headless fork; "off" disables. The
 * default 0 (with --quiet) sends every Ask straight to a fork and keeps its
 * line from the session, so an Ask never costs the main session a turn; the
 * line still arrives when the fork cannot answer it.
 */
const FORK_ASKS_AFTER = /^(off|\d+(\.\d+)?)$/.test(
  env.ROUGHDRAFT_PLUGIN_FORK_ASKS_AFTER ?? "",
)
  ? (env.ROUGHDRAFT_PLUGIN_FORK_ASKS_AFTER ?? "0")
  : "0";
/** Test hook: stop after this many runs of `listen` (0 = never). */
const MAX_RUNS = numberFromEnv("ROUGHDRAFT_PLUGIN_MAX_RUNS", 0);
/** A run this long was healthy: the next failure starts the backoff over. */
const HEALTHY_RUN_MS = 30_000;

const dataDir = process.argv[2] ?? "";
let child = null;
let stopping = false;

function stop() {
  stopping = true;
  child?.kill("SIGTERM");
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("SIGHUP", stop);
// Never write anything but listen's own lines.
process.stdout.on("error", () => process.exit(0));

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function runListen(cli, sessionId) {
  return new Promise((resolve) => {
    const args = [
      "listen",
      "--session",
      sessionId,
      "--quiet",
      "--no-start",
      "--max-seconds",
      String(LISTEN_MAX_SECONDS),
    ];
    // Asks go to a headless fork of the session (`claude -p --resume …
    // --fork-session`); with 0 at once, without waking the session.
    if (FORK_ASKS_AFTER !== "off") {
      args.push("--fork-asks-after", FORK_ASKS_AFTER);
    }
    if (dataDir) {
      args.push("--claims-file", sessionFilePath(dataDir, sessionId));
    }
    child = spawn(cli, args, { stdio: ["ignore", "inherit", "ignore"] });
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  }).finally(() => {
    child = null;
  });
}

async function main() {
  const cli = findRoughdraftCli(env);
  if (!cli) return; // Roughdraft is not installed: stay silent.

  const hostPid = env.CLAUDE_CODE_SESSION_ID ? null : findHostPid();
  let backoff = BACKOFF_MIN_MS;
  let runs = 0;

  while (!stopping) {
    // Orphaned (Claude Code went away without stopping us): exit.
    if (process.ppid === 1) return;

    const sessionId = discoverSessionId(dataDir, env, hostPid ?? undefined);
    if (!sessionId) {
      // The SessionStart hook has not written it yet.
      await sleep(SESSION_POLL_MS);
      continue;
    }

    const startedAt = Date.now();
    const code = await runListen(cli, sessionId);
    runs += 1;
    if (MAX_RUNS > 0 && runs >= MAX_RUNS) return;
    if (stopping) return;

    const ranFor = Date.now() - startedAt;
    if (ranFor >= HEALTHY_RUN_MS) backoff = BACKOFF_MIN_MS;
    // A clean expiry re-arms at once; an instant exit is not "clean".
    if (code === 0 && ranFor >= 1000) continue;
    await sleep(backoff);
    backoff = Math.min(Math.max(backoff, 1) * 2, BACKOFF_MAX_MS);
  }
}

await main();
