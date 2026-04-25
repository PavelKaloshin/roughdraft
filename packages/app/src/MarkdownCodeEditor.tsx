import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";

interface MarkdownCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

export function MarkdownCodeEditor({
  value,
  onChange,
  autoFocus = false,
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
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;

            const nextValue = update.state.doc.toString();
            if (nextValue === lastValueRef.current) return;

            lastValueRef.current = nextValue;
            onChangeRef.current(nextValue);
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
            ".cm-selectionBackground, ::selection": {
              backgroundColor: "rgb(224 242 254)",
            },
            "&.cm-focused": {
              outline: "none",
            },
          }),
        ],
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
  }, [autoFocus]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;

    const currentValue = view.state.doc.toString();
    if (currentValue === value) {
      lastValueRef.current = value;
      return;
    }

    lastValueRef.current = value;
    view.dispatch({
      changes: {
        from: 0,
        to: currentValue.length,
        insert: value,
      },
    });
  }, [value]);

  return <div ref={hostRef} className="markdown-code-editor" />;
}
