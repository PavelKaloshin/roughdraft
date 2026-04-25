import { useEffect, useState, useCallback, useRef } from "react";
import type { StorageBackend, Page, ProjectLayout } from "./storage";
import { detectBackend } from "./detect-backend";
import { AppSidebar } from "./AppSidebar";
import { CanvasWorkspace } from "./CanvasWorkspace";
import { DocumentWorkspace } from "./DocumentWorkspace";
import { HomeScreen } from "./HomeScreen";
import { UpdateNotice } from "./UpdateNotice";
import {
  CANVAS_FRAME_WIDTH,
  type DocumentEditorViewMode,
  type RequestedPathState,
  type ViewMode,
  buildLocationForDocumentEditorViewMode,
  buildLocationForPath,
  buildLocationForViewMode,
  formatWorkspacePathForDisplay,
  getCanvasFrameWidth,
  getCanvasPageId,
  getDocumentEditorViewModeFromLocation,
  getDocumentNavigationState,
  getPathLeaf,
  getRequestedPathState,
  getViewModeFromLocation,
  getWorkspaceName,
  getWorkspacePath,
  joinPath,
  syncProjectPathInUrl,
  syncRequestedPathInUrl,
} from "./app-navigation";
import { LocalStorageBackend } from "./local-storage-backend";
import { recordRecentOpen } from "./recent-items";
import { fetchUpdateStatus, type UpdateStatus } from "./update-status";

interface CanvasRevealRequest {
  pageId: string;
  key: string;
}

