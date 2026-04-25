import { Menu } from "lucide-react";
import { Canvas } from "./Canvas";
import { PageCard } from "./PageCard";
import { Button } from "./components/ui/button";
import type { Page, ProjectLayout, StorageBackend } from "./storage";

interface CanvasRevealRequest {
  pageId: string;
  key: string;
}

interface WorldPoint {
  x: number;
  y: number;
}

interface WorldFrame extends WorldPoint {
  width: number;
  height: number;
}

interface CanvasWorkspaceProps {
  sidebarVisible: boolean;
  sidebarToggleLabel: string;
  onShowSidebar: () => void;
  pages: Page[];
  layout: ProjectLayout;
  backend: StorageBackend | null;
  selectedId: string | null;
  canvasRevealRequest: CanvasRevealRequest | null;
  initialWorldCenter: WorldPoint | null;
  initialWorldCenterKey: string;
  revealedPageFrame: WorldFrame | null;
  onCanvasPointerDown: () => void;
  onSelectPage: (id: string) => void;
  onSavePage: (id: string, content: string) => Promise<void>;
  onReposition: (id: string, x: number, y: number) => void;
  onDeletePage: (id: string) => void | Promise<void>;
}

export function CanvasWorkspace({
  sidebarVisible,
  sidebarToggleLabel,
  onShowSidebar,
  pages,
  layout,
  backend,
  selectedId,
  canvasRevealRequest,
  initialWorldCenter,
  initialWorldCenterKey,
  revealedPageFrame,
  onCanvasPointerDown,
  onSelectPage,
  onSavePage,
  onReposition,
  onDeletePage,
}: CanvasWorkspaceProps) {
  return (
    <>
      {!sidebarVisible ? (
        <div className="absolute top-2 left-2 z-30">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 rounded-[10px] border-transparent bg-transparent text-slate-700 shadow-none hover:bg-transparent"
            onClick={onShowSidebar}
            aria-label={sidebarToggleLabel}
            title={sidebarToggleLabel}
          >
            <Menu className="size-4" />
          </Button>
        </div>
      ) : null}
      <Canvas
        onPointerDownOnCanvas={onCanvasPointerDown}
        initialWorldCenter={initialWorldCenter}
        initialWorldCenterKey={initialWorldCenterKey}
        focusedWorldFrame={revealedPageFrame}
        focusedWorldFrameKey={canvasRevealRequest?.key}
      >
        {pages.map((page) => {
          const pos = layout.pages[page.id] || { x: 0, y: 0 };
          if (!backend) return null;

          return (
            <PageCard
              key={page.id}
              page={page}
              x={pos.x}
              y={pos.y}
              selected={selectedId === page.id}
              focusRequestKey={
                canvasRevealRequest?.pageId === page.id
                  ? canvasRevealRequest.key
                  : null
              }
              canDelete
              onSelect={onSelectPage}
              onSave={onSavePage}
              onReposition={onReposition}
              onDelete={(id) => void onDeletePage(id)}
              backend={backend}
            />
          );
        })}
      </Canvas>
    </>
  );
}
