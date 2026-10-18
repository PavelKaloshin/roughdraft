import { createContext, useContext } from "react";
import {
  buildCommentThreads,
  type CriticComment,
  type CriticCommentIntent,
  flattenCommentThreads,
  isCriticCommentResolved,
} from "./critic-markup";

/**
 * Client-side contract for talking to a Claude Code session through comment
 * threads. The server owns the transient state (who is listening, how far each
 * thread got); the Markdown file owns the thread content.
 */

/**
 * Server-side thread lifecycle, in order: stored without a listener
 * (`pending`), received by a listening session (`queued`), handed to a
 * subagent (`delegated`), acknowledged (`working`), replied to.
 */
export type AgentThreadStatus =
  | "pending"
  | "queued"
  | "delegated"
  | "working"
  | "answered"
  | "applied";

export const AGENT_THREAD_STATUSES: readonly AgentThreadStatus[] = [
  "pending",
  "queued",
  "delegated",
  "working",
  "answered",
  "applied",
];

export type CommentEventType =
  | "comment.ask"
  | "comment.change"
  | "comment.followup";

/** Server timestamps for a thread (ISO 8601). */
export interface AgentThreadTiming {
  /** When the thread entered its current status. */
  since?: string;
  /** When the user's latest Ask/Change/follow-up reached the server. */
  requestedAt?: string;
}

export interface AgentStatusSnapshot {
  listening: boolean;
  listenerCount: number;
  sessionId?: string;
  threads: Record<string, AgentThreadStatus>;
  /** Absent from older servers. */
  threadDetails?: Record<string, AgentThreadTiming>;
}

export interface CommentEventResult {
  duplicate: boolean;
  agent: { listening: boolean; sessionId?: string };
}

export type CommentComposerMode = "comment" | CriticCommentIntent;

export const COMMENT_COMPOSER_MODES: readonly CommentComposerMode[] = [
  "comment",
  "ask",
  "change",
];

export const COMMENT_COMPOSER_MODE_LABELS: Record<CommentComposerMode, string> =
  {
    comment: "Comment",
    ask: "Ask",
    change: "Change",
  };

const COMPOSER_MODE_STORAGE_KEY = "roughdraft.commentComposerMode";

export function readComposerModePreference(): CommentComposerMode {
  try {
    const stored = window.localStorage.getItem(COMPOSER_MODE_STORAGE_KEY);
    return stored === "ask" || stored === "change" ? stored : "comment";
  } catch {
    return "comment";
  }
}

