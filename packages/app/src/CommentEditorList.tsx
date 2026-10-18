import {
  Bot,
  Check,
  CircleCheck,
  Pencil,
  Reply,
  RotateCcw,
  Trash2,
  User,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { NoListenerNotice } from "./AgentConnection";
import { AgentThreadStatusLine } from "./AgentThreadStatus";
import {
  applyCommentIdRenames,
  CommentDraftRenamesContext,
  rekeyRecord,
} from "./comment-draft-renames";
import { CommentMarkdown } from "./CommentMarkdown";
import {
  COMMENT_COMPOSER_MODE_LABELS,
  COMMENT_COMPOSER_MODES,
  type CommentComposerMode,
  defaultCommentAgentContext,
  getCommentSubmitEventType,
  getThreadAgentDisplayStatus,
  isHandledThreadStatus,
  readComposerModePreference,
  useCommentAgent,
  writeComposerModePreference,
} from "./comment-agent";
import {
  getComposerModeShortcutLabel,
  getModeStepHint,
  isComposerSubmitShortcut,
  matchComposerModeShortcut,
  matchModeStepKey,
} from "./comment-shortcuts";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { RadioGroup, RadioGroupSegment } from "./components/ui/radio-group";
import { Textarea } from "./components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";
import {
  buildCommentThreads,
  type CriticComment,
  type CriticCommentIntent,
  type CriticCommentThread,
  flattenCommentThreads,
  isCriticCommentResolved,
} from "./critic-markup";
import { cn } from "./lib/utils";

/** Metadata changes that travel with a content update. */
export interface CommentUpdatePatch {
  intent?: CriticCommentIntent;
  status?: string | null;
}

export type UpdateCommentHandler = (
  commentId: string,
  nextContent: string,
  patch?: CommentUpdatePatch,
) => void;

function getPlatform() {
  return typeof navigator === "undefined" ? null : navigator.platform;
}

function findThreadRoot(
  commentId: string,
  commentMap: ReadonlyMap<string, CriticComment>,
): CriticComment | null {
  let current = commentMap.get(commentId) ?? null;
  const seen = new Set<string>();
  while (current?.parentCommentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = commentMap.get(current.parentCommentId);
    if (!parent) return null;
    current = parent;
  }
  return current;
}

interface CommentEditorListProps {
  comments: CriticComment[];
  variant?: "banner" | "rail";
  selectedCommentId?: string | null;
  hoveredCommentId?: string | null;
  className?: string;
  testId?: string;
  interactive?: boolean;
  onDeleteComment: (commentId: string) => void;
  onUpdateComment: UpdateCommentHandler;
  onSelectComment?: (commentId: string) => void;
  onHoverComment?: (commentId: string | null) => void;
  onFocusComment?: (commentId: string) => void;
  onReplyComment?: (commentId: string) => void;
  pendingFocusCommentId?: string | null;
  newCommentDraftIds?: string[];
  onAutoFocusComment?: (commentId: string) => void;
  renderCommentContent?: (context: CommentContentRenderContext) => ReactNode;
  getCommentActions?: (
    context: CommentActionsRenderContext,
  ) => CommentActionDefinition[];
}

export interface CommentActionDefinition {
  key: string;
  label: string;
  tone?: "neutral" | "danger";
  presentation?: "default" | "popover";
  icon: ReactNode;
  compact?: boolean;
  onClick: (event: MouseEvent) => void;
}

export interface CommentContentRenderContext {
  comment: CriticComment;
  depth: number;
  isEditing: boolean;
  defaultContent: ReactNode;
}

export interface CommentActionsRenderContext {
  comment: CriticComment;
  depth: number;
  isEditing: boolean;
  defaultActions: CommentActionDefinition[];
}

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="radiogroup"]',
    ),
  );
}

function isReplyShortcut(event: KeyboardEvent) {
  return (
    event.key.toLowerCase() === "r" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  );
}

