import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const devFrontendStatePath = path.join(
  repoRoot,
  ".context",
  "dev-frontend.json",
);

export function writeDevFrontendState({
  apiPort = null,
  appPort,
  mode,
  url = `http://localhost:${appPort}`,
}) {
  fs.mkdirSync(path.dirname(devFrontendStatePath), { recursive: true });
  fs.writeFileSync(
    devFrontendStatePath,
    `${JSON.stringify(
      {
        apiPort,
        appPort,
        mode,
        repoRoot,
        startedAt: new Date().toISOString(),
        url,
      },
      null,
      2,
    )}\n`,
  );
}

export function removeDevFrontendState() {
  try {
    fs.rmSync(devFrontendStatePath, { force: true });
  } catch {}
}

export function getDevFrontendStatePath() {
  return devFrontendStatePath;
}
