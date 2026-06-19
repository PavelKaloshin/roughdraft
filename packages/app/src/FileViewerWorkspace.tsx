import { Eye, FileWarning, Loader2, Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { CodeFileViewer } from "./CodeFileViewer";
import type { FileKind } from "./file-types";
import { cn } from "./lib/utils";
import type { StorageBackend } from "./storage";
import {
  readFullWidthPreference,
  writeFullWidthPreference,
} from "./view-preferences";

interface FileViewerWorkspaceProps {
  backend: StorageBackend;
  relativePath: string;
  fileLabel: string;
  kind: Exclude<FileKind, "markdown">;
}

type TextLoadState =
  | { status: "loading" }
  | { status: "ready"; content: string }
  | { status: "binary" }
  | { status: "error"; message: string };

// Text decoded from a binary file is full of replacement/NUL characters; a NUL
// byte is the cheapest reliable signal that we should fall back to the stub
// instead of rendering garbage.
function looksBinary(content: string): boolean {
  return content.includes("\u0000");
}

function FileViewerStub({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof FileWarning;
  title: string;
  body: string;
}) {
  return (
    <div
      data-testid="file-viewer-stub"
      className="flex min-h-[50vh] flex-col items-center justify-center gap-2 text-center"
    >
      <Icon className="size-7 text-slate-400" aria-hidden="true" />
      <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
        {title}
      </p>
      <p className="max-w-sm text-sm text-slate-400">{body}</p>
    </div>
  );
}

function TextOrCodeView({
  backend,
  relativePath,
  fileLabel,
}: {
  backend: StorageBackend;
  relativePath: string;
  fileLabel: string;
}) {
  const [state, setState] = useState<TextLoadState>({ status: "loading" });

  useEffect(() => {
    if (!backend.readTextFile) {
      setState({ status: "error", message: "This file cannot be opened." });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });
    backend
      .readTextFile(relativePath)
      .then((content) => {
        if (cancelled) return;
        setState(
          looksBinary(content)
            ? { status: "binary" }
            : { status: "ready", content },
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message:
            error instanceof Error ? error.message : "Could not read the file.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [backend, relativePath]);

  if (state.status === "loading") {
    return (
      <div
        data-testid="file-viewer-loading"
        className="flex min-h-[50vh] items-center justify-center gap-2 text-sm text-slate-400"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <FileViewerStub
        icon={FileWarning}
        title="Could not open this file"
        body={state.message}
      />
    );
  }

  if (state.status === "binary") {
    return (
      <FileViewerStub
        icon={FileWarning}
        title="Preview unavailable"
        body="This looks like a binary file, so Roughdraft can't show it as text."
      />
    );
  }

  return (
    <CodeFileViewer
      value={state.content}
      filename={fileLabel}
      testId="file-viewer-code"
    />
  );
}

/**
 * Read-only workspace for non-markdown files reached from the directory tree.
 * Images render as a preview, code and text render with highlighting, and
 * other binaries fall back to a stub. None of these support commenting,
 * editing, or saving (ADR 0005).
 */
export function FileViewerWorkspace({
  backend,
  relativePath,
  fileLabel,
  kind,
}: FileViewerWorkspaceProps) {
  const imageUrl =
    kind === "image" ? backend.resolveFileUrl(relativePath) : null;
  const [fullWidth, setFullWidth] = useState(readFullWidthPreference);
  const toggleFullWidth = useCallback(() => {
    setFullWidth((current) => {
      const next = !current;
      writeFullWidthPreference(next);
      return next;
    });
  }, []);

  return (
    <div
      data-testid="file-viewer-workspace"
      className="min-h-0 flex-1 overflow-y-auto px-8 pt-10 pb-8 sm:px-12"
    >
      <div
        className={cn(
          "mx-auto min-h-full",
          fullWidth ? "max-w-none" : "max-w-[1080px]",
        )}
      >
        <div className="mb-4 flex items-center gap-1.5 px-1 text-[0.62rem] font-medium tracking-[0.01em] text-stone-400">
          <span
            className="min-w-0 truncate font-mono text-[0.7rem] text-stone-400 dark:text-stone-500"
            title={fileLabel}
          >
            {fileLabel}
          </span>
          <button
            type="button"
            data-testid="file-viewer-full-width-toggle"
            aria-pressed={fullWidth}
            aria-label={fullWidth ? "Fit width" : "Full width"}
            title={fullWidth ? "Fit width" : "Full width"}
            onClick={toggleFullWidth}
            className={cn(
              "ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-stone-300/70 dark:focus-visible:ring-slate-600/70",
              fullWidth
                ? "bg-[#E8E3DB] text-stone-700 dark:bg-slate-700 dark:text-white"
                : "text-stone-400 hover:bg-[#EEE9E1] hover:text-stone-600 dark:text-stone-500 dark:hover:bg-slate-800 dark:hover:text-stone-300",
            )}
          >
            {fullWidth ? (
              <Minimize2 className="size-[0.68rem]" aria-hidden="true" />
            ) : (
              <Maximize2 className="size-[0.68rem]" aria-hidden="true" />
            )}
          </button>
          <span
            data-testid="file-viewer-readonly-badge"
            className="inline-flex items-center gap-1 font-mono text-[0.7rem] text-stone-400 dark:text-stone-500"
          >
            <Eye className="size-[0.68rem]" aria-hidden="true" />
            Read-only
          </span>
        </div>

        {kind === "image" ? (
          imageUrl ? (
            <div className="flex justify-center py-4">
              <img
                data-testid="file-viewer-image"
                src={imageUrl}
                alt={fileLabel}
                className="max-h-[80vh] max-w-full rounded-md border border-slate-200 object-contain dark:border-slate-800"
              />
            </div>
          ) : (
            <FileViewerStub
              icon={FileWarning}
              title="Preview unavailable"
              body="This image can't be loaded in the current workspace."
            />
          )
        ) : kind === "binary" ? (
          <FileViewerStub
            icon={FileWarning}
            title="Preview unavailable"
            body="This file type can't be shown in Roughdraft. Open it with another app."
          />
        ) : (
          <TextOrCodeView
            backend={backend}
            relativePath={relativePath}
            fileLabel={fileLabel}
          />
        )}
      </div>
    </div>
  );
}
