import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bold,
  Code2,
  ExternalLink,
  Italic,
  Link2,
  List,
  ListOrdered,
  MessageSquarePlus,
  Quote,
  Trash2,
} from "lucide-react";
import {
  getAddCommentShortcutLabel,
  matchesAddCommentShortcut,
} from "./comment-shortcuts";
import { toHtml } from "./markdown";
import type { StorageBackend } from "./storage";

interface EditorContextMenuProps {
  editor: Editor | null;
  backend: StorageBackend;
  onAddComment?: () => void;
  children: ReactNode;
}

interface MenuPosition {
  x: number;
  y: number;
}

interface SelectionActionPosition {
  left: number;
  top: number;
}

interface LinkPopoverState {
  href: string;
  rawHref: string;
  left: number;
  top: number;
}

function getNavigatorPlatform() {
  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };

  return (
    navigatorWithUserAgentData.userAgentData?.platform ?? navigator.platform
  );
}

function isResolvedLinkTarget(value: string) {
  return /^(?:[a-z]+:)?\/\//i.test(value) || value.startsWith("data:");
}

function isLinkTarget(value: string) {
  return isResolvedLinkTarget(value) || value.startsWith("#");
}

function resolveEditableLinkTarget(
  value: string,
  backend: StorageBackend,
  fallback = value,
) {
  if (!value) return fallback;
  if (isLinkTarget(value)) return value;
  return backend.resolveFileUrl(value) ?? fallback;
}

function getElementFromDomNode(node: Node | null) {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

function getContainedSelectionRange(container: HTMLElement) {
  const selection = window.getSelection();

  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const ancestor =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;

  if (!ancestor || !container.contains(ancestor)) {
    return null;
  }

  return range;
}

function findActiveLinkAnchor(
  editor: Editor,
  container: HTMLElement,
): HTMLAnchorElement | null {
  const candidates: Array<Element | null> = [];
  const selection = window.getSelection();

  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    candidates.push(
      getElementFromDomNode(range.startContainer),
      getElementFromDomNode(range.endContainer),
      getElementFromDomNode(range.commonAncestorContainer),
    );
  }

  const { from, to } = editor.state.selection;
  const startDom = editor.view.domAtPos(from);
  const endDom = editor.view.domAtPos(to);
  candidates.push(
    getElementFromDomNode(startDom.node),
    getElementFromDomNode(endDom.node),
  );

  for (const candidate of candidates) {
    const anchor = candidate?.closest("a[href]");

    if (anchor instanceof HTMLAnchorElement && container.contains(anchor)) {
      return anchor;
    }
  }

  return null;
}

function SelectionMenuButton({
  label,
  icon,
  active = false,
  disabled = false,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`inline-flex size-9 items-center justify-center rounded-xl border text-slate-600 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 ${
        active
          ? "border-slate-900 bg-slate-900 text-white shadow-[0_8px_18px_rgba(15,23,42,0.18)]"
          : "border-transparent hover:bg-slate-100 hover:text-slate-900"
      } disabled:cursor-not-allowed disabled:opacity-40`}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      {icon}
    </button>
  );
}

