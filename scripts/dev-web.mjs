import { spawn } from "node:child_process";
import {
  removeDevFrontendState,
  writeDevFrontendState,
} from "./dev-frontend-state.mjs";
import { findAvailableLoopbackPort } from "./find-available-loopback-port.mjs";

function spawnPnpm(args, extraEnv = {}) {
  return spawn("pnpm", args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
}

const appPort = await findAvailableLoopbackPort(
  parseInt(process.env.APP_PORT || "3000", 10),
);

console.log(`Using app port ${appPort}.`);
console.log(`Open Roughdraft web preview at http://localhost:${appPort}`);
console.log(
  `Open files directly with http://localhost:${appPort}/absolute/path/to/file.md`,
);
console.log("This preview uses local storage and does not read local files.");

writeDevFrontendState({ appPort, mode: "preview-web" });

const app = spawnPnpm(
  [
    "--filter",
    "@roughdraft/app",
    "exec",
    "vite",
    "--host",
    "localhost",
    "--port",
    String(appPort),
    "--strictPort",
  ],
  {
    VITE_PREVIEW_WEB: "1",
  },
);

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  removeDevFrontendState();

  if (signal) {
    console.log(`\nStopping web preview (${signal}).`);
  }

  app.kill("SIGTERM");
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

app.on("exit", (code) => {
  removeDevFrontendState();
  if (!shuttingDown) {
    process.exit(code ?? 0);
  }
});
