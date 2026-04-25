import type { Page } from "./storage";

export interface RequestedPathState {
  rawPath: string | null;
  projectPath: string | null;
  documentPath: string | null;
}

export type ViewMode = "canvas" | "document";
export type DocumentEditorViewMode = "rich-text" | "code";

export const CANVAS_FRAME_WIDTH = 680;
export const CANVAS_FRAME_WIDTH_WITH_RAIL = 960;

export function normalizePathSeparators(value: string) {
  return value.replace(/\\/g, "/");
}

export function getRawPathFromLocation(): string | null {
  const searchParams = new URLSearchParams(window.location.search);
  const queryPath = searchParams.get("path")?.trim();
  if (queryPath) return queryPath;

  const normalizedPathname = normalizePathSeparators(window.location.pathname);
  if (normalizedPathname !== "/" && !normalizedPathname.startsWith("/api")) {
    const decodedPathname = decodeURIComponent(normalizedPathname);
    return decodedPathname.startsWith("/")
      ? decodedPathname
      : `/${decodedPathname}`;
  }

  return null;
}

export function getViewModeFromLocation(fallbackMode: ViewMode): ViewMode {
  const searchParams = new URLSearchParams(window.location.search);
  const requestedMode = searchParams.get("mode");
  if (requestedMode === "canvas" || requestedMode === "document") {
    return requestedMode;
  }
  return fallbackMode;
}

export function getDocumentEditorViewModeFromLocation(
  fallbackMode: DocumentEditorViewMode,
): DocumentEditorViewMode {
  const searchParams = new URLSearchParams(window.location.search);
  const requestedMode = searchParams.get("editor");
  if (requestedMode === "rich-text" || requestedMode === "code") {
    return requestedMode;
  }
  return fallbackMode;
}

export function getRequestedPathState(): RequestedPathState {
  const rawPath = getRawPathFromLocation();
  if (!rawPath) {
    return { rawPath: null, projectPath: null, documentPath: null };
  }

  const normalizedPath = normalizePathSeparators(rawPath);
  if (!normalizedPath.toLowerCase().endsWith(".md")) {
    return { rawPath, projectPath: rawPath, documentPath: null };
  }

  const lastSlashIndex = Math.max(
    normalizedPath.lastIndexOf("/"),
    normalizedPath.lastIndexOf("\\"),
  );
  const projectPath =
    lastSlashIndex >= 0 ? rawPath.slice(0, lastSlashIndex) || "/" : ".";
  const documentPath = rawPath.slice(lastSlashIndex + 1);

  return { rawPath, projectPath, documentPath };
}

export function getWorkspacePath(path?: string) {
  return path?.trim() || null;
}

export function formatWorkspacePathForDisplay(path?: string | null) {
  const value = path?.trim();
  if (!value) return null;

  const normalizedPath = normalizePathSeparators(value);
  const collapsedHomePath = normalizedPath.replace(
    /^\/Users\/[^/]+(?=\/|$)/,
    "~",
  );
  return value.includes("\\")
    ? collapsedHomePath.replace(/\//g, "\\")
    : collapsedHomePath;
}

export function getWorkspaceName(path?: string) {
  const workspacePath = getWorkspacePath(path);
  if (!workspacePath) return "Browser drafts";

  const segments = workspacePath.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) || workspacePath;
}

export function getPathLeaf(path?: string | null) {
  const value = path?.trim();
  if (!value) return null;

  const segments = value.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) || value;
}

export function hasCriticMarkupComments(content: string) {
  return content.includes("{>>");
}

export function getCanvasFrameWidth(
  page: Page | null | undefined,
  fallbackWidth: number,
) {
  if (!page) return fallbackWidth;
  return hasCriticMarkupComments(page.content)
    ? CANVAS_FRAME_WIDTH_WITH_RAIL
    : fallbackWidth;
}

export function joinPath(basePath: string, relativePath: string) {
  const separator = basePath.includes("\\") ? "\\" : "/";
  const normalizedBasePath = basePath.endsWith(separator)
    ? basePath.slice(0, -1)
    : basePath;

  return relativePath
    .split("/")
    .filter(Boolean)
    .reduce(
      (result, segment) => `${result}${separator}${segment}`,
      normalizedBasePath,
    );
}

export function getCanvasPageId(relativePath: string) {
  const normalizedPath = normalizePathSeparators(relativePath);
  if (normalizedPath.includes("/")) return null;
  return normalizedPath.replace(/\.md$/i, "");
}

export function getContainingPath(pathValue: string) {
  const trimmedPath = pathValue.trim();
  if (!trimmedPath) return trimmedPath;

  const normalizedPath = trimmedPath.replace(/[\\/]+$/, "");
  if (!normalizedPath) return trimmedPath.startsWith("\\") ? "\\" : "/";

  const lastSeparatorIndex = Math.max(
    normalizedPath.lastIndexOf("/"),
    normalizedPath.lastIndexOf("\\"),
  );

  if (lastSeparatorIndex < 0) return ".";
  if (lastSeparatorIndex === 0) return normalizedPath[0] === "\\" ? "\\" : "/";
  return normalizedPath.slice(0, lastSeparatorIndex);
}

export function getOpenedFolderPath(pathValue: string) {
  const trimmedPath = pathValue.trim();
  if (!trimmedPath) return trimmedPath;

  return normalizePathSeparators(trimmedPath).toLowerCase().endsWith(".md")
    ? getContainingPath(trimmedPath)
    : trimmedPath.replace(/[\\/]+$/, "") || trimmedPath;
}

export function getDocumentNavigationState(
  projectPath: string,
  relativePath: string,
  currentRawPath: string | null,
): RequestedPathState {
  const relativeFolderPath = getContainingPath(relativePath);
  const nextFolderPath =
    relativeFolderPath === "."
      ? projectPath
      : joinPath(projectPath, relativeFolderPath);
  const shouldPreserveUrl =
    !!currentRawPath &&
    normalizePathSeparators(getOpenedFolderPath(currentRawPath)) ===
      normalizePathSeparators(nextFolderPath);

  return {
    rawPath: shouldPreserveUrl
      ? currentRawPath
      : joinPath(projectPath, relativePath),
    projectPath,
    documentPath: relativePath,
  };
}

export function buildLocationForPath(path?: string | null) {
  const nextPath = path?.trim() || null;
  const url = new URL(window.location.href);

  if (nextPath) {
    if (!nextPath.includes("\\")) {
      url.pathname = nextPath.startsWith("/") ? nextPath : `/${nextPath}`;
      url.searchParams.delete("path");
    } else {
      url.pathname = "/";
      url.searchParams.set("path", nextPath);
    }
  } else {
    url.searchParams.delete("path");
    url.pathname = "/";
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

export function buildLocationForViewMode(mode: ViewMode) {
  const url = new URL(window.location.href);
  url.searchParams.set("mode", mode);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function buildLocationForDocumentEditorViewMode(
  mode: DocumentEditorViewMode,
) {
  const url = new URL(window.location.href);
  url.searchParams.set("editor", mode);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function syncProjectPathInUrl(projectPath?: string) {
  const nextLocation = buildLocationForPath(getWorkspacePath(projectPath));
  const currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextLocation !== currentLocation) {
    window.history.replaceState(null, "", nextLocation);
  }
}

export function syncRequestedPathInUrl(path?: string | null) {
  const nextLocation = buildLocationForPath(path);
  const currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextLocation !== currentLocation) {
    window.history.replaceState(null, "", nextLocation);
  }
}
