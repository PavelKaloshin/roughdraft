import fs from "node:fs";
import path from "node:path";

export interface ReviewCompletedEventInput {
  documentPath: string;
  projectPath: string;
  relativePath: string;
  version: string;
  summary: {
    comments: number;
    replies: number;
    suggestions: number;
    unresolved: number;
  };
  overallComment?: string;
}

export interface ReviewCompletedEvent extends ReviewCompletedEventInput {
  type: "review.completed";
  sequence: number;
  createdAt: string;
}

export const COMMENT_EVENT_TYPES = [
  "comment.ask",
  "comment.change",
  "comment.followup",
] as const;

export type CommentEventType = (typeof COMMENT_EVENT_TYPES)[number];

export const REVIEW_EVENT_TYPES = [
  "review.completed",
  ...COMMENT_EVENT_TYPES,
] as const;

export type ReviewEventType = (typeof REVIEW_EVENT_TYPES)[number];

export type CommentIntent = "comment" | "ask" | "change";

/** Who answers an Ask in a headless fork (RFM `model`; absent = `fast`). */
export type AskModel = "fast" | "balanced" | "session";

export interface CommentEventReply {
  id: string;
  author: string | null;
  body: string;
  createdAt: string | null;
}

/**
 * A comment event is self-contained: an agent can act on it without reading
 * the file first. The file stays the source of truth; this is a snapshot taken
 * when the event was posted.
 */
export interface CommentEventInput {
  type: CommentEventType;
  documentPath: string;
  projectPath: string;
  relativePath: string;
  version: string;
  /** The comment the UI posted about (a root comment, or a follow-up reply). */
  commentId: string;
  threadRootId: string;
  intent: CommentIntent;
  /**
   * The Ask thread root's `model`, only when it is not the default (`fast`).
   * Follow-ups in an Ask thread carry their root's model.
   */
  model?: Exclude<AskModel, "fast">;
  anchorText: string | null;
  /** Text of `commentId` (for a follow-up: the user's new reply). */
  body: string;
  author: string | null;
  contextBefore: string;
  contextAfter: string;
  rootBody: string;
  replies: CommentEventReply[];
  latestReplyId: string | null;
}

export interface CommentEvent extends CommentEventInput {
  sequence: number;
  createdAt: string;
}

export type ReviewEvent = ReviewCompletedEvent | CommentEvent;

