import crypto from "node:crypto";
import path from "node:path";
import type {
  CommentEvent,
  ReviewCompletedEvent,
  ReviewEvent,
} from "./review-events.js";
import { roundTimeoutSignal } from "./watch-rounds.js";

/**
 * `roughdraft listen | reply | ack | resolve`: the agent half of comment
 * threads. `listen` is meant to run under Claude Code's Monitor tool, which
 * turns every stdout line into an event that wakes the session, so it prints
 * exactly one self-contained line per comment event and nothing else.
 */

export const LISTEN_EVENT_TYPES = [
  "review.completed",
  "comment.ask",
  "comment.change",
  "comment.followup",
] as const;

/** Monitor stops a command after 30 minutes; exit cleanly before that. */
export const DEFAULT_LISTEN_MAX_SECONDS = 1740;
/** Well under undici's 300s headers timeout for Node's fetch. */
const LISTEN_ROUND_SECONDS = 50;
const LISTEN_BATCH_WINDOW_SECONDS = 0.1;
const RETRY_MIN_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 5_000;
const MAX_TEXT_CHARS = 300;
const MAX_ANCHOR_CHARS = 120;
const REPLY_CONFLICT_RETRIES = 3;

export interface AgentCliIo {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
  readStdin: () => Promise<string>;
  log: (message: string) => void;
  error: (message: string) => void;
  now?: () => number;
}

export interface AgentCliTarget {
  serverUrl: string;
  projectDir: string;
  documentPath: string;
}

interface WatchPayload {
  events: ReviewEvent[];
  timedOut: boolean;
  nextSequence: number;
  latestSequence?: number;
  instanceId?: string;
}

class FatalListenError extends Error {}

export function cliCommandName(env: NodeJS.ProcessEnv): string {
  const wrapper = env.ROUGHDRAFT_DEV_WRAPPER_NAME?.trim();
  return wrapper && /^[\w.-]+$/.test(wrapper) ? wrapper : "roughdraft";
}

export function shellQuote(value: string): string {
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeInline(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\p{Cc}/gu, " ");
}

function clip(value: string, max: number): { text: string; clipped: boolean } {
  const chars = [...value];
  if (chars.length <= max) return { text: value, clipped: false };
  return { text: `${chars.slice(0, max).join("")}…`, clipped: true };
}

/**
 * One line per event. Claude only sees this line, so it carries the
 * question, where it is, and the exact command to answer with.
 */
export function formatListenEventLine(
  event: CommentEvent,
  options: { cliName: string; documentPath: string },
): string {
  const file = shellQuote(options.documentPath);
  const cli = options.cliName;
  const kind = event.type.slice("comment.".length);
  const threadId = event.threadRootId;
  const wantsChange =
    event.type === "comment.change" ||
    (event.type === "comment.followup" && event.intent === "change");

  // Monitor truncates long notification lines, so the command to run comes
  // first and the (clipped) comment context last. A change is edited by the
  // session itself (one writer); an ask goes to a forked subagent so the
  // answer does not wait for the session's current work.
  const ack = `${cli} ack ${file} ${threadId}`;
  const action = wantsChange
    ? `${ack}, edit the file, then: ${cli} reply ${file} ${threadId} --status applied --stdin`
    : `${ack} --delegated, hand to a forked subagent that acks without --delegated and answers without editing the file: ${cli} reply ${file} ${threadId} --stdin`;

  const parts = [`[roughdraft] ${kind} ${threadId}`];
  if (event.type === "comment.followup") {
    parts.push(`reply=${event.commentId}`, `intent=${event.intent}`);
  }
  parts.push(`seq=${event.sequence}`);
  // An Ask's non-default model (`fast` is left out, like in the file).
  if (!wantsChange && event.model) parts.push(`model=${event.model}`);
  parts.push(`→ ${action} |`);
  if (event.author) parts.push(`by=${escapeInline(event.author)}`);
  if (event.anchorText) {
    const anchor = clip(event.anchorText, MAX_ANCHOR_CHARS);
    parts.push(`anchor="${escapeInline(anchor.text)}"`);
  }
  const text = clip(event.body, MAX_TEXT_CHARS);
  parts.push(`text="${escapeInline(text.text)}"`);
  if (text.clipped) {
    parts.push(`(truncated; read comment ${event.commentId} in the file)`);
  }
  return parts.join(" ");
}

