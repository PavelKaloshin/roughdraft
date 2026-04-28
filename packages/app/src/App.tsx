import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  Check,
  Copy,
  ExternalLink,
  FileText,
  MessageSquare,
  PencilLine,
} from "lucide-react";
import {
  type DocumentEditorViewMode,
  ROUGHDRAFT_FLAVORED_MARKDOWN_PATH,
  buildLocationForDocumentEditorViewMode,
  formatWorkspacePathForDisplay,
  getDocumentEditorViewModeFromLocation,
  getPathLeaf,
  getRequestedPathState,
  isReservedAppPath,
  joinPath,
  syncRequestedPathInUrl,
} from "./app-navigation";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";
import { detectBackend } from "./detect-backend";
import { DocumentWorkspace } from "./DocumentWorkspace";
import {
  MarkdownFileConflictError,
  type Page,
  type StorageBackend,
} from "./storage";
import { fetchUpdateStatus, type UpdateStatus } from "./update-status";
import { UpdateNotice } from "./UpdateNotice";

type SaveState = "idle" | "saving" | "error";
type DocumentDiskChangeState = "clean" | "changed" | "conflict" | "paused";
const AGENT_SETUP_PROMPT =
  "Install Roughdraft for me using `npm i -g roughdraft`, then read https://roughdraft.page/setup.md and set yourself up to use it.";
const ROUGHDRAFT_MARKDOWN_FEATURES = [
  {
    title: "Comment in the margins",
    description:
      "Leave review notes inline, then let your agent read and respond to the same `.md` file.",
    example: "{>>Can we tighten this claim?<<}",
    icon: MessageSquare,
  },
  {
    title: "Suggest changes",
    description:
      "Mark insertions, deletions, and substitutions without turning Markdown into a proprietary document.",
    example: "{~~rough notes~>clear next steps~~}",
    icon: PencilLine,
  },
  {
    title: "Keep Markdown portable",
    description:
      "Roughdraft flavored Markdown blends CriticMarkup with Notion-style review affordances for people and agents.",
    example: "regular.md + review markup",
    icon: FileText,
  },
] as const;
const ROUGHDRAFT_MARKDOWN_SYNTAX = [
  {
    label: "Comment",
    syntax:
      '{==selected text==}{>>Comment text<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}',
    description:
      "Highlights the reviewed text and attaches a margin comment to it.",
  },
  {
    label: "Reply",
    syntax:
      '{>>I can make that edit.<<}{id="c2" by="AI" at="2026-04-28T12:01:00.000Z" re="c1"}',
    description:
      "Adds a threaded reply by pointing `re` at the parent comment id.",
  },
  {
    label: "Insertion",
    syntax: '{++new text++}{id="s1" by="AI" at="2026-04-28T12:02:00.000Z"}',
    description: "Suggests text to add without applying it silently.",
  },
  {
    label: "Deletion",
    syntax: '{--old text--}{id="s2" by="user" at="2026-04-28T12:03:00.000Z"}',
    description: "Suggests removing text while keeping the original visible.",
  },
  {
    label: "Substitution",
    syntax:
      '{~~old text~>new text~~}{id="s3" by="AI" at="2026-04-28T12:04:00.000Z"}',
    description: "Suggests replacing one span with another.",
  },
] as const;