export function isCommentEventType(value: unknown): value is CommentEventType {
  return (
    typeof value === "string" &&
    (COMMENT_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export function isReviewEventType(value: unknown): value is ReviewEventType {
  return (
    typeof value === "string" &&
    (REVIEW_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export function isCommentEvent(event: ReviewEvent): event is CommentEvent {
  return event.type !== "review.completed";
}

export interface WaitForReviewEventsOptions {
  documentPath?: string;
  afterSequence?: number;
  timeoutMs?: number;
  batchWindowMs?: number;
  /** Event types to return. Omitted means every type. */
  types?: readonly ReviewEventType[];
  /** Extra predicate; events it rejects are neither returned nor wake the waiter. */
  filter?: (event: ReviewEvent) => boolean;
  /** Aborting resolves the wait as timed out and frees the waiter slot. */
  signal?: AbortSignal;
}

export interface WaitForReviewEventsResult {
  events: ReviewEvent[];
  timedOut: boolean;
  nextSequence: number;
}

export interface ReviewEventQueueOptions {
  /**
   * Soft cap on retained events. Pinned events (see `isPinned`) are kept past
   * the cap so an unanswered ask/change is not lost while no agent listens.
   */
  maxRetainedEvents?: number;
  isPinned?: (event: ReviewEvent) => boolean;
}

interface Waiter {
  options: NormalizedWaitOptions;
  resolve: (result: WaitForReviewEventsResult) => void;
  timeout: NodeJS.Timeout | null;
  batchTimeout: NodeJS.Timeout | null;
  abortListener: (() => void) | null;
}

const DEFAULT_BATCH_WINDOW_MS = 250;
export const DEFAULT_MAX_RETAINED_EVENTS = 1000;
/** Hard ceiling even for pinned events, to bound memory. */
const PINNED_EVENT_HARD_CAP_FACTOR = 5;

type NormalizedWaitOptions = {
  documentPath?: string;
  afterSequence: number;
  timeoutMs?: number;
  batchWindowMs: number;
  types?: ReadonlySet<ReviewEventType>;
  filter?: (event: ReviewEvent) => boolean;
  signal?: AbortSignal;
};

export class ReviewEventQueue {
  private events: ReviewEvent[] = [];
  private waiters = new Set<Waiter>();
  private nextSequence = 1;
  private readonly maxRetainedEvents: number;
  private readonly isPinned: (event: ReviewEvent) => boolean;

  constructor(options: ReviewEventQueueOptions = {}) {
    this.maxRetainedEvents = Math.max(
      1,
      options.maxRetainedEvents ?? DEFAULT_MAX_RETAINED_EVENTS,
    );
    this.isPinned = options.isPinned ?? (() => false);
  }

  emit(input: ReviewCompletedEventInput): {
    delivered: boolean;
    event: ReviewCompletedEvent;
  } {
    const event: ReviewCompletedEvent = {
      ...input,
      type: "review.completed",
      sequence: this.nextSequence,
      createdAt: new Date().toISOString(),
    };
    const delivered = this.push(event);

    appendSlog("review-events.emit", {
      documentPath: event.documentPath,
      sequence: event.sequence,
      waiters: this.waiters.size,
      hasOverallComment: typeof event.overallComment === "string",
      overallCommentLength: event.overallComment?.length ?? 0,
    });

    return { delivered, event };
  }

  /**
   * Emits a comment event unless an identical one (same document, type,
   * comment, and latest reply) is still retained; then the original event is
   * returned with `duplicate: true` and nothing is re-delivered.
   */
  emitComment(input: CommentEventInput): {
    delivered: boolean;
    duplicate: boolean;
    event: CommentEvent;
  } {
    const existing = this.events.find(
      (event): event is CommentEvent =>
        isCommentEvent(event) &&
        event.type === input.type &&
        path.resolve(event.documentPath) === path.resolve(input.documentPath) &&
        event.commentId === input.commentId &&
        event.latestReplyId === input.latestReplyId,
    );
    if (existing) {
      appendSlog("review-events.comment-duplicate", {
        documentPath: input.documentPath,
        type: input.type,
        commentId: input.commentId,
        sequence: existing.sequence,
      });
      return { delivered: false, duplicate: true, event: existing };
    }

    const event: CommentEvent = {
      ...input,
      sequence: this.nextSequence,
      createdAt: new Date().toISOString(),
    };
    const delivered = this.push(event);

    appendSlog("review-events.comment-emit", {
      documentPath: event.documentPath,
      type: event.type,
      commentId: event.commentId,
      threadRootId: event.threadRootId,
      sequence: event.sequence,
      delivered,
    });

    return { delivered, duplicate: false, event };
  }

  wait(
    options: WaitForReviewEventsOptions = {},
  ): Promise<WaitForReviewEventsResult> {
    const normalized = normalizeWaitOptions(options);
    const existing = this.matchingEvents(normalized);

    if (existing.length > 0 || normalized.signal?.aborted) {
      return Promise.resolve(
        resultForEvents(existing, existing.length === 0, this.nextSequence),
      );
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        options: normalized,
        resolve,
        batchTimeout: null,
        abortListener: null,
        timeout:
          normalized.timeoutMs !== undefined
            ? setTimeout(() => {
                this.resolveWaiter(waiter, true);
              }, normalized.timeoutMs)
            : null,
      };

      if (normalized.signal) {
        waiter.abortListener = () => this.resolveWaiter(waiter, true);
        normalized.signal.addEventListener("abort", waiter.abortListener, {
          once: true,
        });
      }

      this.waiters.add(waiter);
      appendSlog("review-events.wait", {
        documentPath: normalized.documentPath ?? null,
        afterSequence: normalized.afterSequence,
        timeoutMs: normalized.timeoutMs,
        types: normalized.types ? [...normalized.types] : null,
      });
    });
  }

  waiterCount(): number {
    return this.waiters.size;
  }

  latestSequence(): number {
    return this.nextSequence - 1;
  }

  /** Counts waiters on `documentPath` that would receive events of `type`. */
  waiterCountForDocument(
    documentPath: string,
    type: ReviewEventType = "review.completed",
  ): number {
    const normalizedPath = path.resolve(documentPath);
    return [...this.waiters].filter(
      (waiter) =>
        waiter.options.documentPath === normalizedPath &&
        (!waiter.options.types || waiter.options.types.has(type)),
    ).length;
  }

  private push(event: ReviewEvent): boolean {
    this.nextSequence += 1;
    this.events.push(event);
    this.trim();

    let delivered = false;
    for (const waiter of [...this.waiters]) {
      if (matchesWaiter(event, waiter.options)) {
        delivered = true;
        this.scheduleResolve(waiter);
      }
    }
    return delivered;
  }

  private trim(): void {
    if (this.events.length <= this.maxRetainedEvents) return;

    const hardCap = this.maxRetainedEvents * PINNED_EVENT_HARD_CAP_FACTOR;
    let excess = this.events.length - this.maxRetainedEvents;
    const kept: ReviewEvent[] = [];
    for (const event of this.events) {
      if (excess > 0 && !this.isPinned(event)) {
        excess -= 1;
        continue;
      }
      kept.push(event);
    }
    this.events = kept.length > hardCap ? kept.slice(-hardCap) : kept;
  }

  private matchingEvents(options: NormalizedWaitOptions): ReviewEvent[] {
    return this.events.filter((event) => matchesWaiter(event, options));
  }

  private scheduleResolve(waiter: Waiter): void {
    if (waiter.batchTimeout) return;

    if (waiter.timeout) {
      clearTimeout(waiter.timeout);
      waiter.timeout = null;
    }

    waiter.batchTimeout = setTimeout(() => {
      this.resolveWaiter(waiter, false);
    }, waiter.options.batchWindowMs);
  }

  private resolveWaiter(waiter: Waiter, timedOut: boolean): void {
    if (!this.waiters.has(waiter)) return;

    this.waiters.delete(waiter);
    if (waiter.timeout) {
      clearTimeout(waiter.timeout);
    }
    if (waiter.batchTimeout) {
      clearTimeout(waiter.batchTimeout);
    }
    if (waiter.abortListener) {
      waiter.options.signal?.removeEventListener("abort", waiter.abortListener);
    }

    const events = timedOut ? [] : this.matchingEvents(waiter.options);
    waiter.resolve(resultForEvents(events, timedOut, this.nextSequence));
  }
}

function normalizeWaitOptions(
  options: WaitForReviewEventsOptions,
): NormalizedWaitOptions {
  return {
    documentPath: options.documentPath
      ? path.resolve(options.documentPath)
      : undefined,
    afterSequence: Math.max(0, options.afterSequence ?? 0),
    timeoutMs:
      options.timeoutMs !== undefined
        ? clamp(options.timeoutMs, 0, 300_000)
        : undefined,
    batchWindowMs: clamp(
      options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
      0,
      10_000,
    ),
    types: options.types ? new Set(options.types) : undefined,
    filter: options.filter,
    signal: options.signal,
  };
}

function matchesWaiter(
  event: ReviewEvent,
  options: NormalizedWaitOptions,
): boolean {
  if (event.sequence <= options.afterSequence) return false;
  if (options.types && !options.types.has(event.type)) return false;
  if (
    options.documentPath &&
    path.resolve(event.documentPath) !== options.documentPath
  ) {
    return false;
  }
  return options.filter ? options.filter(event) : true;
}

function resultForEvents(
  events: ReviewEvent[],
  timedOut: boolean,
  nextSequence: number,
): WaitForReviewEventsResult {
  return {
    events,
    timedOut,
    nextSequence,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function appendSlog(event: string, data: Record<string, unknown>): void {
  const file = process.env.THOUGHTFUL_SLOG_FILE;
  if (!file) return;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      runId: process.env.THOUGHTFUL_SLOG_RUN_ID ?? "manual",
      source: "packages/server/src/review-events.ts",
      event,
      data,
    })}\n`,
  );
}
