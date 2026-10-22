import {
  Bot,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Reply,
  RotateCcw,
  User,
  X,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef } from "react";
import { AgentThreadStatusLine } from "./AgentThreadStatus";
import type { UpdateCommentHandler } from "./CommentEditorList";
import { CommentMarkdown } from "./CommentMarkdown";
import {
  COMMENT_COMPOSER_MODE_LABELS,
  getThreadAgentDisplayStatus,
  useCommentAgent,
} from "./comment-agent";
import { escapeAttributeValue } from "./comment-reader-context";
import { matchReaderNavigationKey } from "./comment-shortcuts";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog";
import {
  buildCommentThreads,
  type CriticComment,
  type CriticCommentThread,
  flattenCommentThreads,
  getCommentDescendantIds,
  isCriticCommentResolved,
} from "./critic-markup";
import { cn } from "./lib/utils";

export interface CommentReaderTarget {
  rootId: string;
  /** The comment the reader opened from; scrolled into view. */
  focusCommentId: string | null;
}

interface CommentThreadReaderDialogProps {
  target: CommentReaderTarget | null;
  comments: ReadonlyMap<string, CriticComment>;
  /** Thread root ids in document order (for prev/next). */
  threadOrder: string[];
  /** The text the thread is anchored to, if any. */
  anchorText: string | null;
  onClose: () => void;
  onNavigate: (rootId: string) => void;
  /** Close, then start a reply to the thread in the rail composer. */
  onReply: (rootId: string) => void;
  onUpdateComment: UpdateCommentHandler;
  /** Where focus goes when the dialog closes (default: Base UI's). */
  getFinalFocus?: () => HTMLElement | boolean;
}

function getAuthorLabel(comment: CriticComment) {
  if (comment.authorType === "ai") return "AI";
  const authorId = comment.authorId?.trim();
  return authorId && authorId.toLowerCase() !== "user" ? authorId : "Me";
}

const timestampFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatTimestamp(value: string) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : timestampFormat.format(time);
}

function getThread(
  rootId: string,
  comments: ReadonlyMap<string, CriticComment>,
): CriticCommentThread | null {
  const root = comments.get(rootId);
  if (!root) return null;
  const threadComments = [rootId, ...getCommentDescendantIds(rootId, comments)]
    .map((id) => comments.get(id))
    .filter((comment): comment is CriticComment => Boolean(comment));
  return (
    buildCommentThreads(threadComments).find(
      (thread) => thread.comment.id === rootId,
    ) ?? null
  );
}

