import type { JSONContent } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCanvasScale } from "./Canvas";
import { CommentEditorList } from "./CommentEditorList";
import { DocumentCommentRail } from "./DocumentCommentRail";
import {
  createCriticComment,
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
  getCommentDescendantIds,
  type CriticComment,
} from "./critic-markup";
import { getPreferredCommentId, parseCommentIds } from "./document-comments";
import { EditorContextMenu } from "./EditorContextMenu";
import {
  commentHighlightPluginKey,
  createEditorExtensions,
} from "./editor-extensions";
import { EditorToolbar } from "./EditorToolbar";
import { cn } from "./lib/utils";
import { MarkdownCodeEditor } from "./MarkdownCodeEditor";
import { toHtml } from "./markdown";
import type { Page, StorageBackend } from "./storage";
import { useCommentAnchorLayout } from "./useCommentAnchorLayout";

const CANVAS_CONTENT_WIDTH = 680;
const CANVAS_CONTENT_HORIZONTAL_PADDING = 20;
const CANVAS_EDITOR_FRAME_WIDTH =
  CANVAS_CONTENT_WIDTH - CANVAS_CONTENT_HORIZONTAL_PADDING * 2;
const CANVAS_RAIL_WIDTH = 420;
const CANVAS_RAIL_GAP = 24;

type SaveState = "idle" | "saving" | "error";
type EditorViewMode = "rich-text" | "code";

interface PageCardProps {
  page: Page;
  x?: number;
  y?: number;
  selected?: boolean;
  focusRequestKey?: string | null;
  canDelete?: boolean;
  mode?: "canvas" | "document";
  onSelect?: (id: string) => void;
  onSave: (id: string, content: string) => Promise<void>;
  onReposition?: (id: string, x: number, y: number) => void;
  onDelete?: (id: string) => void;
  onSaveStateChange?: (state: SaveState) => void;
  editorViewMode?: EditorViewMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
}

interface PageCardEditorSurfaceProps {
  page: Page;
  selected: boolean;
  focusRequestKey: string | null;
  mode: "canvas" | "document";
  onSelect?: (id: string) => void;
  onSave: (id: string, content: string) => Promise<void>;
  onSaveStateChange: (state: SaveState) => void;
  editorViewMode: EditorViewMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
}

interface RichTextEditorSurfaceProps {
  page: Page;
  selected: boolean;
  focusRequestKey: string | null;
  mode: "canvas" | "document";
  sourceMarkdown: string;
  onSelect?: (id: string) => void;
  onMarkdownChange: (markdown: string) => void;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
}

interface CodeEditorSurfaceProps {
  page: Page;
  markdown: string;
  hasCommentRailSpace: boolean;
  onSelect?: (id: string) => void;
  onMarkdownChange: (markdown: string) => void;
}

function getCanvasFilenameLabel(pageId: string) {
  const leaf = pageId.split(/[\\/]/).filter(Boolean).at(-1) || pageId;
  return leaf.toLowerCase().endsWith(".md") ? leaf : `${leaf}.md`;
}

function areCommentIdListsEqual(
  current: string[] | null | undefined,
  next: string[] | null | undefined,
) {
  if (!current || !next) return current === next;
  if (current.length !== next.length) return false;
  return current.every((commentId, index) => commentId === next[index]);
}

function getSelectionCommentIds(editor: Editor | null): string[] {
  if (!editor) return [];

  const directAttributes = editor.getAttributes("commentRef").commentIds;

  if (Array.isArray(directAttributes) && directAttributes.length > 0) {
    return directAttributes;
  }

  const { from, to, empty, $from } = editor.state.selection;
  const commentIds = new Set<string>();

  if (empty) {
    for (const mark of $from.marks()) {
      if (mark.type.name !== "commentRef") continue;

      for (const commentId of mark.attrs.commentIds ?? []) {
        commentIds.add(commentId);
      }
    }
  } else {
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (!node.isText) return;

      for (const mark of node.marks) {
        if (mark.type.name !== "commentRef") continue;

        for (const commentId of mark.attrs.commentIds ?? []) {
          commentIds.add(commentId);
        }
      }
    });
  }

  return [...commentIds];
}

