import path from "node:path";
import type { CommentEvent } from "./review-events.js";

/**
 * Transient, in-memory view of which agent sessions are listening to which
 * document and how far each ask/change thread has progressed. Like remote
 * document sessions (ADR 0004), none of this is persisted: it disappears with
 * the server process, and the Markdown file stays the source of truth for the
 * thread content itself.
 */

/**
 * Thread lifecycle, in order:
 * - `pending`: the event is stored, but no listening session received it yet.
 * - `queued`: a listening session received it; the session handles it at its
 *   next pause between steps.
 * - `delegated`: the session handed the thread to a subagent
 *   (`roughdraft ack --delegated`).
 * - `working`: someone acknowledged it and is writing the answer.
 * - `answered` / `applied`: a reply was written.
 *
 * Transitions only move forward; a new user event (follow-up) starts over.
 */
export type AgentThreadStatus =
  | "pending"
  | "queued"
  | "delegated"
  | "working"
  | "answered"
  | "applied";

const STATUS_RANK: Record<AgentThreadStatus, number> = {
  pending: 0,
  queued: 1,
  delegated: 2,
  working: 3,
  answered: 4,
  applied: 4,
};

export interface AgentThreadDetail {
  status: AgentThreadStatus;
  /** When the thread entered its current status (ISO 8601). */
  since: string;
  /** When the user's latest Ask/Change/follow-up reached the server. */
  requestedAt?: string;
}

export interface AgentStatus {
  documentPath: string;
  listening: boolean;
  listenerCount: number;
  sessionId?: string;
  /** When the current listener first connected (ISO 8601). */
  since?: string;
  threads: Record<string, AgentThreadStatus>;
  /** Per-thread timing, keyed like `threads` (additive to the status map). */
  threadDetails: Record<string, AgentThreadDetail>;
}

export interface AgentListenerIdentity {
  listenerId: string;
  sessionId?: string | null;
  /**
   * How long this listener stays present between requests, when it needs
   * longer than the default (an MCP agent works between bounded waits).
   */
  graceMs?: number;
}

interface ListenerRecord {
  id: string;
  sessionId: string | null;
  connectedAt: number;
  lastSeenAt: number;
  activeRequests: number;
  graceMs: number;
}

interface ThreadRecord {
  status: AgentThreadStatus;
  statusSince: number;
  requestedAt: number | null;
  /** Highest comment-event sequence emitted for this thread. */
  lastEventSequence: number;
  /** Highest comment-event sequence handed to a listener for this thread. */
  lastDeliveredSequence: number;
  /** Events at or below this sequence were answered/applied. */
  handledThroughSequence: number;
}

interface DocumentState {
  listeners: Map<string, ListenerRecord>;
  threads: Map<string, ThreadRecord>;
  subscribers: Set<(status: AgentStatus) => void>;
  graceTimer: NodeJS.Timeout | null;
  lastBroadcast: string | null;
}

export interface AgentRegistryOptions {
  /**
   * How long a listener counts as present after its last long-poll round
   * ended. `roughdraft listen` re-polls immediately, and a Monitor re-arm
   * takes a few seconds, so this bridges those gaps without flicker.
   */
  graceMs?: number;
  now?: () => number;
}

export const DEFAULT_LISTENER_GRACE_MS = 15_000;

export class AgentRegistry {
  private documents = new Map<string, DocumentState>();
  private readonly graceMs: number;
  private readonly now: () => number;