export function CommentEditorList({
  comments,
  variant = "banner",
  selectedCommentId = null,
  hoveredCommentId = null,
  className,
  testId,
  interactive = true,
  onDeleteComment,
  onUpdateComment,
  onSelectComment,
  onHoverComment,
  onFocusComment,
  onReplyComment,
  pendingFocusCommentId = null,
  newCommentDraftIds = [],
  onAutoFocusComment,
  renderCommentContent,
  getCommentActions,
}: CommentEditorListProps) {
  const textareaRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editingCommentIds, setEditingCommentIds] = useState<string[]>([]);
  const agent = useCommentAgent();
  const [preferredMode, setPreferredMode] = useState<CommentComposerMode>(
    readComposerModePreference,
  );
  const [draftModes, setDraftModes] = useState<
    Record<string, CommentComposerMode>
  >({});
  // An external change can claim an open draft's id; the editor then re-keys
  // the draft and this list moves its local state along, before paint.
  const draftRenames = useContext(CommentDraftRenamesContext);
  const appliedDraftRenameCountRef = useRef(draftRenames.length);
  useLayoutEffect(() => {
    const pending = draftRenames.slice(appliedDraftRenameCountRef.current);
    appliedDraftRenameCountRef.current = draftRenames.length;
    if (pending.length === 0) return;
    setDrafts((current) => rekeyRecord(current, pending));
    setDraftModes((current) => rekeyRecord(current, pending));
    setEditingCommentIds((current) =>
      current.map((id) => applyCommentIdRenames(id, pending)),
    );
  }, [draftRenames]);
  const [localShowResolved, setLocalShowResolved] = useState(false);
  const hasAgentProvider = agent !== defaultCommentAgentContext;
  const showResolved = hasAgentProvider
    ? agent.showResolved
    : localShowResolved;
  const setShowResolved = hasAgentProvider
    ? agent.setShowResolved
    : setLocalShowResolved;
  const threads = useMemo(() => buildCommentThreads(comments), [comments]);
  const commentMap = useMemo(
    () => new Map(comments.map((comment) => [comment.id, comment])),
    [comments],
  );
  const hasActiveSelection =
    !!selectedCommentId &&
    comments.some((comment) => comment.id === selectedCommentId);
  const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || !onReplyComment) return;
    if (!isReplyShortcut(event)) return;
    if (isEditableShortcutTarget(event.target)) return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    const rootThread = target.closest<HTMLElement>(
      "[data-comment-thread-root-id]",
    );
    const rootCommentId = rootThread?.dataset.commentThreadRootId;
    if (!rootCommentId) return;

    event.preventDefault();
    event.stopPropagation();
    onReplyComment(rootCommentId);
  };

  useEffect(() => {
    const validCommentIds = new Set(comments.map((comment) => comment.id));

    setDrafts((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([commentId]) =>
          validCommentIds.has(commentId),
        ),
      ),
    );
    setEditingCommentIds((current) =>
      current.filter((commentId) => validCommentIds.has(commentId)),
    );
  }, [comments]);

  useEffect(() => {
    if (!interactive) return;
    if (!pendingFocusCommentId) return;

    const pendingComment = commentMap.get(pendingFocusCommentId);
    if (!pendingComment) return;

    setDrafts((current) => ({
      ...current,
      [pendingFocusCommentId]:
        current[pendingFocusCommentId] ?? pendingComment.content,
    }));
    setEditingCommentIds((current) =>
      current.includes(pendingFocusCommentId)
        ? current
        : [...current, pendingFocusCommentId],
    );
  }, [commentMap, interactive, pendingFocusCommentId]);

  useEffect(() => {
    if (!interactive) return;
    if (!pendingFocusCommentId) return;
    if (!editingCommentIds.includes(pendingFocusCommentId)) return;

    const target = textareaRefs.current.get(pendingFocusCommentId);
    if (!target || target.offsetParent === null) return;

    target.focus();
    const cursorPosition = target.value.length;
    target.setSelectionRange(cursorPosition, cursorPosition);
    onAutoFocusComment?.(pendingFocusCommentId);
  }, [
    editingCommentIds,
    interactive,
    onAutoFocusComment,
    pendingFocusCommentId,
  ]);

  if (comments.length === 0) return null;

  // A reply that escalates a plain thread starts as a plain comment, and its
  // choice is not remembered as the preferred mode for new comments.
  function getDraftMode(commentId: string): CommentComposerMode {
    if (!agent.available) return "comment";
    const isReply = !!commentMap.get(commentId)?.parentCommentId;
    return draftModes[commentId] ?? (isReply ? "comment" : preferredMode);
  }

  const changeDraftMode = (commentId: string, mode: CommentComposerMode) => {
    setDraftModes((current) => ({ ...current, [commentId]: mode }));
    if (commentMap.get(commentId)?.parentCommentId) return;
    setPreferredMode(mode);
    writeComposerModePreference(mode);
  };

  const startEditingComment = (commentId: string) => {
    const comment = commentMap.get(commentId);
    if (!comment) return;

    setDrafts((current) => ({
      ...current,
      [commentId]: current[commentId] ?? comment.content,
    }));
    setEditingCommentIds((current) =>
      current.includes(commentId) ? current : [...current, commentId],
    );
    onSelectComment?.(commentId);
  };

  const stopEditingComment = (commentId: string) => {
    setEditingCommentIds((current) =>
      current.filter((currentCommentId) => currentCommentId !== commentId),
    );
  };

  const submitEditingComment = (commentId: string) => {
    const comment = commentMap.get(commentId);
    if (!comment) return;

    const nextContent = (drafts[commentId] ?? comment.content).trim();

    if (nextContent.length === 0) {
      onDeleteComment(commentId);
      return;
    }

    // Only a brand-new comment (empty until now) can pick a mode or notify the
    // agent; editing an existing comment never re-sends an event. A new reply
    // in a plain thread may escalate it: the intent goes on the thread root
    // and the reply is sent as a follow-up.
    const isNewComment = comment.content.trim().length === 0;
    const isRoot = !comment.parentCommentId;
    const root = isRoot ? comment : findThreadRoot(commentId, commentMap);
    const canEscalateThread =
      !isRoot &&
      isNewComment &&
      !!root &&
      !root.intent &&
      comment.authorType !== "ai";
    const mode =
      isNewComment && (isRoot || canEscalateThread)
        ? getDraftMode(commentId)
        : "comment";
    const patch: CommentUpdatePatch | undefined =
      isRoot && isNewComment && mode !== "comment"
        ? { intent: mode }
        : undefined;
    const escalatedRootIntent =
      canEscalateThread && mode !== "comment" ? mode : undefined;

    if (nextContent !== comment.content || patch) {
      onUpdateComment(commentId, nextContent, patch);
    }
    if (root && escalatedRootIntent) {
      onUpdateComment(root.id, root.content, { intent: escalatedRootIntent });
    }

    if (isNewComment && agent.available) {
      const type = getCommentSubmitEventType({
        isRoot,
        intent: mode,
        rootIntent: escalatedRootIntent ?? root?.intent,
        authorType: comment.authorType,
      });
      if (type && root) {
        agent.submitCommentEvent({
          type,
          commentId,
          threadRootId: root.id,
        });
      }
    }
    setDraftModes((current) => {
      if (!(commentId in current)) return current;
      const next = { ...current };
      delete next[commentId];
      return next;
    });

    setDrafts((current) => {
      const nextDrafts = { ...current };
      delete nextDrafts[commentId];
      return nextDrafts;
    });
    stopEditingComment(commentId);
  };

  const cancelEditingComment = (commentId: string) => {
    const comment = commentMap.get(commentId);
    if (!comment) return;

    setDrafts((current) => {
      const nextDrafts = { ...current };
      delete nextDrafts[commentId];
      return nextDrafts;
    });

    if (comment.content.trim().length === 0) {
      onDeleteComment(commentId);
      return;
    }

    stopEditingComment(commentId);
  };

  return (
    <div
      data-testid={testId}
      data-comment-thread-container="true"
      className={cn(
        variant === "banner"
          ? cn(
              "space-y-2 rounded-xl border border-transparent bg-transparent p-3 shadow-none transition-[background-color,border-color,box-shadow] duration-200 ease-out",
              hasActiveSelection
                ? "border-[#DFDFDC] dark:border-slate-600 bg-white dark:bg-card shadow-[0_20px_48px_rgba(57,47,38,0.14)] dark:shadow-[0_20px_48px_rgba(0,0,0,0.4)]"
                : "",
            )
          : "space-y-1.5 px-4 py-3",
        className,
      )}
      onKeyDownCapture={handleKeyDownCapture}
    >
      {threads.map((thread, index) =>
        isCriticCommentResolved(thread.comment) && !showResolved ? (
          <ResolvedThreadSummary
            key={thread.comment.id}
            thread={thread}
            variant={variant}
            interactive={interactive}
            onShowResolved={() => setShowResolved(true)}
          />
        ) : (
          <CommentThreadNode
            key={thread.comment.id}
            thread={thread}
            depth={0}
            index={index}
            isLast={index === threads.length - 1}
            parentLines={[]}
            variant={variant}
            interactive={interactive}
            drafts={drafts}
            newCommentDraftIds={newCommentDraftIds}
            editingCommentIds={editingCommentIds}
            pendingFocusCommentId={pendingFocusCommentId}
            selectedCommentId={selectedCommentId}
            hoveredCommentId={hoveredCommentId}
            textareaRefs={textareaRefs}
            onDeleteComment={onDeleteComment}
            onUpdateComment={onUpdateComment}
            onSelectComment={onSelectComment}
            onHoverComment={onHoverComment}
            onFocusComment={onFocusComment}
            onReplyComment={onReplyComment}
            onStartEditingComment={startEditingComment}
            onSubmitEditingComment={submitEditingComment}
            onCancelEditingComment={cancelEditingComment}
            renderCommentContent={renderCommentContent}
            getCommentActions={getCommentActions}
            onChangeDraft={(commentId, nextContent) => {
              setDrafts((current) => ({
                ...current,
                [commentId]: nextContent,
              }));
            }}
            getDraftMode={getDraftMode}
            onChangeDraftMode={changeDraftMode}
            showResolved={showResolved}
            onHideResolved={() => setShowResolved(false)}
          />
        ),
      )}
    </div>
  );
}