/** The user clicked Done Reviewing in the browser. */
export function formatListenDoneLine(
  event: ReviewCompletedEvent,
  options: { documentPath: string },
): string {
  const parts = [
    "[roughdraft] done",
    `seq=${event.sequence}`,
    `file=${shellQuote(options.documentPath)}`,
    `comments=${event.summary.comments}`,
    `unresolved=${event.summary.unresolved}`,
  ];
  if (event.overallComment) {
    const text = clip(event.overallComment, MAX_TEXT_CHARS);
    parts.push(`note="${escapeInline(text.text)}"`);
  }
  parts.push(
    "→ the user clicked Done Reviewing: read the file and handle any remaining feedback",
  );
  return parts.join(" ");
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof FatalListenError) return false;
  // Network failures (server restarting), undici timeouts, our own round
  // abort: all transient from a listener's point of view.
  return error instanceof Error;
}

export interface ListenObserver {
  /**
   * Sees a comment event before its line is printed. Returning true means
   * the observer took the event over and the line is not printed.
   */
  observe(event: CommentEvent): boolean;
  /**
   * `listen --session` expired: stop taking new work. True while earlier
   * work still runs; the listener keeps printing events until `close()`
   * settles, so nothing it must print waits behind that work.
   */
  drain?(): boolean;
  /** Called when listening ends; listen exits once it settles. */
  close(): Promise<void>;
  /**
   * Set by `listen --session`: the observer calls it after printing an
   * event's line itself (an Ask a fork gave back).
   */
  onEventPrinted?: (event: CommentEvent) => void;
}