  constructor(options: AgentRegistryOptions = {}) {
    this.graceMs = options.graceMs ?? DEFAULT_LISTENER_GRACE_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Marks a listener as present for the duration of one long-poll request.
   * Returns a function to call when that request ends (or is aborted).
   */
  beginListen(
    documentPath: string,
    identity: AgentListenerIdentity,
  ): () => void {
    const state = this.state(documentPath);
    const now = this.now();
    let record = state.listeners.get(identity.listenerId);
    if (!record) {
      record = {
        id: identity.listenerId,
        sessionId: identity.sessionId || null,
        connectedAt: now,
        lastSeenAt: now,
        activeRequests: 0,
        graceMs: this.graceMs,
      };
      state.listeners.set(identity.listenerId, record);
    }
    if (identity.sessionId) record.sessionId = identity.sessionId;
    record.graceMs = Math.max(this.graceMs, identity.graceMs ?? 0);
    record.activeRequests += 1;
    record.lastSeenAt = now;
    this.broadcast(documentPath);

    let ended = false;
    const listener = record;
    return () => {
      if (ended) return;
      ended = true;
      listener.activeRequests = Math.max(0, listener.activeRequests - 1);
      listener.lastSeenAt = this.now();
      if (listener.activeRequests === 0) {
        this.scheduleGraceCheck(documentPath);
      }
    };
  }

  /** A new ask/change/follow-up event puts its thread back to pending. */
  recordEvent(event: CommentEvent): void {
    const thread = this.thread(event.documentPath, event.threadRootId);
    const now = this.now();
    thread.status = "pending";
    thread.statusSince = now;
    thread.requestedAt = now;
    thread.lastEventSequence = Math.max(
      thread.lastEventSequence,
      event.sequence,
    );
    this.broadcast(event.documentPath);
  }

  recordDelivered(event: CommentEvent): void {
    const thread = this.thread(event.documentPath, event.threadRootId);
    thread.lastDeliveredSequence = Math.max(
      thread.lastDeliveredSequence,
      event.sequence,
    );
    // Delivered to a listening session: it reads the line at its next pause.
    if (
      thread.status === "pending" &&
      event.sequence >= thread.lastEventSequence
    ) {
      this.transition(thread, "queued");
      this.broadcast(event.documentPath);
    }
  }

  /**
   * Moves a thread forward, never back: a late ack or a re-delivery does not
   * undo progress. An answer is always recorded. Returns the status after.
   */
  setThreadStatus(
    documentPath: string,
    threadRootId: string,
    status: AgentThreadStatus,
  ): AgentThreadStatus {
    const thread = this.thread(documentPath, threadRootId);
    const isAnswer = status === "answered" || status === "applied";
    if (!isAnswer && STATUS_RANK[status] <= STATUS_RANK[thread.status]) {
      return thread.status;
    }
    this.transition(thread, status);
    if (status === "answered" || status === "applied") {
      // An answer covers what the agent was shown. If it answered without
      // ever being shown an event (e.g. replied by hand), it covers them all.
      thread.handledThroughSequence = Math.max(
        thread.handledThroughSequence,
        thread.lastDeliveredSequence || thread.lastEventSequence,
      );
    }
    this.broadcast(documentPath);
    return thread.status;
  }

  clearThread(documentPath: string, threadRootId: string): void {
    const state = this.documents.get(path.resolve(documentPath));
    if (!state?.threads.delete(threadRootId)) return;
    this.broadcast(documentPath);
  }

  /** True when the event's thread was already answered after it was shown. */
  isHandled(event: CommentEvent): boolean {
    const thread = this.documents
      .get(path.resolve(event.documentPath))
      ?.threads.get(event.threadRootId);
    if (!thread) return false;
    return event.sequence <= thread.handledThroughSequence;
  }

  /** Events that still need an agent: never trimmed from the event buffer. */
  isAwaitingAgent(event: CommentEvent): boolean {
    const thread = this.documents
      .get(path.resolve(event.documentPath))
      ?.threads.get(event.threadRootId);
    if (!thread) return false;
    return (
      STATUS_RANK[thread.status] < STATUS_RANK.answered &&
      !this.isHandled(event)
    );
  }

  status(documentPath: string): AgentStatus {
    const resolved = path.resolve(documentPath);
    const state = this.documents.get(resolved);
    const threads: Record<string, AgentThreadStatus> = {};
    const threadDetails: Record<string, AgentThreadDetail> = {};
    if (!state) {
      return {
        documentPath: resolved,
        listening: false,
        listenerCount: 0,
        threads,
        threadDetails,
      };
    }

    for (const [id, thread] of state.threads) {
      threads[id] = thread.status;
      threadDetails[id] = {
        status: thread.status,
        since: new Date(thread.statusSince).toISOString(),
        ...(thread.requestedAt !== null
          ? { requestedAt: new Date(thread.requestedAt).toISOString() }
          : {}),
      };
    }

    const present = this.presentListeners(state);
    const current = present.sort((a, b) => b.connectedAt - a.connectedAt)[0];
    return {
      documentPath: resolved,
      listening: present.length > 0,
      listenerCount: present.length,
      ...(current?.sessionId ? { sessionId: current.sessionId } : {}),
      ...(current
        ? { since: new Date(current.connectedAt).toISOString() }
        : {}),
      threads,
      threadDetails,
    };
  }

  subscribe(
    documentPath: string,
    callback: (status: AgentStatus) => void,
  ): () => void {
    const state = this.state(documentPath);
    state.subscribers.add(callback);
    return () => {
      state.subscribers.delete(callback);
    };
  }

  private presentListeners(state: DocumentState): ListenerRecord[] {
    const now = this.now();
    const present: ListenerRecord[] = [];
    for (const [id, listener] of state.listeners) {
      if (
        listener.activeRequests > 0 ||
        now - listener.lastSeenAt <= listener.graceMs
      ) {
        present.push(listener);
      } else {
        state.listeners.delete(id);
      }
    }
    return present;
  }

  private longestGraceMs(state: DocumentState): number {
    let longest = this.graceMs;
    for (const listener of state.listeners.values()) {
      longest = Math.max(longest, listener.graceMs);
    }
    return longest;
  }

  private scheduleGraceCheck(documentPath: string): void {
    const state = this.state(documentPath);
    if (state.graceTimer) clearTimeout(state.graceTimer);
    state.graceTimer = setTimeout(() => {
      state.graceTimer = null;
      this.broadcast(documentPath);
    }, this.longestGraceMs(state) + 10);
    state.graceTimer.unref?.();
  }

  private broadcast(documentPath: string): void {
    const state = this.documents.get(path.resolve(documentPath));
    if (!state) return;
    const status = this.status(documentPath);
    const serialized = JSON.stringify(status);
    if (serialized === state.lastBroadcast) return;
    state.lastBroadcast = serialized;
    for (const subscriber of [...state.subscribers]) {
      subscriber(status);
    }
  }

  private transition(thread: ThreadRecord, status: AgentThreadStatus): void {
    if (thread.status !== status) thread.statusSince = this.now();
    thread.status = status;
  }

  private thread(documentPath: string, threadRootId: string): ThreadRecord {
    const state = this.state(documentPath);
    let thread = state.threads.get(threadRootId);
    if (!thread) {
      thread = {
        status: "pending",
        statusSince: this.now(),
        requestedAt: null,
        lastEventSequence: 0,
        lastDeliveredSequence: 0,
        handledThroughSequence: 0,
      };
      state.threads.set(threadRootId, thread);
    }
    return thread;
  }

  private state(documentPath: string): DocumentState {
    const resolved = path.resolve(documentPath);
    let state = this.documents.get(resolved);
    if (!state) {
      state = {
        listeners: new Map(),
        threads: new Map(),
        subscribers: new Set(),
        graceTimer: null,
        lastBroadcast: null,
      };
      this.documents.set(resolved, state);
    }
    return state;
  }
}
