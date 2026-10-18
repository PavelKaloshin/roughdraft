// SessionStart hook: tells the monitor which session it belongs to, records
// the session's name and folder for the Roughdraft UI, and adds one line of
// context so Claude knows what `[roughdraft]` lines mean.
// Usage: session-start.mjs <CLAUDE_PLUGIN_DATA>
import fs from "node:fs";
import path from "node:path";
import {
  findHostPid,
  findRoughdraftCli,
  hostFilePath,
  isProcessAlive,
  readJson,
  readStdinJson,
  sessionFilePath,
  writeJson,
} from "./lib.mjs";

const SESSION_FILE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const CONTEXT_LINE =
  "Roughdraft live review is on: Markdown files you write, edit or open with `roughdraft open` are linked to this session, and `[roughdraft] …` lines from the Roughdraft monitor are the user's review comments on them. Handle each one as the roughdraft-live-review skill says (no need to arm Monitor or run `roughdraft listen` yourself).";

function prune(dataDir) {
  const now = Date.now();
  const byPid = path.join(dataDir, "by-pid");
  for (const name of safeList(byPid)) {
    const pid = Number(name.replace(/\.json$/, ""));
    if (!Number.isInteger(pid) || !isProcessAlive(pid)) {
      fs.rmSync(path.join(byPid, name), { force: true });
    }
  }
  const sessions = path.join(dataDir, "sessions");
  for (const name of safeList(sessions)) {
    const file = path.join(sessions, name);
    try {
      if (now - fs.statSync(file).mtimeMs > SESSION_FILE_MAX_AGE_MS) {
        fs.rmSync(file, { force: true });
      }
    } catch {}
  }
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

async function main() {
  const dataDir = process.argv[2];
  const input = await readStdinJson();
  const sessionId =
    typeof input.session_id === "string" ? input.session_id.trim() : "";
  if (!dataDir || !sessionId) return;

  try {
    prune(dataDir);
    const title =
      typeof input.session_title === "string" && input.session_title.trim()
        ? input.session_title.trim()
        : undefined;
    const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();

    const hostPid = findHostPid();
    if (hostPid) {
      writeJson(hostFilePath(dataDir, hostPid), {
        sessionId,
        at: new Date().toISOString(),
      });
    }

    const sessionFile = sessionFilePath(dataDir, sessionId);
    const existing = readJson(sessionFile);
    const record =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? existing
        : {};
    writeJson(sessionFile, {
      ...record,
      sessionId,
      ...(title ? { title } : {}),
      cwd,
      claims: Array.isArray(record.claims) ? record.claims : [],
    });
  } catch {
    // Never break session start over bookkeeping.
  }

  if (findRoughdraftCli()) process.stdout.write(`${CONTEXT_LINE}\n`);
}

await main();
