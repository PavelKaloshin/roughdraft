import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ROUGHDRAFT_BIND_HOST,
  ROUGHDRAFT_LOOPBACK_HOSTS,
  ROUGHDRAFT_PUBLIC_HOST,
} from "./network.js";
import { findAvailablePort } from "./ports.js";

const DEFAULT_PORT = 3000;
const STATUS_PATH = "/api/status";
const STATUS_TIMEOUT_MS = 750;
const SERVER_WAIT_ATTEMPTS = 40;
const SERVER_WAIT_DELAY_MS = 150;
const PROCESS_WAIT_ATTEMPTS = 20;
const PROCESS_WAIT_DELAY_MS = 150;

export interface RoughdraftServerState {
  port: number;
  pid: number;
  startedAt: string;
  url: string;
}

interface StatusPayload {
  backend?: string;
  projectDir?: string;
  serverRoot?: string;
  port?: number;
}

interface DevFrontendState {
  apiPort: number | null;
  appPort: number;
  mode?: "full-dev" | "preview-web";
  repoRoot: string;
  startedAt: string;
  url: string;
}

export interface SpawnedServer {
  pid: number;
}

export interface CliDependencies {
  env: NodeJS.ProcessEnv;
  cwd: string;
  fetchImpl: typeof fetch;
  findAvailablePortImpl: typeof findAvailablePort;
  sleepImpl: (ms: number) => Promise<void>;
  spawnServerProcess: (options: {
    port: number;
    projectDir: string;
  }) => Promise<SpawnedServer> | SpawnedServer;
  isProcessRunning: (pid: number) => boolean;
  stopProcess: (pid: number) => Promise<void>;
  openUrl: (url: string) => OpenMode;
  log: (message: string) => void;
  error: (message: string) => void;
}

type OpenMode = "browser" | "chrome-app" | "disabled" | "none";

interface EnsureRunningResult {
  server: {
    port: number;
    url: string;
    tracked: boolean;
    pid: number | null;
    startedAt: string | null;
  };
  reused: boolean;
  portChanged: boolean;
}

interface ResolvedTargetPath {
  projectDir: string;
  openPath: string;
}

interface ReusableServer {
  port: number;
  url: string;
  tracked: boolean;
  pid: number | null;
  startedAt: string | null;
}

const currentServerRoot = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

function hasChromeAppMode() {
  if (process.platform !== "darwin") return false;
  return (
    spawnSync("open", ["-Ra", "Google Chrome"], { stdio: "ignore" }).status ===
    0
  );
}

function openDetached(command: string, args: string[]) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function defaultOpenUrl(url: string): OpenMode {
  if (process.env.ROUGHDRAFT_NO_OPEN === "1") {
    return "disabled";
  }

  if (hasChromeAppMode()) {
    openDetached("open", ["-na", "Google Chrome", "--args", `--app=${url}`]);
    return "chrome-app";
  }

  if (process.platform === "darwin") {
    openDetached("open", [url]);
    return "browser";
  }

  if (process.platform === "linux") {
    openDetached("xdg-open", [url]);
    return "browser";
  }

  if (process.platform === "win32") {
    openDetached("cmd", ["/c", "start", "", url]);
    return "browser";
  }

  return "none";
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function defaultStopProcess(pid: number): Promise<void> {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
    return;
  }

  for (let attempt = 0; attempt < PROCESS_WAIT_ATTEMPTS; attempt += 1) {
    if (!defaultIsProcessRunning(pid)) {
      return;
    }
    await sleep(PROCESS_WAIT_DELAY_MS);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
  }
}

function defaultSpawnServerProcess(options: {
  port: number;
  projectDir: string;
}): SpawnedServer {
  const serverEntryPath = fileURLToPath(new URL("./child.js", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      serverEntryPath,
      "--port",
      String(options.port),
      "--project-dir",
      options.projectDir,
    ],
    {
      cwd: options.projectDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    },
  );

  child.unref();

  if (!child.pid) {
    throw new Error("Failed to start Roughdraft in the background.");
  }

  return { pid: child.pid };
}

