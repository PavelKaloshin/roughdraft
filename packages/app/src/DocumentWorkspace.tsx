import {
  AlertTriangle,
  Check,
  CodeXml,
  Eye,
  Loader2,
  MessageSquarePlus,
  PencilLine,
  RefreshCcw,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentEditorViewMode } from "./app-navigation";
import { Button } from "./components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";
import { criticMarkdownHasReviewRail } from "./critic-markup";
import { cn } from "./lib/utils";
import { PageCard, type DocumentInteractionMode } from "./PageCard";
import type { Page, StorageBackend } from "./storage";

type SaveState = "idle" | "saving" | "error";
type DiskChangeState = "clean" | "changed" | "conflict" | "paused";

const documentInteractionModeOptions = [
  { value: "editing", label: "editing", Icon: PencilLine },
  { value: "suggesting", label: "suggesting", Icon: MessageSquarePlus },
  { value: "viewing", label: "viewing", Icon: Eye },
] satisfies {
  value: DocumentInteractionMode;
  label: string;
  Icon: typeof Eye;
}[];

const conflictNoticeCopy: Record<
  Exclude<DiskChangeState, "clean">,
  {
    title: string;
    body: string;
  }
> = {
  changed: {
    title: "File changed on disk",
    body: "Roughdraft found a newer version of this file on disk. Reload to use that version, or overwrite it with your current draft.",
  },
  conflict: {
    title: "Save conflict",
    body: "This file changed on disk while you have unsaved edits. Autosave is paused so your draft will not overwrite those changes.",
  },
  paused: {
    title: "Autosave paused",
    body: "Keep editing locally, then reload from disk to discard your draft or overwrite the disk file when you are ready.",
  },
};

interface DocumentWorkspaceProps {
  documentPage: Page | null;
  activeDocumentPath: string | null;
  documentFilenameLabel: string;
  documentEditorViewMode: DocumentEditorViewMode;
  onDocumentEditorViewModeChange: (mode: DocumentEditorViewMode) => void;
  onSaveDocument: (id: string, content: string) => Promise<void>;
  onDocumentSaveStateChange: (state: SaveState) => void;
  onDocumentDirtyStateChange: (isDirty: boolean) => void;
  onDocumentLocalContentChange: (markdown: string) => void;
  documentDiskChangeState: DiskChangeState;
  documentForceResetKey: string | null;
  onReloadDocumentFromDisk: () => void | Promise<void>;
  onKeepEditingWithoutAutosave: () => void;
  onOverwriteDocumentOnDisk: () => void | Promise<void>;
  backend: StorageBackend | null;
}