function ReaderComment({
  thread,
  depth,
}: {
  thread: CriticCommentThread;
  depth: number;
}) {
  const { comment } = thread;
  const isAi = comment.authorType === "ai";
  const AuthorIcon = isAi ? Bot : User;
  const timestamp = formatTimestamp(comment.createdAt);
  const hasContent = comment.content.trim().length > 0;

  return (
    <>
      <article
        data-testid={`comment-reader-comment-${comment.id}`}
        data-comment-reader-comment-id={comment.id}
        className={cn(
          "scroll-mt-4 border-l-2 pl-4",
          isAi
            ? "border-sky-300 dark:border-sky-700"
            : "border-stone-200 dark:border-slate-700",
        )}
        style={depth > 0 ? { marginLeft: Math.min(depth, 3) * 16 } : undefined}
      >
        <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span
            className={cn(
              "flex size-6 items-center justify-center rounded-full border",
              isAi
                ? "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-900 dark:text-sky-300"
                : "border-[#D2C7B8] bg-[#DED8CE] text-stone-700 dark:border-slate-600 dark:bg-slate-700 dark:text-stone-200",
            )}
          >
            <AuthorIcon className="size-3" />
          </span>
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {getAuthorLabel(comment)}
          </span>
          {timestamp ? (
            <time
              data-testid={`comment-reader-comment-${comment.id}-time`}
              dateTime={comment.createdAt}
              className="text-xs text-stone-500 dark:text-slate-400"
            >
              {timestamp}
            </time>
          ) : null}
        </header>
        {hasContent ? (
          <CommentMarkdown
            content={comment.content}
            testId={`comment-reader-comment-${comment.id}-body`}
            className="comment-reader-markdown mt-2 text-slate-800 dark:text-slate-200"
          />
        ) : (
          <p className="mt-2 text-sm text-stone-500 italic dark:text-slate-400">
            Empty comment
          </p>
        )}
      </article>
      {thread.replies.map((reply) => (
        <ReaderComment
          key={reply.comment.id}
          thread={reply}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

/**
 * A centered, scrollable reader for one comment thread: long agent answers
 * get a readable measure instead of the ~280px rail. It renders from the
 * same comment state as the rail, so a reply arriving while it is open
 * shows up here too.
 */
export function CommentThreadReaderDialog({
  target,
  comments,
  threadOrder,
  anchorText,
  onClose,
  onNavigate,
  onReply,
  onUpdateComment,
  getFinalFocus,
}: CommentThreadReaderDialogProps) {
  const agent = useCommentAgent();
  const bodyRef = useRef<HTMLDivElement>(null);
  // Keep showing the last thread while the dialog animates closed (and so
  // Base UI can run its close focus handling before unmounting).
  const lastTargetRef = useRef<CommentReaderTarget | null>(null);
  if (target) lastTargetRef.current = target;
  const shownTarget = target ?? lastTargetRef.current;
  const rootId = shownTarget?.rootId ?? null;
  const thread = useMemo(
    () => (rootId ? getThread(rootId, comments) : null),
    [comments, rootId],
  );
  const open = target !== null && thread !== null;
  const position = rootId ? threadOrder.indexOf(rootId) : -1;
  const previousId = position > 0 ? threadOrder[position - 1] : undefined;
  const nextId =
    position >= 0 && position < threadOrder.length - 1
      ? threadOrder[position + 1]
      : undefined;

  // Opening on a reply scrolls to it; moving to another thread starts at
  // its top.
  const focusCommentId = target?.focusCommentId ?? null;
  useEffect(() => {
    if (!open) return;
    const body = bodyRef.current;
    if (!body) return;
    const focusTarget =
      focusCommentId && focusCommentId !== rootId
        ? body.querySelector<HTMLElement>(
            `[data-comment-reader-comment-id="${escapeAttributeValue(focusCommentId)}"]`,
          )
        : null;
    if (focusTarget?.scrollIntoView) {
      focusTarget.scrollIntoView({ block: "start" });
    } else {
      body.scrollTop = 0;
    }
  }, [focusCommentId, open, rootId]);

  if (!shownTarget) return null;

  const root = thread?.comment;
  const resolved = root ? isCriticCommentResolved(root) : false;
  const latest = thread ? flattenCommentThreads([thread]).at(-1) : undefined;
  const agentStatus = root
    ? getThreadAgentDisplayStatus({
        intent: root.intent,
        resolved,
        sending: agent.getThreadState(root.id).sending,
        serverStatus: agent.status?.threads[root.id],
        latestCommentIsFromAgent:
          latest !== undefined &&
          latest.id !== root.id &&
          latest.authorType === "ai",
      })
    : null;
  const quote = anchorText?.replace(/\s+/g, " ").trim() ?? "";

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = matchReaderNavigationKey(event);
    if (!direction) return;
    const destination = direction === 1 ? nextId : previousId;
    event.preventDefault();
    event.stopPropagation();
    if (destination) onNavigate(destination);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        data-testid="comment-reader"
        data-comment-reader="true"
        showCloseButton={false}
        finalFocus={getFinalFocus ? () => getFinalFocus() : true}
        className={cn(
          "comment-reader flex max-h-[80vh] w-[calc(100%-2rem)] max-w-[720px] flex-col gap-0 overflow-hidden p-0",
          "bg-white dark:bg-slate-900 dark:border-slate-700",
          // Narrow viewports: near full-screen.
          "max-sm:h-[100dvh] max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0",
        )}
        onKeyDown={handleKeyDown}
      >
        {root ? (
          <>
            <div className="border-b border-stone-200 px-6 pt-5 pb-4 dark:border-slate-700">
              <div className="flex items-center gap-2 pr-9">
                <DialogTitle className="text-base text-slate-900 dark:text-slate-100">
                  Comment thread
                </DialogTitle>
                {root.intent ? (
                  <Badge
                    data-testid="comment-reader-intent"
                    variant="outline"
                    className={cn(
                      root.intent === "ask"
                        ? "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300"
                        : "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300",
                    )}
                  >
                    {COMMENT_COMPOSER_MODE_LABELS[root.intent]}
                  </Badge>
                ) : null}
                {resolved ? (
                  <Badge
                    data-testid="comment-reader-resolved-badge"
                    variant="secondary"
                  >
                    <CircleCheck />
                    Resolved
                  </Badge>
                ) : null}
                {position >= 0 && threadOrder.length > 1 ? (
                  <span
                    data-testid="comment-reader-position"
                    className="ml-auto text-xs whitespace-nowrap text-stone-500 tabular-nums dark:text-slate-400"
                  >
                    {position + 1} of {threadOrder.length}
                  </span>
                ) : null}
              </div>
              <DialogClose
                data-testid="comment-reader-close"
                aria-label="Close"
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute top-4 right-4 text-stone-500 dark:text-slate-400"
                  />
                }
              >
                <X className="size-4" />
              </DialogClose>
              {quote ? (
                <blockquote
                  data-testid="comment-reader-anchor"
                  className="mt-3 line-clamp-3 border-l-2 border-amber-300 pl-3 text-sm leading-6 text-stone-600 italic dark:border-amber-600 dark:text-slate-300"
                >
                  {quote}
                </blockquote>
              ) : (
                <DialogDescription className="sr-only">
                  A comment thread without anchored text.
                </DialogDescription>
              )}
              {agentStatus ? (
                <AgentThreadStatusLine
                  status={agentStatus}
                  listening={agent.status?.listening === true}
                  since={agent.status?.threadDetails?.[root.id]?.since}
                  requestedAt={
                    agentStatus === "sending"
                      ? undefined
                      : agent.status?.threadDetails?.[root.id]?.requestedAt
                  }
                  testId="comment-reader-agent-status"
                />
              ) : null}
            </div>
            <div
              ref={bodyRef}
              data-testid="comment-reader-body"
              className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-6 py-5"
            >
              {thread ? <ReaderComment thread={thread} depth={0} /> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-stone-200 px-6 py-3 dark:border-slate-700">
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  data-testid="comment-reader-prev"
                  aria-label="Previous thread"
                  title="Previous thread (← or K)"
                  disabled={!previousId}
                  onClick={() => previousId && onNavigate(previousId)}
                >
                  <ChevronLeft />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  data-testid="comment-reader-next"
                  aria-label="Next thread"
                  title="Next thread (→ or J)"
                  disabled={!nextId}
                  onClick={() => nextId && onNavigate(nextId)}
                >
                  <ChevronRight />
                </Button>
                <span className="hidden text-xs text-stone-500 sm:inline dark:text-slate-400">
                  ←/→ or J/K · Esc to close
                </span>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  size="lg"
                  data-testid="comment-reader-reply"
                  onClick={() => onReply(root.id)}
                >
                  <Reply />
                  Reply
                </Button>
                {resolved ? (
                  <Button
                    variant="outline"
                    size="lg"
                    data-testid="comment-reader-reopen"
                    onClick={() =>
                      onUpdateComment(root.id, root.content, { status: null })
                    }
                  >
                    <RotateCcw />
                    Reopen
                  </Button>
                ) : (
                  <Button
                    variant="default"
                    size="lg"
                    data-testid="comment-reader-resolve"
                    onClick={() =>
                      onUpdateComment(root.id, root.content, {
                        status: "resolved",
                      })
                    }
                  >
                    <CircleCheck />
                    Resolve
                  </Button>
                )}
              </div>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
