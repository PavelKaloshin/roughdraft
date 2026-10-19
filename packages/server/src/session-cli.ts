import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type AgentCliIo,
  type AgentCliTarget,
  cliCommandName,
  formatListenDoneLine,
  formatListenEventLine,
  type ListenObserver,
  shellQuote,
} from "./agent-cli.js";
import {
  DEFAULT_MAX_CONCURRENT_FORKS,
  ForkScheduler,
  fetchThreadStatus,
  runAnswerFork,
} from "./fork-responder.js";
import type { CommentEvent, ReviewEvent } from "./review-events.js";
import type { OwnershipNotice, SessionSummary } from "./session-ownership.js";
import { roundTimeoutSignal } from "./watch-rounds.js";

/**
 * `roughdraft listen --session | claim | sessions` (ADR 0007). The Claude
 * Code plugin runs `listen --session` as a monitor for the whole session and
 * `claim` from a PostToolUse hook; every stdout line of `listen` wakes the
 * session, so `--quiet` prints only events and ownership changes.
 */

const SESSION_ROUND_SECONDS = 50;
const SESSION_BATCH_WINDOW_SECONDS = 0.1;
const RETRY_MIN_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 5_000;
const CLAIM_TIMEOUT_MS = 5_000;

/** Resolves the server to talk to, or null when none is running. */
export type ServerLocator = () => Promise<string | null>;

// --- claims file ------------------------------------------------------------

/**
 * `${CLAUDE_PLUGIN_DATA}/sessions/<session>.json`, kept by the plugin so a
 * session's claims survive a server restart (the server keeps none on disk).
 */
export interface SessionFile {
  sessionId?: string;
  title?: string;
  cwd?: string;
  claims: string[];
}

export function readSessionFile(file: string): SessionFile {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) {
      return { claims: parsed.filter((item) => typeof item === "string") };
    }
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const claims = Array.isArray(record.claims)
        ? record.claims.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      return {
        ...(typeof record.sessionId === "string"
          ? { sessionId: record.sessionId }
          : {}),
        ...(typeof record.title === "string" ? { title: record.title } : {}),
        ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
        claims,
      };
    }
  } catch {
    // Missing or unreadable: no claims yet.
  }
  return { claims: [] };
}

/** Read-modify-write of the claims list, keeping every other key. */
export function updateSessionClaims(
  file: string,
  update: (claims: string[]) => string[],
): string[] {
  let record: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      record = parsed as Record<string, unknown>;
    }
  } catch {}
  const current = readSessionFile(file).claims;
  const next = [...new Set(update(current))];
  record.claims = next;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(temp, file);
  return next;
}

// --- lines --------------------------------------------------------------------

export function formatClaimedLine(documentPath: string): string {
  return `[roughdraft] claimed ${shellQuote(documentPath)} → Ask/Change comments on it now come to this session; no action needed`;
}

export function formatReleasedLine(documentPath: string): string {
  return `[roughdraft] released ${shellQuote(documentPath)}: reassigned to another session → stop handling its comments; the other session answers them now`;
}

/** The per-file line, with `file=` right after the thread id. */
export function formatSessionEventLine(
  event: ReviewEvent,
  cliName: string,
): string {
  if (event.type === "review.completed") {
    return formatListenDoneLine(event, { documentPath: event.documentPath });
  }
  const line = formatListenEventLine(event, {
    cliName,
    documentPath: event.documentPath,
  });
  return line.replace(
    /^(\[roughdraft\] \S+ \S+)/,
    `$1 file=${shellQuote(event.documentPath)}`,
  );
}

// --- listen --session ---------------------------------------------------------

interface SessionListenPayload {
  events: ReviewEvent[];
  notices: OwnershipNotice[];
  noticeCursor: number;
  documents: string[];
  rejectedClaims?: Array<{ documentPath: string; owner: string }>;
  nextSequence: number;
  latestSequence?: number;
  instanceId?: string;
}

class FatalSessionError extends Error {}

