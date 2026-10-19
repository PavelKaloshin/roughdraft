import {
  extractRoughdraftReviewIndex,
  type RfmReviewItem,
} from "@roughdraft/rfm";
import type {
  CommentEventInput,
  CommentEventReply,
  CommentEventType,
  CommentIntent,
} from "./review-events.js";

const CONTEXT_CHARS = 160;

export type CommentLookupResult =
  | {
      ok: true;
      item: RfmReviewItem;
      root: RfmReviewItem;
      threadRootId: string;
      items: RfmReviewItem[];
    }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Finds a comment (root or reply) and the root of its thread. Replies are
 * flat in RFM (`re` points at the root), but walk the chain defensively.
 */
export function lookupComment(
  markdown: string,
  commentId: string,
): CommentLookupResult {
  const { items } = extractRoughdraftReviewIndex(markdown);
  const item = items.find((candidate) => candidate.id === commentId);
  if (!item) {
    return { ok: false, status: 404, error: `Comment not found: ${commentId}` };
  }

  const byId = new Map(items.map((candidate) => [candidate.id, candidate]));
  let root = item;
  const seen = new Set<string>([item.id]);
  while (root.parentId) {
    const parent = byId.get(root.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    root = parent;
  }

  return { ok: true, item, root, threadRootId: root.id, items };
}

export type BuildCommentEventResult =
  | { ok: true; input: CommentEventInput }
  | { ok: false; status: 400 | 404; error: string };

export function buildCommentEventInput(
  markdown: string,
  options: {
    type: CommentEventType;
    commentId: string;
    documentPath: string;
    projectPath: string;
    relativePath: string;
    version: string;
  },
): BuildCommentEventResult {
  const lookup = lookupComment(markdown, options.commentId);
  if (!lookup.ok) return lookup;

  const { item, root, threadRootId, items } = lookup;
  if (item.kind === "suggestion") {
    return {
      ok: false,
      status: 400,
      error: `${options.type} must target a comment, not suggestion ${item.id}`,
    };
  }
  if (options.type !== "comment.followup" && item.kind !== "comment") {
    return {
      ok: false,
      status: 400,
      error: `${options.type} must target a root comment; ${item.id} is a reply (use comment.followup)`,
    };
  }

  const replies: CommentEventReply[] = items
    .filter(
      (candidate) =>
        candidate.kind === "reply" &&
        candidate.id !== threadRootId &&
        threadRootOf(items, candidate) === threadRootId,
    )
    .map((reply, index) => ({ reply, index }))
    .sort(
      (a, b) =>
        compareTimestamps(a.reply.createdAt, b.reply.createdAt) ||
        a.index - b.index,
    )
    .map(({ reply }) => ({
      id: reply.id,
      author: reply.author,
      body: reply.text,
      createdAt: reply.createdAt,
    }));

  const latestReply = replies.at(-1) ?? null;
  // A follow-up posted against the root (rather than the new reply) is about
  // the newest reply in the thread.
  const subject =
    options.type === "comment.followup" && item.id === threadRootId
      ? latestReply
      : null;

  const intent: CommentIntent =
    options.type === "comment.ask"
      ? "ask"
      : options.type === "comment.change"
        ? "change"
        : (root.intent ?? "comment");
  // Only an Ask thread has a model; the default (`fast`) is left out.
  const model =
    intent === "ask" && root.model && root.model !== "fast"
      ? root.model
      : undefined;

  return {
    ok: true,
    input: {
      type: options.type,
      documentPath: options.documentPath,
      projectPath: options.projectPath,
      relativePath: options.relativePath,
      version: options.version,
      commentId: item.id,
      threadRootId,
      intent,
      ...(model ? { model } : {}),
      anchorText: root.anchorText ?? null,
      body: subject ? subject.body : item.text,
      author: subject ? subject.author : item.author,
      ...surroundingContext(markdown, root),
      rootBody: root.text,
      replies,
      latestReplyId: latestReply?.id ?? null,
    },
  };
}

/** Agent replies are written `by: AI` (ADR 0006). */
function isAgentAuthor(author: string | null): boolean {
  return author?.trim().toLowerCase() === "ai";
}

/**
 * Unresolved ask/change threads in which the user spoke last, as the event
 * the browser would have posted for them: the root's ask/change when nobody
 * replied yet, or a follow-up on the newest user reply. Plain `comment`
 * threads never involve the agent, so they are not included.
 */
/**
 * Thread roots that are still open in the file: they exist and the user has
 * not resolved them. An event for any other thread is stale.
 */
export function findOpenThreadRootIds(markdown: string): Set<string> {
  const open = new Set<string>();
  for (const item of extractRoughdraftReviewIndex(markdown).items) {
    if (item.kind === "comment" && item.status !== "resolved")
      open.add(item.id);
  }
  return open;
}

export function findUnansweredAgentThreads(
  markdown: string,
): Array<{ type: CommentEventType; commentId: string }> {
  const { items } = extractRoughdraftReviewIndex(markdown);
  const pending: Array<{ type: CommentEventType; commentId: string }> = [];

  for (const root of items) {
    if (root.kind !== "comment" || root.status === "resolved") continue;
    if (root.intent !== "ask" && root.intent !== "change") continue;

    const replies = items
      .map((item, index) => ({ item, index }))
      .filter(
        ({ item }) =>
          item.kind === "reply" && threadRootOf(items, item) === root.id,
      )
      .sort(
        (a, b) =>
          compareTimestamps(a.item.createdAt, b.item.createdAt) ||
          a.index - b.index,
      );
    const last = replies.at(-1)?.item;
    if (!last) {
      pending.push({ type: `comment.${root.intent}`, commentId: root.id });
    } else if (!isAgentAuthor(last.author)) {
      pending.push({ type: "comment.followup", commentId: last.id });
    }
  }

  return pending;
}

function threadRootOf(items: RfmReviewItem[], item: RfmReviewItem): string {
  const byId = new Map(items.map((candidate) => [candidate.id, candidate]));
  let current = item;
  const seen = new Set<string>([item.id]);
  while (current.parentId) {
    const parent = byId.get(current.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  return current.id;
}

function compareTimestamps(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) || Number.isNaN(right)) return 0;
  return left - right;
}

/**
 * Short plain-ish text around the thread's anchor so an agent can orient
 * without opening the file. Review markup is stripped; endmatter-only
 * (document-level) comments have no surrounding text.
 */
function surroundingContext(
  markdown: string,
  root: RfmReviewItem,
): { contextBefore: string; contextAfter: string } {
  if (root.offset === root.endOffset) {
    return { contextBefore: "", contextAfter: "" };
  }

  const highlightStart =
    root.anchorText !== undefined
      ? markdown.lastIndexOf("{==", root.offset)
      : -1;
  const start = highlightStart >= 0 ? highlightStart : root.offset;
  const rawBefore = markdown.slice(
    Math.max(0, start - CONTEXT_CHARS * 3),
    start,
  );
  const rawAfter = markdown
    .slice(root.endOffset, root.endOffset + CONTEXT_CHARS * 3)
    .split(/\n---[ \t]*\r?\n/)[0];

  const before = plainText(rawBefore ?? "");
  const after = plainText(rawAfter ?? "");
  return {
    contextBefore:
      before.length > CONTEXT_CHARS
        ? `…${before.slice(-CONTEXT_CHARS).trimStart()}`
        : before,
    contextAfter:
      after.length > CONTEXT_CHARS
        ? `${after.slice(0, CONTEXT_CHARS).trimEnd()}…`
        : after,
  };
}

function plainText(markdown: string): string {
  return markdown
    .replace(/\{>>[\s\S]*?<<\}/g, "")
    .replace(/\{#[A-Za-z][\w-]*\}/g, "")
    .replace(/\{(?:[A-Za-z][\w-]*="(?:[^"\\]|\\.)*"\s*)+\}/g, "")
    .replace(/\{==([\s\S]*?)==\}/g, "$1")
    .replace(/\{\+\+([\s\S]*?)\+\+\}/g, "$1")
    .replace(/\{--([\s\S]*?)--\}/g, "$1")
    .replace(/\{~~([\s\S]*?)~>([\s\S]*?)~~\}/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}
