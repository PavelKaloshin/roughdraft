import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type CommentEventInput, ReviewEventQueue } from "./review-events";

function eventInput(documentPath = "/tmp/project/draft.md") {
  return {
    documentPath,
    projectPath: path.dirname(documentPath),
    relativePath: path.basename(documentPath),
    version: "v1",
    summary: {
      comments: 1,
      replies: 0,
      suggestions: 1,
      unresolved: 2,
    },
  };
}

describe("ReviewEventQueue", () => {
  it("queues events in creation order", async () => {
    const queue = new ReviewEventQueue();

    queue.emit(eventInput("/tmp/project/a.md"));
    queue.emit(eventInput("/tmp/project/b.md"));

    const result = await queue.wait({ timeoutMs: 0 });

    expect(result.timedOut).toBe(false);
    expect(result.events.map((event) => event.documentPath)).toEqual([
      "/tmp/project/a.md",
      "/tmp/project/b.md",
    ]);
    expect(result.events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("resolves a waiting watcher when a matching event arrives", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      timeoutMs: 1_000,
      batchWindowMs: 10,
    });

    const emitted = queue.emit(eventInput("/tmp/project/draft.md"));
    await vi.advanceTimersByTimeAsync(10);

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      events: [emitted.event],
    });
    expect(emitted.delivered).toBe(true);
    vi.useRealTimers();
  });

  it("returns overall comments with delivered events", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      timeoutMs: 1_000,
      batchWindowMs: 0,
    });

    queue.emit({
      ...eventInput("/tmp/project/draft.md"),
      overallComment: "Please prioritize the CLI contract.",
    });
    await vi.advanceTimersByTimeAsync(0);

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      events: [
        {
          overallComment: "Please prioritize the CLI contract.",
        },
      ],
    });
    vi.useRealTimers();
  });

  it("keeps events without overall comments unchanged", async () => {
    const queue = new ReviewEventQueue();

    queue.emit(eventInput("/tmp/project/draft.md"));

    const result = await queue.wait();
    expect(result.events[0]).not.toHaveProperty("overallComment");
  });

  it("keeps a watcher active without a timeout until a matching event arrives", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      batchWindowMs: 0,
    });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(queue.waiterCount()).toBe(1);

    const emitted = queue.emit(eventInput("/tmp/project/draft.md"));
    await vi.advanceTimersByTimeAsync(0);

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      events: [emitted.event],
    });
    vi.useRealTimers();
  });

  it("ignores unrelated document paths", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      timeoutMs: 100,
      batchWindowMs: 0,
    });

    const emitted = queue.emit(eventInput("/tmp/project/other.md"));
    await vi.advanceTimersByTimeAsync(100);

    await expect(waiting).resolves.toMatchObject({
      timedOut: true,
      events: [],
    });
    expect(emitted.delivered).toBe(false);
    vi.useRealTimers();
  });

  it("batches events during the batch window", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({ timeoutMs: 1_000, batchWindowMs: 50 });

    queue.emit(eventInput("/tmp/project/a.md"));
    await vi.advanceTimersByTimeAsync(25);
    queue.emit(eventInput("/tmp/project/b.md"));
    await vi.advanceTimersByTimeAsync(25);

    const result = await waiting;

    expect(result.events.map((event) => event.documentPath)).toEqual([
      "/tmp/project/a.md",
      "/tmp/project/b.md",
    ]);
    vi.useRealTimers();
  });

  it("does not time out after a matching event arrives during a longer batch window", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      timeoutMs: 100,
      batchWindowMs: 200,
    });

    await vi.advanceTimersByTimeAsync(50);
    const emitted = queue.emit(eventInput("/tmp/project/draft.md"));
    await vi.advanceTimersByTimeAsync(200);

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      events: [emitted.event],
    });
    expect(emitted.delivered).toBe(true);
    vi.useRealTimers();
  });

  it("prunes retained events deterministically", async () => {
    const queue = new ReviewEventQueue({ maxRetainedEvents: 100 });

    for (let index = 0; index < 105; index += 1) {
      queue.emit(eventInput(`/tmp/project/${index}.md`));
    }

    const result = await queue.wait();

    expect(result.events).toHaveLength(100);
    expect(result.events[0]?.sequence).toBe(6);
    expect(result.events.at(-1)?.sequence).toBe(105);
  });

  it("retains 1000 events by default", async () => {
    const queue = new ReviewEventQueue();

    for (let index = 0; index < 1005; index += 1) {
      queue.emit(eventInput(`/tmp/project/${index}.md`));
    }

    const result = await queue.wait();
    expect(result.events).toHaveLength(1000);
    expect(result.events[0]?.sequence).toBe(6);
  });
});