export async function runSessionListen(
  io: AgentCliIo,
  locateServer: ServerLocator,
  options: {
    sessionId: string;
    claimsFile?: string;
    title?: string;
    cwd: string;
    maxSeconds: number;
    quiet: boolean;
    roundSeconds?: number;
    /** Sees every comment event printed (`--fork-asks-after`). */
    observer?: ListenObserver;
  },
): Promise<number> {
  const now = io.now ?? Date.now;
  const cli = cliCommandName(io.env);
  const deadline = now() + options.maxSeconds * 1000;
  const roundLimit = options.roundSeconds ?? SESSION_ROUND_SECONDS;
  const listenerId = crypto.randomUUID();
  const sessionFile = options.claimsFile
    ? readSessionFile(options.claimsFile)
    : null;
  const title = options.title ?? sessionFile?.title;

  let serverUrl: string | null = null;
  let instanceId: string | null = null;
  let cursor = 0;
  let noticeCursor = 0;
  // Claims go with the first round of every connection (and after a
  // server restart), so ownership survives the server's lifetime.
  let sendClaims = true;
  let announced = false;
  let retryDelay = RETRY_MIN_DELAY_MS;

  const poll = async (
    url: string,
    timeoutSeconds: number,
  ): Promise<SessionListenPayload> => {
    const claims =
      sendClaims && options.claimsFile
        ? readSessionFile(options.claimsFile).claims
        : undefined;
    const response = await io.fetchImpl(new URL("/api/sessions/listen", url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: options.sessionId,
        listenerId,
        ...(title ? { title } : {}),
        cwd: options.cwd,
        ...(claims ? { claims } : {}),
        afterSequence: cursor,
        afterNotice: noticeCursor,
        ...(instanceId ? { instanceId } : {}),
        timeoutSeconds,
        batchWindowSeconds: SESSION_BATCH_WINDOW_SECONDS,
      }),
      signal: roundTimeoutSignal(timeoutSeconds, 10),
    });
    if (response.status === 404) {
      // An older server without session routes: nothing to listen to.
      throw new FatalSessionError(
        "the running Roughdraft server does not support session listening; restart it with `roughdraft stop && roughdraft start`",
      );
    }
    if (!response.ok) {
      throw new Error(`listen failed with HTTP ${response.status}`);
    }
    return (await response.json()) as SessionListenPayload;
  };

  const sleepUntilRetry = async () => {
    await io.sleepImpl(Math.min(retryDelay, Math.max(0, deadline - now())));
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_DELAY_MS);
  };

  while (now() < deadline || !announced) {
    if (!serverUrl) {
      serverUrl = await locateServer().catch(() => null);
      if (!serverUrl) {
        if (now() >= deadline) break;
        await sleepUntilRetry();
        continue;
      }
      sendClaims = true;
    }

    const remainingSeconds = Math.max(0, (deadline - now()) / 1000);
    const roundSeconds = announced ? Math.min(remainingSeconds, roundLimit) : 0;

    let payload: SessionListenPayload;
    try {
      payload = await poll(serverUrl, roundSeconds);
      retryDelay = RETRY_MIN_DELAY_MS;
    } catch (error) {
      if (error instanceof FatalSessionError) {
        if (!options.quiet)
          io.log(`[roughdraft] listen stopped: ${error.message}`);
        await options.observer?.close();
        return 1;
      }
      // The server went away or restarted (maybe on another port).
      serverUrl = null;
      if (now() >= deadline) break;
      await sleepUntilRetry();
      continue;
    }

    sendClaims = false;
    if (
      instanceId !== null &&
      payload.instanceId !== undefined &&
      payload.instanceId !== instanceId
    ) {
      // A new server process: sequences start over, re-send the claims.
      cursor = 0;
      noticeCursor = 0;
      sendClaims = true;
    }
    instanceId = payload.instanceId ?? instanceId;

    if (!announced) {
      announced = true;
      if (!options.quiet) {
        const count = payload.documents.length;
        io.log(
          `[roughdraft] listening for session ${options.sessionId} (${count} ${count === 1 ? "file" : "files"})`,
        );
      }
    }

    if (options.claimsFile && payload.rejectedClaims?.length) {
      const rejected = new Set(
        payload.rejectedClaims.map((claim) => claim.documentPath),
      );
      updateSessionClaims(options.claimsFile, (claims) =>
        claims.filter((claim) => !rejected.has(claim)),
      );
    }

    for (const notice of payload.notices) {
      if (notice.type === "claimed") {
        if (options.claimsFile) {
          updateSessionClaims(options.claimsFile, (claims) => [
            ...claims,
            notice.documentPath,
          ]);
        }
        io.log(formatClaimedLine(notice.documentPath));
      } else {
        if (options.claimsFile) {
          updateSessionClaims(options.claimsFile, (claims) =>
            claims.filter((claim) => claim !== notice.documentPath),
          );
        }
        io.log(formatReleasedLine(notice.documentPath));
      }
    }
    // The server's cursor is authoritative (it starts over with the process).
    noticeCursor = payload.noticeCursor;

    for (const event of payload.events) {
      cursor = Math.max(cursor, event.sequence);
      // With `--quiet --fork-asks-after 0` the fork observer takes Asks
      // over: their lines reach the session only if no fork answers them.
      if (
        event.type !== "review.completed" &&
        options.observer?.observe(event) === true
      ) {
        continue;
      }
      io.log(formatSessionEventLine(event, cli));
    }
    cursor = Math.max(cursor, payload.nextSequence - 1);
  }

  await options.observer?.close();
  if (!options.quiet) {
    io.log(
      `[roughdraft] listen expired; re-arm with: ${cli} listen --session ${shellQuote(options.sessionId)}`,
    );
  }
  return 0;
}

