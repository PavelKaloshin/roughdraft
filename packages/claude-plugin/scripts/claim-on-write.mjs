// PostToolUse hook (Write|Edit, async): a session that writes a Markdown file
// claims it, so the file's Ask/Change comments come to this session.
// Usage: claim-on-write.mjs <CLAUDE_PLUGIN_DATA>
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findRoughdraftCli, readStdinJson, sessionFilePath } from "./lib.mjs";

const CLAIM_TIMEOUT_MS = 15_000;

async function main() {
  const dataDir = process.argv[2];
  const input = await readStdinJson();
  const filePath = input?.tool_input?.file_path;
  const sessionId =
    typeof input.session_id === "string" ? input.session_id.trim() : "";
  if (typeof filePath !== "string" || !/\.md$/i.test(filePath)) return;
  if (!sessionId || !dataDir) return;

  const cli = findRoughdraftCli();
  if (!cli) return;

  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const documentPath = path.resolve(cwd, filePath);
  await new Promise((resolve) => {
    const child = spawn(
      cli,
      [
        "claim",
        documentPath,
        "--session",
        sessionId,
        "--claims-file",
        sessionFilePath(dataDir, sessionId),
        "--no-start",
        "--quiet",
      ],
      { cwd: fs.existsSync(cwd) ? cwd : undefined, stdio: "ignore" },
    );
    const timer = setTimeout(() => child.kill(), CLAIM_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.on("error", done);
    child.on("exit", done);
  });
}

await main();
