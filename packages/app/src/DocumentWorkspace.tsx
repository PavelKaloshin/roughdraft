import { ChevronLeft, CodeXml, Eye, Menu } from "lucide-react";
import { useEffect, useState } from "react";
import type { DocumentEditorViewMode } from "./app-navigation";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import { PageCard } from "./PageCard";
import type { Page, StorageBackend } from "./storage";

type SaveState = "idle" | "saving" | "error";

interface DocumentWorkspaceProps {
  sidebarVisible: boolean;
  sidebarToggleLabel: string;
  onToggleSidebar: () => void;
  documentPage: Page | null;
  activeDocumentPath: string | null;
  documentFilenameLabel: string;
  documentEditorViewMode: DocumentEditorViewMode;
  onDocumentEditorViewModeChange: (mode: DocumentEditorViewMode) => void;
  onSaveDocument: (id: string, content: string) => Promise<void>;
  onDocumentSaveStateChange: (state: SaveState) => void;
  backend: StorageBackend | null;
}

export function DocumentWorkspace({
  sidebarVisible,
  sidebarToggleLabel,
  onToggleSidebar,
  documentPage,
  activeDocumentPath,
  documentFilenameLabel,
  documentEditorViewMode,
  onDocumentEditorViewModeChange,
  onSaveDocument,
  onDocumentSaveStateChange,
  backend,
}: DocumentWorkspaceProps) {
  const [documentHasComments, setDocumentHasComments] = useState(
    () => !!documentPage?.content.includes("{>>"),
  );

  useEffect(() => {
    setDocumentHasComments(!!documentPage?.content.includes("{>>"));
  }, [documentPage]);

  return (
    <>
      <div className="absolute top-2 left-2 z-30">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-9 rounded-[10px] border-transparent bg-transparent text-stone-700 shadow-none hover:bg-transparent"
          onClick={onToggleSidebar}
          aria-label={sidebarToggleLabel}
          title={sidebarToggleLabel}
        >
          {sidebarVisible ? (
            <ChevronLeft className="size-4" />
          ) : (
            <Menu className="size-4" />
          )}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-20 pb-8 sm:px-12">
        <div className="mx-auto min-h-full max-w-[1080px]">
          {documentPage ? (
            <div
              className={cn(
                "document-page-header mb-2 flex w-full max-w-[46.5rem] items-center gap-1.5 px-1 text-[0.62rem] font-medium tracking-[0.01em] text-stone-400",
                !documentHasComments && "document-page-header-no-comments",
              )}
            >
              <button
                type="button"
                className="grid h-[1.25rem] shrink-0 grid-cols-2 rounded-[999px] bg-[#DED8CE] px-[2px] py-[2px] shadow-[inset_0_1px_0_rgba(255,251,245,0.72)]"
                onClick={() =>
                  onDocumentEditorViewModeChange(
                    documentEditorViewMode === "rich-text"
                      ? "code"
                      : "rich-text",
                  )
                }
                aria-label={
                  documentEditorViewMode === "rich-text"
                    ? "Switch to code view"
                    : "Switch to rich text view"
                }
                title={
                  documentEditorViewMode === "rich-text"
                    ? "Switch to code view"
                    : "Switch to rich text view"
                }
              >
                <span
                  className={`flex h-[1rem] w-[1.375rem] items-center justify-center rounded-full transition ${
                    documentEditorViewMode === "rich-text"
                      ? "bg-[#FFFDFC] text-stone-700 shadow-[0_1px_2px_rgba(41,37,36,0.12)]"
                      : "text-stone-500"
                  }`}
                >
                  <Eye className="size-[0.75rem]" />
                </span>
                <span
                  className={`flex h-[1rem] w-[1.375rem] items-center justify-center rounded-full transition ${
                    documentEditorViewMode === "code"
                      ? "bg-[#FFFDFC] text-stone-700 shadow-[0_1px_2px_rgba(41,37,36,0.12)]"
                      : "text-stone-500"
                  }`}
                >
                  <CodeXml className="size-[0.75rem]" />
                </span>
              </button>
              <div
                className="min-w-0 truncate font-mono text-[0.7rem] tracking-[0.01em] text-stone-400"
                title={documentFilenameLabel}
              >
                {documentFilenameLabel}
              </div>
            </div>
          ) : null}
          {documentPage ? (
            backend ? (
              <PageCard
                key={`${documentPage.id}:${activeDocumentPath ?? ""}`}
                page={documentPage}
                mode="document"
                selected
                canDelete={false}
                onSave={onSaveDocument}
                onSaveStateChange={onDocumentSaveStateChange}
                editorViewMode={documentEditorViewMode}
                backend={backend}
                onCommentRailPresenceChange={setDocumentHasComments}
              />
            ) : null
          ) : (
            <div className="flex min-h-[50vh] items-center justify-center text-sm text-slate-500">
              Select a markdown file from the sidebar.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
