interface RequestedPathState {
  rawPath: string | null;
  projectPath: string | null;
  documentPath: string | null;
}

export type DocumentEditorViewMode = "rich-text" | "code";
export const ROUGHDRAFT_FLAVORED_MARKDOWN_PATH =
  "/roughdraft-flavored-markdown";

function normalizePathSeparators(value: string) {
  return value.replace(/\\/g, "/");
}

export function isReservedAppPath(pathname: string) {
  return (
    normalizePathSeparators(pathname) === ROUGHDRAFT_FLAVORED_MARKDOWN_PATH
  );
}

function getRawPathFromLocation(): string | null {
  const searchParams = new URLSearchParams(window.location.search);
  const queryPath = searchParams.get("path")?.trim();
  if (queryPath) return queryPath;

  const normalizedPathname = normalizePathSeparators(window.location.pathname);
  if (isReservedAppPath(normalizedPathname)) return null;

  if (normalizedPathname !== "/" && !normalizedPathname.startsWith("/api")) {
    const decodedPathname = decodeURIComponent(normalizedPathname);
    return decodedPathname.startsWith("/")
      ? decodedPathname
      : `/${decodedPathname}`;
  }

  return null;
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

export function getPathLeaf(path?: string | null) {
  const value = path?.trim();
  if (!value) return null;

  const segments = value.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) || value;
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

function buildLocationForPath(path?: string | null) {
  const nextPath = path?.trim() || null;
  const url = new URL(window.location.href);

  if (nextPath) {
    if (!nextPath.startsWith("/") && !nextPath.includes("\\")) {
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

export function buildLocationForDocumentEditorViewMode(
  mode: DocumentEditorViewMode,
) {
  const url = new URL(window.location.href);
  url.searchParams.set("editor", mode);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function syncRequestedPathInUrl(path?: string | null) {
  const nextLocation = buildLocationForPath(path);
  const currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextLocation !== currentLocation) {
    window.history.replaceState(null, "", nextLocation);
  }
}