function findCommentRange(editor: Editor | null, commentId: string) {
  if (!editor) return null;

  const commentMarkType = editor.state.schema.marks.commentRef;
  if (!commentMarkType) return null;

  let from: number | null = null;
  let to: number | null = null;
  let closed = false;

  editor.state.doc.descendants((node, pos) => {
    if (closed || !node.isText) return false;

    const hasCommentId = node.marks.some(
      (mark) =>
        mark.type === commentMarkType &&
        Array.isArray(mark.attrs.commentIds) &&
        mark.attrs.commentIds.includes(commentId),
    );

    if (!hasCommentId) {
      if (from != null && to != null && pos >= to) {
        closed = true;
      }
      return;
    }

    if (from == null || to == null) {
      from = pos;
      to = pos + node.nodeSize;
      return;
    }

    if (pos <= to) {
      to = pos + node.nodeSize;
      return;
    }

    closed = true;
  });

  if (from == null || to == null) return null;

  return { from, to };
}

function findCommentAnchorElement(editor: Editor | null, commentId: string) {
  if (!editor) return null;

  const anchors = editor.view.dom.querySelectorAll<HTMLElement>(
    ".comment-anchor[data-comment-ids]",
  );

  return (
    [...anchors].find((anchor) =>
      parseCommentIds(anchor.dataset.commentIds).includes(commentId),
    ) ?? null
  );
}

function getAnchorCommentIds(
  editor: Editor | null,
  commentId: string,
): string[] {
  const anchorElement = findCommentAnchorElement(editor, commentId);
  if (!anchorElement) return [];
  return parseCommentIds(anchorElement.dataset.commentIds);
}

function addCommentIdsToAnchor(
  editor: Editor | null,
  anchorCommentId: string,
  commentIdsToAdd: string[],
): string[] | null {
  if (!editor) return null;

  const commentMarkType = editor.state.schema.marks.commentRef;
  const anchorCommentIds = getAnchorCommentIds(editor, anchorCommentId);
  const nextCommentIds = [
    ...new Set([...anchorCommentIds, ...commentIdsToAdd]),
  ];
  if (!commentMarkType || anchorCommentIds.length === 0) return null;

  let found = false;
  const tr = editor.state.tr;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;

    const mark = node.marks.find(
      (candidate) =>
        candidate.type === commentMarkType &&
        Array.isArray(candidate.attrs.commentIds) &&
        candidate.attrs.commentIds.includes(anchorCommentId),
    );

    if (!mark) return;

    found = true;

    const from = pos;
    const to = pos + node.nodeSize;
    tr.removeMark(from, to, commentMarkType);
    tr.addMark(
      from,
      to,
      commentMarkType.create({ commentIds: nextCommentIds }),
    );
  });

  if (!found) return null;

  editor.view.dispatch(tr);
  return nextCommentIds;
}

export function shouldDismissCommentThread(target: EventTarget | null) {
  if (!(target instanceof Element)) return true;

  return !target.closest(
    '[data-comment-thread-container="true"], .comment-anchor[data-comment-ids]',
  );
}

