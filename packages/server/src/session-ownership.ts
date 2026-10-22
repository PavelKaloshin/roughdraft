import path from "node:path";

/**
 * Which Claude Code session owns which document (ADR 0007). Exactly one
 * session receives a document's Ask/Change/follow-up/Done events. Like the
 * rest of the agent state (ADR 0004, ADR 0006) this lives only in the server
 * process; a session's listener re-sends its claims when it (re)connects.
 *
 * A session is live while one of its listeners has a long-poll open, and for a
 * grace period after (the same rule as a per-file listener).
 */

export interface SessionSummary {
  sessionId: string;
  title?: string;
  cwd?: string;
  live: boolean;
  /** Last long-poll activity (ISO 8601). */
  lastActiveAt: string;
  /** Documents this session owns (absolute paths). */
  documents: string[];
}

export interface DocumentOwner {
  sessionId: string;
  title?: string;
  cwd?: string;
  live: boolean;
  lastActiveAt?: string;
}

export type OwnershipNoticeType = "claimed" | "released";

export interface OwnershipNotice {
  /** Per-session cursor, starting at 1. */
  id: number;
  type: OwnershipNoticeType;
  documentPath: string;
  /** `claim`: the session claimed it; `reassigned`: moved to/from another session. */
  reason: "claim" | "reassigned";
  at: string;
}

export interface ClaimResult {
  claimed: boolean;
  owner: DocumentOwner | null;
  previousOwner?: string;
}

export interface SessionMeta {
  title?: string | null;
  cwd?: string | null;
}

interface SessionRecord {
  id: string;
  title: string | null;
  cwd: string | null;
  listeners: Map<string, { activeRequests: number; lastSeenAt: number }>;
  lastSeenAt: number;
  notices: OwnershipNotice[];
  nextNoticeId: number;
  noticeWaiters: Set<() => void>;
  /** Documents whose unanswered events this session must be shown again. */
  replay: Set<string>;
}

export interface SessionOwnershipOptions {
  graceMs: number;
  now?: () => number;
  /** Called when the owner or the live session set changes. */
  onChange?: () => void;
}

const MAX_NOTICES = 100;

export class SessionOwnership {
  private sessions = new Map<string, SessionRecord>();
  private owners = new Map<string, string>();
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly onChange: () => void;
  private graceTimer: NodeJS.Timeout | null = null;
  private lastLiveKey = "";

  constructor(options: SessionOwnershipOptions) {
    this.graceMs = options.graceMs;
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange ?? (() => {});
  }

  /**
   * Marks a session present for one long-poll request (a session listener,
   * or a per-file listener that reported its session id). Returns the
   * function to call when the request ends.
   */
  beginPresence(
    sessionId: string,
    listenerId: string,
    meta: SessionMeta = {},
  ): () => void {
    const session = this.session(sessionId);
    if (meta.title) session.title = meta.title;
    if (meta.cwd) session.cwd = meta.cwd;
    let listener = session.listeners.get(listenerId);
    if (!listener) {
      listener = { activeRequests: 0, lastSeenAt: this.now() };
      session.listeners.set(listenerId, listener);
    }
    listener.activeRequests += 1;
    listener.lastSeenAt = this.now();
    session.lastSeenAt = listener.lastSeenAt;
    this.changedIfLiveSetMoved();

    let ended = false;
    const record = listener;
    return () => {
      if (ended) return;
      ended = true;
      record.activeRequests = Math.max(0, record.activeRequests - 1);
      record.lastSeenAt = this.now();
      session.lastSeenAt = record.lastSeenAt;
      if (record.activeRequests === 0) this.scheduleGraceCheck();
    };
  }