export function Homepage({
  message,
  updateStatus,
}: {
  message: string;
  updateStatus: UpdateStatus | null;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );

  const handleCopySetupPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(AGENT_SETUP_PROMPT);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("error");
    }
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#FCFCFC] px-6 py-12 text-slate-950">
      {updateStatus ? (
        <div className="absolute top-4 right-4 max-w-sm">
          <UpdateNotice updateStatus={updateStatus} />
        </div>
      ) : null}
      <div className="w-full max-w-6xl text-center">
        <div className="mx-auto max-w-2xl">
          <p className="mb-3 text-xs font-medium tracking-[0.16em] text-slate-500 uppercase">
            Roughdraft
          </p>
          <h1 className="text-4xl leading-tight font-semibold tracking-[-0.025em] text-balance text-slate-950 sm:text-5xl">
            Easier collaboration with your coding agent
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg leading-8 text-balance text-slate-600">
            {message}
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5 text-xs font-medium leading-none text-stone-500">
            {["Free", "Open-source", "Runs locally"].map((item) => (
              <div
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[#DCD6CC]/70 bg-transparent px-2.5"
                key={item}
              >
                <span className="inline-flex size-3.5 items-center justify-center rounded-full bg-transparent text-stone-500">
                  <Check className="size-2.5 stroke-[2.5]" aria-hidden="true" />
                </span>
                <span>{item}</span>
              </div>
            ))}
          </div>

          <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Dialog>
              <DialogTrigger
                render={
                  <Button className="h-10 gap-2 px-4 text-sm" size="lg">
                    Install Now
                  </Button>
                }
              />
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Copy this into your coding agent</DialogTitle>
                  <DialogDescription>
                    This prompt tells the agent how to install Roughdraft and
                    set up the review workflow.
                  </DialogDescription>
                </DialogHeader>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <p className="break-words text-sm leading-6 text-slate-800">
                    {AGENT_SETUP_PROMPT}
                  </p>
                  {copyState === "error" ? (
                    <p className="mt-3 text-sm text-red-600">
                      Copy failed. Select the instruction text and copy it
                      manually.
                    </p>
                  ) : null}
                </div>

                <DialogFooter>
                  <Button
                    className="h-9 gap-2 px-3 text-sm"
                    type="button"
                    onClick={handleCopySetupPrompt}
                  >
                    {copyState === "copied" ? (
                      <Check className="size-4" aria-hidden="true" />
                    ) : (
                      <Copy className="size-4" aria-hidden="true" />
                    )}
                    {copyState === "copied" ? "Copied" : "Copy prompt"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Button
              className="h-10 gap-2 px-4 text-sm"
              size="lg"
              variant="outline"
              render={
                <a
                  href="https://github.com/Lex-Inc/roughdraft"
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="size-4" aria-hidden="true" />
                  View on GitHub
                </a>
              }
            />
          </div>
        </div>

        <div className="mx-auto mt-10 w-full max-w-5xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.12)]">
          <img
            src="/sneak-peek.png"
            alt="Roughdraft markdown review workspace"
            className="block aspect-[1728/1117] w-full object-cover"
          />
        </div>

        <section
          aria-labelledby="roughdraft-markdown-heading"
          className="mx-auto mt-20 grid w-full max-w-5xl gap-8 text-left sm:mt-24 lg:grid-cols-[0.95fr_1.05fr] lg:items-start"
        >
          <div>
            <p className="text-xs font-medium tracking-[0.16em] text-stone-500 uppercase">
              Roughdraft flavored Markdown
            </p>
            <h2
              className="mt-3 text-3xl leading-tight font-semibold text-balance text-slate-950 sm:text-4xl"
              id="roughdraft-markdown-heading"
            >
              We extended Markdown to add support for comment threads and
              suggested changes.
            </h2>
            <p className="mt-4 text-base leading-7 text-slate-600">
              The big idea is simple: keep the file as Markdown, but make it
              reviewable. Roughdraft uses a small layer of portable markup so
              you can comment, suggest edits, and send the exact same document
              back to your coding agent.
            </p>
            <Button
              className="mt-6 h-9 gap-2 px-3 text-sm"
              variant="outline"
              render={
                <a href={ROUGHDRAFT_FLAVORED_MARKDOWN_PATH}>
                  Read the spec
                  <ArrowRight className="size-4" aria-hidden="true" />
                </a>
              }
            />
          </div>

          <div className="grid gap-3">
            {ROUGHDRAFT_MARKDOWN_FEATURES.map(
              ({ description, example, icon: Icon, title }) => (
                <div
                  className="grid gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-[0_10px_30px_rgba(15,23,42,0.06)] sm:grid-cols-[2.5rem_1fr]"
                  key={title}
                >
                  <div className="flex size-10 items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-slate-700">
                    <Icon className="size-4" aria-hidden="true" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-slate-950">
                      {title}
                    </h3>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      {description}
                    </p>
                    <code className="mt-3 block overflow-x-auto rounded-md border border-slate-200 bg-[#FAFAF8] px-3 py-2 text-xs text-slate-700">
                      {example}
                    </code>
                  </div>
                </div>
              ),
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

export function RoughdraftFlavoredMarkdownPage() {
  return (
    <main className="min-h-screen bg-[#FCFCFC] px-6 py-8 text-slate-950">
      <div className="mx-auto max-w-5xl">
        <Button
          className="h-9 gap-2 px-3 text-sm"
          variant="ghost"
          render={
            <a href="/">
              <ArrowLeft className="size-4" aria-hidden="true" />
              Back to Roughdraft
            </a>
          }
        />

        <section className="mt-12 max-w-3xl">
          <p className="text-xs font-medium tracking-[0.16em] text-stone-500 uppercase">
            Roughdraft flavored Markdown
          </p>
          <h1 className="mt-3 text-4xl leading-tight font-semibold text-balance text-slate-950 sm:text-5xl">
            Markdown with review comments and suggested changes
          </h1>
          <p className="mt-5 text-lg leading-8 text-slate-600">
            Roughdraft Flavored Markdown is regular Markdown plus portable
            review markup. It blends CriticMarkup syntax with Notion-style
            comment threads, so a person and a coding agent can review the same
            file without a sidecar database or hosted document format.
          </p>
        </section>

        <section className="mt-12 grid gap-4 md:grid-cols-3">
          {[
            {
              title: "Plain text first",
              description:
                "The saved file remains readable in editors, terminals, git diffs, and agent context windows.",
              icon: FileText,
            },
            {
              title: "Threaded review",
              description:
                "Comments carry document-local ids, authors, timestamps, and reply links for back-and-forth discussion.",
              icon: MessageSquare,
            },
            {
              title: "Explicit edits",
              description:
                "Suggestions are represented as insertions, deletions, and substitutions until someone accepts them.",
              icon: PencilLine,
            },
          ].map(({ description, icon: Icon, title }) => (
            <div
              className="rounded-lg border border-slate-200 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]"
              key={title}
            >
              <div className="flex size-10 items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-slate-700">
                <Icon className="size-4" aria-hidden="true" />
              </div>
              <h2 className="mt-4 text-base font-semibold text-slate-950">
                {title}
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {description}
              </p>
            </div>
          ))}
        </section>

        <section className="mt-14 grid gap-8 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <p className="text-xs font-medium tracking-[0.16em] text-stone-500 uppercase">
              Syntax
            </p>
            <h2 className="mt-3 text-3xl leading-tight font-semibold text-slate-950">
              The review layer is small on purpose
            </h2>
            <p className="mt-4 text-base leading-7 text-slate-600">
              Roughdraft uses CriticMarkup-compatible markers for comments,
              highlights, insertions, deletions, and substitutions. Metadata is
              stored in a compact attribute block after the markup.
            </p>
          </div>

          <div className="grid gap-3">
            {ROUGHDRAFT_MARKDOWN_SYNTAX.map(
              ({ description, label, syntax }) => (
                <div
                  className="rounded-lg border border-slate-200 bg-white p-4"
                  key={label}
                >
                  <div className="flex items-center gap-2">
                    <Braces
                      className="size-4 text-slate-500"
                      aria-hidden="true"
                    />
                    <h3 className="text-sm font-semibold text-slate-950">
                      {label}
                    </h3>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    {description}
                  </p>
                  <code className="mt-3 block overflow-x-auto rounded-md border border-slate-200 bg-[#FAFAF8] px-3 py-2 text-xs text-slate-700">
                    {syntax}
                  </code>
                </div>
              ),
            )}
          </div>
        </section>

        <section className="mt-14 max-w-3xl border-t border-slate-200 pt-10">
          <h2 className="text-2xl font-semibold text-slate-950">
            What this is not
          </h2>
          <p className="mt-4 text-base leading-7 text-slate-600">
            It is not a new replacement for Markdown, and it is not a hidden app
            state format. If Roughdraft adds review information, that
            information should stay visible, portable, and understandable in the
            Markdown file itself.
          </p>
        </section>
      </div>
    </main>
  );
}

export function App() {
  const initialRequestedPathState = getRequestedPathState();
  const [requestedPathState] = useState(initialRequestedPathState);
  const isRoughdraftFlavoredMarkdownRoute = isReservedAppPath(
    window.location.pathname,
  );
  const [backend, setBackend] = useState<StorageBackend | null>(null);
  const [documentPage, setDocumentPage] = useState<Page | null>(null);
  const [activeDocumentPath, setActiveDocumentPath] = useState<string | null>(
    initialRequestedPathState.documentPath,
  );
  const [, setDocumentSaveState] = useState<SaveState>("idle");
  const [documentDiskChangeState, setDocumentDiskChangeState] =
    useState<DocumentDiskChangeState>("clean");
  const [documentForceResetKey, setDocumentForceResetKey] = useState<
    string | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const documentEditorViewMode =
    getDocumentEditorViewModeFromLocation("rich-text");
  const backendRef = useRef<StorageBackend | null>(null);
  const documentPageRef = useRef<Page | null>(null);
  const activeDocumentPathRef = useRef<string | null>(activeDocumentPath);
  const documentDirtyRef = useRef(false);
  const documentDraftContentRef = useRef<string | null>(null);

  backendRef.current = backend;
  documentPageRef.current = documentPage;
  activeDocumentPathRef.current = activeDocumentPath;

  const applyDocumentPage = useCallback((nextDocument: Page) => {
    setDocumentPage(nextDocument);
    documentDraftContentRef.current = nextDocument.content;
  }, []);

  const loadDocument = useCallback(
    async (nextBackend: StorageBackend, relativePath: string) => {
      const nextDocument = await nextBackend.getMarkdownFile(relativePath);
      applyDocumentPage(nextDocument);
      setActiveDocumentPath(relativePath);
      documentDirtyRef.current = false;
      setDocumentDiskChangeState("clean");
      return nextDocument;
    },
    [applyDocumentPage],
  );

  useEffect(() => {
    let cancelled = false;

    const loadUpdateStatus = async () => {
      const nextUpdateStatus = await fetchUpdateStatus();
      if (!cancelled) {
        setUpdateStatus(nextUpdateStatus);
      }
    };

    void loadUpdateStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const sourceUrl = new URL("/api/open-requests", window.location.origin);
    if (requestedPathState.rawPath) {
      sourceUrl.searchParams.set("path", requestedPathState.rawPath);
    }

    const source = new EventSource(`${sourceUrl.pathname}${sourceUrl.search}`);
    const handleOpenRequest = (event: Event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          url?: unknown;
        };
        if (typeof payload.url !== "string" || !payload.url.trim()) return;

        const nextUrl = new URL(payload.url, window.location.origin);
        window.focus();
        if (nextUrl.href !== window.location.href) {
          window.location.assign(nextUrl.href);
        }
      } catch (error) {
        console.error("Failed to handle Roughdraft open request:", error);
      }
    };

    source.addEventListener("open-request", handleOpenRequest);

    return () => {
      source.removeEventListener("open-request", handleOpenRequest);
      source.close();
    };
  }, [requestedPathState.rawPath]);

  useEffect(() => {
    let cancelled = false;

    const initialize = async () => {
      setLoading(true);
      setLoadError(null);
      setDocumentPage(null);

      try {
        const detectedBackend = await detectBackend();
        if (cancelled) return;

        setBackend(detectedBackend);

        if (!requestedPathState.rawPath) {
          setActiveDocumentPath(null);
          setLoading(false);
          return;
        }

        syncRequestedPathInUrl(requestedPathState.rawPath);

        if (
          !requestedPathState.projectPath ||
          !requestedPathState.documentPath
        ) {
          setActiveDocumentPath(null);
          setLoadError("Roughdraft now opens one .md file at a time.");
          setLoading(false);
          return;
        }

        if (detectedBackend.canManageProjects) {
          await detectedBackend.openProject(requestedPathState.projectPath);
        }

        if (cancelled) return;

        await loadDocument(detectedBackend, requestedPathState.documentPath);
        if (cancelled) return;

        setLoading(false);
      } catch (error) {
        if (cancelled) return;

        console.error("Failed to open markdown file:", error);
        setActiveDocumentPath(null);
        setLoadError("Could not open that markdown file.");
        setLoading(false);
      }
    };

    void initialize();

    return () => {
      cancelled = true;
    };
  }, [
    loadDocument,
    requestedPathState.documentPath,
    requestedPathState.projectPath,
    requestedPathState.rawPath,
  ]);

  useEffect(() => {
    const workspaceTitlePath = activeDocumentPath
      ? formatWorkspacePathForDisplay(
          backend?.info.projectPath
            ? joinPath(backend.info.projectPath, activeDocumentPath)
            : requestedPathState.rawPath,
        )
      : null;

    document.title = isRoughdraftFlavoredMarkdownRoute
      ? "Roughdraft Flavored Markdown"
      : (workspaceTitlePath ?? "Roughdraft");
  }, [
    activeDocumentPath,
    backend,
    isRoughdraftFlavoredMarkdownRoute,
    requestedPathState.rawPath,
  ]);

  const handleSaveDocument = useCallback(
    async (id: string, content: string) => {
      if (!activeDocumentPath) return;
      const expectedVersion =
        documentPageRef.current?.id === id
          ? documentPageRef.current.version
          : undefined;

      let savedDocument: Page | undefined;
      try {
        savedDocument = await backendRef.current?.saveMarkdownFile(
          activeDocumentPath,
          content,
          expectedVersion,
        );
      } catch (error) {
        if (error instanceof MarkdownFileConflictError) {
          setDocumentDiskChangeState("conflict");
        }
        throw error;
      }

      const firstLine = content.split("\n")[0] || "";
      const fallbackTitle = id.split("/").at(-1) || id;
      const title = firstLine.replace(/^#*\s*/, "") || fallbackTitle;
      const nextDocument = savedDocument ?? {
        id,
        content,
        title,
        version: expectedVersion,
      };

      applyDocumentPage(nextDocument);
      documentDirtyRef.current = false;
      setDocumentDiskChangeState("clean");
    },
    [activeDocumentPath, applyDocumentPage],
  );

  const handleDocumentDirtyStateChange = useCallback((isDirty: boolean) => {
    documentDirtyRef.current = isDirty;
  }, []);

  const handleDocumentLocalContentChange = useCallback((markdown: string) => {
    documentDraftContentRef.current = markdown;
  }, []);

  const handleReloadDocumentFromDisk = useCallback(async () => {
    const currentBackend = backendRef.current;
    const currentPath = activeDocumentPathRef.current;
    if (!currentBackend || !currentPath) return;

    const nextDocument = await currentBackend.getMarkdownFile(currentPath);
    applyDocumentPage(nextDocument);
    documentDirtyRef.current = false;
    setDocumentDiskChangeState("clean");
    setDocumentForceResetKey(
      `${currentPath}:${nextDocument.version ?? Date.now()}`,
    );
  }, [applyDocumentPage]);

  const handleKeepEditingWithoutAutosave = useCallback(() => {
    setDocumentDiskChangeState("paused");
  }, []);

  const handleOverwriteDocumentOnDisk = useCallback(async () => {
    const currentBackend = backendRef.current;
    const currentPath = activeDocumentPathRef.current;
    const currentDocument = documentPageRef.current;
    if (!currentBackend || !currentPath || !currentDocument) return;

    const content = documentDraftContentRef.current ?? currentDocument.content;
    const firstLine = content.split("\n")[0] || "";
    const fallbackTitle =
      currentDocument.id.split("/").at(-1) || currentDocument.id;
    const title = firstLine.replace(/^#*\s*/, "") || fallbackTitle;
    const savedDocument = (await currentBackend.saveMarkdownFile(
      currentPath,
      content,
    )) ?? {
      ...currentDocument,
      content,
      title,
    };

    applyDocumentPage(savedDocument);
    documentDirtyRef.current = false;
    setDocumentDiskChangeState("clean");
  }, [applyDocumentPage]);

  useEffect(() => {
    if (!backend?.watchMarkdownFile || !activeDocumentPath) return;

    let disposed = false;
    const stopWatching = backend.watchMarkdownFile(
      activeDocumentPath,
      (event) => {
        if (disposed || event.path !== activeDocumentPath) return;

        const currentDocument = documentPageRef.current;
        if (event.version && currentDocument?.version === event.version) {
          return;
        }

        if (!event.exists) {
          setDocumentDiskChangeState("changed");
          return;
        }

        if (documentDiskChangeState === "paused") {
          return;
        }

        if (documentDirtyRef.current) {
          setDocumentDiskChangeState("changed");
          return;
        }

        void (async () => {
          const currentBackend = backendRef.current;
          const currentPath = activeDocumentPathRef.current;
          if (!currentBackend || !currentPath || disposed) return;

          try {
            const nextDocument =
              await currentBackend.getMarkdownFile(currentPath);
            if (disposed) return;
            applyDocumentPage(nextDocument);
            setDocumentDiskChangeState("clean");
          } catch (error) {
            console.error("Failed to reload changed markdown file:", error);
          }
        })();
      },
    );

    return () => {
      disposed = true;
      stopWatching();
    };
  }, [activeDocumentPath, applyDocumentPage, backend, documentDiskChangeState]);

  const handleDocumentEditorViewModeChange = useCallback(
    (nextMode: DocumentEditorViewMode) => {
      if (nextMode === documentEditorViewMode) return;
      window.location.assign(buildLocationForDocumentEditorViewMode(nextMode));
    },
    [documentEditorViewMode],
  );

  if (loading) {
    return <div className="h-screen bg-[#FCFCFC]" aria-hidden="true" />;
  }

  if (isRoughdraftFlavoredMarkdownRoute) {
    return <RoughdraftFlavoredMarkdownPage />;
  }

  if (!requestedPathState.rawPath || loadError) {
    return (
      <Homepage
        message={
          loadError ??
          "Roughdraft is a markdown editor with commenting and suggest changes mode, making it easier to align with AI on complex ideas."
        }
        updateStatus={updateStatus}
      />
    );
  }

  const documentAbsolutePath =
    activeDocumentPath && backend?.info.projectPath
      ? joinPath(backend.info.projectPath, activeDocumentPath)
      : requestedPathState.rawPath;
  const documentFilenameLabel =
    getPathLeaf(documentAbsolutePath ?? activeDocumentPath) ?? "Untitled.md";

  return (
    <main className="relative flex h-screen min-w-0 flex-col overflow-hidden bg-[#FCFCFC] text-slate-950">
      {updateStatus ? (
        <div className="pointer-events-none absolute top-4 right-4 z-40 max-w-sm">
          <div className="pointer-events-auto">
            <UpdateNotice updateStatus={updateStatus} />
          </div>
        </div>
      ) : null}
      <DocumentWorkspace
        documentPage={documentPage}
        activeDocumentPath={activeDocumentPath}
        documentFilenameLabel={documentFilenameLabel}
        documentEditorViewMode={documentEditorViewMode}
        onDocumentEditorViewModeChange={handleDocumentEditorViewModeChange}
        onSaveDocument={handleSaveDocument}
        onDocumentSaveStateChange={setDocumentSaveState}
        onDocumentDirtyStateChange={handleDocumentDirtyStateChange}
        onDocumentLocalContentChange={handleDocumentLocalContentChange}
        documentDiskChangeState={documentDiskChangeState}
        documentForceResetKey={documentForceResetKey}
        onReloadDocumentFromDisk={handleReloadDocumentFromDisk}
        onKeepEditingWithoutAutosave={handleKeepEditingWithoutAutosave}
        onOverwriteDocumentOnDisk={handleOverwriteDocumentOnDisk}
        backend={backend}
      />
    </main>
  );
}