function ResolvedThreadSummary({
  thread,
  variant,
  interactive,
  onShowResolved,
}: {
  thread: CriticCommentThread;
  variant: "banner" | "rail";
  interactive: boolean;
  onShowResolved: () => void;
}) {
  const replyCount = flattenCommentThreads([thread]).length - 1;
  const excerpt = thread.comment.content.replace(/\s+/g, " ").trim();

  return (
    <div
      data-testid={`comment-${variant}-${thread.comment.id}-resolved`}
      data-comment-thread-root-id={thread.comment.id}
      data-comment-resolved="true"
      className="flex min-w-0 items-center gap-1.5 text-[12px] leading-5 text-stone-400 dark:text-slate-500"
    >
      <CircleCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" />
      <span className="shrink-0 font-medium text-stone-500 dark:text-slate-400">
        Resolved
      </span>
      <span className="min-w-0 truncate">
        {excerpt}
        {replyCount > 0
          ? ` · ${replyCount} ${replyCount === 1 ? "reply" : "replies"}`
          : ""}
      </span>
      {interactive ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid={`comment-${variant}-${thread.comment.id}-show-resolved`}
          className="ml-auto shrink-0 text-stone-500 dark:text-slate-400"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onShowResolved();
          }}
        >
          Show resolved
        </Button>
      ) : null}
    </div>
  );
}