export function App() {
  const initialRequestedPathState = getRequestedPathState();
  const [requestedPathState, setRequestedPathState] =
    useState<RequestedPathState>(initialRequestedPathState);
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    getViewModeFromLocation(
      initialRequestedPathState.documentPath ? "document" : "canvas",
    ),
  );
  const [backend, setBackend] = useState<StorageBackend | null>(null);
  const [allPages, setAllPages] = useState<Page[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  const [documentPage, setDocumentPage] = useState<Page | null>(null);
  const [activeDocumentPath, setActiveDocumentPath] = useState<string | null>(
    requestedPathState.documentPath,
  );
  const [layout, setLayout] = useState<ProjectLayout>({ pages: {} });
  const [pathSwitcherDismissCount, setPathSwitcherDismissCount] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canvasRevealRequest, setCanvasRevealRequest] =
    useState<CanvasRevealRequest | null>(null);
  const [, setDocumentSaveState] = useState<"idle" | "saving" | "error">(
    "idle",
  );
  const documentEditorViewMode =
    getDocumentEditorViewModeFromLocation("rich-text");
  const [projectTreeVersion, setProjectTreeVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [demoModeEnabled, setDemoModeEnabled] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(
    () => !getRequestedPathState().documentPath,
  );
  const backendRef = useRef<StorageBackend | null>(null);
  const layoutRef = useRef<ProjectLayout>({ pages: {} });
  const saveLayoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  backendRef.current = backend;
  layoutRef.current = layout;

  const loadProject = useCallback(async (nextBackend: StorageBackend) => {
    if (saveLayoutTimer.current) {
      clearTimeout(saveLayoutTimer.current);
      saveLayoutTimer.current = null;
    }

    const [pageList, project] = await Promise.all([
      nextBackend.listPages(),
      nextBackend.getProject(),
    ]);

    let pg: Page[];
    let proj = project;

    if (pageList.length === 0) {
      const page = await nextBackend.createPage(
        "Untitled",
        "# Welcome to Roughdraft\n\nStart writing. Your work is saved automatically.\n",
      );
      pg = [page];
      proj = await nextBackend.getProject();
    } else {
      pg = pageList;
    }

    let layoutChanged = false;
    for (const p of pg) {
      if (!proj.pages[p.id]) {
        const idx = Object.keys(proj.pages).length;
        proj.pages[p.id] = {
          x: idx * 720,
          y: 0,
          width: 680,
          height: 500,
        };
        layoutChanged = true;
      }
    }
    if (layoutChanged) {
      await nextBackend.saveProject(proj);
    }

    setAllPages(pg);
    setSelectedId(null);
    setPages(pg);
    setLayout(proj);

    return pg;
  }, []);

  const loadDocument = useCallback(
    async (nextBackend: StorageBackend, relativePath: string) => {
      const nextDocument = await nextBackend.getMarkdownFile(relativePath);
      setDocumentPage(nextDocument);
      setActiveDocumentPath(relativePath);
      return nextDocument;
    },
    [],
  );

  const resetProjectState = useCallback(() => {
    setAllPages([]);
    setPages([]);
    setLayout({ pages: {} });
    setSelectedId(null);
    setDocumentPage(null);
    setActiveDocumentPath(null);
  }, []);

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
    let cancelled = false;

    const initialize = async () => {
      const detectedBackend = await detectBackend();
      if (cancelled) return;

      if (requestedPathState.rawPath && detectedBackend.canManageProjects) {
        const requestedProjectPath = requestedPathState.projectPath;
        if (
          requestedProjectPath &&
          requestedProjectPath !==
            getWorkspacePath(detectedBackend.info.projectPath)
        ) {
          try {
            await detectedBackend.openProject(requestedProjectPath);
          } catch (error) {
            console.error("Failed to open project from URL:", error);
          }
        }
      }

      if (requestedPathState.rawPath) {
        syncRequestedPathInUrl(requestedPathState.rawPath);
      } else {
        syncRequestedPathInUrl(null);
      }

      setBackend(detectedBackend);

      if (!requestedPathState.projectPath) {
        resetProjectState();
        setLoading(false);
        return;
      }

      const loadedPages = await loadProject(detectedBackend);
      const initialDocumentPath =
        requestedPathState.documentPath ??
        (viewMode === "document" && loadedPages[0]
          ? `${loadedPages[0].id}.md`
          : null);

      if (initialDocumentPath) {
        const nextDocument = await loadDocument(
          detectedBackend,
          initialDocumentPath,
        );
        setSelectedId(nextDocument.id);
      } else {
        setDocumentPage(null);
        setActiveDocumentPath(null);
      }

      if (cancelled) return;
      setLoading(false);
    };

    void initialize();

    return () => {
      cancelled = true;
    };
  }, [
    loadDocument,
    loadProject,
    resetProjectState,
    requestedPathState.documentPath,
    requestedPathState.projectPath,
    requestedPathState.rawPath,
    viewMode,
  ]);

  useEffect(() => {
    if (!requestedPathState.rawPath) return;
    recordRecentOpen(requestedPathState.rawPath);
  }, [requestedPathState.rawPath]);

  useEffect(() => {
    const workspaceTitlePath = activeDocumentPath
      ? formatWorkspacePathForDisplay(
          backend?.info.projectPath
            ? joinPath(backend.info.projectPath, activeDocumentPath)
            : requestedPathState.rawPath,
        )
      : formatWorkspacePathForDisplay(
          backend?.info.projectPath ?? requestedPathState.projectPath,
        );

    document.title = workspaceTitlePath
      ? `Roughdraft of ${workspaceTitlePath}`
      : "Roughdraft";
  }, [
    activeDocumentPath,
    backend,
    requestedPathState.projectPath,
    requestedPathState.rawPath,
  ]);

  const handleOpenDemo = useCallback(async () => {
    const nextBackend = new LocalStorageBackend();
    setLoading(true);
    setDemoModeEnabled(true);
    setSidebarVisible(true);
    setViewMode("canvas");
    syncRequestedPathInUrl(null);
    setBackend(nextBackend);
    resetProjectState();

    try {
      await loadProject(nextBackend);
    } finally {
      setLoading(false);
    }
  }, [loadProject, resetProjectState]);

  const handleSavePage = useCallback(async (id: string, content: string) => {
    await backendRef.current?.savePage(id, content);
    const updatePage = (page: Page) => {
      if (page.id !== id) return page;
      const firstLine = content.split("\n")[0] || "";
      const title = firstLine.replace(/^#*\s*/, "") || page.id;
      return { ...page, content, title };
    };
    setPages((prev) => prev.map(updatePage));
    setAllPages((prev) => prev.map(updatePage));
  }, []);

  const handleSaveDocument = useCallback(
    async (id: string, content: string) => {
      if (!activeDocumentPath) return;
      await backendRef.current?.saveMarkdownFile(activeDocumentPath, content);

      const firstLine = content.split("\n")[0] || "";
      const fallbackTitle = id.split("/").at(-1) || id;
      const title = firstLine.replace(/^#*\s*/, "") || fallbackTitle;

      setDocumentPage((prev) =>
        prev && prev.id === id
          ? {
              ...prev,
              content,
              title,
            }
          : prev,
      );
      setPages((prev) =>
        prev.map((page) =>
          page.id === id ? { ...page, content, title } : page,
        ),
      );
      setAllPages((prev) =>
        prev.map((page) =>
          page.id === id ? { ...page, content, title } : page,
        ),
      );
    },
    [activeDocumentPath],
  );

  const handleReposition = useCallback((id: string, x: number, y: number) => {
    setLayout((prev) => {
      const entry = prev.pages[id] || { x: 0, y: 0, width: 680, height: 500 };
      const next = {
        ...prev,
        pages: { ...prev.pages, [id]: { ...entry, x, y } },
      };
      if (saveLayoutTimer.current) clearTimeout(saveLayoutTimer.current);
      saveLayoutTimer.current = setTimeout(() => {
        backendRef.current?.saveProject(layoutRef.current).catch((err) => {
          console.error("Failed to save layout:", err);
        });
      }, 300);
      return next;
    });
  }, []);

  const handleCreatePage = useCallback(async () => {
    if (!backendRef.current) return;
    const page = await backendRef.current.createPage(
      "Untitled",
      "# Untitled\n",
    );
    const proj = await backendRef.current.getProject();
    setAllPages((prev) => [...prev, page]);
    setPages((prev) => [...prev, page]);
    setLayout(proj);
    setSelectedId(page.id);
    setProjectTreeVersion((version) => version + 1);

    if (viewMode !== "document") return;

    const projectPath =
      backendRef.current.info.projectPath ?? requestedPathState.projectPath;
    const relativePath = `${page.id}.md`;

    setDocumentPage(page);
    setActiveDocumentPath(relativePath);
    setDocumentSaveState("idle");
    setCanvasRevealRequest(null);

    if (!projectPath) return;

    const nextPathState = getDocumentNavigationState(
      projectPath,
      relativePath,
      requestedPathState.rawPath,
    );
    setRequestedPathState(nextPathState);
    syncRequestedPathInUrl(nextPathState.rawPath);
  }, [requestedPathState.projectPath, requestedPathState.rawPath, viewMode]);

  const handleDeletePage = useCallback(
    async (id: string) => {
      if (!backendRef.current) return;
      await backendRef.current.deletePage(id);
      setAllPages((prev) => prev.filter((p) => p.id !== id));
      setPages((prev) => prev.filter((p) => p.id !== id));
      setLayout((prev) => {
        const next = { ...prev, pages: { ...prev.pages } };
        delete next.pages[id];
        return next;
      });
      if (selectedId === id) setSelectedId(null);
      setProjectTreeVersion((version) => version + 1);
    },
    [selectedId],
  );

  const handleCanvasPointerDown = useCallback(() => {
    setSelectedId(null);
    setPathSwitcherDismissCount((count) => count + 1);
  }, []);

  const openDocumentInRegularMode = useCallback(
    async (relativePath: string) => {
      if (!backendRef.current) return;

      const projectPath =
        backendRef.current.info.projectPath ?? requestedPathState.projectPath;
      if (!projectPath) return;

      try {
        const nextDocument = await loadDocument(
          backendRef.current,
          relativePath,
        );
        const nextPathState = getDocumentNavigationState(
          projectPath,
          relativePath,
          requestedPathState.rawPath,
        );
        setRequestedPathState(nextPathState);
        syncRequestedPathInUrl(nextPathState.rawPath);
        setSelectedId(nextDocument.id);
        setCanvasRevealRequest(null);
      } catch (error) {
        console.error("Failed to open markdown file:", error);
      }

      setPathSwitcherDismissCount((count) => count + 1);
    },
    [loadDocument, requestedPathState.projectPath, requestedPathState.rawPath],
  );

  const revealMarkdownPageOnCanvas = useCallback(
    (relativePath: string) => {
      const pageId = getCanvasPageId(relativePath);
      if (!pageId) return false;

      const targetPage = allPages.find((page) => page.id === pageId);
      if (!targetPage) return false;

      const projectPath =
        backendRef.current?.info.projectPath ?? requestedPathState.projectPath;
      if (!projectPath) return false;

      setRequestedPathState({
        rawPath: projectPath,
        projectPath,
        documentPath: null,
      });
      syncProjectPathInUrl(projectPath);
      setSelectedId(pageId);
      setCanvasRevealRequest({
        pageId,
        key: `${pageId}:${Date.now()}`,
      });
      setPathSwitcherDismissCount((count) => count + 1);
      return true;
    },
    [allPages, requestedPathState.projectPath],
  );

  const handleOpenMarkdownPage = useCallback(
    async (relativePath: string) => {
      if (viewMode === "document") {
        await openDocumentInRegularMode(relativePath);
        return;
      }

      revealMarkdownPageOnCanvas(relativePath);
    },
    [openDocumentInRegularMode, revealMarkdownPageOnCanvas, viewMode],
  );

  const handleViewModeChange = useCallback(
    (nextMode: ViewMode) => {
      if (nextMode === viewMode) return;
      window.location.assign(buildLocationForViewMode(nextMode));
    },
    [viewMode],
  );

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

  const shouldShowHomepage = !requestedPathState.rawPath && !demoModeEnabled;

  if (shouldShowHomepage) {
    return (
      <HomeScreen
        backend={backend}
        buildLocationForPath={buildLocationForPath}
        onOpenDemo={() => void handleOpenDemo()}
        updateStatus={updateStatus}
      />
    );
  }

  const documentAbsolutePath =
    activeDocumentPath && backend?.info.projectPath
      ? joinPath(backend.info.projectPath, activeDocumentPath)
      : requestedPathState.rawPath;
  const displayPath =
    viewMode === "document" && documentPage
      ? documentAbsolutePath
      : backend?.info.projectPath;
  const workspaceName = getWorkspaceName(displayPath ?? undefined);
  const isDocumentMode = viewMode === "document";
  const workspacePath =
    getWorkspacePath(
      backend?.info.projectPath ?? requestedPathState.projectPath ?? undefined,
    ) ?? "Browser drafts";
  const workspacePathLabel =
    formatWorkspacePathForDisplay(workspacePath) ?? workspacePath;
  const selectedCanvasPath =
    selectedId && backend?.info.projectPath
      ? joinPath(backend.info.projectPath, `${selectedId}.md`)
      : null;
  const treeCurrentPath = isDocumentMode
    ? documentAbsolutePath
    : (selectedCanvasPath ?? backend?.info.projectPath ?? displayPath);
  const firstPage = pages[0];
  const firstPageLayout = firstPage ? layout.pages[firstPage.id] : null;
  const firstPageFrame = firstPage
    ? {
        x: firstPageLayout?.x ?? 0,
        y: firstPageLayout?.y ?? 0,
        width: getCanvasFrameWidth(
          firstPage,
          firstPageLayout?.width ?? CANVAS_FRAME_WIDTH,
        ),
        height: firstPageLayout?.height ?? 500,
      }
    : null;
  const initialWorldCenter = firstPageFrame
    ? {
        x: firstPageFrame.x + firstPageFrame.width / 2,
        y: firstPageFrame.y + firstPageFrame.height / 2,
      }
    : null;
  const initialWorldCenterKey = `${displayPath ?? "browser"}:${firstPage?.id ?? "none"}`;
  const revealedPageLayout = canvasRevealRequest
    ? layout.pages[canvasRevealRequest.pageId]
    : null;
  const revealedPage = canvasRevealRequest
    ? pages.find((page) => page.id === canvasRevealRequest.pageId)
    : null;
  const revealedPageFrame =
    canvasRevealRequest && revealedPageLayout
      ? {
          x: revealedPageLayout.x,
          y: revealedPageLayout.y,
          width: getCanvasFrameWidth(revealedPage, revealedPageLayout.width),
          height: revealedPageLayout.height,
        }
      : null;
  const projectLabel = getPathLeaf(backend?.info.projectPath) ?? workspaceName;
  const documentFilenameLabel =
    getPathLeaf(activeDocumentPath) ?? "Untitled.md";
  const sidebarToggleLabel = sidebarVisible ? "Hide sidebar" : "Show sidebar";

  return (
    <div className="flex h-screen overflow-hidden bg-[#FCFCFC] text-slate-950">
      {sidebarVisible ? (
        <AppSidebar
          isDocumentMode={isDocumentMode}
          sidebarToggleLabel={sidebarToggleLabel}
          backend={backend}
          projectLabel={projectLabel}
          displayPath={displayPath ?? null}
          workspacePathLabel={workspacePathLabel}
          buildLocationForPath={buildLocationForPath}
          pathSwitcherDismissCount={pathSwitcherDismissCount}
          viewMode={viewMode}
          onViewModeChange={handleViewModeChange}
          onCreatePage={() => void handleCreatePage()}
          onHideSidebar={() => setSidebarVisible(false)}
          treeCurrentPath={treeCurrentPath ?? null}
          projectTreeVersion={projectTreeVersion}
          onOpenMarkdownPage={handleOpenMarkdownPage}
        />
      ) : null}

      <main className="relative min-w-0 flex-1 overflow-hidden">
        {updateStatus ? (
          <div className="pointer-events-none absolute top-4 right-4 z-40 max-w-sm">
            <div className="pointer-events-auto">
              <UpdateNotice updateStatus={updateStatus} />
            </div>
          </div>
        ) : null}
        <div className="flex h-full flex-col overflow-hidden bg-[#FCFCFC]">
          {isDocumentMode ? (
            <DocumentWorkspace
              sidebarVisible={sidebarVisible}
              sidebarToggleLabel={sidebarToggleLabel}
              onToggleSidebar={() => setSidebarVisible((visible) => !visible)}
              documentPage={documentPage}
              activeDocumentPath={activeDocumentPath}
              documentFilenameLabel={documentFilenameLabel}
              documentEditorViewMode={documentEditorViewMode}
              onDocumentEditorViewModeChange={
                handleDocumentEditorViewModeChange
              }
              onSaveDocument={handleSaveDocument}
              onDocumentSaveStateChange={setDocumentSaveState}
              backend={backend}
            />
          ) : (
            <CanvasWorkspace
              sidebarVisible={sidebarVisible}
              sidebarToggleLabel={sidebarToggleLabel}
              onShowSidebar={() => setSidebarVisible(true)}
              pages={pages}
              layout={layout}
              backend={backend}
              selectedId={selectedId}
              canvasRevealRequest={canvasRevealRequest}
              initialWorldCenter={initialWorldCenter}
              initialWorldCenterKey={initialWorldCenterKey}
              revealedPageFrame={revealedPageFrame}
              onCanvasPointerDown={handleCanvasPointerDown}
              onSelectPage={setSelectedId}
              onSavePage={handleSavePage}
              onReposition={handleReposition}
              onDeletePage={handleDeletePage}
            />
          )}
        </div>
      </main>
    </div>
  );
}