const RichTextEditorSurface = memo(function RichTextEditorSurface({
  page,
  selected,
  focusRequestKey,
  mode,
  sourceMarkdown,
  onSelect,
  onMarkdownChange,
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
}: RichTextEditorSurfaceProps) {
  const editorRef = useRef<Editor | null>(null);
  const commentsRef = useRef<Map<string, CriticComment>>(new Map());
  const lastFocusRequestKeyRef = useRef<string | null>(null);
  const selectedCommentIdRef = useRef<string | null>(null);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(
    null,
  );
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);
  const [pendingFocusCommentId, setPendingFocusCommentId] = useState<
    string | null
  >(null);

  const resolveFileUrl = useCallback(
    (path: string) => backend.resolveFileUrl(path),
    [backend],
  );

  const parsedContent = useMemo(
    () =>
      criticMarkdownToEditorState(sourceMarkdown, {
        resolveFileUrl,
      }),
    [resolveFileUrl, sourceMarkdown],
  );
  const [comments, setComments] = useState<Map<string, CriticComment>>(
    () => parsedContent.comments,
  );

  useEffect(() => {
    commentsRef.current = comments;
  }, [comments]);

  useEffect(() => {
    onCommentRailPresenceChange?.(comments.size > 0);
  }, [comments.size, onCommentRailPresenceChange]);

  const emitMarkdownChange = useCallback(
    (doc?: JSONContent, nextComments?: Map<string, CriticComment>) => {
      const currentEditor = editorRef.current;
      const currentDoc = doc ?? currentEditor?.getJSON();
      if (!currentDoc) return;

      onMarkdownChange(
        editorStateToCriticMarkdown(
          currentDoc,
          nextComments ?? commentsRef.current,
        ),
      );
    },
    [onMarkdownChange],
  );

  const insertFiles = useCallback(
    async (files: File[]) => {
      const currentEditor = editorRef.current;
      if (!currentEditor || files.length === 0) return;

      const assets = await Promise.all(
        files.map((file) => backend.saveAsset(file)),
      );
      const markdown = assets
        .map((asset, index) => {
          const file = files[index];
          if (asset.mimeType.startsWith("image/")) {
            return `![${file?.name || "Image"}](${asset.markdownPath})`;
          }
          return `[${file?.name || "Attachment"}](${asset.markdownPath})`;
        })
        .join("\n\n");

      currentEditor
        .chain()
        .focus()
        .insertContent(
          toHtml(markdown, {
            resolveFileUrl,
          }),
        )
        .run();
    },
    [backend, resolveFileUrl],
  );

  const editor = useEditor(
    {
      extensions: createEditorExtensions("Start writing..."),
      content: parsedContent.doc,
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          class:
            mode === "canvas"
              ? "tiptap min-h-[120px] selection:bg-sky-100"
              : "tiptap min-h-[70vh] selection:bg-sky-100",
        },
        handleDrop: (_view, event) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          void insertFiles(files);
          return true;
        },
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          void insertFiles(files);
          return true;
        },
      },
      onUpdate: ({ editor: currentEditor }) => {
        emitMarkdownChange(currentEditor.getJSON());
      },
    },
    [page.id],
  );

  editorRef.current = editor;
  selectedCommentIdRef.current = selectedCommentId;

  const activeCommentIds =
    useEditorState({
      editor,
      selector: ({ editor: currentEditor }) =>
        getSelectionCommentIds(currentEditor),
      equalityFn: areCommentIdListsEqual,
    }) ?? [];

  const { commentGroups, contentHeight, measureLayout } =
    useCommentAnchorLayout(editor, comments.size > 0);

  useEffect(() => {
    onEditorReady?.(editor);

    return () => {
      onEditorReady?.(null);
    };
  }, [editor, onEditorReady]);

  useEffect(() => {
    setSelectedCommentId((current) =>
      getPreferredCommentId(activeCommentIds, current),
    );
  }, [activeCommentIds]);

  useEffect(() => {
    if (!editor) return;
    if (editor.isFocused) return;

    commentsRef.current = parsedContent.comments;
    setComments(parsedContent.comments);
    setSelectedCommentId(null);
    setHoveredCommentId(null);
    setPendingFocusCommentId(null);

    const nextDoc = parsedContent.doc;
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(nextDoc)) {
      editor.commands.setContent(nextDoc, { emitUpdate: false });
    }
  }, [editor, parsedContent]);

  useEffect(() => {
    if (!editor || !selected || !focusRequestKey) return;
    if (lastFocusRequestKeyRef.current === focusRequestKey) return;
    lastFocusRequestKeyRef.current = focusRequestKey;

    requestAnimationFrame(() => {
      editor.chain().focus("end").run();
    });
  }, [editor, focusRequestKey, selected]);

  useEffect(() => {
    if (selectedCommentId && !comments.has(selectedCommentId)) {
      setSelectedCommentId(null);
    }

    if (hoveredCommentId && !comments.has(hoveredCommentId)) {
      setHoveredCommentId(null);
    }
  }, [comments, hoveredCommentId, selectedCommentId]);

  useEffect(() => {
    if (!editor) return;

    const effectiveHoveredCommentId = selectedCommentId
      ? hoveredCommentId
      : null;

    editor.view.dispatch(
      editor.state.tr.setMeta(commentHighlightPluginKey, {
        selectedCommentId,
        hoveredCommentId: effectiveHoveredCommentId,
      }),
    );
  }, [editor, hoveredCommentId, selectedCommentId]);

  useEffect(() => {
    if (!editor) return;

    const anchorElements = editor.view.dom.querySelectorAll<HTMLElement>(
      ".comment-anchor[data-comment-ids]",
    );
    const cleanupCallbacks: Array<() => void> = [];

    for (const anchor of anchorElements) {
      const commentIds = parseCommentIds(anchor.dataset.commentIds);
      if (commentIds.length === 0) continue;

      const handleMouseEnter = () => {
        const nextCommentId = getPreferredCommentId(
          commentIds,
          selectedCommentIdRef.current,
        );
        if (nextCommentId) {
          setHoveredCommentId(nextCommentId);
        }
      };

      const handleMouseLeave = () => {
        setHoveredCommentId((current) =>
          current && commentIds.includes(current) ? null : current,
        );
      };

      const handleClick = () => {
        const nextCommentId = getPreferredCommentId(
          commentIds,
          selectedCommentIdRef.current,
        );
        if (nextCommentId) {
          setSelectedCommentId(nextCommentId);
        }
      };

      anchor.addEventListener("mouseenter", handleMouseEnter);
      anchor.addEventListener("mouseleave", handleMouseLeave);
      anchor.addEventListener("click", handleClick);
      cleanupCallbacks.push(() => {
        anchor.removeEventListener("mouseenter", handleMouseEnter);
        anchor.removeEventListener("mouseleave", handleMouseLeave);
        anchor.removeEventListener("click", handleClick);
      });
    }

    return () => {
      for (const cleanup of cleanupCallbacks) {
        cleanup();
      }
    };
  }, [editor]);

  useEffect(() => {
    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (!selectedCommentIdRef.current) return;
      if (!shouldDismissCommentThread(event.target)) return;

      setSelectedCommentId(null);
      setHoveredCommentId(null);
      setPendingFocusCommentId(null);
    };

    document.addEventListener("pointerdown", handleDocumentPointerDown, true);

    return () => {
      document.removeEventListener(
        "pointerdown",
        handleDocumentPointerDown,
        true,
      );
    };
  }, []);

  const handleAddComment = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.state.selection.empty) return;

    const existingIds = getSelectionCommentIds(currentEditor);
    const comment = createCriticComment(undefined, {
      existingComments: commentsRef.current.values(),
    });
    const nextComments = new Map(commentsRef.current);
    nextComments.set(comment.id, comment);
    commentsRef.current = nextComments;
    setComments(nextComments);

    currentEditor
      .chain()
      .focus()
      .setCommentRef({ commentIds: [...existingIds, comment.id] })
      .run();

    setSelectedCommentId(comment.id);
    setPendingFocusCommentId(comment.id);
    emitMarkdownChange(currentEditor.getJSON(), nextComments);
    requestAnimationFrame(() => {
      measureLayout();
    });
  }, [emitMarkdownChange, measureLayout]);

  const updateComment = useCallback(
    (commentId: string, updater: (comment: CriticComment) => CriticComment) => {
      const existingComment = commentsRef.current.get(commentId);
      if (!existingComment) return;

      const nextComments = new Map(commentsRef.current);
      nextComments.set(commentId, updater(existingComment));
      commentsRef.current = nextComments;
      setComments(nextComments);
      emitMarkdownChange(undefined, nextComments);
    },
    [emitMarkdownChange],
  );

  const replyToComment = useCallback(
    (commentId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      const comment = createCriticComment(
        {
          parentCommentId: commentId,
        },
        {
          existingComments: commentsRef.current.values(),
        },
      );
      const nextAnchorCommentIds = addCommentIdsToAnchor(
        currentEditor,
        commentId,
        [comment.id],
      );
      if (!nextAnchorCommentIds) return;

      const nextComments = new Map(commentsRef.current);
      nextComments.set(comment.id, comment);
      commentsRef.current = nextComments;
      setComments(nextComments);
      setSelectedCommentId(comment.id);
      setHoveredCommentId(null);
      setPendingFocusCommentId(comment.id);
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [emitMarkdownChange, measureLayout],
  );

  const deleteComment = useCallback(
    (commentId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      const descendantIds = getCommentDescendantIds(
        commentId,
        commentsRef.current,
      );
      const commentIdsToDelete = [commentId, ...descendantIds];
      const deletedIds = new Set(commentIdsToDelete);
      const nextComments = new Map(commentsRef.current);
      for (const id of commentIdsToDelete) {
        nextComments.delete(id);
      }
      commentsRef.current = nextComments;
      setComments(nextComments);

      const chain = currentEditor.chain().focus();
      for (const id of commentIdsToDelete) {
        chain.removeCommentId(id);
      }
      chain.run();
      setSelectedCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      setHoveredCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      setPendingFocusCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [emitMarkdownChange, measureLayout],
  );

  const selectComment = useCallback((commentId: string) => {
    setSelectedCommentId(commentId);
  }, []);

  const focusComment = useCallback((commentId: string) => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    setSelectedCommentId(commentId);

    const range = findCommentRange(currentEditor, commentId);
    if (range) {
      currentEditor.commands.focus(undefined, { scrollIntoView: false });
      currentEditor.view.dispatch(
        currentEditor.state.tr.setSelection(
          TextSelection.create(currentEditor.state.doc, range.from, range.to),
        ),
      );
      return;
    }

    if (!findCommentAnchorElement(currentEditor, commentId)) return;

    currentEditor.commands.focus(undefined, { scrollIntoView: false });
  }, []);

  const handleBodyPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      event.stopPropagation();
      onSelect?.(page.id);
    },
    [onSelect, page.id],
  );

  const handleSelectPageCapture = useCallback(() => {
    onSelect?.(page.id);
  }, [onSelect, page.id]);

  const isCanvasMode = mode === "canvas";
  const showCanvasRail = isCanvasMode && comments.size > 0;
  const hasComments = comments.size > 0;
  const activeComments = activeCommentIds
    .map((commentId) => comments.get(commentId))
    .filter((comment): comment is CriticComment => Boolean(comment));
  const toolbar = isCanvasMode ? (
    <EditorToolbar editor={editor} onPickFiles={insertFiles} variant="canvas" />
  ) : null;
  const contentCardClass =
    "rounded-[0.75rem] border border-[#E9E9E8] bg-white shadow-[0_18px_44px_rgba(57,47,38,0.08)]";

  if (isCanvasMode) {
    return (
      <div
        className="cursor-text rounded-b-2xl bg-[#FCFCFC] px-5 pt-4 pb-6"
        onPointerDown={handleBodyPointerDown}
      >
        {toolbar}
        <div className="relative">
          <div className={cn(contentCardClass, "px-8 py-5")}>
            <EditorContextMenu
              editor={editor}
              backend={backend}
              onAddComment={handleAddComment}
            >
              <EditorContent editor={editor} />
            </EditorContextMenu>
          </div>
          {showCanvasRail ? (
            <div
              className="absolute top-0"
              style={{
                left: CANVAS_EDITOR_FRAME_WIDTH + CANVAS_RAIL_GAP,
                width: CANVAS_RAIL_WIDTH,
              }}
              onPointerDownCapture={handleSelectPageCapture}
              onPointerDown={handleBodyPointerDown}
            >
              <DocumentCommentRail
                className="w-full"
                commentGroups={commentGroups}
                comments={comments}
                selectedCommentId={selectedCommentId}
                hoveredCommentId={hoveredCommentId}
                contentHeight={contentHeight}
                onDeleteComment={deleteComment}
                onUpdateComment={(commentId, nextContent) => {
                  updateComment(commentId, (current) => ({
                    ...current,
                    content: nextContent,
                  }));
                }}
                onReplyComment={replyToComment}
                onSelectComment={selectComment}
                onFocusComment={focusComment}
                onHoverComment={setHoveredCommentId}
                pendingFocusCommentId={pendingFocusCommentId}
                onAutoFocusComment={(commentId) => {
                  setPendingFocusCommentId((current) =>
                    current === commentId ? null : current,
                  );
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className="cursor-text bg-transparent"
      onPointerDown={handleBodyPointerDown}
    >
      {toolbar}
      <div
        className={cn(
          "document-page-shell",
          !hasComments && "document-page-shell-no-comments",
        )}
      >
        <div className="document-page-main min-w-0">
          {activeComments.length > 0 ? (
            <CommentEditorList
              comments={activeComments}
              className="document-comment-fallback mb-4"
              selectedCommentId={selectedCommentId}
              hoveredCommentId={hoveredCommentId}
              onDeleteComment={deleteComment}
              onUpdateComment={(commentId, nextContent) => {
                updateComment(commentId, (current) => ({
                  ...current,
                  content: nextContent,
                }));
              }}
              onReplyComment={replyToComment}
              onSelectComment={selectComment}
              onHoverComment={setHoveredCommentId}
              pendingFocusCommentId={pendingFocusCommentId}
              onAutoFocusComment={(commentId) => {
                setPendingFocusCommentId((current) =>
                  current === commentId ? null : current,
                );
              }}
            />
          ) : null}
          <div className="pb-24">
            <div
              className={cn(contentCardClass, "px-10 py-10 sm:px-14 sm:py-14")}
            >
              <EditorContextMenu
                editor={editor}
                backend={backend}
                onAddComment={handleAddComment}
              >
                <EditorContent editor={editor} />
              </EditorContextMenu>
            </div>
          </div>
        </div>
        <DocumentCommentRail
          className="document-comment-rail"
          commentGroups={commentGroups}
          comments={comments}
          selectedCommentId={selectedCommentId}
          hoveredCommentId={hoveredCommentId}
          contentHeight={contentHeight}
          onDeleteComment={deleteComment}
          onUpdateComment={(commentId, nextContent) => {
            updateComment(commentId, (current) => ({
              ...current,
              content: nextContent,
            }));
          }}
          onReplyComment={replyToComment}
          onSelectComment={selectComment}
          onFocusComment={focusComment}
          onHoverComment={setHoveredCommentId}
          pendingFocusCommentId={pendingFocusCommentId}
          onAutoFocusComment={(commentId) => {
            setPendingFocusCommentId((current) =>
              current === commentId ? null : current,
            );
          }}
        />
      </div>
    </div>
  );
});

const CodeEditorSurface = memo(function CodeEditorSurface({
  page,
  markdown,
  hasCommentRailSpace,
  onSelect,
  onMarkdownChange,
}: CodeEditorSurfaceProps) {
  const handleBodyPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      event.stopPropagation();
      onSelect?.(page.id);
    },
    [onSelect, page.id],
  );

  return (
    <div
      className="cursor-text bg-transparent"
      onPointerDown={handleBodyPointerDown}
    >
      <div
        className={cn(
          "document-page-shell",
          !hasCommentRailSpace && "document-page-shell-no-comments",
        )}
      >
        <div className="document-page-main min-w-0">
          <div className="pb-24">
            <div className="markdown-code-shell rounded-[0.75rem] border border-[#E9E9E8] bg-white pl-5 pr-6 py-10 shadow-[0_18px_44px_rgba(57,47,38,0.08)] sm:pl-8 sm:pr-10 sm:py-14">
              <MarkdownCodeEditor
                value={markdown}
                onChange={onMarkdownChange}
                autoFocus
              />
            </div>
          </div>
        </div>
        {hasCommentRailSpace ? (
          <div
            className="document-comment-rail pointer-events-none invisible"
            aria-hidden="true"
          />
        ) : null}
      </div>
    </div>
  );
});

const PageCardEditorSurface = memo(function PageCardEditorSurface({
  page,
  selected,
  focusRequestKey,
  mode,
  onSelect,
  onSave,
  onSaveStateChange,
  editorViewMode,
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
}: PageCardEditorSurfaceProps) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recentMarkdownRef = useRef<Set<string>>(new Set());
  const previousEditorViewModeRef = useRef<EditorViewMode>(editorViewMode);
  const [markdown, setMarkdown] = useState(page.content);
  const [richTextSourceMarkdown, setRichTextSourceMarkdown] = useState(
    page.content,
  );
  const [richTextSourceVersion, setRichTextSourceVersion] = useState(0);

  const scheduleSave = useCallback(
    (nextMarkdown: string) => {
      recentMarkdownRef.current.add(nextMarkdown);
      if (recentMarkdownRef.current.size > 10) {
        const iterator = recentMarkdownRef.current.values();
        recentMarkdownRef.current.delete(iterator.next().value as string);
      }

      if (saveTimer.current) clearTimeout(saveTimer.current);
      onSaveStateChange("saving");
      saveTimer.current = setTimeout(async () => {
        try {
          await onSave(page.id, nextMarkdown);
          onSaveStateChange("idle");
        } catch (error) {
          console.error("Failed to save page:", error);
          onSaveStateChange("error");
        }
      }, 500);
    },
    [onSave, onSaveStateChange, page.id],
  );

  const handleMarkdownChange = useCallback(
    (nextMarkdown: string) => {
      setMarkdown(nextMarkdown);
      scheduleSave(nextMarkdown);
    },
    [scheduleSave],
  );

  useEffect(() => {
    if (recentMarkdownRef.current.has(page.content)) {
      recentMarkdownRef.current.delete(page.content);
      return;
    }

    setMarkdown(page.content);
    setRichTextSourceMarkdown(page.content);
    setRichTextSourceVersion((current) => current + 1);
  }, [page.content]);

  useEffect(() => {
    const previousEditorViewMode = previousEditorViewModeRef.current;
    previousEditorViewModeRef.current = editorViewMode;

    if (
      mode !== "document" ||
      previousEditorViewMode !== "code" ||
      editorViewMode !== "rich-text"
    ) {
      return;
    }

    setRichTextSourceMarkdown(markdown);
    setRichTextSourceVersion((current) => current + 1);
  }, [editorViewMode, markdown, mode]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
    };
  }, []);

  const hasCommentRailSpace = markdown.includes("{>>");

  useEffect(() => {
    if (editorViewMode !== "code") return;
    onCommentRailPresenceChange?.(hasCommentRailSpace);
  }, [editorViewMode, hasCommentRailSpace, onCommentRailPresenceChange]);

  if (mode === "document" && editorViewMode === "code") {
    return (
      <CodeEditorSurface
        page={page}
        markdown={markdown}
        hasCommentRailSpace={hasCommentRailSpace}
        onSelect={onSelect}
        onMarkdownChange={handleMarkdownChange}
      />
    );
  }

  return (
    <RichTextEditorSurface
      key={`${page.id}:${richTextSourceVersion}`}
      page={page}
      selected={selected}
      focusRequestKey={focusRequestKey}
      mode={mode}
      sourceMarkdown={richTextSourceMarkdown}
      onSelect={onSelect}
      onMarkdownChange={handleMarkdownChange}
      onCommentRailPresenceChange={onCommentRailPresenceChange}
      backend={backend}
      onEditorReady={onEditorReady}
    />
  );
});