/**
 * `listen --session --fork-asks-after`: one fork scheduler per document
 * (thread ids are only unique within a file), talking to whichever server
 * the listener currently uses.
 */
export class SessionForkObserver implements ListenObserver {
  private readonly schedulers = new Map<string, ForkScheduler>();

  constructor(
    private readonly options: {
      io: AgentCliIo;
      sessionId: string;
      cwd: string;
      afterSeconds: number;
      /**
       * `listen --quiet`: print only what the session must act on. With
       * `afterSeconds` 0 an Ask goes straight to a fork and its line is
       * printed only if the fork cannot answer it.
       */
      quiet?: boolean;
      claudePath?: string;
      serverUrl: () => string | null;
      /** Test hook: replaces `runAnswerFork`. */
      runFork?: ConstructorParameters<typeof ForkScheduler>[0]["runFork"];
    },
  ) {}

  observe(event: CommentEvent): boolean {
    return this.scheduler(event.documentPath).observe(event);
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.schedulers.values()].map((scheduler) => scheduler.close()),
    );
  }

  private scheduler(documentPath: string): ForkScheduler {
    let scheduler = this.schedulers.get(documentPath);
    if (scheduler) return scheduler;
    const { io, serverUrl } = this.options;
    const target: AgentCliTarget = {
      get serverUrl() {
        return serverUrl() ?? "http://127.0.0.1:0";
      },
      projectDir: path.dirname(documentPath),
      documentPath,
    };
    const cli = cliCommandName(io.env);
    const quiet = this.options.quiet === true;
    scheduler = new ForkScheduler({
      afterMs: this.options.afterSeconds * 1000,
      maxConcurrent: DEFAULT_MAX_CONCURRENT_FORKS,
      takeOverAsks: quiet && this.options.afterSeconds === 0,
      announceForks: !quiet,
      threadStatus: (threadRootId) =>
        fetchThreadStatus(io, target, threadRootId),
      runFork:
        this.options.runFork ??
        ((event, started) =>
          runAnswerFork(io, target, {
            commentId: event.commentId,
            sessionId: this.options.sessionId,
            cwd: this.options.cwd,
            claudePath: this.options.claudePath,
            onStarted: started,
            ...(quiet
              ? {}
              : {
                  onRetry: (reason: string) =>
                    io.log(
                      `[roughdraft] headless fork for ${event.threadRootId} failed (${reason}); retrying with the session model`,
                    ),
                }),
          })),
      log: io.log,
      formatEventLine: (event) => formatSessionEventLine(event, cli),
    });
    this.schedulers.set(documentPath, scheduler);
    return scheduler;
  }
}

// --- claim --------------------------------------------------------------------

