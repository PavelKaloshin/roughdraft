import { useCallback, useEffect, useMemo, useState } from "react";
import {
  extractMarkdownOutline,
  type OutlineHeading,
  outlineHeadingsEqual,
} from "./markdown-outline";

export interface OutlineState {
  status: "loading" | "ready" | "error";
  headings: OutlineHeading[];
}

const LOADING_OUTLINE: OutlineState = { status: "loading", headings: [] };
const ERROR_OUTLINE: OutlineState = { status: "error", headings: [] };

export interface UseFileOutlinesOptions {
  /** Relative path of the open markdown document, if any. */
  activePath: string | null;
  /** In-memory content of the open document; the source of truth for its outline. */
  activeContent: string | null;
  /** Reads any other markdown file in the directory. */
  readMarkdownFile: ((relativePath: string) => Promise<string>) | null;
  /** How often expanded non-open files are re-read from disk. */
  refreshMs: number;
}

export interface FileOutlines {
  isExpanded: (relativePath: string) => boolean;
  getOutline: (relativePath: string) => OutlineState | null;
  toggle: (relativePath: string) => void;
}

/**
 * Outline state for the directory tree.
 *
 * The open document's outline is derived from the content already held in
 * memory, so it tracks edits and watcher-driven reloads with no extra request.
 * Other expanded files are read on expand and then polled, which is what keeps
 * a heading list honest while an agent rewrites the file underneath it.
 */
export function useFileOutlines({
  activePath,
  activeContent,
  readMarkdownFile,
  refreshMs,
}: UseFileOutlinesOptions): FileOutlines {
  const [expandedPaths, setExpandedPaths] = useState<string[]>([]);
  const [loadedOutlines, setLoadedOutlines] = useState<
    Record<string, OutlineState>
  >({});

  const activeOutline = useMemo<OutlineState | null>(
    () =>
      activePath === null || activeContent === null
        ? null
        : { status: "ready", headings: extractMarkdownOutline(activeContent) },
    [activeContent, activePath],
  );

  // Opening a markdown file reveals its outline; a later manual collapse sticks
  // until the file is opened again.
  useEffect(() => {
    if (!activePath) return;
    setExpandedPaths((current) =>
      current.includes(activePath) ? current : [...current, activePath],
    );
  }, [activePath]);

  const polledPathsKey = expandedPaths
    .filter((path) => path !== activePath)
    .join("\n");

  useEffect(() => {
    if (!readMarkdownFile || !polledPathsKey) return;

    const paths = polledPathsKey.split("\n");
    let cancelled = false;

    const applyOutline = (path: string, next: OutlineState) => {
      setLoadedOutlines((current) => {
        const previous = current[path];
        if (
          previous &&
          previous.status === next.status &&
          outlineHeadingsEqual(previous.headings, next.headings)
        ) {
          return current;
        }
        return { ...current, [path]: next };
      });
    };

    const readOutlines = async () => {
      await Promise.all(
        paths.map(async (path) => {
          try {
            const content = await readMarkdownFile(path);
            if (cancelled) return;
            applyOutline(path, {
              status: "ready",
              headings: extractMarkdownOutline(content),
            });
          } catch (error) {
            if (cancelled) return;
            console.error(`Failed to read headings for ${path}:`, error);
            applyOutline(path, ERROR_OUTLINE);
          }
        }),
      );
    };

    void readOutlines();
    const intervalId = window.setInterval(() => {
      void readOutlines();
    }, refreshMs);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [polledPathsKey, readMarkdownFile, refreshMs]);

  const isExpanded = useCallback(
    (relativePath: string) => expandedPaths.includes(relativePath),
    [expandedPaths],
  );

  const getOutline = useCallback(
    (relativePath: string): OutlineState | null => {
      if (relativePath === activePath) return activeOutline ?? LOADING_OUTLINE;
      return loadedOutlines[relativePath] ?? LOADING_OUTLINE;
    },
    [activeOutline, activePath, loadedOutlines],
  );

  const toggle = useCallback((relativePath: string) => {
    setExpandedPaths((current) =>
      current.includes(relativePath)
        ? current.filter((path) => path !== relativePath)
        : [...current, relativePath],
    );
  }, []);

  return { isExpanded, getOutline, toggle };
}