export function writeComposerModePreference(mode: CommentComposerMode) {
  try {
    window.localStorage.setItem(COMPOSER_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
}

/** Which event, if any, submitting a new comment should send to the agent. */
export function getCommentSubmitEventType({
  isRoot,
  intent,
  rootIntent,
  authorType,
}: {
  isRoot: boolean;
  /** The mode chosen in the composer, for a new root comment. */
  intent?: CommentComposerMode;
  /** The intent of the thread root, for a reply. */
  rootIntent?: CriticCommentIntent;
  authorType?: CriticComment["authorType"];
}): CommentEventType | null {
  if (isRoot) {
    if (intent === "ask") return "comment.ask";
    if (intent === "change") return "comment.change";
    return null;
  }
  if (authorType === "ai") return null;
  return rootIntent ? "comment.followup" : null;
}

/** An unresolved Ask/Change thread in the document. */
export interface OpenAgentThread {
  rootId: string;
  intent: CriticCommentIntent;
  /** The thread's latest comment (the root itself when it has no replies). */
  latestCommentId: string;
  latestCommentIsFromAgent: boolean;
}

export function getOpenAgentThreads(
  comments: Iterable<CriticComment>,
): OpenAgentThread[] {
  const threads: OpenAgentThread[] = [];
  for (const thread of buildCommentThreads(comments)) {
    const root = thread.comment;
    if (!root.intent || isCriticCommentResolved(root)) continue;
    const latest = flattenCommentThreads([thread]).at(-1) ?? root;
    threads.push({
      rootId: root.id,
      intent: root.intent,
      latestCommentId: latest.id,
      latestCommentIsFromAgent: latest.authorType === "ai",
    });
  }
  return threads;
}

export function isHandledThreadStatus(
  status: AgentThreadStatus | ThreadAgentDisplayStatus | null | undefined,
) {
  return status === "answered" || status === "applied";
}

export type ThreadAgentDisplayStatus = "sending" | AgentThreadStatus;

export const THREAD_AGENT_STATUS_LABELS: Record<
  ThreadAgentDisplayStatus,
  string
> = {
  sending: "Sending to Claude…",
  pending: "Waiting for a Claude session",
  queued: "Queued in Claude's session",
  delegated: "Passed to a subagent",
  working: "Claude is working…",
  answered: "Answered",
  applied: "Applied",
};

/**
 * `pending` with a session listening means the session has not polled yet
 * (between `listen` rounds, or an MCP agent between waits).
 */
export function getThreadAgentStatusLabel(
  status: ThreadAgentDisplayStatus,
  { listening }: { listening: boolean },
) {
  if (status === "pending" && listening) {
    return "Waiting for Claude to pick it up";
  }
  return THREAD_AGENT_STATUS_LABELS[status];
}

/** Statuses that are still waiting on Claude: they show a live timer. */
export function isActiveThreadStatus(
  status: ThreadAgentDisplayStatus | null | undefined,
) {
  return (
    status === "pending" ||
    status === "queued" ||
    status === "delegated" ||
    status === "working"
  );
}

/** After this long in `queued`, the session is busy with a long step. */
export const QUEUED_BUSY_HINT_AFTER_MS = 60_000;
export const QUEUED_BUSY_HINT =
  "Claude is busy; it will answer after its current step";

export function formatAgentElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

const SUMMARY_PARTS: ReadonlyArray<[AgentThreadStatus, string]> = [
  ["queued", "queued"],
  ["delegated", "with a subagent"],
  ["working", "working"],
];

/**
 * Header summary of threads a session has picked up, e.g. "2 queued · 1
 * working". `openThreadIds` limits it to threads still open in the document
 * (the server keeps a thread the user resolved locally).
 */
export function summarizeAgentThreads(
  threads: Record<string, AgentThreadStatus>,
  openThreadIds?: ReadonlySet<string> | null,
): string | null {
  const counts = new Map<AgentThreadStatus, number>();
  for (const [id, status] of Object.entries(threads)) {
    if (openThreadIds && !openThreadIds.has(id)) continue;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const parts = SUMMARY_PARTS.flatMap(([status, label]) => {
    const count = counts.get(status) ?? 0;
    return count > 0 ? [`${count} ${label}`] : [];
  });
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The status line shown on an Ask/Change thread. The live server state wins;
 * without it (no event this server session, or after a restart) a thread whose
 * latest comment is from the agent still reads as answered/applied.
 */
export function getThreadAgentDisplayStatus({
  intent,
  resolved,
  sending,
  serverStatus,
  latestCommentIsFromAgent,
}: {
  intent?: CriticCommentIntent;
  resolved: boolean;
  sending: boolean;
  serverStatus?: AgentThreadStatus;
  latestCommentIsFromAgent: boolean;
}): ThreadAgentDisplayStatus | null {
  if (!intent || resolved) return null;
  if (sending) return "sending";
  if (serverStatus) return serverStatus;
  if (latestCommentIsFromAgent) {
    return intent === "change" ? "applied" : "answered";
  }
  return null;
}

function quoteShellArgument(value: string) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildListenCommand(absolutePath: string) {
  return `roughdraft listen ${quoteShellArgument(absolutePath)}`;
}

export interface CommentAgentThreadState {
  /** An event for this thread is being saved/sent right now. */
  sending: boolean;
  /** The last event was accepted while no Claude session was listening. */
  undelivered: boolean;
  /** The last event could not be sent. */
  error: string | null;
}

export interface CommentAgentContextValue {
  /** False outside a document backed by the local server. */
  available: boolean;
  status: AgentStatusSnapshot | null;
  /** Header summary such as "2 queued · 1 working", or null. */
  threadSummary: string | null;
  /** Some event was accepted while no session listened and is still waiting. */
  hasUndeliveredEvents: boolean;
  listenCommand: string | null;
  showResolved: boolean;
  setShowResolved: (show: boolean) => void;
  getThreadState: (threadRootId: string) => CommentAgentThreadState;
  /**
   * Called after a new comment was submitted. Waits for the document save to
   * land on disk, then posts the event exactly once per comment.
   */
  submitCommentEvent: (input: {
    type: CommentEventType;
    commentId: string;
    threadRootId: string;
  }) => void;
  retryThread: (threadRootId: string) => void;
}

const idleThreadState: CommentAgentThreadState = {
  sending: false,
  undelivered: false,
  error: null,
};

export const defaultCommentAgentContext: CommentAgentContextValue = {
  available: false,
  status: null,
  threadSummary: null,
  hasUndeliveredEvents: false,
  listenCommand: null,
  showResolved: false,
  setShowResolved: () => {},
  getThreadState: () => idleThreadState,
  submitCommentEvent: () => {},
  retryThread: () => {},
};

export const CommentAgentContext = createContext<CommentAgentContextValue>(
  defaultCommentAgentContext,
);

export function useCommentAgent() {
  return useContext(CommentAgentContext);
}

export { idleThreadState };