export async function runClaim(
  io: AgentCliIo,
  serverUrl: string | null,
  options: {
    sessionId: string;
    documentPath: string;
    force: boolean;
    claimsFile?: string;
    title?: string;
    cwd: string;
    json: boolean;
    quiet: boolean;
  },
): Promise<number> {
  const file = shellQuote(options.documentPath);
  const say = (line: string) => {
    if (!options.quiet) io.log(line);
  };

  if (!serverUrl) {
    if (options.claimsFile) {
      updateSessionClaims(options.claimsFile, (claims) => [
        ...claims,
        options.documentPath,
      ]);
    }
    if (options.json) {
      io.log(
        JSON.stringify(
          { running: false, recorded: Boolean(options.claimsFile) },
          null,
          2,
        ),
      );
      return 0;
    }
    say(
      options.claimsFile
        ? `[roughdraft] Roughdraft is not running; ${file} is claimed for session ${options.sessionId} when its listener connects`
        : "[roughdraft] Roughdraft is not running; nothing claimed",
    );
    return 0;
  }

  let response: Response;
  try {
    response = await io.fetchImpl(new URL("/api/sessions/claim", serverUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: options.sessionId,
        documentPath: options.documentPath,
        force: options.force,
        ...(options.title ? { title: options.title } : {}),
        cwd: options.cwd,
      }),
      signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
    });
  } catch (error) {
    io.error(
      `Failed to claim ${options.documentPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  const payload = (await response.json().catch(() => ({}))) as {
    claimed?: boolean;
    owner?: { sessionId?: string } | null;
    previousOwner?: string;
    error?: string;
  };
  if (!response.ok) {
    io.error(
      `Failed to claim ${options.documentPath}: ${payload.error ?? `HTTP ${response.status}`}`,
    );
    return 1;
  }

  if (payload.claimed && options.claimsFile) {
    updateSessionClaims(options.claimsFile, (claims) => [
      ...claims,
      options.documentPath,
    ]);
  }
  if (options.json) {
    io.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  if (payload.claimed) {
    const was =
      payload.previousOwner && payload.previousOwner !== options.sessionId
        ? ` (was ${payload.previousOwner})`
        : "";
    say(`[roughdraft] claimed ${file} for session ${options.sessionId}${was}`);
  } else {
    say(
      `[roughdraft] ${file} stays with live session ${payload.owner?.sessionId ?? "another session"}; pass --force to take it over`,
    );
  }
  return 0;
}

/**
 * Best effort: `roughdraft open` from inside a Claude Code session claims
 * the file for that session (automatic claim, never from a live owner).
 */
export async function claimForCallingSession(
  io: Pick<AgentCliIo, "env" | "fetchImpl">,
  serverUrl: string,
  documentPath: string,
): Promise<void> {
  const sessionId = io.env.CLAUDE_CODE_SESSION_ID?.trim();
  if (!sessionId || !documentPath.toLowerCase().endsWith(".md")) return;
  try {
    await io.fetchImpl(new URL("/api/sessions/claim", serverUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, documentPath }),
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // An older server, or none reachable: opening still works.
  }
}

// --- sessions -----------------------------------------------------------------

function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

export async function runSessions(
  io: AgentCliIo,
  serverUrl: string | null,
  options: { json: boolean },
): Promise<number> {
  if (!serverUrl) {
    if (options.json) {
      io.log(JSON.stringify({ running: false, sessions: [] }, null, 2));
    } else {
      io.log("Roughdraft is not running.");
    }
    return 0;
  }
  let sessions: SessionSummary[];
  try {
    const response = await io.fetchImpl(new URL("/api/sessions", serverUrl), {
      signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    sessions =
      ((await response.json()) as { sessions?: SessionSummary[] }).sessions ??
      [];
  } catch (error) {
    io.error(
      `Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  if (options.json) {
    io.log(JSON.stringify({ running: true, sessions }, null, 2));
    return 0;
  }
  if (sessions.length === 0) {
    io.log(
      "No live Claude Code sessions. Install the plugin: roughdraft setup claude",
    );
    return 0;
  }
  const now = (io.now ?? Date.now)();
  for (const session of sessions) {
    io.log(
      [
        session.sessionId,
        session.title ?? "-",
        session.cwd ?? "-",
        `active ${ago(session.lastActiveAt, now)} ago`,
      ].join("  "),
    );
    for (const document of session.documents) io.log(`  ${document}`);
  }
  return 0;
}

// --- setup claude -------------------------------------------------------------

export const CLAUDE_PLUGIN_MARKETPLACE = "roughdraft";
export const CLAUDE_PLUGIN_ID = `roughdraft@${CLAUDE_PLUGIN_MARKETPLACE}`;

export function claudeSetupCommands(pluginDir: string): string[][] {
  return [
    ["claude", "plugin", "marketplace", "add", pluginDir],
    ["claude", "plugin", "install", CLAUDE_PLUGIN_ID],
  ];
}

export async function runSetupClaude(
  io: AgentCliIo,
  options: {
    pluginDir: string;
    install: boolean;
    runCommand: (argv: string[]) => number;
  },
): Promise<number> {
  const commands = claudeSetupCommands(options.pluginDir);
  if (!fs.existsSync(path.join(options.pluginDir, ".claude-plugin"))) {
    io.error(`Claude Code plugin not found at ${options.pluginDir}`);
    return 1;
  }
  if (!options.install) {
    io.log(
      "Install the Roughdraft plugin for Claude Code once (user scope, every project):",
    );
    io.log("");
    for (const argv of commands) io.log(`  ${argv.map(shellQuote).join(" ")}`);
    io.log("");
    io.log(
      "Every interactive Claude Code session then claims the Markdown files it writes",
    );
    io.log(
      "and receives their Ask/Change comments automatically. Run with --install to do it now.",
    );
    return 0;
  }
  for (const argv of commands) {
    io.log(`$ ${argv.map(shellQuote).join(" ")}`);
    const code = options.runCommand(argv);
    if (code !== 0) {
      io.error(
        `Command failed with exit code ${code}. Is Claude Code installed (\`claude --version\`)?`,
      );
      return code;
    }
  }
  io.log(
    "Installed. New Claude Code sessions pick it up; restart running sessions.",
  );
  return 0;
}

// --- help ---------------------------------------------------------------------

export function printSessionCommandHelp(
  command: SessionCommand,
  log: (message: string) => void,
): void {
  if (command === "listen") {
    log("");
    log("Session mode (ADR 0007; run by the Claude Code plugin):");
    log(`  ${SESSION_COMMAND_USAGE.listenSession.replace("Usage: ", "")}`);
    log("");
    log(
      "Listens for every Markdown file the session owns, across projects. Lines carry",
    );
    log(
      "file=<path>, plus one line when a file is claimed for or released from the session:",
    );
    log("  [roughdraft] ask c3 file=<file> seq=12 → <command to run> | ...");
    log("  [roughdraft] claimed <file> → ...");
    log("  [roughdraft] released <file>: reassigned to another session → ...");
    log("");
    log(
      "  --session <id>           Claude Code session id (CLAUDE_CODE_SESSION_ID)",
    );
    log(
      "  --claims-file <path>     JSON file with the session's claims; re-sent on every",
    );
    log(
      "                           (re)connect and kept in sync with claimed/released lines",
    );
    log("  --title <text>           Session name shown in Roughdraft");
    log("  --quiet                  Print only events and ownership changes");
    log(
      "  --fork-asks-after <s>    Answer an Ask still queued after <s> seconds from a",
    );
    log(
      "                           headless fork of the session; with --quiet and 0 an Ask",
    );
    log(
      "                           is printed only if the fork cannot answer it",
    );
    log(
      "  --no-start               Never start a server; wait for one to appear",
    );
    return;
  }
  if (command === "claim") {
    log("Usage:");
    log(`  ${SESSION_COMMAND_USAGE.claim.replace("Usage: ", "")}`);
    log("");
    log(
      "Makes a Claude Code session the one that receives this file's Ask/Change comments.",
    );
    log(
      "Without --force it only claims a file that no live session owns. With --force it",
    );
    log("takes the file over and the previous session is told.");
    log("");
    log("Flags:");
    log(
      "  --session <id>           Session id, default CLAUDE_CODE_SESSION_ID",
    );
    log("  --force                  Take the file from a live session");
    log(
      "  --claims-file <path>     Also record the claim there (the plugin's session file)",
    );
    log(
      "  --no-start               Do not start a server; with --claims-file the claim is",
    );
    log(
      "                           applied when the session's listener connects",
    );
    log("  --quiet                  Print nothing");
    log("  --json                   Print the server response");
    return;
  }
  if (command === "sessions") {
    log("Usage:");
    log("  roughdraft sessions [--json]");
    log("");
    log(
      "Lists live Claude Code sessions (id, name, folder, last activity) and the files",
    );
    log("each one owns. Does not start a server.");
    return;
  }
  log("Usage:");
  log("  roughdraft setup claude [--install]");
  log("");
  log(
    "Prints (or, with --install, runs) the commands that install the Roughdraft",
  );
  log(
    "plugin for Claude Code at user scope: every interactive session then claims the",
  );
  log(
    "Markdown files it writes and receives their Ask/Change comments automatically.",
  );
}

// --- argument parsing and dispatch --------------------------------------------

export const SESSION_COMMAND_USAGE = {
  listenSession:
    "Usage: roughdraft listen --session <id> [--claims-file <path>] [--title <text>] [--quiet] [--no-start] [--max-seconds <seconds>]",
  claim:
    "Usage: roughdraft claim <file.md> [--session <id>] [--force] [--claims-file <path>] [--no-start] [--quiet] [--json]",
  sessions: "Usage: roughdraft sessions [--json]",
  setup: "Usage: roughdraft setup claude [--install]",
} as const;

interface SessionArgs {
  positionals: string[];
  help: boolean;
  json: boolean;
  force: boolean;
  quiet: boolean;
  noStart: boolean;
  install: boolean;
  session?: string;
  claimsFile?: string;
  title?: string;
  maxSeconds?: number;
  forkAsksAfter?: number;
  claude?: string;
  stateDir?: string;
  stateFile?: string;
}

type SessionStringFlag =
  | "session"
  | "claimsFile"
  | "title"
  | "claude"
  | "stateDir"
  | "stateFile";
type SessionNumberFlag = "maxSeconds" | "forkAsksAfter";
type SessionBooleanFlag =
  | "help"
  | "json"
  | "force"
  | "quiet"
  | "noStart"
  | "install";

const SESSION_VALUE_FLAGS: Record<
  string,
  SessionStringFlag | SessionNumberFlag
> = {
  "--session": "session",
  "--claims-file": "claimsFile",
  "--title": "title",
  "--max-seconds": "maxSeconds",
  "--fork-asks-after": "forkAsksAfter",
  "--claude": "claude",
  "--state-dir": "stateDir",
  "--state-file": "stateFile",
};

const SESSION_BOOLEAN_FLAGS: Record<string, SessionBooleanFlag> = {
  "--json": "json",
  "--force": "force",
  "--quiet": "quiet",
  "--no-start": "noStart",
  "--install": "install",
  "-h": "help",
  "--help": "help",
};

export function parseSessionArgs(args: string[]): SessionArgs {
  const parsed: SessionArgs = {
    positionals: [],
    help: false,
    json: false,
    force: false,
    quiet: false,
    noStart: false,
    install: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const booleanKey = SESSION_BOOLEAN_FLAGS[arg];
    if (booleanKey) {
      parsed[booleanKey] = true;
      continue;
    }
    const [flag = "", inline] = arg.startsWith("--")
      ? (arg.split(/=(.*)/s, 2) as [string, string | undefined])
      : [arg, undefined];
    const valueKey = SESSION_VALUE_FLAGS[flag];
    if (valueKey) {
      const value = inline ?? args[index + 1];
      if (value === undefined) throw new Error(`${flag} requires a value.`);
      if (inline === undefined) index += 1;
      if (valueKey === "maxSeconds" || valueKey === "forkAsksAfter") {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0 || value.trim() === "") {
          throw new Error(`${flag} must be a non-negative number.`);
        }
        parsed[valueKey] = number;
      } else {
        parsed[valueKey] = value;
      }
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    parsed.positionals.push(arg);
  }
  return parsed;
}

/** `listen --session …` is the session listener; `listen <file>` is not. */
export function isSessionListenArgs(args: string[]): boolean {
  let hasSession = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") return false;
    if (arg.startsWith("--session")) hasSession = true;
    if (arg.startsWith("-")) {
      // Skip a flag's separate value (`--session id`, `--since 3`, …).
      if (!arg.includes("=") && LISTEN_VALUE_FLAGS.has(arg)) index += 1;
      continue;
    }
    // `listen <file> --session <id>`: a per-file listener for that session.
    return false;
  }
  return hasSession;
}