export function EditorContextMenu({
  editor,
  backend,
  onAddComment,
  children,
}: EditorContextMenuProps) {
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [selectionActionPosition, setSelectionActionPosition] =
    useState<SelectionActionPosition | null>(null);
  const [linkPopoverState, setLinkPopoverState] =
    useState<LinkPopoverState | null>(null);
  const [linkDraft, setLinkDraft] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const linkPopoverRef = useRef<HTMLDivElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const shortcutLabel = getAddCommentShortcutLabel(getNavigatorPlatform());
  const selectionMenuState = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => ({
      isBoldActive: currentEditor?.isActive("bold") ?? false,
      isItalicActive: currentEditor?.isActive("italic") ?? false,
      isCodeActive: currentEditor?.isActive("code") ?? false,
      isBulletListActive: currentEditor?.isActive("bulletList") ?? false,
      isOrderedListActive: currentEditor?.isActive("orderedList") ?? false,
      isBlockquoteActive: currentEditor?.isActive("blockquote") ?? false,
      isLinkActive: currentEditor?.isActive("link") ?? false,
      canToggleBold:
        currentEditor?.can().chain().focus().toggleBold().run() ?? false,
      canToggleItalic:
        currentEditor?.can().chain().focus().toggleItalic().run() ?? false,
      canToggleCode:
        currentEditor?.can().chain().focus().toggleCode().run() ?? false,
      canToggleBulletList:
        currentEditor?.can().chain().focus().toggleBulletList().run() ?? false,
      canToggleOrderedList:
        currentEditor?.can().chain().focus().toggleOrderedList().run() ?? false,
      canToggleBlockquote:
        currentEditor?.can().chain().focus().toggleBlockquote().run() ?? false,
    }),
  }) ?? {
    isBoldActive: false,
    isItalicActive: false,
    isCodeActive: false,
    isBulletListActive: false,
    isOrderedListActive: false,
    isBlockquoteActive: false,
    isLinkActive: false,
    canToggleBold: false,
    canToggleItalic: false,
    canToggleCode: false,
    canToggleBulletList: false,
    canToggleOrderedList: false,
    canToggleBlockquote: false,
  };

  const close = useCallback(() => {
    setPosition(null);
  }, []);

  const closeLinkPopover = useCallback(() => {
    setLinkPopoverState(null);
  }, []);

  const updateSelectionActionPosition = useCallback(() => {
    if (
      !editor ||
      !onAddComment ||
      !editor.isFocused ||
      editor.state.selection.empty
    ) {
      setSelectionActionPosition(null);
      return;
    }

    const container = containerRef.current;
    if (!container) {
      setSelectionActionPosition(null);
      return;
    }

    const range = getContainedSelectionRange(container);

    if (!range) {
      setSelectionActionPosition(null);
      return;
    }

    const boundingRect = range.getBoundingClientRect();
    if (boundingRect.width === 0 && boundingRect.height === 0) {
      setSelectionActionPosition(null);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const nextLeft =
      boundingRect.left + boundingRect.width / 2 - containerRect.left;
    const nextTop = boundingRect.top - containerRect.top - 14;

    setSelectionActionPosition({
      left: nextLeft,
      top: nextTop,
    });
  }, [editor, onAddComment]);

  const updateLinkPopover = useCallback(() => {
    if (!editor || !containerRef.current || !editor.isActive("link")) {
      setLinkPopoverState(null);
      return;
    }

    const anchor = findActiveLinkAnchor(editor, containerRef.current);

    if (!anchor) {
      setLinkPopoverState(null);
      return;
    }

    const rect = anchor.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setLinkPopoverState(null);
      return;
    }

    const rawHref =
      (editor.getAttributes("link").dataMarkdownSrc as string | null) ||
      anchor.getAttribute("data-markdown-src") ||
      anchor.getAttribute("href") ||
      "";
    const href = resolveEditableLinkTarget(
      rawHref,
      backend,
      (editor.getAttributes("link").href as string | null) || anchor.href,
    );

    setLinkPopoverState({
      href,
      rawHref,
      left: rect.left + rect.width / 2,
      top: rect.top - 12,
    });
  }, [backend, editor]);

  const openLinkPopover = useCallback(() => {
    if (!editor || !containerRef.current) return;

    const anchor = findActiveLinkAnchor(editor, containerRef.current);

    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      const rawHref =
        (editor.getAttributes("link").dataMarkdownSrc as string | null) ||
        anchor.getAttribute("data-markdown-src") ||
        anchor.getAttribute("href") ||
        "";
      const href = resolveEditableLinkTarget(
        rawHref,
        backend,
        (editor.getAttributes("link").href as string | null) || anchor.href,
      );

      setLinkPopoverState({
        href,
        rawHref,
        left: rect.left + rect.width / 2,
        top: rect.top - 12,
      });
      return;
    }

    const range = getContainedSelectionRange(containerRef.current);
    if (!range) return;

    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;

    const rawHref =
      (editor.getAttributes("link").dataMarkdownSrc as string | null) || "";

    setLinkPopoverState({
      href: resolveEditableLinkTarget(rawHref, backend, rawHref || "https://"),
      rawHref,
      left: rect.left + rect.width / 2,
      top: rect.top - 12,
    });
  }, [backend, editor]);

  const applyLink = useCallback(
    (nextValue: string) => {
      if (!editor) return;

      const nextHref = nextValue.trim();

      if (!nextHref) {
        editor.chain().focus().unsetLink().run();
        setLinkPopoverState(null);
        return;
      }

      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .setMark("link", {
          href: resolveEditableLinkTarget(nextHref, backend, nextHref),
          dataMarkdownSrc: nextHref,
        })
        .run();
    },
    [backend, editor],
  );

  useEffect(() => {
    if (!position && !linkPopoverState) return;

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;

      if (menuRef.current && !menuRef.current.contains(target)) {
        close();
      }

      if (
        linkPopoverRef.current &&
        !linkPopoverRef.current.contains(target) &&
        containerRef.current &&
        !containerRef.current.contains(target)
      ) {
        applyLink(linkDraft);
        closeLinkPopover();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "Escape") closeLinkPopover();
    };

    document.addEventListener("mousedown", handleMouseDown, true);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleMouseDown, true);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [
    applyLink,
    close,
    closeLinkPopover,
    linkDraft,
    linkPopoverState,
    position,
  ]);

  useEffect(() => {
    if (!editor) return;

    const schedulePositionUpdate = () => {
      requestAnimationFrame(() => {
        updateSelectionActionPosition();
        updateLinkPopover();
      });
    };

    const clearSelectionAction = () => {
      setSelectionActionPosition(null);
    };

    const handleSelectionChange = () => {
      schedulePositionUpdate();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !onAddComment ||
        !editor.isFocused ||
        editor.state.selection.empty ||
        !matchesAddCommentShortcut(event, getNavigatorPlatform())
      ) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      onAddComment();
      clearSelectionAction();
    };

    editor.on("selectionUpdate", schedulePositionUpdate);
    editor.on("update", schedulePositionUpdate);
    editor.on("focus", schedulePositionUpdate);
    editor.on("blur", clearSelectionAction);
    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", schedulePositionUpdate);
    window.addEventListener("scroll", schedulePositionUpdate, true);

    schedulePositionUpdate();

    return () => {
      editor.off("selectionUpdate", schedulePositionUpdate);
      editor.off("update", schedulePositionUpdate);
      editor.off("focus", schedulePositionUpdate);
      editor.off("blur", clearSelectionAction);
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", schedulePositionUpdate);
      window.removeEventListener("scroll", schedulePositionUpdate, true);
    };
  }, [editor, onAddComment, updateLinkPopover, updateSelectionActionPosition]);

  useEffect(() => {
    if (!linkPopoverState) return;
    setLinkDraft(linkPopoverState.rawHref);
  }, [linkPopoverState]);

  useEffect(() => {
    if (!linkPopoverState || !linkInputRef.current) return;

    requestAnimationFrame(() => {
      linkInputRef.current?.focus();
      linkInputRef.current?.select();
    });
  }, [linkPopoverState]);

  const handlePasteText = useCallback(async () => {
    if (!editor) return;

    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        editor.chain().focus().insertContent(text).run();
      }
    } finally {
      close();
    }
  }, [close, editor]);

  const handlePasteMarkdown = useCallback(async () => {
    if (!editor) return;

    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        editor
          .chain()
          .focus()
          .insertContent(
            toHtml(text, {
              resolveFileUrl: (path) => backend.resolveFileUrl(path),
            }),
          )
          .run();
      }
    } finally {
      close();
    }
  }, [backend, close, editor]);

  return (
    <div
      ref={containerRef}
      className="relative"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setPosition({ x: event.clientX, y: event.clientY });
      }}
    >
      {children}
      {selectionActionPosition && !linkPopoverState ? (
        <div
          className="absolute z-30 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-full rounded-[22px] border border-slate-200/90 bg-white/95 p-2 shadow-[0_18px_48px_rgba(15,23,42,0.16)] backdrop-blur-xl"
          style={{
            left: selectionActionPosition.left,
            top: selectionActionPosition.top,
          }}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <div className="flex flex-wrap items-center gap-1">
            <SelectionMenuButton
              label="Bold"
              icon={<Bold className="size-4" />}
              active={selectionMenuState.isBoldActive}
              disabled={!selectionMenuState.canToggleBold}
              onClick={() => editor?.chain().focus().toggleBold().run()}
            />
            <SelectionMenuButton
              label="Italic"
              icon={<Italic className="size-4" />}
              active={selectionMenuState.isItalicActive}
              disabled={!selectionMenuState.canToggleItalic}
              onClick={() => editor?.chain().focus().toggleItalic().run()}
            />
            <SelectionMenuButton
              label="Inline code"
              icon={<Code2 className="size-4" />}
              active={selectionMenuState.isCodeActive}
              disabled={!selectionMenuState.canToggleCode}
              onClick={() => editor?.chain().focus().toggleCode().run()}
            />
            <SelectionMenuButton
              label="Blockquote"
              icon={<Quote className="size-4" />}
              active={selectionMenuState.isBlockquoteActive}
              disabled={!selectionMenuState.canToggleBlockquote}
              onClick={() => editor?.chain().focus().toggleBlockquote().run()}
            />
            <SelectionMenuButton
              label="Bulleted list"
              icon={<List className="size-4" />}
              active={selectionMenuState.isBulletListActive}
              disabled={!selectionMenuState.canToggleBulletList}
              onClick={() => editor?.chain().focus().toggleBulletList().run()}
            />
            <SelectionMenuButton
              label="Numbered list"
              icon={<ListOrdered className="size-4" />}
              active={selectionMenuState.isOrderedListActive}
              disabled={!selectionMenuState.canToggleOrderedList}
              onClick={() => editor?.chain().focus().toggleOrderedList().run()}
            />
            <SelectionMenuButton
              label="Link"
              icon={<Link2 className="size-4" />}
              active={selectionMenuState.isLinkActive}
              onClick={openLinkPopover}
            />
          </div>
          <div className="my-2 h-px bg-slate-200/80" aria-hidden="true" />
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium text-slate-700 transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={() => {
              onAddComment?.();
              setSelectionActionPosition(null);
            }}
          >
            <span className="inline-flex items-center gap-2">
              <MessageSquarePlus className="size-4.5" />
              <span>Comment</span>
            </span>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold tracking-[0.01em] text-slate-500">
              {shortcutLabel}
            </span>
          </button>
        </div>
      ) : null}
      {linkPopoverState ? (
        <div
          ref={linkPopoverRef}
          className="fixed z-[220] flex -translate-x-1/2 -translate-y-full items-center rounded-[18px] border border-slate-200/90 bg-white/95 px-3 py-2 shadow-[0_18px_48px_rgba(15,23,42,0.16)] backdrop-blur-xl"
          style={{
            left: linkPopoverState.left,
            top: linkPopoverState.top,
          }}
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
        >
          <input
            ref={linkInputRef}
            value={linkDraft}
            onChange={(event) => setLinkDraft(event.target.value)}
            onBlur={(event) => {
              const nextFocused = event.relatedTarget as Node | null;

              if (
                nextFocused &&
                linkPopoverRef.current?.contains(nextFocused)
              ) {
                return;
              }

              applyLink(linkDraft);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyLink(linkDraft);
                editor?.commands.focus();
              }

              if (event.key === "Escape") {
                event.preventDefault();
                closeLinkPopover();
                editor?.commands.focus();
              }
            }}
            className="h-10 w-[22rem] border-0 bg-transparent px-2 text-[17px] text-slate-900 outline-none placeholder:text-slate-400"
            placeholder="https://example.com"
            aria-label="Link URL"
          />
          <div className="mx-2 h-8 w-px bg-slate-200" aria-hidden="true" />
          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              applyLink(linkDraft);
              const target =
                resolveEditableLinkTarget(linkDraft.trim(), backend) ||
                linkPopoverState.href;

              if (target) {
                window.open(target, "_blank", "noopener,noreferrer");
              }
            }}
            aria-label="Open link in new tab"
            title="Open link in new tab"
          >
            <ExternalLink className="size-5" />
          </button>
          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-rose-50 hover:text-rose-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              editor?.chain().focus().unsetLink().run();
              closeLinkPopover();
            }}
            aria-label="Delete link"
            title="Delete link"
          >
            <Trash2 className="size-5" />
          </button>
        </div>
      ) : null}
      {position ? (
        <div
          ref={menuRef}
          className="fixed z-[200] min-w-44 rounded-2xl border border-slate-200/90 bg-white/95 p-1.5 shadow-[0_18px_48px_rgba(15,23,42,0.16)] backdrop-blur-xl"
          style={{ left: position.x, top: position.y }}
        >
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!editor || editor.state.selection.empty}
            onClick={() => {
              onAddComment?.();
              close();
            }}
          >
            <span>Add comment</span>
            <span className="text-[11px] font-medium text-slate-400">
              {shortcutLabel}
            </span>
          </button>
          <button
            type="button"
            className="block w-full rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50"
            onClick={() => void handlePasteText()}
          >
            Paste
          </button>
          <button
            type="button"
            className="block w-full rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50"
            onClick={() => void handlePasteMarkdown()}
          >
            Paste Markdown
          </button>
        </div>
      ) : null}
    </div>
  );
}