function commentInput(
  overrides: Partial<CommentEventInput> = {},
): CommentEventInput {
  return {
    type: "comment.ask",
    documentPath: "/tmp/project/draft.md",
    projectPath: "/tmp/project",
    relativePath: "draft.md",
    version: "v1",
    commentId: "c1",
    threadRootId: "c1",
    intent: "ask",
    anchorText: "four seconds",
    body: "Why?",
    author: "user",
    contextBefore: "",
    contextAfter: "",
    rootBody: "Why?",
    replies: [],
    latestReplyId: null,
    ...overrides,
  };
}

describe("ReviewEventQueue comment events", () => {
  it("does not return comment events to a watcher that only wants review.completed", async () => {
    const queue = new ReviewEventQueue();
    queue.emitComment(commentInput());

    const result = await queue.wait({
      types: ["review.completed"],
      timeoutMs: 0,
    });

    expect(result).toMatchObject({ timedOut: true, events: [] });
  });

  it("does not count a comment-only listener as a Done Reviewing watcher", () => {
    const queue = new ReviewEventQueue();
    void queue.wait({
      documentPath: "/tmp/project/draft.md",
      types: ["comment.ask"],
      timeoutMs: 1_000,
    });

    expect(queue.waiterCountForDocument("/tmp/project/draft.md")).toBe(0);
    expect(
      queue.waiterCountForDocument("/tmp/project/draft.md", "comment.ask"),
    ).toBe(1);
  });

  it("emits the same type, comment, and latest reply only once", () => {
    const queue = new ReviewEventQueue();

    const first = queue.emitComment(commentInput());
    const second = queue.emitComment(commentInput());
    const afterReply = queue.emitComment(
      commentInput({ type: "comment.followup", latestReplyId: "c2" }),
    );

    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({ duplicate: true, event: first.event });
    expect(afterReply.duplicate).toBe(false);
    expect(afterReply.event.sequence).toBe(first.event.sequence + 1);
  });

  it("keeps pinned events past the retention cap", async () => {
    const queue = new ReviewEventQueue({
      maxRetainedEvents: 3,
      isPinned: (event) => event.type === "comment.ask",
    });

    queue.emitComment(commentInput());
    for (let index = 0; index < 5; index += 1) {
      queue.emit(eventInput(`/tmp/project/${index}.md`));
    }

    const result = await queue.wait();
    expect(result.events.map((event) => event.type)).toEqual([
      "comment.ask",
      "review.completed",
      "review.completed",
    ]);
  });

  it("frees a waiter when its signal aborts", async () => {
    const queue = new ReviewEventQueue();
    const abort = new AbortController();
    const waiting = queue.wait({ signal: abort.signal });

    expect(queue.waiterCount()).toBe(1);
    abort.abort();

    await expect(waiting).resolves.toMatchObject({ timedOut: true });
    expect(queue.waiterCount()).toBe(0);
  });

  it("applies the extra filter before waking a waiter", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      timeoutMs: 100,
      batchWindowMs: 0,
      filter: (event) => event.type !== "comment.ask",
    });

    const emitted = queue.emitComment(commentInput());
    await vi.advanceTimersByTimeAsync(100);

    await expect(waiting).resolves.toMatchObject({ timedOut: true });
    expect(emitted.delivered).toBe(false);
    vi.useRealTimers();
  });
});
