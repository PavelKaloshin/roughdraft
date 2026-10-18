import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { cn } from "./lib/utils";

interface MarkdownCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  readOnly?: boolean;
  className?: string;
  testId?: string;
  /**
   * Scrolls a 1-based source line to the top of the editor. A new `requestId`
   * re-runs the scroll, so clicking the same outline heading twice works.
   */
  scrollToLine?: { line: number; requestId: number } | null;
  /**
   * Receives a function that applies an external value immediately, as a
   * minimal change, without reporting it back through `onChange`.
   */
  applyValueRef?: { current: ((value: string) => void) | null };
}

/**
 * The smallest single change that turns `current` into `next`: the common
 * prefix and suffix stay, so the selection and scroll position map through an
 * external edit instead of jumping to the end of a whole-document replace.
 */
export function computeMinimalTextChange(
  current: string,
  next: string,
): { from: number; to: number; insert: string } | null {
  if (current === next) return null;

  let start = 0;
  const maxStart = Math.min(current.length, next.length);
  while (start < maxStart && current[start] === next[start]) start += 1;

  let currentEnd = current.length;
  let nextEnd = next.length;
  while (
    currentEnd > start &&
    nextEnd > start &&
    current[currentEnd - 1] === next[nextEnd - 1]
  ) {
    currentEnd -= 1;
    nextEnd -= 1;
  }

  return { from: start, to: currentEnd, insert: next.slice(start, nextEnd) };
}

function applyMinimalValue(
  view: EditorView,
  value: string,
  lastValueRef: { current: string },
) {
  lastValueRef.current = value;
  const change = computeMinimalTextChange(view.state.doc.toString(), value);
  if (!change) return;
  view.dispatch({ changes: change });
}

export function createMarkdownCodeEditorExtensions(
  readOnly: boolean,
  onDocumentChange: (value: string) => void,
  lastValueRef: { current: string },
): Extension[] {
  return [
    basicSetup,
    yamlFrontmatter({ content: markdown() }),
    EditorView.lineWrapping,
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;

      const nextValue = update.state.doc.toString();
      if (nextValue === lastValueRef.current) return;

      lastValueRef.current = nextValue;
      onDocumentChange(nextValue);
    }),
    EditorView.theme({
      "&": {
        backgroundColor: "transparent",
        color: "inherit",
        fontFamily:
          'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: "0.95rem",
      },
      ".cm-scroller": {
        fontFamily: "inherit",
        lineHeight: "1.75",
        overflow: "auto",
      },
      ".cm-content": {
        minHeight: "70vh",
        padding: "0",
      },
      ".cm-line": {
        padding: "0",
      },
      ".cm-gutters": {
        backgroundColor: "transparent",
        border: "none",
        color: "rgb(148 163 184)",
        marginRight: "0.75rem",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: "var(--cm-selection-bg, rgb(224 242 254))",
      },
      ".cm-gutterElement": {
        padding: "0 0.5rem 0 0",
      },
      ".cm-foldGutter": {
        display: "none",
      },
      ".cm-activeLine": {
        backgroundColor: "transparent",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: "rgb(100 116 139)",
      },
      "&.cm-focused": {
        outline: "none",
      },
    }),
  ];
}

export function MarkdownCodeEditor({
  value,
  onChange,
  autoFocus = false,
  readOnly = false,
  className,
  testId,
  scrollToLine = null,
  applyValueRef,
}: MarkdownCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const initialValueRef = useRef(value);
  const lastValueRef = useRef(value);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const hostElement = hostRef.current;
    if (!hostElement) return;

    const view = new EditorView({
      parent: hostElement,
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: createMarkdownCodeEditorExtensions(
          readOnly,
          (nextValue) => onChangeRef.current(nextValue),
          lastValueRef,
        ),
      }),
    });

    editorViewRef.current = view;
    lastValueRef.current = view.state.doc.toString();

    if (autoFocus) {
      view.focus();
    }

    return () => {
      editorViewRef.current = null;
      view.destroy();
    };
  }, [autoFocus, readOnly]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;

    applyMinimalValue(view, value, lastValueRef);
  }, [value]);

  useEffect(() => {
    if (!applyValueRef) return;
    applyValueRef.current = (nextValue) => {
      const view = editorViewRef.current;
      if (view) applyMinimalValue(view, nextValue, lastValueRef);
    };
    return () => {
      applyValueRef.current = null;
    };
  }, [applyValueRef]);

  useEffect(() => {
    if (!scrollToLine) return;
    const view = editorViewRef.current;
    if (!view) return;

    const lineNumber = Math.min(
      Math.max(scrollToLine.line, 1),
      view.state.doc.lines,
    );
    const position = view.state.doc.line(lineNumber).from;

    view.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: "start" }),
    });
  }, [scrollToLine]);

  return (
    <div
      ref={hostRef}
      className={cn("markdown-code-editor", className)}
      data-testid={testId}
    />
  );
}