interface CommentThreadNodeProps {
  thread: CriticCommentThread;
  depth: number;
  index: number;
  isLast: boolean;
  parentLines: boolean[];
  variant: "banner" | "rail";
  interactive: boolean;
  drafts: Record<string, string>;
  newCommentDraftIds: string[];
  editingCommentIds: string[];
  pendingFocusCommentId: string | null;
  selectedCommentId: string | null;
  hoveredCommentId: string | null;
  textareaRefs: MutableRefObject<Map<string, HTMLTextAreaElement>>;
  onDeleteComment: (commentId: string) => void;
  onUpdateComment: UpdateCommentHandler;
  onSelectComment?: (commentId: string) => void;
  onHoverComment?: (commentId: string | null) => void;
  onFocusComment?: (commentId: string) => void;
  onReplyComment?: (commentId: string) => void;
  onStartEditingComment: (commentId: string) => void;
  onSubmitEditingComment: (commentId: string) => void;
  onCancelEditingComment: (commentId: string) => void;
  renderCommentContent?: (context: CommentContentRenderContext) => ReactNode;
  getCommentActions?: (
    context: CommentActionsRenderContext,
  ) => CommentActionDefinition[];
  onChangeDraft: (commentId: string, nextContent: string) => void;
  getDraftMode: (commentId: string) => CommentComposerMode;
  onChangeDraftMode: (commentId: string, mode: CommentComposerMode) => void;
  showResolved: boolean;
  onHideResolved: () => void;
  /** The thread root's intent, for replies. */
  threadRootIntent?: CriticCommentIntent;
}

const COMMENT_TREE_INDENT = 16;
const COMMENT_TREE_ELBOW_TOP = 12;
const COMMENT_TREE_ROW_GAP = 10;
const COMMENT_AVATAR_SIZE = 20;
const COMMENT_AVATAR_CENTER = 12;