export function DocumentWorkspace({
  documentPage,
  activeDocumentPath,
  documentFilenameLabel,
  documentEditorViewMode,
  onDocumentEditorViewModeChange,
  onSaveDocument,
  onDocumentSaveStateChange,
  onDocumentDirtyStateChange,
  onDocumentLocalContentChange,
  documentDiskChangeState,
  documentForceResetKey,
  onReloadDocumentFromDisk,
  onKeepEditingWithoutAutosave,
  onOverwriteDocumentOnDisk,
  backend,
}: DocumentWorkspaceProps) {
  const [documentInteractionMode, setDocumentInteractionMode] =
    useState<DocumentInteractionMode>("editing");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [showSaved, setShowSaved] = useState(false);
  const wasSavingRef = useRef(false);

  const handleSaveStateChange = useCallback(
    (state: SaveState) => {
      setSaveState(state);
      onDocumentSaveStateChange(state);
      if (state === "saving") {
        wasSavingRef.current = true;
        setShowSaved(false);
      } else if (state === "idle" && wasSavingRef.current) {
        wasSavingRef.current = false;
        setShowSaved(true);
        const timer = setTimeout(() => setShowSaved(false), 2000);
        return () => clearTimeout(timer);
      }
    },
    [onDocumentSaveStateChange],
  );

  const [documentHasComments, setDocumentHasComments] = useState(
    () =>
      !!documentPage?.content &&
      criticMarkdownHasReviewRail(documentPage.content),
  );

  useEffect(() => {
    setDocumentHasComments(
      !!documentPage?.content &&
        criticMarkdownHasReviewRail(documentPage.content),
    );
  }, [documentPage]);

  const editorViewModeToggleLabel =
    documentEditorViewMode === "rich-text"
      ? "Switch to code view"
      : "Switch to rich text view";
  const activeDocumentInteractionMode = documentInteractionModeOptions.find(
    (option) => option.value === documentInteractionMode,
  );
  const ActiveDocumentInteractionModeIcon =
    activeDocumentInteractionMode?.Icon ?? PencilLine;
  const conflictNotice =
    documentDiskChangeState === "clean"
      ? null
      : conflictNoticeCopy[documentDiskChangeState];

  return (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-y-auto px-8 pb-8 sm:px-12",
        conflictNotice ? "pt-40 sm:pt-28" : "pt-10",
      )}
    >
      {conflictNotice ? (
        <div
          role="status"
          aria-label="File conflict"
          className="fixed top-3 left-1/2 z-50 flex w-[min(calc(100vw-1rem),52rem)] -translate-x-1/2 flex-col gap-3 rounded-[8px] border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-3 py-3 text-amber-950 dark:text-amber-100 shadow-[0_14px_40px_rgba(120,53,15,0.18)] dark:shadow-[0_14px_40px_rgba(0,0,0,0.4)] sm:flex-row sm:items-center sm:justify-between sm:px-4"
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <div className="text-sm font-semibold leading-5">
                {conflictNotice.title}
              </div>
              <div className="mt-0.5 text-xs leading-5 text-amber-900 dark:text-amber-200">
                {conflictNotice.body}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 rounded-[7px] bg-white/55 dark:bg-white/10 px-2 text-xs text-amber-950 dark:text-amber-100 hover:bg-white dark:hover:bg-white/20"
              onClick={() => void onReloadDocumentFromDisk()}
            >
              <RefreshCcw className="size-3.5" />
              Reload from disk
            </Button>
            {documentDiskChangeState !== "paused" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 rounded-[7px] bg-white/55 dark:bg-white/10 px-2 text-xs text-amber-950 dark:text-amber-100 hover:bg-white dark:hover:bg-white/20"
                onClick={onKeepEditingWithoutAutosave}
              >
                <PencilLine className="size-3.5" />
                Keep editing with autosave paused
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 rounded-[7px] bg-amber-900 dark:bg-amber-600 px-2 text-xs text-white hover:bg-amber-800 dark:hover:bg-amber-500"
              onClick={() => void onOverwriteDocumentOnDisk()}
            >
              <Upload className="size-3.5" />
              Overwrite disk file
            </Button>
          </div>
        </div>
      ) : null}
      <div className="mx-auto min-h-full max-w-[1080px]">
        {documentPage ? (
          <div
            className={cn(
              "document-page-shell mb-2 text-[0.62rem] font-medium tracking-[0.01em] text-stone-400",
              !documentHasComments && "document-page-shell-no-comments",
            )}
          >
            <div className="document-page-main min-w-0">
              <div className="flex w-full flex-wrap items-center gap-1.5 px-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        className="grid h-[1.25rem] shrink-0 grid-cols-2 rounded-[999px] bg-[#DED8CE] dark:bg-slate-700 px-[2px] py-[2px] shadow-[inset_0_1px_0_rgba(255,251,245,0.72)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                      >
                        <span
                          className={`flex h-[1rem] w-[1.375rem] items-center justify-center rounded-full transition ${
                            documentEditorViewMode === "rich-text"
                              ? "bg-[#FFFDFC] dark:bg-slate-500 text-stone-700 dark:text-white shadow-[0_1px_2px_rgba(41,37,36,0.12)]"
                              : "text-stone-500 dark:text-slate-400"
                          }`}
                        >
                          <Eye className="size-[0.75rem]" />
                        </span>
                        <span
                          className={`flex h-[1rem] w-[1.375rem] items-center justify-center rounded-full transition ${
                            documentEditorViewMode === "code"
                              ? "bg-[#FFFDFC] dark:bg-slate-500 text-stone-700 dark:text-white shadow-[0_1px_2px_rgba(41,37,36,0.12)]"
                              : "text-stone-500 dark:text-slate-400"
                          }`}
                        >
                          <CodeXml className="size-[0.75rem]" />
                        </span>
                      </button>
                    }
                    aria-label={editorViewModeToggleLabel}
                    onClick={() =>
                      onDocumentEditorViewModeChange(
                        documentEditorViewMode === "rich-text"
                          ? "code"
                          : "rich-text",
                      )
                    }
                  />
                  <TooltipContent>{editorViewModeToggleLabel}</TooltipContent>
                </Tooltip>
                <div
                  className="min-w-0 truncate font-mono text-[0.7rem] tracking-[0.01em] text-stone-400 dark:text-stone-500"
                  title={documentFilenameLabel}
                >
                  {documentFilenameLabel}
                </div>
                {saveState === "saving" ? (
                  <span
                    role="status"
                    aria-label="Saving"
                    className="inline-flex shrink-0 items-center gap-1 font-mono text-[0.6rem] tracking-[0.01em] text-stone-400 dark:text-stone-500"
                  >
                    <Loader2 className="size-[0.6rem] animate-spin" />
                    Saving
                  </span>
                ) : showSaved ? (
                  <span
                    role="status"
                    aria-label="Saved"
                    className="inline-flex shrink-0 items-center gap-1 font-mono text-[0.6rem] tracking-[0.01em] text-stone-400 dark:text-stone-500"
                  >
                    <Check className="size-[0.6rem]" />
                    Saved
                  </span>
                ) : null}
                <div className="ml-auto inline-flex h-[1.25rem] shrink-0 items-center">
                  <Select<DocumentInteractionMode>
                    value={documentInteractionMode}
                    onValueChange={(value) => {
                      if (value) setDocumentInteractionMode(value);
                    }}
                  >
                    <SelectTrigger
                      aria-label="Document mode"
                      className="h-[1.5rem] px-1 font-mono text-[0.7rem] leading-[1.25rem] font-normal tracking-[0.01em] text-stone-400 dark:text-stone-500 hover:text-stone-500 dark:hover:text-stone-400"
                    >
                      <ActiveDocumentInteractionModeIcon className="size-[0.68rem]" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {documentInteractionModeOptions.map(
                        ({ value, label, Icon }) => (
                          <SelectItem key={value} value={value} label={label}>
                            <Icon className="size-3 text-stone-500 dark:text-stone-400" />
                            <SelectItemText>{label}</SelectItemText>
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            {documentHasComments ? (
              <div
                className="document-comment-rail pointer-events-none invisible"
                aria-hidden="true"
              />
            ) : null}
          </div>
        ) : null}
        {documentPage ? (
          backend ? (
            <PageCard
              key={`${documentPage.id}:${activeDocumentPath ?? ""}`}
              page={documentPage}
              selected
              onSave={onSaveDocument}
              onSaveStateChange={handleSaveStateChange}
              editorViewMode={documentEditorViewMode}
              interactionMode={documentInteractionMode}
              backend={backend}
              onCommentRailPresenceChange={setDocumentHasComments}
              onDirtyStateChange={onDocumentDirtyStateChange}
              onLocalContentChange={onDocumentLocalContentChange}
              saveBlocked={documentDiskChangeState !== "clean"}
              forceResetKey={documentForceResetKey}
            />
          ) : null
        ) : (
          <div className="flex min-h-[50vh] items-center justify-center text-sm text-slate-500 dark:text-slate-400">
            Open a markdown file to begin.
          </div>
        )}
      </div>
    </div>
  );
}