export function PageCard({
  page,
  x = 0,
  y = 0,
  selected = false,
  focusRequestKey = null,
  canDelete = true,
  mode = "canvas",
  onSelect,
  onSave,
  onReposition,
  onDelete,
  onSaveStateChange,
  editorViewMode = "rich-text",
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
}: PageCardProps) {
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, pageX: 0, pageY: 0 });
  const scale = useCanvasScale();
  const [saveState, setSaveState] = useState<SaveState>("idle");

  useEffect(() => {
    onSaveStateChange?.(saveState);
  }, [onSaveStateChange, saveState]);

  const handleDragPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (mode !== "canvas" || !onSelect) return;
      event.stopPropagation();
      event.preventDefault();
      isDragging.current = true;
      dragStart.current = { x, y, pageX: event.clientX, pageY: event.clientY };
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      onSelect(page.id);
    },
    [mode, onSelect, page.id, x, y],
  );

  const handleDragPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      if (mode !== "canvas" || !onReposition || !isDragging.current) return;
      const dx = (event.clientX - dragStart.current.pageX) / scale;
      const dy = (event.clientY - dragStart.current.pageY) / scale;
      onReposition(page.id, dragStart.current.x + dx, dragStart.current.y + dy);
    },
    [mode, onReposition, page.id, scale],
  );

  const handleDragPointerUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  const isCanvasMode = mode === "canvas";
  const chromeTitle = isCanvasMode
    ? getCanvasFilenameLabel(page.id)
    : page.title;

  return (
    <div
      className={
        isCanvasMode ? `absolute ${selected ? "z-10" : "z-0"}` : "w-full"
      }
      style={isCanvasMode ? { left: x, top: y } : undefined}
    >
      {isCanvasMode ? (
        <div className="relative" style={{ width: CANVAS_CONTENT_WIDTH }}>
          <div
            className={`rounded-2xl border bg-[#FCFCFC] shadow-[0_18px_50px_rgba(15,23,42,0.14)] backdrop-blur transition-[border-color,box-shadow] ${
              selected
                ? "border-sky-300 shadow-[0_28px_72px_rgba(14,116,144,0.22)]"
                : "border-slate-200/90"
            }`}
          >
            <div
              className="flex min-h-10 cursor-grab select-none items-center gap-2 rounded-t-2xl border-b border-slate-200/80 bg-slate-50/90 px-4 active:cursor-grabbing"
              onPointerDown={handleDragPointerDown}
              onPointerMove={handleDragPointerMove}
              onPointerUp={handleDragPointerUp}
            >
              <span className="flex-1 truncate text-sm text-slate-500">
                {chromeTitle}
              </span>
              {saveState === "saving" ? (
                <span className="text-[11px] font-medium tracking-[0.08em] text-slate-400 uppercase">
                  Saving…
                </span>
              ) : null}
              {saveState === "error" ? (
                <span className="text-[11px] font-medium tracking-[0.08em] text-rose-600 uppercase">
                  Save failed
                </span>
              ) : null}
              {canDelete ? (
                <button
                  type="button"
                  className="inline-flex size-7 items-center justify-center rounded-full border border-transparent text-lg leading-none text-slate-400 transition hover:border-rose-100 hover:bg-rose-50 hover:text-rose-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete?.(page.id);
                  }}
                  title="Delete page"
                >
                  &times;
                </button>
              ) : null}
            </div>
            <PageCardEditorSurface
              page={page}
              selected={selected}
              focusRequestKey={focusRequestKey}
              mode={mode}
              onSelect={onSelect}
              onSave={onSave}
              onSaveStateChange={setSaveState}
              editorViewMode={editorViewMode}
              backend={backend}
              onEditorReady={onEditorReady}
              onCommentRailPresenceChange={onCommentRailPresenceChange}
            />
          </div>
        </div>
      ) : (
        <PageCardEditorSurface
          page={page}
          selected={selected}
          focusRequestKey={focusRequestKey}
          mode={mode}
          onSelect={onSelect}
          onSave={onSave}
          onSaveStateChange={setSaveState}
          editorViewMode={editorViewMode}
          backend={backend}
          onEditorReady={onEditorReady}
          onCommentRailPresenceChange={onCommentRailPresenceChange}
        />
      )}
    </div>
  );
}