const LISTEN_VALUE_FLAGS = new Set([
  ...Object.keys(SESSION_VALUE_FLAGS),
  "--since",
  "--instance",
  "--fork-asks-after",
  "--claude",
]);

export type SessionCommand = "listen" | "claim" | "sessions" | "setup";

export interface SessionCommandDeps extends AgentCliIo {
  cwd: string;
  /** The running server, without starting one. */
  locateServer: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  /** The running server, starting one if needed. */
  ensureServer: (env: NodeJS.ProcessEnv, projectDir: string) => Promise<string>;
  pluginDir: string;
  runCommand: (argv: string[]) => number;
  printHelp: (command: SessionCommand) => void;
}

const USAGE_ERROR = 2;
/** Re-armed by the plugin's own loop (or the agent's Monitor). */
const DEFAULT_SESSION_LISTEN_MAX_SECONDS = 1740;

export async function runSessionCommand(
  command: SessionCommand,
  rest: string[],
  baseDeps: SessionCommandDeps,
  globalJson: boolean,
): Promise<number> {
  const usage =
    command === "listen"
      ? SESSION_COMMAND_USAGE.listenSession
      : SESSION_COMMAND_USAGE[command];
  let options: SessionArgs;
  try {
    options = parseSessionArgs(rest);
  } catch (error) {
    baseDeps.error(error instanceof Error ? error.message : "Invalid usage.");
    baseDeps.error(usage);
    return USAGE_ERROR;
  }
  if (options.help) {
    baseDeps.printHelp(command);
    return 0;
  }
  const env: NodeJS.ProcessEnv = {
    ...baseDeps.env,
    ...(options.stateDir ? { ROUGHDRAFT_STATE_DIR: options.stateDir } : {}),
    ...(options.stateFile ? { ROUGHDRAFT_STATE_FILE: options.stateFile } : {}),
  };
  const deps: SessionCommandDeps = { ...baseDeps, env };
  const json = globalJson || options.json;

  if (command === "setup") {
    if (
      options.positionals.length !== 1 ||
      options.positionals[0] !== "claude"
    ) {
      deps.error(usage);
      return USAGE_ERROR;
    }
    return runSetupClaude(deps, {
      pluginDir: deps.pluginDir,
      install: options.install,
      runCommand: deps.runCommand,
    });
  }

  if (command === "sessions") {
    if (options.positionals.length > 0) {
      deps.error(usage);
      return USAGE_ERROR;
    }
    return runSessions(deps, await deps.locateServer(env), { json });
  }

  const claimsFile = options.claimsFile
    ? path.resolve(deps.cwd, options.claimsFile)
    : undefined;

  if (command === "listen") {
    const sessionId = options.session?.trim() ?? "";
    if (options.positionals.length > 0 || !sessionId) {
      deps.error("listen takes either a file or --session <id>, not both.");
      deps.error(usage);
      return USAGE_ERROR;
    }
    let currentServer: string | null = null;
    const locate = async () => {
      currentServer = options.noStart
        ? await deps.locateServer(env)
        : await deps.ensureServer(env, deps.cwd);
      return currentServer;
    };
    const observer =
      options.forkAsksAfter !== undefined
        ? new SessionForkObserver({
            io: deps,
            sessionId,
            cwd: deps.cwd,
            afterSeconds: options.forkAsksAfter,
            quiet: options.quiet,
            ...(options.claude ? { claudePath: options.claude } : {}),
            serverUrl: () => currentServer,
          })
        : undefined;
    return runSessionListen(deps, locate, {
      ...(observer ? { observer } : {}),
      sessionId,
      ...(claimsFile ? { claimsFile } : {}),
      ...(options.title ? { title: options.title } : {}),
      cwd: deps.cwd,
      maxSeconds: options.maxSeconds ?? DEFAULT_SESSION_LISTEN_MAX_SECONDS,
      quiet: options.quiet,
    });
  }

  // claim
  const sessionId =
    options.session?.trim() || env.CLAUDE_CODE_SESSION_ID?.trim() || "";
  if (options.positionals.length !== 1) {
    deps.error(usage);
    return USAGE_ERROR;
  }
  if (!sessionId) {
    deps.error(
      "No session: pass --session <id> (CLAUDE_CODE_SESSION_ID is not set).",
    );
    deps.error(usage);
    return USAGE_ERROR;
  }
  const documentPath = path.resolve(deps.cwd, options.positionals[0] ?? "");
  if (!documentPath.toLowerCase().endsWith(".md")) {
    deps.error(`claim works on a .md file: ${documentPath}`);
    return USAGE_ERROR;
  }
  let serverUrl: string | null;
  try {
    serverUrl = options.noStart
      ? await deps.locateServer(env)
      : await deps.ensureServer(env, path.dirname(documentPath));
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  return runClaim(deps, serverUrl, {
    sessionId,
    documentPath,
    force: options.force,
    ...(claimsFile ? { claimsFile } : {}),
    ...(options.title ? { title: options.title } : {}),
    cwd: deps.cwd,
    json,
    quiet: options.quiet,
  });
}
