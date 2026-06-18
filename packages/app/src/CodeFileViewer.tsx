import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { cn } from "./lib/utils";

interface CodeFileViewerProps {
  value: string;
  /** Filename used to pick a syntax-highlighting language (lazily loaded). */
  filename: string;
  className?: string;
  testId?: string;
}

const codeViewerTheme = EditorView.theme({
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
  ".cm-line": { padding: "0" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "rgb(148 163 184)",
    marginRight: "0.75rem",
  },
  ".cm-gutterElement": { padding: "0 0.5rem 0 0" },
  ".cm-foldGutter": { display: "none" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "rgb(100 116 139)",
  },
  "&.cm-focused": { outline: "none" },
});

/**
 * Read-only source viewer. Syntax highlighting is loaded on demand for the
 * matched language so the base bundle stays small; files with no matching
 * language render as plain monospaced text.
 */
export function CodeFileViewer({
  value,
  filename,
  className,
  testId,
}: CodeFileViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const hostElement = hostRef.current;
    if (!hostElement) return;

    const languageCompartment = new Compartment();
    const view = new EditorView({
      parent: hostElement,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          languageCompartment.of([]),
          codeViewerTheme,
        ],
      }),
    });

    let disposed = false;
    const description = LanguageDescription.matchFilename(languages, filename);
    if (description) {
      void description
        .load()
        .then((support) => {
          if (disposed) return;
          view.dispatch({
            effects: languageCompartment.reconfigure(support),
          });
        })
        .catch(() => {
          // Highlighting is best-effort; plain text is an acceptable fallback.
        });
    }

    return () => {
      disposed = true;
      view.destroy();
    };
  }, [value, filename]);

  return (
    <div
      ref={hostRef}
      className={cn("markdown-code-editor", className)}
      data-testid={testId}
    />
  );
}
