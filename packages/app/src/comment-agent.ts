import { createContext, useContext } from "react";
import type { CriticComment, CriticCommentIntent } from "./critic-markup";

/**
 * Client-side contract for talking to a Claude Code session through comment
 * threads. The server owns the transient state (who is listening, how far each
 * thread got); the Markdown file owns the thread content.
 */

export type AgentThreadStatus = "pending" | "working" | "answered" | "applied";

export type CommentEventType =
  | "comment.ask"
  | "comment.change"
  | "comment.followup";

export interface AgentStatusSnapshot {
  listening: boolean;
  listenerCount: number;
  sessionId?: string;
  threads: Record<string, AgentThreadStatus>;
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

export function isHandledThreadStatus(
  status: AgentThreadStatus | ThreadAgentDisplayStatus | null | undefined,
) {
  return status === "answered" || status === "applied";
}

export type ThreadAgentDisplayStatus =
  | "sending"
  | "pending"
  | "working"
  | "answered"
  | "applied";

export const THREAD_AGENT_STATUS_LABELS: Record<
  ThreadAgentDisplayStatus,
  string
> = {
  sending: "Sending to Claude…",
  pending: "Waiting for Claude",
  working: "Claude is working…",
  answered: "Answered",
  applied: "Applied",
};

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
