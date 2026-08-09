import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { DocumentOutlineBox } from "./DocumentOutline";
import { classifyFile, type FileKind } from "./file-types";
import { type FileOutlines, useFileOutlines } from "./file-outlines";
import { cn } from "./lib/utils";
import type { OutlineHeading } from "./markdown-outline";

export interface FileTreeNode {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  children: FileTreeNode[];
}

/**
 * Build a nested tree from the flat `paths` returned by `/api/file-tree`.
 *
 * Every file is kept so the directory can be browsed in full; directories are
 * inferred from file path segments, so empty directories are pruned
 * automatically. Directories sort before files, then by numeric-aware name
 * order. Markdown opens as the interactive unit of work; other files open
 * read-only (see ADR 0005).
 */
export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const directoryIndex = new Map<string, FileTreeNode>();

  const filePaths = paths.filter((entry) => !entry.endsWith("/"));

  for (const filePath of filePaths) {
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

  const sortNodes = (nodes: FileTreeNode[]) => {
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
  nodes: FileTreeNode[];
  activePath: string | null;
  onSelect: (relativePath: string) => void;
  outlines: FileOutlines;
  onSelectHeading: (relativePath: string, heading: OutlineHeading) => void;
  depth?: number;
}

function DirectoryTree({
  nodes,
  activePath,
  onSelect,
  outlines,
  onSelectHeading,
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
            outlines={outlines}
            onSelectHeading={onSelectHeading}
            depth={depth}
          />
        ) : (
          <DirectoryTreeFile
            key={node.relativePath}
            node={node}
            activePath={activePath}
            onSelect={onSelect}
            outlines={outlines}
            onSelectHeading={onSelectHeading}
            depth={depth}
          />
        ),
      )}
    </ul>
  );
}

interface DirectoryTreeNodeProps {
  node: FileTreeNode;
  activePath: string | null;
  onSelect: (relativePath: string) => void;
  outlines: FileOutlines;
  onSelectHeading: (relativePath: string, heading: OutlineHeading) => void;
  depth: number;
}

const INDENT_STEP_REM = 0.75;

const fileIconByKind: Record<FileKind, typeof FileText> = {
  markdown: FileText,
  text: FileText,
  code: FileCode,
  image: ImageIcon,
  binary: FileIcon,
};

function DirectoryTreeFolder({
  node,
  activePath,
  onSelect,
  outlines,
  onSelectHeading,
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
          outlines={outlines}
          onSelectHeading={onSelectHeading}
          depth={depth + 1}
        />
      ) : null}
    </li>
  );
}

const OUTLINE_TOGGLE_WIDTH_REM = 1.25;

function DirectoryTreeFile({
  node,
  activePath,
  onSelect,
  outlines,
  onSelectHeading,
  depth,
}: DirectoryTreeNodeProps) {
  const isActive = activePath === node.relativePath;
  const kind = classifyFile(node.relativePath).kind;
  const FileKindIcon = fileIconByKind[kind];
  const hasOutline = kind === "markdown";
  const outlineExpanded = hasOutline && outlines.isExpanded(node.relativePath);
  const outline = outlineExpanded
    ? outlines.getOutline(node.relativePath)
    : null;
  const outlineToggleLabel = outlineExpanded
    ? `Hide headings in ${node.name}`
    : `Show headings in ${node.name}`;

  return (
    <li>
      <div
        className="flex items-center"
        style={{ paddingLeft: `${0.5 + depth * INDENT_STEP_REM}rem` }}
      >
        {hasOutline ? (
          <button
            type="button"
            onClick={() => outlines.toggle(node.relativePath)}
            aria-expanded={outlineExpanded}
            aria-label={outlineToggleLabel}
            title={outlineToggleLabel}
            data-testid={`directory-outline-toggle-${node.relativePath}`}
            className="flex size-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-200/60 dark:text-slate-400 dark:hover:bg-slate-700/50"
          >
            {outlineExpanded ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
          </button>
        ) : (
          <span
            className="shrink-0"
            style={{ width: `${OUTLINE_TOGGLE_WIDTH_REM}rem` }}
            aria-hidden="true"
          />
        )}
        <button
          type="button"
          onClick={() => onSelect(node.relativePath)}
          aria-current={isActive ? "true" : undefined}
          data-testid={`directory-file-${node.relativePath}`}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm",
            isActive
              ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
              : "text-slate-700 hover:bg-slate-200/60 dark:text-slate-200 dark:hover:bg-slate-700/50",
          )}
        >
          <FileKindIcon className="size-4 shrink-0 opacity-70" />
          <span className="truncate">{node.name}</span>
        </button>
      </div>
      {outline ? (
        <DocumentOutlineBox
          headings={outline.headings}
          status={outline.status}
          onSelectHeading={(heading) =>
            onSelectHeading(node.relativePath, heading)
          }
          testId={`directory-outline-${node.relativePath}`}
          testIdPrefix={`directory-outline-${node.relativePath}`}
          className="mr-1"
          style={{
            marginLeft: `${
              0.5 + depth * INDENT_STEP_REM + OUTLINE_TOGGLE_WIDTH_REM + 0.25
            }rem`,
          }}
        />
      ) : null}
    </li>
  );
}

interface DirectorySidebarProps {
  directoryLabel: string;
  paths: string[];
  activePath: string | null;
  onSelect: (relativePath: string) => void;
  /** Relative path of the open markdown document, if one is open. */
  activeMarkdownPath: string | null;
  /** In-memory content of the open markdown document. */
  activeMarkdownContent: string | null;
  /** Reads another markdown file so its headings can be listed. */
  readMarkdownFile: ((relativePath: string) => Promise<string>) | null;
  /** Re-read interval for expanded files that are not the open document. */
  outlineRefreshMs: number;
  onSelectHeading: (relativePath: string, heading: OutlineHeading) => void;
}

export function DirectorySidebar({
  directoryLabel,
  paths,
  activePath,
  onSelect,
  activeMarkdownPath,
  activeMarkdownContent,
  readMarkdownFile,
  outlineRefreshMs,
  onSelectHeading,
}: DirectorySidebarProps) {
  const nodes = useMemo(() => buildFileTree(paths), [paths]);
  const outlines = useFileOutlines({
    activePath: activeMarkdownPath,
    activeContent: activeMarkdownContent,
    readMarkdownFile,
    refreshMs: outlineRefreshMs,
  });

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
            outlines={outlines}
            onSelectHeading={onSelectHeading}
          />
        ) : (
          <p className="px-3 py-2 text-sm text-slate-400">No files here.</p>
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
        Select a file from the sidebar. Markdown opens for review; other files
        open read-only.
      </p>
    </div>
  );
}