export async function runListen(
  io: AgentCliIo,
  target: AgentCliTarget,
  options: {
    since?: number;
    /** Server instance the `since` cursor came from (printed on expiry). */
    instanceId?: string;
    maxSeconds: number;
    roundSeconds?: number;
    /** Sees every comment event line printed (`--fork-asks-after`). */
    observer?: ListenObserver;
  },
): Promise<number> {
  const now = io.now ?? Date.now;
  const cli = cliCommandName(io.env);
  const deadline = now() + options.maxSeconds * 1000;
  const roundLimit = options.roundSeconds ?? LISTEN_ROUND_SECONDS;
  const listenerId = crypto.randomUUID();
  const sessionId = io.env.CLAUDE_CODE_SESSION_ID?.trim() || null;
  const watchUrl = new URL("/api/review-events/watch", target.serverUrl);
  const relativePath = path.relative(target.projectDir, target.documentPath);
  const file = shellQuote(target.documentPath);

  let cursor = options.since ?? 0;
  let instanceId: string | null = options.instanceId ?? null;
  let announced = false;
  let retryDelay = RETRY_MIN_DELAY_MS;
  let completedBefore = 0;

  const poll = async (timeoutSeconds: number): Promise<WatchPayload> => {
    const response = await io.fetchImpl(watchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: target.projectDir,
        path: relativePath,
        types: LISTEN_EVENT_TYPES,
        fromNow: false,
        afterSequence: cursor,
        timeoutSeconds,
        batchWindowSeconds: LISTEN_BATCH_WINDOW_SECONDS,
        skipHandled: true,
        ...(instanceId ? { instanceId } : {}),
        listener: { id: listenerId, ...(sessionId ? { sessionId } : {}) },
      }),
      signal: roundTimeoutSignal(timeoutSeconds, 10),
    });
    if (response.status >= 400 && response.status < 500) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new FatalListenError(
        payload.error ?? `listen failed with HTTP ${response.status}`,
      );
    }
    if (!response.ok) {
      throw new Error(`listen failed with HTTP ${response.status}`);
    }
    return (await response.json()) as WatchPayload;
  };

  for (;;) {
    const remainingSeconds = Math.max(0, (deadline - now()) / 1000);
    if (announced && remainingSeconds <= 0) break;
    // The first round returns immediately so the "listening" line (with the
    // effective cursor) prints right away.
    const roundSeconds = announced ? Math.min(remainingSeconds, roundLimit) : 0;

    let payload: WatchPayload;
    try {
      payload = await poll(roundSeconds);
      retryDelay = RETRY_MIN_DELAY_MS;
    } catch (error) {
      if (!isRetryableError(error)) {
        io.log(
          `[roughdraft] listen stopped on ${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
        await options.observer?.close();
        return 1;
      }
      if (now() >= deadline) break;
      await io.sleepImpl(Math.min(retryDelay, Math.max(0, deadline - now())));
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_DELAY_MS);
      continue;
    }

    // Sequences restart with the server. A different instance, or a cursor
    // ahead of everything the server has seen, means our cursor belongs to an
    // older server: start over from 0 (answered threads are skipped anyway).
    const restarted =
      (instanceId !== null &&
        payload.instanceId !== undefined &&
        payload.instanceId !== instanceId) ||
      (payload.latestSequence !== undefined && cursor > payload.latestSequence);
    instanceId = payload.instanceId ?? instanceId;
    if (restarted) {
      cursor = 0;
      if (announced) continue;
    }

    if (!announced) {
      announced = true;
      if (options.since === undefined) {
        completedBefore = payload.latestSequence ?? payload.nextSequence - 1;
      }
      io.log(
        `[roughdraft] listening on ${file} (${sessionId ? `session ${sessionId}` : "no session id"}) since=${cursor}`,
      );
      if (restarted) continue;
    }

    for (const event of payload.events) {
      cursor = Math.max(cursor, event.sequence);
      if (event.type === "review.completed") {
        // Unanswered comment events are replayed on purpose, but a Done
        // Reviewing from before this listener started is stale news.
        if (event.sequence <= completedBefore) continue;
        io.log(
          formatListenDoneLine(event, { documentPath: target.documentPath }),
        );
        continue;
      }
      if (options.observer?.observe(event) === true) continue;
      io.log(
        formatListenEventLine(event, {
          cliName: cli,
          documentPath: target.documentPath,
        }),
      );
    }
    cursor = Math.max(cursor, payload.nextSequence - 1);
  }

  io.log(
    `[roughdraft] listen expired; re-arm with: ${cli} listen ${file} --since ${cursor}${instanceId ? ` --instance ${instanceId}` : ""}`,
  );
  await options.observer?.close();
  return 0;
}

async function postJson(
  io: AgentCliIo,
  target: AgentCliTarget,
  pathname: string,
  body: Record<string, unknown>,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await io.fetchImpl(new URL(pathname, target.serverUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectPath: target.projectDir,
      path: path.relative(target.projectDir, target.documentPath),
      ...body,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return { status: response.status, payload };
}

function errorText(payload: Record<string, unknown>, status: number): string {
  return typeof payload.error === "string"
    ? payload.error
    : `request failed with HTTP ${status}`;
}

export async function runReply(
  io: AgentCliIo,
  target: AgentCliTarget,
  options: {
    commentId: string;
    body: string;
    status: "answered" | "applied";
    json: boolean;
  },
): Promise<number> {
  let result = { status: 0, payload: {} as Record<string, unknown> };
  for (let attempt = 0; attempt < REPLY_CONFLICT_RETRIES; attempt += 1) {
    result = await postJson(io, target, "/api/comments/reply", {
      commentId: options.commentId,
      body: options.body,
      status: options.status,
    });
    if (result.status !== 409) break;
    await io.sleepImpl(100 * (attempt + 1));
  }

  if (result.status !== 201) {
    io.error(
      `Failed to reply to ${options.commentId}: ${errorText(result.payload, result.status)}`,
    );
    return 1;
  }

  if (options.json) {
    io.log(JSON.stringify(result.payload, null, 2));
    return 0;
  }
  io.log(
    `[roughdraft] replied to ${String(result.payload.threadRootId)} in ${target.documentPath} (reply ${String(result.payload.replyId)}, status ${String(result.payload.status)})`,
  );
  return 0;
}

export async function runAck(
  io: AgentCliIo,
  target: AgentCliTarget,
  options: { commentId: string; delegated?: boolean; json: boolean },
): Promise<number> {
  const result = await postJson(io, target, "/api/agent/ack", {
    commentId: options.commentId,
    ...(options.delegated ? { delegated: true } : {}),
  });
  if (result.status !== 200) {
    io.error(
      `Failed to ack ${options.commentId}: ${errorText(result.payload, result.status)}`,
    );
    return 1;
  }
  if (options.json) {
    io.log(JSON.stringify(result.payload, null, 2));
    return 0;
  }
  const owner =
    result.payload.delegatedTo === "fork-process"
      ? " (to a headless fork; leave it)"
      : "";
  io.log(
    `[roughdraft] ${String(result.payload.threadRootId)} is now ${String(result.payload.status)}${owner} in ${target.documentPath}`,
  );
  return 0;
}

export async function runResolve(
  io: AgentCliIo,
  target: AgentCliTarget,
  options: { commentId: string; summary?: string; json: boolean },
): Promise<number> {
  const result = await postJson(io, target, "/api/comments/resolve", {
    commentId: options.commentId,
    ...(options.summary ? { summary: options.summary } : {}),
  });
  if (result.status !== 200) {
    io.error(
      `Failed to resolve ${options.commentId}: ${errorText(result.payload, result.status)}`,
    );
    return 1;
  }
  if (options.json) {
    io.log(JSON.stringify(result.payload, null, 2));
    return 0;
  }
  io.log(
    `[roughdraft] resolved ${String(result.payload.threadRootId)} in ${target.documentPath}`,
  );
  return 0;
}

export interface ParsedAgentArgs {
  positionals: string[];
  help: boolean;
  json: boolean;
  stdin: boolean;
  delegated: boolean;
  body?: string;
  status?: string;
  summary?: string;
  since?: number;
  instance?: string;
  maxSeconds?: number;
  stateDir?: string;
  stateFile?: string;
  session?: string;
  claude?: string;
  timeout?: number;
  forkAsksAfter?: number;
}

const VALUE_FLAGS = {
  "--body": "body",
  "--status": "status",
  "--summary": "summary",
  "--since": "since",
  "--instance": "instance",
  "--max-seconds": "maxSeconds",
  "--state-dir": "stateDir",
  "--state-file": "stateFile",
  "--session": "session",
  "--claude": "claude",
  "--timeout": "timeout",
  "--fork-asks-after": "forkAsksAfter",
} as const;

type ValueFlag = keyof typeof VALUE_FLAGS;

/**
 * Small parser for the agent commands. Unlike the shared parser, a flag value
 * may start with "-" (`--body "- item"` is a normal Markdown reply).
 */
export function parseAgentArgs(
  args: string[],
  allowed: readonly ValueFlag[],
  options: { allowStdin?: boolean; allowDelegated?: boolean } = {},
): ParsedAgentArgs {
  const parsed: ParsedAgentArgs = {
    positionals: [],
    help: false,
    json: false,
    stdin: false,
    delegated: false,
  };

  const assign = (flag: ValueFlag, value: string) => {
    const key = VALUE_FLAGS[flag];
    if (
      key === "since" ||
      key === "maxSeconds" ||
      key === "timeout" ||
      key === "forkAsksAfter"
    ) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || value.trim() === "") {
        throw new Error(`${flag} must be a non-negative number.`);
      }
      parsed[key] = key === "since" ? Math.floor(number) : number;
      return;
    }
    parsed[key] = value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      parsed.positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--stdin" && options.allowStdin) {
      parsed.stdin = true;
      continue;
    }
    if (arg === "--delegated" && options.allowDelegated) {
      parsed.delegated = true;
      continue;
    }

    const [flag, inlineValue] = arg.startsWith("--")
      ? (arg.split(/=(.*)/s, 2) as [string, string | undefined])
      : [arg, undefined];
    if ((allowed as readonly string[]).includes(flag)) {
      if (inlineValue !== undefined) {
        assign(flag as ValueFlag, inlineValue);
        continue;
      }
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${flag} requires a value.`);
      assign(flag as ValueFlag, value);
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    parsed.positionals.push(arg);
  }

  return parsed;
}
