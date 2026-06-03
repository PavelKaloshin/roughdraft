import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "./lib/utils";

export interface MarkdownTreeNode {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  children: MarkdownTreeNode[];
}

/**
 * Build a nested tree from the flat `paths` returned by `/api/file-tree`.
 *
 * Only `.md` files are kept; directories are inferred from file path segments,
 * so empty directories and non-markdown files are pruned automatically.
 * Directories sort before files, then by numeric-aware name order.
 */
export function buildMarkdownFileTree(paths: string[]): MarkdownTreeNode[] {
  const root: MarkdownTreeNode[] = [];
  const directoryIndex = new Map<string, MarkdownTreeNode>();

  const markdownPaths = paths.filter(
    (entry) => !entry.endsWith("/") && entry.toLowerCase().endsWith(".md"),
  );

  for (const filePath of markdownPaths) {
    const segments = filePath.split("/").filter(Boolean);
    let currentChildren = root;
    let currentPrefix = "";

    segments.forEach((segment, index) => {
      currentPrefix = currentPrefix ? `${currentPrefix}/${segment}` : segment;
      const isFile = index === segments.length - 1;

      if (isFile) {
        currentChildren.push({
          name: segment,
          relativePath: currentPrefix,
          kind: "file",
          children: [],
        });
        return;
      }

      let directoryNode = directoryIndex.get(currentPrefix);
      if (!directoryNode) {
        directoryNode = {
          name: segment,
          relativePath: currentPrefix,
          kind: "directory",
          children: [],
        };
        directoryIndex.set(currentPrefix, directoryNode);
        currentChildren.push(directoryNode);
      }
      currentChildren = directoryNode.children;
    });
  }

  const sortNodes = (nodes: MarkdownTreeNode[]) => {
    nodes.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, { numeric: true });
    });
    for (const node of nodes) {
      if (node.kind === "directory") sortNodes(node.children);
    }
  };

  sortNodes(root);
  return root;
}

interface DirectoryTreeProps {
  nodes: MarkdownTreeNode[];
  activePath: string | null;
  onSelect: (relativePath: string) => void;
  depth?: number;
}

function DirectoryTree({
  nodes,
  activePath,
  onSelect,
  depth = 0,
}: DirectoryTreeProps) {
  return (
    <ul className="m-0 list-none p-0">
      {nodes.map((node) =>
        node.kind === "directory" ? (
          <DirectoryTreeFolder
            key={node.relativePath}
            node={node}
            activePath={activePath}
            onSelect={onSelect}
            depth={depth}
          />
        ) : (
          <DirectoryTreeFile
            key={node.relativePath}
            node={node}
            activePath={activePath}
            onSelect={onSelect}
            depth={depth}
          />
        ),
      )}
    </ul>
  );
}

interface DirectoryTreeNodeProps {
  node: MarkdownTreeNode;
  activePath: string | null;
  onSelect: (relativePath: string) => void;
  depth: number;
}

const INDENT_STEP_REM = 0.75;

function DirectoryTreeFolder({
  node,
  activePath,
  onSelect,
  depth,
}: DirectoryTreeNodeProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <li>
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        data-testid={`directory-folder-${node.relativePath}`}
        className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-sm text-slate-600 hover:bg-slate-200/60 dark:text-slate-300 dark:hover:bg-slate-700/50"
        style={{ paddingLeft: `${0.5 + depth * INDENT_STEP_REM}rem` }}
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 opacity-70" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 opacity-70" />
        )}
        {expanded ? (
          <FolderOpen className="size-4 shrink-0 opacity-80" />
        ) : (
          <Folder className="size-4 shrink-0 opacity-80" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {expanded ? (
        <DirectoryTree
          nodes={node.children}
          activePath={activePath}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ) : null}
    </li>
  );
}

function DirectoryTreeFile({
  node,
  activePath,
  onSelect,
  depth,
}: DirectoryTreeNodeProps) {
  const isActive = activePath === node.relativePath;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.relativePath)}
        aria-current={isActive ? "true" : undefined}
        data-testid={`directory-file-${node.relativePath}`}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm",
          isActive
            ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
            : "text-slate-700 hover:bg-slate-200/60 dark:text-slate-200 dark:hover:bg-slate-700/50",
        )}
        style={{ paddingLeft: `${0.5 + depth * INDENT_STEP_REM + 1.25}rem` }}
      >
        <FileText className="size-4 shrink-0 opacity-70" />
        <span className="truncate">{node.name}</span>
      </button>
    </li>
  );
}

interface DirectorySidebarProps {
  directoryLabel: string;
  paths: string[];
  activePath: string | null;
  onSelect: (relativePath: string) => void;
}

export function DirectorySidebar({
  directoryLabel,
  paths,
  activePath,
  onSelect,
}: DirectorySidebarProps) {
  const nodes = useMemo(() => buildMarkdownFileTree(paths), [paths]);

  return (
    <nav
      aria-label="Directory files"
      data-testid="directory-sidebar"
      className="flex h-screen w-64 shrink-0 flex-col border-r border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40"
    >
      <div className="border-b border-slate-200 px-3 py-3 dark:border-slate-800">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Directory
        </p>
        <p
          className="truncate text-sm font-medium text-slate-700 dark:text-slate-200"
          title={directoryLabel}
        >
          {directoryLabel}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
        {nodes.length > 0 ? (
          <DirectoryTree
            nodes={nodes}
            activePath={activePath}
            onSelect={onSelect}
          />
        ) : (
          <p className="px-3 py-2 text-sm text-slate-400">
            No Markdown files here.
          </p>
        )}
      </div>
    </nav>
  );
}

export function DirectoryEmptyState() {
  return (
    <div
      data-testid="directory-empty-state"
      className="flex h-full flex-1 items-center justify-center p-8 text-center"
    >
      <p className="max-w-sm text-sm text-slate-400">
        Select a Markdown file from the sidebar to review it.
      </p>
    </div>
  );
}
