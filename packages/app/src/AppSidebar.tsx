import { ChevronLeft } from "lucide-react";
import { Button } from "./components/ui/button";
import { PathSwitcher } from "./PathSwitcher";
import { ProjectTreeSidebar } from "./ProjectTreeSidebar";
import type { StorageBackend } from "./storage";
import type { ViewMode } from "./app-navigation";

interface AppSidebarProps {
  isDocumentMode: boolean;
  sidebarToggleLabel: string;
  backend: StorageBackend | null;
  projectLabel: string;
  displayPath: string | null;
  workspacePathLabel: string;
  buildLocationForPath: (path?: string | null) => string;
  pathSwitcherDismissCount: number;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onCreatePage: () => void;
  onHideSidebar: () => void;
  treeCurrentPath: string | null;
  projectTreeVersion: number;
  onOpenMarkdownPage: (relativePath: string) => void | Promise<void>;
}

export function AppSidebar({
  isDocumentMode,
  sidebarToggleLabel,
  backend,
  projectLabel,
  displayPath,
  workspacePathLabel,
  buildLocationForPath,
  pathSwitcherDismissCount,
  viewMode,
  onViewModeChange,
  onCreatePage,
  onHideSidebar,
  treeCurrentPath,
  projectTreeVersion,
  onOpenMarkdownPage,
}: AppSidebarProps) {
  return (
    <aside
      className={`flex h-full w-[320px] max-w-[34vw] min-w-[280px] shrink-0 flex-col border-r ${
        isDocumentMode
          ? "border-slate-200 bg-white"
          : "border-slate-200/80 bg-white"
      }`}
    >
      <div
        className={`border-b px-4 pt-5 pb-4 ${isDocumentMode ? "border-slate-200" : "border-slate-200/80"}`}
      >
        {!isDocumentMode ? (
          <div className="mb-3 flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="rounded-[10px] text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              onClick={onHideSidebar}
              aria-label={sidebarToggleLabel}
              title={sidebarToggleLabel}
            >
              <ChevronLeft className="size-4" />
            </Button>
          </div>
        ) : null}

        {backend ? (
          <PathSwitcher
            backend={backend}
            currentLabel={projectLabel}
            currentPath={displayPath}
            projectPath={backend.info.projectPath ?? null}
            buildLocationForPath={buildLocationForPath}
            dismissCount={pathSwitcherDismissCount}
            description={workspacePathLabel}
          />
        ) : (
          <div className="rounded-[14px] border border-slate-200/80 bg-white/80 px-4 py-3 shadow-[0_8px_24px_rgba(15,23,42,0.06)]">
            <div className="truncate text-[0.95rem] font-semibold tracking-[-0.02em] text-slate-950">
              {projectLabel}
            </div>
            <div className="mt-1 truncate text-[0.74rem] text-slate-500">
              {workspacePathLabel}
            </div>
          </div>
        )}

        <div className="mt-4">
          <div className="grid h-9 grid-cols-2 rounded-[10px] border border-slate-200/80 bg-white/75 p-1 shadow-[0_6px_18px_rgba(15,23,42,0.04)]">
            <button
              type="button"
              className={`rounded-[8px] px-3 text-[0.82rem] font-semibold transition ${
                viewMode === "canvas"
                  ? "bg-slate-900 text-white shadow-[0_6px_14px_rgba(15,23,42,0.18)]"
                  : "text-slate-600 hover:bg-slate-100/80"
              }`}
              onClick={() => onViewModeChange("canvas")}
            >
              Canvas
            </button>
            <button
              type="button"
              className={`rounded-[8px] px-3 text-[0.82rem] font-semibold transition ${
                isDocumentMode
                  ? "bg-slate-900 text-white shadow-[0_6px_14px_rgba(15,23,42,0.18)]"
                  : "text-slate-600 hover:bg-slate-100/80"
              }`}
              onClick={() => onViewModeChange("document")}
            >
              Document
            </button>
          </div>
        </div>

        <div className="mt-3">
          <Button
            type="button"
            variant={isDocumentMode ? "outline" : "default"}
            className={`h-10 w-full justify-center rounded-[10px] border text-[0.84rem] font-semibold shadow-none ${
              isDocumentMode
                ? "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                : "border-slate-900 bg-slate-900 text-white hover:bg-slate-800"
            }`}
            onClick={onCreatePage}
            title={isDocumentMode ? "New document" : "New page"}
          >
            {isDocumentMode ? "+ New document" : "+ New page"}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {backend ? (
          <ProjectTreeSidebar
            backend={backend}
            projectPath={backend.info.projectPath ?? null}
            currentPath={treeCurrentPath}
            buildLocationForPath={buildLocationForPath}
            layout="embedded"
            refreshKey={projectTreeVersion}
            onOpenMarkdownPage={(relativePath) =>
              void onOpenMarkdownPage(relativePath)
            }
          />
        ) : null}
      </div>
    </aside>
  );
}
