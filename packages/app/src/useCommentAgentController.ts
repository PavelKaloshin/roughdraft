import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentStatusSnapshot,
  buildListenCommand,
  type CommentAgentContextValue,
  type CommentAgentThreadState,
  type CommentEventType,
  getOpenAgentThreads,
  idleThreadState,
  isHandledThreadStatus,
  summarizeAgentThreads,
} from "./comment-agent";
import { criticMarkdownComments } from "./critic-markup";
import type { ManualSaveResult } from "./PageCard";
import type { StorageBackend } from "./storage";

interface PendingEvent {
  type: CommentEventType;
  commentId: string;
  threadRootId: string;
}

export const COMMENT_EVENT_NOT_SAVED_ERROR =
  "Not sent to Claude: the comment is not saved to disk yet.";
export const COMMENT_EVENT_SEND_ERROR =
  "Could not send to Claude. Check that the local Roughdraft server is running.";

/**
 * Owns the browser side of the comment ↔ Claude handoff for one document:
 * subscribes to the agent status stream and sends Ask/Change/follow-up events
 * once the comment has been saved.
 */
export function useCommentAgentController({
  backend,
  documentPath,
  absolutePath,
  markdown,
  flushSave,
}: {
  backend: StorageBackend | null;
  documentPath: string | null;
  absolutePath: string | null;
  /**
   * The document as the editor has it now (the local draft). Thread state
   * shown outside the threads (the header notice) follows it, so a thread
   * resolved or deleted in the UI stops counting before the server's
   * in-memory status catches up.
   */
  markdown: string | null;
  /** Resolves once the current draft is on disk (or could not be saved). */
  flushSave: () => Promise<ManualSaveResult | undefined>;
}): CommentAgentContextValue {
  const available = Boolean(backend?.postCommentEvent && documentPath);
  const [status, setStatus] = useState<AgentStatusSnapshot | null>(null);
  const [threadStates, setThreadStates] = useState<
    Record<string, CommentAgentThreadState>
  >({});
  const [showResolved, setShowResolved] = useState(false);
  const sentEventKeysRef = useRef(new Set<string>());
  const lastEventByThreadRef = useRef(new Map<string, PendingEvent>());
  const flushSaveRef = useRef(flushSave);
  flushSaveRef.current = flushSave;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per document
  useEffect(() => {
    sentEventKeysRef.current = new Set();
    lastEventByThreadRef.current = new Map();
    setThreadStates({});
    setStatus(null);
  }, [backend, documentPath]);

  useEffect(() => {
    if (!backend?.watchAgentStatus || !documentPath) return;
    return backend.watchAgentStatus(documentPath, setStatus);
  }, [backend, documentPath]);

  // Events posted while nobody listened are replayed to the next listener,
  // so the notice goes away as soon as a session connects.
  useEffect(() => {
    if (!status?.listening) return;
    setThreadStates((current) => {
      let changed = false;
      const next: Record<string, CommentAgentThreadState> = {};
      for (const [id, state] of Object.entries(current)) {
        if (state.undelivered) changed = true;
        next[id] = { ...state, undelivered: false };
      }
      return changed ? next : current;
    });
  }, [status?.listening]);

  const setThreadState = useCallback(
    (threadRootId: string, patch: Partial<CommentAgentThreadState>) => {
      setThreadStates((current) => ({
        ...current,
        [threadRootId]: {
          ...(current[threadRootId] ?? idleThreadState),
          ...patch,
        },
      }));
    },
    [],
  );

  const send = useCallback(
    async (event: PendingEvent) => {
      if (!backend?.postCommentEvent || !documentPath) return;
      const key = `${event.type}:${event.commentId}`;
      if (sentEventKeysRef.current.has(key)) return;
      sentEventKeysRef.current.add(key);
      lastEventByThreadRef.current.set(event.threadRootId, event);
      setThreadState(event.threadRootId, { sending: true, error: null });

      const saved = await flushSaveRef.current();
      if (saved?.status !== "saved") {
        sentEventKeysRef.current.delete(key);
        setThreadState(event.threadRootId, {
          sending: false,
          error: COMMENT_EVENT_NOT_SAVED_ERROR,
        });
        return;
      }

      try {
        const result = await backend.postCommentEvent(documentPath, {
          type: event.type,
          commentId: event.commentId,
        });
        setThreadState(event.threadRootId, {
          sending: false,
          error: null,
          undelivered: !result.agent.listening,
        });
        setStatus((current) =>
          current
            ? {
                ...current,
                listening: result.agent.listening,
                ...(result.agent.sessionId
                  ? { sessionId: result.agent.sessionId }
                  : {}),
              }
            : current,
        );
      } catch (error) {
        console.error("Failed to send comment event:", error);
        sentEventKeysRef.current.delete(key);
        setThreadState(event.threadRootId, {
          sending: false,
          error: COMMENT_EVENT_SEND_ERROR,
        });
      }
    },
    [backend, documentPath, setThreadState],
  );

  const submitCommentEvent = useCallback(
    (event: PendingEvent) => {
      void send(event);
    },
    [send],
  );

  const retryThread = useCallback(
    (threadRootId: string) => {
      const event = lastEventByThreadRef.current.get(threadRootId);
      if (event) void send(event);
    },
    [send],
  );

  const getThreadState = useCallback(
    (threadRootId: string) => threadStates[threadRootId] ?? idleThreadState,
    [threadStates],
  );

  const listenCommand = absolutePath ? buildListenCommand(absolutePath) : null;
  const undeliveredThreadIds = Object.entries(threadStates)
    .filter(([, state]) => state.undelivered)
    .map(([threadRootId]) => threadRootId);
  const hasUndeliveredState = undeliveredThreadIds.length > 0;
  const hasPickedUpThreads = Object.values(status?.threads ?? {}).some(
    (threadStatus) =>
      threadStatus === "queued" ||
      threadStatus === "delegated" ||
      threadStatus === "working",
  );
  // Parsed only while some thread waits on Claude (not on every keystroke
  // of an ordinary review).
  const openThreadIds = useMemo(
    () =>
      (hasUndeliveredState || hasPickedUpThreads) && markdown != null
        ? new Set(
            getOpenAgentThreads(criticMarkdownComments(markdown).values()).map(
              (thread) => thread.rootId,
            ),
          )
        : null,
    [hasUndeliveredState, hasPickedUpThreads, markdown],
  );
  const threadSummary =
    hasPickedUpThreads && status
      ? summarizeAgentThreads(status.threads, openThreadIds)
      : null;
  // A thread the agent already answered (e.g. via `roughdraft reply` without
  // a listener), or one the user resolved or deleted, no longer waits.
  const hasUndeliveredEvents =
    !status?.listening &&
    undeliveredThreadIds.some(
      (threadRootId) =>
        (openThreadIds?.has(threadRootId) ?? true) &&
        !isHandledThreadStatus(status?.threads[threadRootId]),
    );

  return useMemo(
    () => ({
      available,
      status,
      threadSummary,
      hasUndeliveredEvents,
      listenCommand,
      showResolved,
      setShowResolved,
      getThreadState,
      submitCommentEvent,
      retryThread,
    }),
    [
      available,
      getThreadState,
      hasUndeliveredEvents,
      listenCommand,
      retryThread,
      showResolved,
      status,
      submitCommentEvent,
      threadSummary,
    ],
  );
}