  isLive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const now = this.now();
    for (const listener of session.listeners.values()) {
      if (listener.activeRequests > 0) return true;
      if (now - listener.lastSeenAt <= this.graceMs) return true;
    }
    return false;
  }

  ownerId(documentPath: string): string | null {
    return this.owners.get(path.resolve(documentPath)) ?? null;
  }

  owner(documentPath: string): DocumentOwner | null {
    const id = this.ownerId(documentPath);
    if (!id) return null;
    const session = this.sessions.get(id);
    return {
      sessionId: id,
      ...(session?.title ? { title: session.title } : {}),
      ...(session?.cwd ? { cwd: session.cwd } : {}),
      live: this.isLive(id),
      ...(session
        ? { lastActiveAt: new Date(session.lastSeenAt).toISOString() }
        : {}),
    };
  }

  /**
   * Makes `sessionId` the owner of `documentPath`.
   * - automatic (default): only when the document has no live owner;
   * - `force`: always (the UI's "Connect session", `claim --force`);
   * - `restore`: automatic, but the session is not told (a listener
   *   re-sending its claims after a reconnect).
   */
  claim(
    documentPath: string,
    sessionId: string,
    options: { force?: boolean; restore?: boolean; meta?: SessionMeta } = {},
  ): ClaimResult {
    const resolved = path.resolve(documentPath);
    const session = this.session(sessionId);
    if (options.meta?.title) session.title = options.meta.title;
    if (options.meta?.cwd) session.cwd = options.meta.cwd;

    const current = this.owners.get(resolved) ?? null;
    if (current === sessionId) {
      return { claimed: true, owner: this.owner(resolved) };
    }
    if (current && !options.force && this.isLive(current)) {
      return { claimed: false, owner: this.owner(resolved) };
    }

    this.owners.set(resolved, sessionId);
    session.replay.add(resolved);
    const reason = current && options.force ? "reassigned" : "claim";
    if (current) {
      const previous = this.sessions.get(current);
      previous?.replay.delete(resolved);
      if (previous && options.force) {
        this.notify(previous, "released", resolved, "reassigned");
      }
    }
    if (!options.restore) this.notify(session, "claimed", resolved, reason);
    this.onChange();
    return {
      claimed: true,
      owner: this.owner(resolved),
      ...(current ? { previousOwner: current } : {}),
    };
  }

  /** Gives up ownership; a no-op unless `sessionId` owns the document. */
  release(documentPath: string, sessionId: string): boolean {
    const resolved = path.resolve(documentPath);
    if (this.owners.get(resolved) !== sessionId) return false;
    this.owners.delete(resolved);
    this.sessions.get(sessionId)?.replay.delete(resolved);
    this.onChange();
    return true;
  }

  documentsOf(sessionId: string): string[] {
    const documents: string[] = [];
    for (const [documentPath, owner] of this.owners) {
      if (owner === sessionId) documents.push(documentPath);
    }
    return documents.sort();
  }

  /** Live sessions, most recently active first. */
  liveSessions(): SessionSummary[] {
    const summaries: SessionSummary[] = [];
    for (const session of this.sessions.values()) {
      if (!this.isLive(session.id)) continue;
      summaries.push({
        sessionId: session.id,
        ...(session.title ? { title: session.title } : {}),
        ...(session.cwd ? { cwd: session.cwd } : {}),
        live: true,
        lastActiveAt: new Date(session.lastSeenAt).toISOString(),
        documents: this.documentsOf(session.id),
      });
    }
    return summaries.sort((a, b) =>
      b.lastActiveAt.localeCompare(a.lastActiveAt),
    );
  }

  noticesAfter(sessionId: string, afterNotice: number): OwnershipNotice[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.notices.filter((notice) => notice.id > afterNotice);
  }

  noticeCursor(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    return session ? session.nextNoticeId - 1 : 0;
  }

  /** Resolves when a new notice arrives for the session, or on abort. */
  waitForNotice(sessionId: string, signal: AbortSignal): Promise<void> {
    const session = this.session(sessionId);
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = () => {
        session.noticeWaiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      session.noticeWaiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  needsReplay(sessionId: string, documentPath: string): boolean {
    return this.sessions.get(sessionId)?.replay.has(documentPath) ?? false;
  }

  /** After a round delivered events, replayed documents are caught up. */
  clearReplay(sessionId: string): void {
    this.sessions.get(sessionId)?.replay.clear();
  }

  private notify(
    session: SessionRecord,
    type: OwnershipNoticeType,
    documentPath: string,
    reason: OwnershipNotice["reason"],
  ): void {
    session.notices.push({
      id: session.nextNoticeId,
      type,
      documentPath,
      reason,
      at: new Date(this.now()).toISOString(),
    });
    session.nextNoticeId += 1;
    if (session.notices.length > MAX_NOTICES) {
      session.notices.splice(0, session.notices.length - MAX_NOTICES);
    }
    for (const waiter of [...session.noticeWaiters]) waiter();
  }

  private liveKey(): string {
    return [...this.sessions.keys()]
      .filter((id) => this.isLive(id))
      .sort()
      .join("\n");
  }

  private changedIfLiveSetMoved(): void {
    const key = this.liveKey();
    if (key === this.lastLiveKey) return;
    this.lastLiveKey = key;
    this.onChange();
  }

  private scheduleGraceCheck(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.changedIfLiveSetMoved();
      this.prune();
    }, this.graceMs + 10);
    this.graceTimer.unref?.();
  }

  /** Forget dead sessions that own nothing and have nobody waiting. */
  private prune(): void {
    for (const [id, session] of this.sessions) {
      if (this.isLive(id)) continue;
      if (session.noticeWaiters.size > 0) continue;
      if (this.documentsOf(id).length > 0) continue;
      this.sessions.delete(id);
    }
  }

  private session(sessionId: string): SessionRecord {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        title: null,
        cwd: null,
        listeners: new Map(),
        lastSeenAt: this.now(),
        notices: [],
        nextNoticeId: 1,
        noticeWaiters: new Set(),
        replay: new Set(),
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }
}