function CommentActionButton({
  label,
  testId,
  tone = "neutral",
  presentation = "default",
  icon,
  compact = false,
  className,
  onClick,
}: {
  label: string;
  testId?: string;
  tone?: "neutral" | "danger";
  presentation?: "default" | "popover";
  icon: ReactNode;
  compact?: boolean;
  className?: string;
  onClick: (event: MouseEvent) => void;
}) {
  const button = (
    <Button
      type="button"
      aria-label={compact ? label : undefined}
      data-testid={testId}
      variant="ghost"
      size={compact ? "icon-xs" : "sm"}
      className={cn(
        presentation === "popover" && !compact
          ? "h-9 w-full rounded-xl bg-[#E8E3DB] px-3 py-2 text-sm font-bold normal-case tracking-normal text-black shadow-[inset_0_1px_0_rgba(255,251,245,0.72)] hover:bg-[#ded8ce] hover:text-black dark:bg-slate-700 dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] dark:hover:bg-slate-600 dark:hover:text-slate-100"
          : compact
            ? "rounded-full border border-transparent transition-colors duration-150"
            : "h-7 rounded-full border border-transparent px-2.5 text-[11px] font-medium tracking-[0.08em] uppercase transition-colors duration-150",
        presentation === "popover"
          ? ""
          : tone === "danger"
            ? "text-stone-400 hover:bg-rose-100 hover:text-rose-700 dark:text-stone-500 dark:hover:bg-rose-900/40 dark:hover:text-rose-400"
            : "text-stone-400 hover:bg-[#DED8CE]/45 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-slate-700 dark:hover:text-stone-300",
        className,
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      {icon}
      {compact ? null : <span>{label}</span>}
    </Button>
  );

  if (!compact) return button;

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function CommentThreadNode({
  thread,
  depth,
  index,
  isLast,
  parentLines,
  variant,
  interactive,
  drafts,
  newCommentDraftIds,
  editingCommentIds,
  pendingFocusCommentId,
  selectedCommentId,
  hoveredCommentId,
  textareaRefs,
  onDeleteComment,
  onUpdateComment,
  onSelectComment,
  onHoverComment,
  onFocusComment,
  onReplyComment,
  onStartEditingComment,
  onSubmitEditingComment,
  onCancelEditingComment,
  renderCommentContent,
  getCommentActions,
  onChangeDraft,
  getDraftMode,
  onChangeDraftMode,
  showResolved,
  onHideResolved,
  threadRootIntent,
}: CommentThreadNodeProps) {
  const agent = useCommentAgent();
  const { comment, replies } = thread;
  const hasReplies = replies.length > 0;
  const isRootThread = depth === 0;
  const isSelected = comment.id === selectedCommentId;
  const isHovered = comment.id === hoveredCommentId;
  const isEditing = interactive && editingCommentIds.includes(comment.id);
  const isAiAuthor = comment.authorType === "ai";
  const userAuthorId = comment.authorId?.trim();
  const authorLabel = isAiAuthor
    ? "AI"
    : userAuthorId && userAuthorId.toLowerCase() !== "user"
      ? userAuthorId
      : "Me";
  const AuthorIcon = isAiAuthor ? Bot : User;
  const draftContent = drafts[comment.id] ?? comment.content;
  const avatarTone = isAiAuthor
    ? variant === "banner"
      ? "border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-700 dark:bg-sky-900 dark:text-sky-400"
      : "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-900 dark:text-sky-400"
    : variant === "banner"
      ? "border-[#D2C7B8] bg-[#DED8CE] text-stone-700 dark:border-slate-600 dark:bg-slate-700 dark:text-stone-300"
      : "border-[#D2C7B8] bg-[#DED8CE] text-stone-700 dark:border-slate-600 dark:bg-slate-700 dark:text-stone-300";
  const bodyTone =
    variant === "banner"
      ? isSelected
        ? "bg-white"
        : isHovered
          ? "bg-white"
          : "bg-transparent"
      : "bg-transparent";
  const treeLineTone =
    variant === "banner"
      ? "bg-[#DED8CE]/90 dark:bg-slate-600/90"
      : "bg-[#DED8CE]/85 dark:bg-slate-600/85";
  const hasCommentContent = comment.content.trim().length > 0;
  const isResolved = isRootThread && isCriticCommentResolved(comment);
  const rootIntent = isRootThread ? comment.intent : undefined;
  // New root comments pick a mode; a new user reply can escalate a plain
  // thread (replies in an Ask/Change thread inherit its intent).
  const showComposerModes =
    isEditing &&
    !hasCommentContent &&
    agent.available &&
    (isRootThread || (!threadRootIntent && !isAiAuthor));
  const draftMode = showComposerModes ? getDraftMode(comment.id) : "comment";
  // Keyboard flow: the first Mod+Enter confirms the text and moves here; the
  // second one sends with the chosen mode (see comment-shortcuts.ts).
  const [isChoosingModeState, setChoosingMode] = useState(false);
  const isChoosingMode = showComposerModes && isChoosingModeState;
  const modeRadioRefs = useRef(new Map<CommentComposerMode, HTMLElement>());
  const focusModeRadio = (mode: CommentComposerMode) => {
    modeRadioRefs.current.get(mode)?.focus();
  };
  const selectDraftMode = (mode: CommentComposerMode) => {
    onChangeDraftMode(comment.id, mode);
    focusModeRadio(mode);
  };
  const enterModeStep = () => {
    setChoosingMode(true);
    focusModeRadio(draftMode);
  };
  const returnToEditing = () => {
    setChoosingMode(false);
    const textarea = textareaRefs.current.get(comment.id);
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  };
  const submitDraft = () => {
    setChoosingMode(false);
    onSubmitEditingComment(comment.id);
  };
  /** Keys of the mode-selection step; returns whether the key was handled. */
  const handleModeStepKey = (event: KeyboardEvent) => {
    const shortcut = matchComposerModeShortcut(event, getPlatform());
    if (shortcut) {
      setChoosingMode(true);
      selectDraftMode(draftMode === shortcut ? "comment" : shortcut);
      return true;
    }
    const action = matchModeStepKey(event);
    if (!action) return false;
    if (action.type === "submit") {
      submitDraft();
    } else if (action.type === "edit") {
      returnToEditing();
    } else {
      const currentIndex = COMMENT_COMPOSER_MODES.indexOf(draftMode);
      const count = COMMENT_COMPOSER_MODES.length;
      const nextIndex =
        action.type === "select"
          ? action.index
          : (currentIndex + action.delta + count) % count;
      const next = COMMENT_COMPOSER_MODES[nextIndex];
      if (!next) return false;
      setChoosingMode(true);
      selectDraftMode(next);
    }
    return true;
  };
  const threadState = isRootThread ? agent.getThreadState(comment.id) : null;
  const latestThreadComment = isRootThread
    ? flattenCommentThreads([thread]).at(-1)
    : undefined;
  const agentDisplayStatus = isRootThread
    ? getThreadAgentDisplayStatus({
        intent: rootIntent,
        resolved: isResolved,
        sending: threadState?.sending ?? false,
        serverStatus: agent.status?.threads[comment.id],
        latestCommentIsFromAgent:
          latestThreadComment !== undefined &&
          latestThreadComment.id !== comment.id &&
          latestThreadComment.authorType === "ai",
      })
    : null;
  const showNoListenerNotice =
    isRootThread &&
    !isResolved &&
    !!threadState?.undelivered &&
    !agent.status?.listening &&
    !isHandledThreadStatus(agentDisplayStatus);
  const defaultContent = hasCommentContent ? (
    <CommentMarkdown
      content={comment.content}
      testId={`comment-${variant}-${comment.id}-body`}
    />
  ) : (
    "Empty comment"
  );
  const isNewRootCommentDraft =
    isEditing &&
    depth === 0 &&
    (comment.id === pendingFocusCommentId ||
      newCommentDraftIds.includes(comment.id));
  const renderedContent =
    renderCommentContent?.({
      comment,
      depth,
      isEditing,
      defaultContent,
    }) ?? defaultContent;
  const defaultActions: CommentActionDefinition[] = isEditing
    ? [
        {
          key: "save",
          label: "Save",
          presentation: isNewRootCommentDraft ? "popover" : "default",
          icon: <Check className="size-3.5" />,
          onClick: (event) => {
            event.stopPropagation();
            onSubmitEditingComment(comment.id);
          },
        },
        {
          key: "cancel",
          label: "Cancel",
          icon: <X className="size-3.5" />,
          onClick: (event) => {
            event.stopPropagation();
            onCancelEditingComment(comment.id);
          },
        },
      ]
    : [
        {
          key: "reply",
          label: "Reply",
          icon: <Reply className="size-3.5" />,
          compact: true,
          onClick: (event) => {
            event.stopPropagation();
            onReplyComment?.(comment.id);
          },
        },
        {
          key: "edit",
          label: "Edit",
          icon: <Pencil className="size-3.5" />,
          compact: true,
          onClick: (event) => {
            event.stopPropagation();
            onStartEditingComment(comment.id);
          },
        },
        {
          key: "delete",
          label: "Delete",
          tone: "danger",
          icon: <Trash2 className="size-3.5" />,
          compact: true,
          onClick: (event) => {
            event.stopPropagation();
            onDeleteComment(comment.id);
          },
        },
        ...(isRootThread && hasCommentContent
          ? [
              isResolved
                ? {
                    key: "reopen",
                    label: "Reopen thread",
                    icon: <RotateCcw className="size-3.5" />,
                    compact: true,
                    onClick: (event: MouseEvent) => {
                      event.stopPropagation();
                      onUpdateComment(comment.id, comment.content, {
                        status: null,
                      });
                    },
                  }
                : {
                    key: "resolve",
                    label: "Resolve thread",
                    icon: <CircleCheck className="size-3.5" />,
                    compact: true,
                    onClick: (event: MouseEvent) => {
                      event.stopPropagation();
                      onUpdateComment(comment.id, comment.content, {
                        status: "resolved",
                      });
                    },
                  },
            ]
          : []),
      ];
  const defaultVisibleActions = isNewRootCommentDraft
    ? defaultActions.filter((action) => action.key !== "cancel")
    : defaultActions;
  const actions =
    getCommentActions?.({
      comment,
      depth,
      isEditing,
      defaultActions: defaultVisibleActions,
    }) ?? defaultVisibleActions;
  const ancestorGuideOffsets = parentLines.reduce<number[]>(
    (offsets, showLine, guideIndex) => {
      if (showLine) {
        offsets.push(guideIndex * COMMENT_TREE_INDENT + COMMENT_AVATAR_CENTER);
      }
      return offsets;
    },
    [],
  );

  return (
    <div
      data-testid={`comment-${variant}-${comment.id}`}
      data-comment-thread-root-id={isRootThread ? comment.id : undefined}
      tabIndex={interactive && isRootThread ? 0 : undefined}
      className={cn(
        "relative transition-all duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-300 dark:focus-visible:ring-slate-600",
        variant === "rail" &&
          isRootThread &&
          (index > 0
            ? "border-t border-slate-200/80 dark:border-slate-700/80 pt-3"
            : "pt-0"),
      )}
      onClick={() => {
        if (!interactive) return;
        onSelectComment?.(comment.id);
      }}
      onMouseEnter={() => {
        if (!interactive) return;
        onHoverComment?.(comment.id);
      }}
      onMouseLeave={() => {
        if (!interactive) return;
        onHoverComment?.(null);
      }}
      onPointerDown={() => {
        if (!interactive) return;
        onSelectComment?.(comment.id);
      }}
    >
      <div className="relative flex min-w-0 items-stretch">
        {depth > 0 ? (
          <div
            aria-hidden="true"
            className="pointer-events-none relative shrink-0 self-stretch"
            style={{ width: depth * COMMENT_TREE_INDENT }}
          >
            {ancestorGuideOffsets.map((left) => (
              <div
                key={`${comment.id}-guide-${left}`}
                data-testid="comment-tree-line"
                className={cn("absolute top-0 bottom-0 w-px", treeLineTone)}
                style={{
                  left,
                  top: -COMMENT_TREE_ROW_GAP,
                  bottom: -COMMENT_TREE_ROW_GAP,
                }}
              />
            ))}
            <div
              data-testid="comment-tree-line"
              className={cn(
                "absolute w-px",
                treeLineTone,
                isLast ? "" : "bottom-0",
              )}
              style={{
                left: (depth - 1) * COMMENT_TREE_INDENT + COMMENT_AVATAR_CENTER,
                top: -COMMENT_TREE_ROW_GAP,
                ...(isLast
                  ? {
                      height: COMMENT_TREE_ELBOW_TOP + COMMENT_TREE_ROW_GAP,
                    }
                  : {
                      bottom: -COMMENT_TREE_ROW_GAP,
                    }),
              }}
            />
            <div
              data-testid="comment-tree-line"
              className={cn("absolute h-px", treeLineTone)}
              style={{
                left: (depth - 1) * COMMENT_TREE_INDENT + COMMENT_AVATAR_CENTER,
                top: COMMENT_TREE_ELBOW_TOP,
                width: COMMENT_TREE_INDENT,
              }}
            />
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-1.5">
            {interactive && isRootThread ? (
              <CommentActionButton
                label="Delete thread"
                testId={`comment-${variant}-${comment.id}-action-delete-thread`}
                tone="danger"
                icon={<Trash2 className="size-3.5" />}
                compact
                className="absolute top-0 right-0 z-20 bg-white/80 dark:bg-slate-800/80"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteComment(comment.id);
                }}
              />
            ) : null}
            {hasReplies ? (
              <div
                aria-hidden="true"
                data-testid="comment-tree-line"
                className={cn(
                  "pointer-events-none absolute w-px",
                  treeLineTone,
                )}
                style={{
                  left: COMMENT_AVATAR_CENTER,
                  top: COMMENT_AVATAR_SIZE,
                  bottom: -COMMENT_TREE_ROW_GAP,
                }}
              />
            ) : null}
            <div className="relative flex justify-center">
              <div
                className={cn(
                  "relative z-10 flex size-5 items-center justify-center rounded-full border shadow-[0_1px_2px_rgba(15,23,42,0.08)]",
                  avatarTone,
                )}
                title={authorLabel}
              >
                <AuthorIcon className="size-2.5 shrink-0" />
              </div>
            </div>
            <div
              className={cn(
                "min-w-0 rounded-xl px-0.5",
                isRootThread && interactive && !isEditing && "pr-7",
                bodyTone,
              )}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <div className="max-w-full truncate text-xs font-semibold text-slate-900 dark:text-slate-100">
                  {authorLabel}
                </div>
                {rootIntent ? (
                  <Badge
                    data-testid={`comment-${variant}-${comment.id}-intent`}
                    variant="outline"
                    className={cn(
                      "h-4 px-1.5 text-[0.6rem]",
                      rootIntent === "ask"
                        ? "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300"
                        : "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300",
                    )}
                  >
                    {COMMENT_COMPOSER_MODE_LABELS[rootIntent]}
                  </Badge>
                ) : null}
                {isResolved ? (
                  <Badge
                    data-testid={`comment-${variant}-${comment.id}-resolved-badge`}
                    variant="secondary"
                    className="h-4 px-1.5 text-[0.6rem]"
                  >
                    <CircleCheck />
                    Resolved
                  </Badge>
                ) : null}
                {isResolved && showResolved && interactive ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    data-testid={`comment-${variant}-${comment.id}-hide-resolved`}
                    className="h-4 px-1 text-[0.6rem] text-stone-400"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onHideResolved();
                    }}
                  >
                    Hide resolved
                  </Button>
                ) : null}
              </div>
              <div
                className={cn(
                  "mt-0.5 text-[13px] leading-5 whitespace-pre-wrap",
                  !hasCommentContent && "italic",
                  variant === "banner"
                    ? "text-slate-800 dark:text-slate-200"
                    : "text-slate-700 dark:text-slate-300",
                )}
              >
                {isEditing ? null : renderedContent}
              </div>
              {agentDisplayStatus ? (
                <AgentThreadStatusLine
                  status={agentDisplayStatus}
                  listening={agent.status?.listening === true}
                  since={agent.status?.threadDetails?.[comment.id]?.since}
                  delegatedTo={
                    agent.status?.threadDetails?.[comment.id]?.delegatedTo
                  }
                  requestedAt={
                    agentDisplayStatus === "sending"
                      ? undefined
                      : agent.status?.threadDetails?.[comment.id]?.requestedAt
                  }
                  testId={`comment-${variant}-${comment.id}-agent-status`}
                />
              ) : null}
              {showNoListenerNotice ? (
                <NoListenerNotice
                  listenCommand={agent.listenCommand}
                  testId={`comment-${variant}-${comment.id}-agent-notice`}
                  className="mt-2"
                />
              ) : null}
              {isRootThread && !isResolved && threadState?.error ? (
                <Alert
                  variant="destructive"
                  data-testid={`comment-${variant}-${comment.id}-agent-error`}
                  className="mt-2"
                >
                  <AlertTitle>{threadState.error}</AlertTitle>
                  <AlertDescription>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      data-testid={`comment-${variant}-${comment.id}-agent-retry`}
                      className="mt-1"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        agent.retryThread(comment.id);
                      }}
                    >
                      Retry
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : null}
              {isEditing ? (
                <Textarea
                  data-testid={`comment-${variant}-${comment.id}-editor`}
                  ref={(node) => {
                    if (node) {
                      textareaRefs.current.set(comment.id, node);
                    } else {
                      textareaRefs.current.delete(comment.id);
                    }
                  }}
                  value={draftContent}
                  placeholder={
                    depth === 0 ? "Add your comment" : "Write a reply"
                  }
                  rows={1}
                  readOnly={isChoosingMode}
                  className={cn(
                    "mt-2 min-h-12 px-2.5 py-2 text-[13px] leading-5 md:text-[13px] md:leading-5",
                    variant === "banner"
                      ? "border-amber-200 dark:border-amber-700 bg-white/90 dark:bg-slate-800/90 text-slate-800 dark:text-slate-200"
                      : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 shadow-none",
                    isChoosingMode &&
                      "cursor-default border-dashed bg-stone-50 text-stone-600 focus-visible:ring-0 dark:bg-slate-900/60 dark:text-slate-400",
                  )}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    onSelectComment?.(comment.id);
                    // Clicking the confirmed text goes back to editing it.
                    if (isChoosingMode) setChoosingMode(false);
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                  onKeyDown={(event) => {
                    if (isChoosingMode) {
                      if (handleModeStepKey(event)) {
                        event.preventDefault();
                        event.stopPropagation();
                      }
                      return;
                    }

                    if (showComposerModes) {
                      const target = matchComposerModeShortcut(
                        event,
                        getPlatform(),
                      );
                      if (target) {
                        event.preventDefault();
                        event.stopPropagation();
                        onChangeDraftMode(
                          comment.id,
                          draftMode === target ? "comment" : target,
                        );
                        return;
                      }
                    }

                    if (isComposerSubmitShortcut(event)) {
                      event.preventDefault();
                      event.stopPropagation();
                      if (showComposerModes && draftContent.trim().length > 0) {
                        enterModeStep();
                      } else {
                        onSubmitEditingComment(comment.id);
                      }
                      return;
                    }

                    if (event.key !== "Escape") return;

                    event.preventDefault();
                    event.stopPropagation();
                    onCancelEditingComment(comment.id);
                  }}
                  onFocus={() => {
                    onSelectComment?.(comment.id);
                  }}
                  onChange={(event) => {
                    onChangeDraft(comment.id, event.target.value);
                  }}
                />
              ) : null}
              {showComposerModes ? (
                <ComposerModeToggle
                  commentId={comment.id}
                  variant={variant}
                  mode={draftMode}
                  choosing={isChoosingMode}
                  radioRefs={modeRadioRefs}
                  onChange={(mode) => onChangeDraftMode(comment.id, mode)}
                  onKeyDown={handleModeStepKey}
                />
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {actions.map((action) => (
                  <CommentActionButton
                    key={action.key}
                    label={action.label}
                    testId={`comment-${variant}-${comment.id}-action-${action.key}`}
                    tone={action.tone}
                    presentation={action.presentation}
                    icon={action.icon}
                    compact={action.compact}
                    onClick={action.onClick}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      {hasReplies ? (
        <div className="mt-2.5 space-y-2.5">
          {replies.map((reply, replyIndex) => (
            <CommentThreadNode
              key={reply.comment.id}
              thread={reply}
              depth={depth + 1}
              index={replyIndex}
              isLast={replyIndex === replies.length - 1}
              parentLines={depth === 0 ? [] : [...parentLines, !isLast]}
              variant={variant}
              interactive={interactive}
              drafts={drafts}
              newCommentDraftIds={newCommentDraftIds}
              editingCommentIds={editingCommentIds}
              pendingFocusCommentId={pendingFocusCommentId}
              selectedCommentId={selectedCommentId}
              hoveredCommentId={hoveredCommentId}
              textareaRefs={textareaRefs}
              onDeleteComment={onDeleteComment}
              onUpdateComment={onUpdateComment}
              onSelectComment={onSelectComment}
              onHoverComment={onHoverComment}
              onFocusComment={onFocusComment}
              onReplyComment={onReplyComment}
              onStartEditingComment={onStartEditingComment}
              onSubmitEditingComment={onSubmitEditingComment}
              onCancelEditingComment={onCancelEditingComment}
              renderCommentContent={renderCommentContent}
              getCommentActions={getCommentActions}
              onChangeDraft={onChangeDraft}
              getDraftMode={getDraftMode}
              onChangeDraftMode={onChangeDraftMode}
              showResolved={showResolved}
              onHideResolved={onHideResolved}
              threadRootIntent={
                isRootThread ? comment.intent : threadRootIntent
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const composerModeHints: Record<CommentComposerMode, string> = {
  comment: "A note for the document. Claude is not notified.",
  ask: "Claude answers in this thread without editing the document.",
  change: "Claude edits the document and replies with what changed.",
};

function ComposerModeToggle({
  commentId,
  variant,
  mode,
  choosing,
  radioRefs,
  onChange,
  onKeyDown,
}: {
  commentId: string;
  variant: "banner" | "rail";
  mode: CommentComposerMode;
  /** The keyboard mode-selection step is active. */
  choosing: boolean;
  radioRefs: MutableRefObject<Map<CommentComposerMode, HTMLElement>>;
  onChange: (mode: CommentComposerMode) => void;
  /** Mode-selection step keys; returns whether the key was handled. */
  onKeyDown: (event: KeyboardEvent) => boolean;
}) {
  const platform = getPlatform();
  const testIdPrefix = `comment-${variant}-${commentId}-mode`;
  const stepHintId = `${testIdPrefix}-step-hint`;

  return (
    // Capture phase: the step's keys (digits, arrows, Enter, Escape) are
    // handled here before the radio group's own arrow-key navigation, so the
    // selection and focus move together and Enter sends.
    <div
      className="mt-2 space-y-1"
      onKeyDownCapture={(event) => {
        if (onKeyDown(event)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <RadioGroup
        aria-label="Comment type"
        aria-describedby={stepHintId}
        data-testid={testIdPrefix}
        data-choosing={choosing ? "true" : undefined}
        className={cn(
          "flex w-fit flex-row gap-0 rounded-md",
          choosing &&
            "ring-2 ring-amber-300 ring-offset-1 ring-offset-white dark:ring-amber-600 dark:ring-offset-slate-900",
        )}
        value={mode}
        onValueChange={(value) => {
          if (value === "comment" || value === "ask" || value === "change") {
            onChange(value);
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {COMMENT_COMPOSER_MODES.map((option, index) => (
          <RadioGroupSegment
            key={option}
            value={option}
            ref={(node: HTMLElement | null) => {
              if (node) radioRefs.current.set(option, node);
              else radioRefs.current.delete(option);
            }}
            data-testid={`${testIdPrefix}-${option}`}
            title={
              option === "comment"
                ? `${COMMENT_COMPOSER_MODE_LABELS[option]} (${index + 1})`
                : `${COMMENT_COMPOSER_MODE_LABELS[option]} (${index + 1} · ${getComposerModeShortcutLabel(option, platform)})`
            }
            className="h-6 px-2 text-[11px] data-checked:bg-stone-800 data-checked:text-white dark:data-checked:bg-slate-200 dark:data-checked:text-slate-900"
          >
            {COMMENT_COMPOSER_MODE_LABELS[option]}
          </RadioGroupSegment>
        ))}
      </RadioGroup>
      <p
        data-testid={`${testIdPrefix}-hint`}
        className="text-[11px] leading-4 text-stone-400 dark:text-slate-500"
      >
        {composerModeHints[mode]}
      </p>
      <p
        id={stepHintId}
        data-testid={stepHintId}
        aria-live="polite"
        className={cn(
          "text-[11px] leading-4 text-stone-500 dark:text-slate-400",
          !choosing && "sr-only",
        )}
      >
        {/* Wrap only between items, never inside "⌘↵ send". */}
        {choosing
          ? getModeStepHint(platform)
              .split(" · ")
              .map((item, index) => (
                <span key={item}>
                  {index > 0 ? " · " : null}
                  <span className="whitespace-nowrap">{item}</span>
                </span>
              ))
          : null}
      </p>
    </div>
  );
}