export function createCliDependencies(
  overrides: Partial<CliDependencies> = {},
): CliDependencies {
  return {
    env: overrides.env ?? process.env,
    cwd: overrides.cwd ?? process.cwd(),
    fetchImpl: overrides.fetchImpl ?? fetch,
    findAvailablePortImpl: overrides.findAvailablePortImpl ?? findAvailablePort,
    sleepImpl: overrides.sleepImpl ?? ((ms) => sleep(ms)),
    spawnServerProcess:
      overrides.spawnServerProcess ?? defaultSpawnServerProcess,
    isProcessRunning: overrides.isProcessRunning ?? defaultIsProcessRunning,
    stopProcess: overrides.stopProcess ?? defaultStopProcess,
    openUrl: overrides.openUrl ?? defaultOpenUrl,
    log: overrides.log ?? ((message) => console.log(message)),
    error: overrides.error ?? ((message) => console.error(message)),
  };
}

function printHelp(log: (message: string) => void) {
  log("Roughdraft is a local markdown review app for AI-assisted workflows.");
  log("");
  log("Usage:");
  log("  roughdraft start");
  log("  roughdraft open <path>");
  log("  roughdraft status");
  log("  roughdraft stop");
  log("  roughdraft help");
  log("  roughdraft help criticmarkup");
  log("");
  log("Start the local server once:");
  log("  roughdraft start");
  log("");
  log("Open a markdown file or folder:");
  log("  roughdraft open /absolute/path/to/file.md");
  log("  roughdraft open /absolute/path/to/folder");
  log("");
  log("Review loop:");
  log("  1. Open a file or folder in Roughdraft.");
  log("  2. Read, comment, and suggest edits with CriticMarkup.");
  log("  3. After review, continue by reading the markdown files from disk.");
  log("");
  log("CriticMarkup quick reference:");
  log("  {>>comment<<}  {++inserted++}  {--deleted--}");
  log("  {~~old~>new~~}  {==highlighted==}");
  log("");
  log("Use `roughdraft help criticmarkup` for examples.");
}

function printCriticMarkupHelp(log: (message: string) => void) {
  log("CriticMarkup reference:");
  log("  {>>comment<<}       Comment");
  log("  {++new text++}      Insertion");
  log("  {--old text--}      Deletion");
  log("  {~~old~>new~~}      Substitution");
  log("  {==text==}          Highlight");
  log("");
  log("Examples:");
  log("  The intro {~~is vague~>needs a tighter claim~~}.");
  log("  Add {>>one concrete example here<<} before the conclusion.");
  log("");
  log("Anchored comment with id:");
  log(
    "  Review {==this sentence==}{>>Needs a source<<}{@id:c1;by:user;at:2026-04-23T18:00:00.000Z@}.",
  );
  log("");
  log("Reply to an existing comment:");
  log(
    "  Review {==this sentence==}{>>Needs a source<<}{@id:c1;by:user;at:2026-04-23T18:00:00.000Z@}{>>I can add one from the intro.<<}{@id:c2;by:AI;at:2026-04-23T18:05:00.000Z;re:c1@}.",
  );
  log("");
  log("Reply guidance:");
  log("  Use explicit `id:` and `re:` metadata for replies.");
  log(
    "  Comment ids are document-local and usually look like `c1`, `c2`, `c3`.",
  );
}

function printInstallDeprecation(
  log: (message: string) => void,
  error: (message: string) => void,
) {
  error("`roughdraft install` has been removed.");
  log("Install Roughdraft with:");
  log("  npm i -g roughdraft");
  log("");
  log(
    "Roughdraft no longer edits `~/CLAUDE.md`, `~/AGENTS.md`, or other user-level agent files.",
  );
}

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

function buildPublicBaseUrl(port: number): string {
  return `http://${ROUGHDRAFT_PUBLIC_HOST}:${port}`;
}

function getDevFrontendStateFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicitFile = env.ROUGHDRAFT_DEV_FRONTEND_STATE_FILE?.trim();
  if (explicitFile) {
    return path.resolve(explicitFile);
  }

  return path.join(currentServerRoot, ".context", "dev-frontend.json");
}

function buildLoopbackUrl(host: string, port: number, pathname = "/"): URL {
  const baseHost = host.includes(":") ? `[${host}]` : host;
  return new URL(`http://${baseHost}:${port}${pathname}`);
}

function buildTargetUrl(baseUrl: string, openPath: string): string {
  const url = new URL(baseUrl);

  if (openPath.includes("\\")) {
    url.searchParams.set("path", openPath);
    return url.toString();
  }

  const normalizedPath = openPath.replace(/\\/g, "/");
  url.pathname = normalizedPath.startsWith("/")
    ? normalizedPath
    : `/${normalizedPath}`;
  return url.toString();
}

function resolveTargetPath(inputPath: string): ResolvedTargetPath {
  const resolvedPath = path.resolve(inputPath);
  const looksLikeMarkdownFile = resolvedPath.toLowerCase().endsWith(".md");

  try {
    const stat = fs.statSync(resolvedPath);
    if (stat.isDirectory()) {
      return { projectDir: resolvedPath, openPath: resolvedPath };
    }

    if (stat.isFile()) {
      if (!looksLikeMarkdownFile) {
        throw new Error(
          `Roughdraft can only open directories and .md files: ${resolvedPath}`,
        );
      }

      return {
        projectDir: path.dirname(resolvedPath),
        openPath: resolvedPath,
      };
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Roughdraft can only open")
    ) {
      throw error;
    }

    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      throw new Error(`Path not found: ${resolvedPath}`);
    }

    throw new Error(`Failed to read path: ${resolvedPath}`);
  }

  throw new Error(`Unsupported path: ${resolvedPath}`);
}

export function getServerStateFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicitFile = env.ROUGHDRAFT_STATE_FILE?.trim();
  if (explicitFile) {
    return path.resolve(explicitFile);
  }

  const explicitDir = env.ROUGHDRAFT_STATE_DIR?.trim();
  if (explicitDir) {
    return path.join(path.resolve(explicitDir), "server.json");
  }

  return path.join(os.homedir(), ".roughdraft", "server.json");
}

function isValidServerState(value: unknown): value is RoughdraftServerState {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<RoughdraftServerState>;
  return (
    typeof candidate.port === "number" &&
    Number.isFinite(candidate.port) &&
    typeof candidate.pid === "number" &&
    Number.isFinite(candidate.pid) &&
    typeof candidate.startedAt === "string" &&
    candidate.startedAt.length > 0 &&
    typeof candidate.url === "string" &&
    candidate.url.length > 0
  );
}

function isValidDevFrontendState(value: unknown): value is DevFrontendState {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<DevFrontendState>;
  return (
    (candidate.apiPort === null ||
      (typeof candidate.apiPort === "number" &&
        Number.isFinite(candidate.apiPort))) &&
    typeof candidate.appPort === "number" &&
    Number.isFinite(candidate.appPort) &&
    (candidate.mode === undefined ||
      candidate.mode === "full-dev" ||
      candidate.mode === "preview-web") &&
    typeof candidate.repoRoot === "string" &&
    candidate.repoRoot.length > 0 &&
    typeof candidate.startedAt === "string" &&
    candidate.startedAt.length > 0 &&
    typeof candidate.url === "string" &&
    candidate.url.length > 0
  );
}

function readServerStateFromDisk(
  stateFilePath: string,
): RoughdraftServerState | null {
  try {
    const raw = fs.readFileSync(stateFilePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isValidServerState(parsed)) {
      return parsed;
    }
  } catch {}

  if (fs.existsSync(stateFilePath)) {
    removeServerStateFile(stateFilePath);
  }

  return null;
}

function readDevFrontendStateFromDisk(
  stateFilePath: string,
): DevFrontendState | null {
  try {
    const raw = fs.readFileSync(stateFilePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isValidDevFrontendState(parsed)) {
      return parsed;
    }
  } catch {}

  return null;
}

function writeServerStateToDisk(
  stateFilePath: string,
  state: RoughdraftServerState,
) {
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`);
}

function removeServerStateFile(stateFilePath: string) {
  try {
    fs.rmSync(stateFilePath, { force: true });
  } catch {}
}

async function getStatusPayload(
  port: number,
  deps: CliDependencies,
): Promise<StatusPayload | null> {
  for (const host of [ROUGHDRAFT_BIND_HOST, ...ROUGHDRAFT_LOOPBACK_HOSTS]) {
    try {
      const response = await deps.fetchImpl(
        buildLoopbackUrl(host, port, STATUS_PATH),
        {
          signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
        },
      );

      if (!response.ok) {
        continue;
      }

      const payload = (await response.json()) as StatusPayload;
      if (payload.backend === "local-files") {
        return payload;
      }
    } catch {}
  }

  return null;
}

async function waitForServer(port: number, deps: CliDependencies) {
  for (let attempt = 0; attempt < SERVER_WAIT_ATTEMPTS; attempt += 1) {
    const payload = await getStatusPayload(port, deps);
    if (payload) {
      return payload;
    }
    await deps.sleepImpl(SERVER_WAIT_DELAY_MS);
  }

  throw new Error("Timed out waiting for Roughdraft to start.");
}

async function waitForServerToStop(
  port: number,
  deps: CliDependencies,
): Promise<boolean> {
  for (let attempt = 0; attempt < PROCESS_WAIT_ATTEMPTS; attempt += 1) {
    const payload = await getStatusPayload(port, deps);
    if (!payload) {
      return true;
    }

    await deps.sleepImpl(PROCESS_WAIT_DELAY_MS);
  }

  return false;
}

async function resolveLiveDevFrontendBaseUrl(
  deps: CliDependencies,
): Promise<string | null> {
  const state = readDevFrontendStateFromDisk(
    getDevFrontendStateFilePath(deps.env),
  );
  if (!state) {
    return null;
  }

  if (path.resolve(state.repoRoot) !== currentServerRoot) {
    return null;
  }

  try {
    const frontendUrl = new URL(state.url);
    const mode =
      state.mode ?? (state.apiPort === null ? "preview-web" : "full-dev");

    if (mode === "preview-web") {
      const response = await deps.fetchImpl(frontendUrl, {
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }
    } else {
      const statusUrl = new URL("/api/status", frontendUrl);
      const response = await deps.fetchImpl(statusUrl, {
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as StatusPayload;
      if (payload.backend !== "local-files") {
        return null;
      }

      if (
        !payload.serverRoot ||
        path.resolve(payload.serverRoot) !== currentServerRoot
      ) {
        return null;
      }

      if (
        typeof payload.port === "number" &&
        state.apiPort !== null &&
        payload.port !== state.apiPort
      ) {
        return null;
      }
    }

    frontendUrl.pathname = "/";
    frontendUrl.search = "";
    frontendUrl.hash = "";
    return frontendUrl.toString();
  } catch {
    return null;
  }
}

async function normalizeTrackedState(
  persistedState: RoughdraftServerState,
  stateFilePath: string,
): Promise<RoughdraftServerState> {
  const normalizedState = {
    ...persistedState,
    url: buildPublicBaseUrl(persistedState.port),
  };

  if (normalizedState.url !== persistedState.url) {
    writeServerStateToDisk(stateFilePath, normalizedState);
  }

  return normalizedState;
}

async function findReusableServer(
  deps: CliDependencies,
  options: { serverRoot?: string } = {},
): Promise<ReusableServer | null> {
  const stateFilePath = getServerStateFilePath(deps.env);
  const persistedState = readServerStateFromDisk(stateFilePath);
  const preferredPort = parsePort(deps.env.PORT);
  const expectedServerRoot = path.resolve(
    options.serverRoot ?? currentServerRoot,
  );

  const matchesServerRoot = (payload: StatusPayload | null) =>
    payload?.serverRoot
      ? path.resolve(payload.serverRoot) === expectedServerRoot
      : false;

  if (persistedState) {
    const pidRunning = deps.isProcessRunning(persistedState.pid);
    const statusPayload = await getStatusPayload(persistedState.port, deps);

    if (pidRunning && statusPayload && matchesServerRoot(statusPayload)) {
      const normalizedState = await normalizeTrackedState(
        persistedState,
        stateFilePath,
      );
      return {
        port: normalizedState.port,
        url: normalizedState.url,
        tracked: true,
        pid: normalizedState.pid,
        startedAt: normalizedState.startedAt,
      };
    }

    removeServerStateFile(stateFilePath);

    if (statusPayload && matchesServerRoot(statusPayload)) {
      return {
        port: persistedState.port,
        url: buildPublicBaseUrl(persistedState.port),
        tracked: false,
        pid: null,
        startedAt: null,
      };
    }
  }

  const preferredStatus = await getStatusPayload(preferredPort, deps);
  if (!preferredStatus || !matchesServerRoot(preferredStatus)) {
    return null;
  }

  return {
    port: preferredPort,
    url: buildPublicBaseUrl(preferredPort),
    tracked: false,
    pid: null,
    startedAt: null,
  };
}

export async function readRunningServerState(
  deps: CliDependencies,
): Promise<RoughdraftServerState | null> {
  const reusableServer = await findReusableServer(deps, {
    serverRoot: currentServerRoot,
  });
  if (
    !reusableServer?.tracked ||
    reusableServer.pid === null ||
    reusableServer.startedAt === null
  ) {
    return null;
  }

  return {
    port: reusableServer.port,
    pid: reusableServer.pid,
    startedAt: reusableServer.startedAt,
    url: reusableServer.url,
  };
}

export async function ensureServerRunning(
  deps: CliDependencies,
  options: { projectDir?: string } = {},
): Promise<EnsureRunningResult> {
  const reusableServer = await findReusableServer(deps, {
    serverRoot: currentServerRoot,
  });
  if (reusableServer) {
    return { server: reusableServer, reused: true, portChanged: false };
  }

  const preferredPort = parsePort(deps.env.PORT);
  const port = await deps.findAvailablePortImpl(preferredPort);
  const projectDir = path.resolve(options.projectDir ?? deps.cwd);
  const spawned = await deps.spawnServerProcess({
    port,
    projectDir,
  });

  try {
    await waitForServer(port, deps);
  } catch (error) {
    await deps.stopProcess(spawned.pid);
    throw error;
  }

  const state: RoughdraftServerState = {
    port,
    pid: spawned.pid,
    startedAt: new Date().toISOString(),
    url: buildPublicBaseUrl(port),
  };
  writeServerStateToDisk(getServerStateFilePath(deps.env), state);

  return {
    server: {
      port: state.port,
      url: state.url,
      tracked: true,
      pid: state.pid,
      startedAt: state.startedAt,
    },
    reused: false,
    portChanged: port !== preferredPort,
  };
}

export async function runCli(
  args: string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const deps = createCliDependencies(overrides);
  const [command, ...rest] = args;

  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    if (rest[0] === "criticmarkup") {
      printCriticMarkupHelp(deps.log);
      return 0;
    }

    printHelp(deps.log);
    return 0;
  }

  if (command === "criticmarkup") {
    printCriticMarkupHelp(deps.log);
    return 0;
  }

  if (command === "install") {
    printInstallDeprecation(deps.log, deps.error);
    return 1;
  }

  if (command === "start") {
    const result = await ensureServerRunning(deps);
    if (result.reused) {
      if (result.server.tracked) {
        deps.log(`Roughdraft is already running at ${result.server.url}`);
      } else {
        deps.log(
          `Roughdraft is already running at ${result.server.url}, but it is not managed by ${getServerStateFilePath(deps.env)}.`,
        );
      }
      return 0;
    }

    if (result.portChanged) {
      deps.log(
        `Preferred port ${parsePort(deps.env.PORT)} is busy, using ${result.server.port}.`,
      );
    }

    deps.log(`Roughdraft running at ${result.server.url}`);
    return 0;
  }

  if (command === "status") {
    const server = await findReusableServer(deps);
    if (!server) {
      deps.log("Roughdraft is not running. Start it with `roughdraft start`.");
      return 1;
    }

    deps.log(`Roughdraft is running at ${server.url}`);
    if (server.tracked && server.pid !== null && server.startedAt !== null) {
      deps.log(`PID: ${server.pid}`);
      deps.log(`Started: ${server.startedAt}`);
      deps.log(`State file: ${getServerStateFilePath(deps.env)}`);
    } else {
      deps.log(
        `This server is not managed by ${getServerStateFilePath(deps.env)}.`,
      );
    }
    return 0;
  }

  if (command === "stop") {
    const stateFilePath = getServerStateFilePath(deps.env);
    const persistedState = readServerStateFromDisk(stateFilePath);

    if (!persistedState) {
      const preferredPort = parsePort(deps.env.PORT);
      const unmanagedServer = await getStatusPayload(preferredPort, deps);
      if (unmanagedServer) {
        deps.error(
          `Roughdraft is still running at ${buildPublicBaseUrl(preferredPort)}, but it is not managed by ${stateFilePath}. Stop it manually.`,
        );
        return 1;
      }

      deps.log("Roughdraft is not running.");
      return 0;
    }

    if (deps.isProcessRunning(persistedState.pid)) {
      await deps.stopProcess(persistedState.pid);
    }

    const trackedPidStillRunning = deps.isProcessRunning(persistedState.pid);
    const portIsQuiet = await waitForServerToStop(persistedState.port, deps);

    if (trackedPidStillRunning) {
      deps.error(`Failed to stop Roughdraft process ${persistedState.pid}.`);
      writeServerStateToDisk(stateFilePath, {
        ...persistedState,
        url: buildPublicBaseUrl(persistedState.port),
      });
      return 1;
    }

    removeServerStateFile(stateFilePath);
    if (!portIsQuiet) {
      deps.error(
        `Stopped tracked Roughdraft process ${persistedState.pid}, but another Roughdraft instance is still running at ${buildPublicBaseUrl(persistedState.port)}.`,
      );
      return 1;
    }

    deps.log(
      `Stopped Roughdraft at ${buildPublicBaseUrl(persistedState.port)}.`,
    );
    return 0;
  }

  if (command === "open") {
    const target = rest[0];
    if (!target) {
      deps.error("Usage: roughdraft open <path>");
      return 1;
    }

    let resolvedTarget: ResolvedTargetPath;
    try {
      resolvedTarget = resolveTargetPath(target);
    } catch (error) {
      deps.error(error instanceof Error ? error.message : "Invalid path.");
      return 1;
    }

    const { projectDir, openPath } = resolvedTarget;
    const liveDevFrontendUrl = await resolveLiveDevFrontendBaseUrl(deps);
    let result: EnsureRunningResult | null = null;
    let baseUrl: string;

    if (liveDevFrontendUrl) {
      baseUrl = liveDevFrontendUrl;
    } else {
      result = await ensureServerRunning(deps, { projectDir });
      baseUrl = buildPublicBaseUrl(result.server.port);
    }

    const targetUrl = buildTargetUrl(baseUrl, openPath);
    const openMode = deps.openUrl(targetUrl);

    if (result?.portChanged) {
      deps.log(
        `Preferred port ${parsePort(deps.env.PORT)} is busy, using ${result.server.port}.`,
      );
    }

    if (openMode === "chrome-app") {
      deps.log(`Opened Roughdraft in a Chrome app window: ${targetUrl}`);
      return 0;
    }

    if (openMode === "browser") {
      deps.log(`Opened Roughdraft in the default browser: ${targetUrl}`);
      return 0;
    }

    deps.log(`Roughdraft is running at ${targetUrl}`);
    return 0;
  }

  return runCli(["open", command, ...rest], overrides);
}
