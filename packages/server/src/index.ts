import crypto from "node:crypto";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendRoughdraftDocumentComment,
  appendRoughdraftReply,
  extractRoughdraftReviewIndex,
  markRoughdraftResolved,
} from "@roughdraft/rfm";
import express, { type Express, type Request, type Response } from "express";
import {
  hasNonLoopbackHost,
  ROUGHDRAFT_DEFAULT_PORT,
  ROUGHDRAFT_PUBLIC_HOST,
  resolveBindHosts,
} from "./network.js";
import { AgentRegistry, type AgentThreadStatus } from "./agent-registry.js";
import {
  buildCommentEventInput,
  findOpenThreadRootIds,
  findUnansweredAgentThreads,
  lookupComment,
} from "./comment-events.js";
import {
  isCommentEvent,
  isCommentEventType,
  isReviewEventType,
  type ReviewEvent,
  ReviewEventQueue,
  type ReviewEventType,
} from "./review-events.js";
import { resolveUpdateStatus } from "./update-status.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(__dirname, "../../app/dist");
const defaultServerRoot = path.resolve(__dirname, "../../..");

interface AssetPayload {
  filename?: string;
  mimeType?: string;
  dataBase64?: string;
}

interface DirectoryEntry {
  name: string;
  path: string;
}

interface DirectoryListing {
  path: string;
  parentPath: string | null;
  directories: DirectoryEntry[];
}

interface FileSystemEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

interface FileSystemListing {
  path: string;
  displayPath: string;
  parentPath: string | null;
  directories: FileSystemEntry[];
  files: FileSystemEntry[];
}

interface ProjectTreeListing {
  paths: string[];
}

interface CreateAppOptions {
  port?: number;
  projectDir?: string;
  serverRoot?: string;
  homeDir?: string;
  staticDirPath?: string;
  packageJsonPath?: string;
  fetchImpl?: typeof fetch;
  packageName?: string;
  remoteDocumentToken?: string;
  /** How long an agent listener stays "present" between long-poll rounds. */
  agentListenerGraceMs?: number;
}

interface CreateAppResult {
  app: Express;
  port: number;
}

interface OpenRequestClient {
  id: number;
  path: string | null;
  response: Response;
}

interface OpenRequestPayload {
  path?: string;
  url?: string;
}

interface RemoteSession {
  id: string;
  originPath: string;
  content: string;
  version: string;
  saveClient: Response | null;
  viewers: Set<Response>;
  disconnectedAt: number | null;
}

interface RemoteDocumentRegisterPayload {
  sessionId?: string;
  originPath?: string;
  content?: string;
}

interface RemoteDocumentSavePayload {
  content?: string;
  expectedVersion?: string;
}

const REMOTE_SESSION_TTL_MS = 5 * 60 * 1000;
const REMOTE_SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
const REMOTE_SESSION_KEEPALIVE_MS = 15 * 1000;
const MAX_OVERALL_COMMENT_LENGTH = 4_000;
const MAX_AGENT_REPLY_LENGTH = 100_000;
const AGENT_EVENTS_KEEPALIVE_MS = 15 * 1000;
const WRITE_CONFLICT_RETRIES = 3;
const AGENT_REPLY_STATUSES = ["answered", "applied"] as const;

let nextOpenRequestClientId = 1;

function remoteSessionVersion(content: string): string {
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  return `${hash}:${crypto.randomUUID()}`;
}

function remoteSessionView(session: RemoteSession): {
  id: string;
  originPath: string;
  content: string;
  version: string;
} {
  return {
    id: session.id,
    originPath: session.originPath,
    content: session.content,
    version: session.version,
  };
}

function writeRemoteSessionEvent(
  response: Response,
  event: string,
  data: unknown,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function listMdFiles(projectDir: string): string[] {
  try {
    return fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

function titleFromContent(content: string, fallback: string): string {
  const firstLine = content.split("\n")[0] || "";
  return firstLine.replace(/^#*\s*/, "").trim() || fallback;
}

function fileVersionFromContent(
  stats: fs.Stats,
  content: string | Buffer,
): string {
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");
  return `${stats.mtimeMs}:${stats.size}:${contentHash}`;
}

function fileVersionFromFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  const stats = fs.statSync(filePath);
  return fileVersionFromContent(stats, content);
}

function fileVersionOrNull(filePath: string): string | null {
  try {
    return fileVersionFromFile(filePath);
  } catch {
    return null;
  }
}

/** Coalesces the burst of notifications one save produces. */
const FILE_WATCH_DEBOUNCE_MS = 50;
/** Stat-polling fallback when native watching is unavailable. */
const FILE_WATCH_POLL_INTERVAL_MS = 500;

/**
 * Calls `onChange` (debounced) when `filePath` may have changed. Watches the
 * containing directory rather than the file: editors and agents often save
 * atomically (write a temp file, rename it over the target), which replaces
 * the inode a file watcher would be attached to. Falls back to stat polling
 * if native watching fails (unsupported filesystem, watcher limits, the
 * directory going away). Callers dedupe by content version.
 */
function watchFileForChanges(
  filePath: string,
  onChange: () => void,
): () => void {
  const directory = path.dirname(filePath);
  const fileName = path.basename(filePath);
  let timer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  let polling = false;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!stopped) onChange();
    }, FILE_WATCH_DEBOUNCE_MS);
  };
  const poll = (current: fs.Stats, previous: fs.Stats) => {
    if (
      current.mtimeMs !== previous.mtimeMs ||
      current.size !== previous.size ||
      current.nlink !== previous.nlink
    ) {
      schedule();
    }
  };
  const fallBackToPolling = () => {
    watcher?.close();
    watcher = null;
    if (stopped || polling) return;
    polling = true;
    fs.watchFile(filePath, { interval: FILE_WATCH_POLL_INTERVAL_MS }, poll);
    // Do not miss a change that happened while switching.
    schedule();
  };

  try {
    watcher = fs.watch(directory, { persistent: false }, (_event, name) => {
      // Some platforms omit the name; then any entry may be ours.
      if (name === null || name.toString() === fileName) schedule();
    });
    watcher.on("error", fallBackToPolling);
  } catch {
    fallBackToPolling();
  }

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
    if (polling) fs.unwatchFile(filePath, poll);
  };
}

function normalizeOverallComment(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function markdownPageFromFile(
  relativePath: string,
  absolutePath: string,
): {
  id: string;
  title: string;
  content: string;
  version: string;
} {
  const content = fs.readFileSync(absolutePath, "utf-8");
  const stats = fs.statSync(absolutePath);
  const fallbackTitle = path.basename(relativePath, ".md");

  return {
    id: pageIdFromRelativePath(relativePath),
    title: titleFromContent(content, fallbackTitle),
    content,
    version: fileVersionFromContent(stats, content),
  };
}

function pageIdFromRelativePath(relativePath: string): string {
  return relativePath.replace(/\.md$/i, "").split(path.sep).join("/");
}

function nextUntitledId(projectDir: string): string {
  const existing = listMdFiles(projectDir);
  let i = 1;
  while (existing.includes(`untitled-${i}`)) i++;
  return `untitled-${i}`;
}

function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim() || "attachment";
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function ensureProjectPath(
  projectDir: string,
  relativePath: string,
): string | null {
  const normalized = relativePath.replace(/^\.?\//, "");
  const absolute = path.resolve(projectDir, normalized);
  const relative = path.relative(projectDir, absolute);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return absolute;
}

function pageFilePathFromId(projectDir: string, id: string): string | null {
  return ensureProjectPath(projectDir, `${id}.md`);
}

function nextAssetPath(projectDir: string, filename: string): string {
  const assetsDir = path.join(projectDir, ".roughdraft-assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  const safeName = sanitizeFilename(filename);
  const extensionIndex = safeName.lastIndexOf(".");
  const basename =
    extensionIndex > 0 ? safeName.slice(0, extensionIndex) : safeName;
  const extension = extensionIndex > 0 ? safeName.slice(extensionIndex) : "";

  let counter = 0;
  while (true) {
    const suffix = counter === 0 ? "" : `-${counter}`;
    const relativePath = `.roughdraft-assets/${basename}${suffix}${extension}`;
    const absolutePath = path.join(projectDir, relativePath);
    if (!fs.existsSync(absolutePath)) {
      return relativePath;
    }
    counter += 1;
  }
}

function ensureDirectoryExists(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function isExistingDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function listDirectories(dir: string): DirectoryListing {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(dir, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const parentPath = path.dirname(dir);

  return {
    path: dir,
    parentPath: parentPath === dir ? null : parentPath,
    directories: entries,
  };
}

function formatDisplayPath(targetPath: string, homeDir: string): string {
  const normalizedHome = path.resolve(homeDir);
  const normalizedTarget = path.resolve(targetPath);

  if (normalizedTarget === normalizedHome) {
    return "~";
  }

  const relativeToHome = path.relative(normalizedHome, normalizedTarget);
  if (!relativeToHome.startsWith("..") && !path.isAbsolute(relativeToHome)) {
    return `~/${relativeToHome.split(path.sep).join("/")}`;
  }

  return normalizedTarget;
}

function listFileSystem(dir: string, homeDir: string): FileSystemListing {
  const normalizedDir = path.resolve(dir);
  const normalizedHome = path.resolve(homeDir);

  let rawEntries: fs.Dirent[];
  try {
    rawEntries = fs.readdirSync(normalizedDir, { withFileTypes: true });
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "EACCES" || errorCode === "EPERM") {
      throw new Error("Directory is not readable.");
    }
    throw error;
  }

  const directories = rawEntries
    .filter((entry) => entry.isDirectory())
    .map<FileSystemEntry>((entry) => ({
      name: entry.name,
      path: path.join(normalizedDir, entry.name),
      kind: "directory",
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const files = rawEntries
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"),
    )
    .map<FileSystemEntry>((entry) => ({
      name: entry.name,
      path: path.join(normalizedDir, entry.name),
      kind: "file",
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  return {
    path: normalizedDir,
    displayPath: formatDisplayPath(normalizedDir, normalizedHome),
    parentPath:
      normalizedDir === normalizedHome ? null : path.dirname(normalizedDir),
    directories,
    files,
  };
}

function toCanonicalRelativePath(
  projectDir: string,
  absolutePath: string,
  isDirectory: boolean,
): string {
  const relativePath = path.relative(projectDir, absolutePath);
  const canonicalPath = relativePath.split(path.sep).join("/");
  return isDirectory ? `${canonicalPath}/` : canonicalPath;
}

function isIgnoredTreeDirectory(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}

function listProjectTree(projectDir: string): ProjectTreeListing {
  const paths: string[] = [];

  const visitDirectory = (dir: string) => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .slice()
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }
        return left.name.localeCompare(right.name, undefined, {
          numeric: true,
        });
      });

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (isIgnoredTreeDirectory(entry.name)) {
          continue;
        }
        paths.push(toCanonicalRelativePath(projectDir, absolutePath, true));
        visitDirectory(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        paths.push(toCanonicalRelativePath(projectDir, absolutePath, false));
      }
    }
  };

  visitDirectory(projectDir);

  return { paths };
}

type MarkdownRewrite =
  | { ok: true; markdown: string }
  | { ok: false; status: 400 | 404; error: string };

type RewriteOutcome =
  | { ok: true; version: string }
  | { ok: false; status: number; payload: Record<string, unknown> };

/**
 * Read-modify-write of a Markdown file with an optimistic version check.
 * `expectedVersion` (when given) must match the file as first read; after
 * that, an external write landing between our read and write is retried
 * against the fresh content instead of being clobbered.
 */
function rewriteMarkdownFile(
  absolutePath: string,
  expectedVersion: unknown,
  rewrite: (markdown: string) => MarkdownRewrite,
): RewriteOutcome {
  for (let attempt = 0; attempt < WRITE_CONFLICT_RETRIES; attempt += 1) {
    const markdown = fs.readFileSync(absolutePath, "utf-8");
    const version = fileVersionFromContent(fs.statSync(absolutePath), markdown);
    if (
      attempt === 0 &&
      typeof expectedVersion === "string" &&
      expectedVersion.length > 0 &&
      expectedVersion !== version
    ) {
      return {
        ok: false,
        status: 409,
        payload: { error: "Markdown file changed on disk", version },
      };
    }

    let result: MarkdownRewrite;
    try {
      result = rewrite(markdown);
    } catch (error) {
      return {
        ok: false,
        status: 400,
        payload: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        payload: { error: result.error },
      };
    }

    if (fileVersionFromFile(absolutePath) !== version) continue;
    fs.writeFileSync(absolutePath, result.markdown);
    return { ok: true, version: fileVersionFromFile(absolutePath) };
  }

  return {
    ok: false,
    status: 409,
    payload: { error: "Markdown file kept changing on disk; try again" },
  };
}

export function createApp(options: CreateAppOptions = {}): CreateAppResult {
  const port = options.port ?? ROUGHDRAFT_DEFAULT_PORT;
  const homeDir = options.homeDir ?? os.homedir();
  const serverRoot = path.resolve(options.serverRoot ?? defaultServerRoot);
  const staticDirPath = options.staticDirPath ?? staticDir;
  const fetchImpl = options.fetchImpl ?? fetch;
  const remoteDocumentToken =
    typeof options.remoteDocumentToken === "string" &&
    options.remoteDocumentToken.length > 0
      ? options.remoteDocumentToken
      : null;
  const app = express();
  const openRequestClients = new Set<OpenRequestClient>();
  // Identifies this server process so listeners notice a restart (event
  // sequences start over) and reset their cursor instead of missing events.
  const instanceId = crypto.randomUUID();
  const agentRegistry = new AgentRegistry({
    graceMs: options.agentListenerGraceMs,
  });
  const reviewEvents = new ReviewEventQueue({
    isPinned: (event) =>
      isCommentEvent(event) && agentRegistry.isAwaitingAgent(event),
  });
  const remoteSessions = new Map<string, RemoteSession>();
  const requeuedDocuments = new Set<string>();

  /**
   * Comment events live in memory, so asks posted before this process
   * started (a restart, or no server at the time) are gone. The first time a
   * listener attaches to a document, queue the ask/change threads that are
   * still waiting for the agent according to the file itself. Events the tab
   * posts later dedupe against these.
   */
  function requeueUnansweredThreads(target: {
    absolutePath: string;
    projectDir: string;
    relativePath: string;
  }): void {
    if (requeuedDocuments.has(target.absolutePath)) return;
    requeuedDocuments.add(target.absolutePath);

    const markdown = fs.readFileSync(target.absolutePath, "utf-8");
    const version = fileVersionFromFile(target.absolutePath);
    for (const thread of findUnansweredAgentThreads(markdown)) {
      const built = buildCommentEventInput(markdown, {
        ...thread,
        documentPath: target.absolutePath,
        projectPath: target.projectDir,
        relativePath: target.relativePath,
        version,
      });
      if (!built.ok) continue;
      const result = reviewEvents.emitComment(built.input);
      if (!result.duplicate) agentRegistry.recordEvent(result.event);
    }
  }

  function isAuthorizedRemoteDocumentRequest(req: Request): boolean {
    if (!remoteDocumentToken) return true;

    const header =
      typeof req.headers.authorization === "string"
        ? req.headers.authorization
        : "";
    if (header.startsWith("Bearer ")) {
      const supplied = header.slice("Bearer ".length).trim();
      if (supplied === remoteDocumentToken) return true;
    }

    const acceptsQueryToken =
      req.method === "GET" &&
      req.path.startsWith("/api/remote-document/") &&
      req.path.endsWith("/events");
    const queryToken =
      acceptsQueryToken && typeof req.query.token === "string"
        ? req.query.token
        : "";
    return queryToken === remoteDocumentToken;
  }

  function rejectUnauthorizedRemoteDocumentRequest(res: Response): void {
    res.status(401).json({
      error:
        "Remote document endpoints require a valid token. Set ROUGHDRAFT_TOKEN on the client; browser event streams may include ?token=... in the URL.",
    });
  }

  const remoteSessionSweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of remoteSessions) {
      if (
        session.disconnectedAt !== null &&
        now - session.disconnectedAt > REMOTE_SESSION_TTL_MS
      ) {
        remoteSessions.delete(id);
      }
    }
  }, REMOTE_SESSION_SWEEP_INTERVAL_MS);
  remoteSessionSweeper.unref?.();

  app.use(express.json({ limit: "50mb" }));

  function requestedProjectPath(req: Request): string | null {
    const queryPath =
      typeof req.query.projectPath === "string"
        ? req.query.projectPath.trim()
        : "";
    const bodyPath =
      typeof req.body?.projectPath === "string"
        ? req.body.projectPath.trim()
        : "";
    const nextPath = queryPath || bodyPath;
    return nextPath.length > 0 ? nextPath : null;
  }

  function projectDirFromRequest(
    req: Request,
    res: Response,
    options?: { mustExist?: boolean },
  ): string | null {
    const nextProjectPath = requestedProjectPath(req);
    if (!nextProjectPath) {
      res.status(400).json({ error: "projectPath is required" });
      return null;
    }

    const resolvedProjectDir = path.resolve(nextProjectPath);
    const mustExist = options?.mustExist ?? true;

    if (mustExist && !isExistingDirectory(resolvedProjectDir)) {
      res.status(404).json({ error: "Project directory not found" });
      return null;
    }

    return resolvedProjectDir;
  }

  function markdownPathFromRequest(
    req: Request,
    res: Response,
  ): { relativePath: string; absolutePath: string; projectDir: string } | null {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return null;

    const relativePath =
      typeof req.query.path === "string"
        ? req.query.path
        : typeof req.body?.path === "string"
          ? req.body.path
          : "";
    const absolutePath = ensureProjectPath(projectDir, relativePath);

    if (!absolutePath?.toLowerCase().endsWith(".md")) {
      res.status(404).json({ error: "Markdown file not found" });
      return null;
    }

    if (!fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "Markdown file not found" });
      return null;
    }

    return { relativePath, absolutePath, projectDir };
  }

  function requestedCommentId(req: Request, res: Response): string | null {
    const commentId =
      typeof req.body?.commentId === "string" ? req.body.commentId.trim() : "";
    if (!commentId) {
      res.status(400).json({ error: "commentId is required" });
      return null;
    }
    return commentId;
  }

  // --- API routes ---

  app.get("/api/pages", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const ids = listMdFiles(projectDir);
    const pages = ids.map((id) => {
      const content = fs.readFileSync(
        path.join(projectDir, `${id}.md`),
        "utf-8",
      );
      return { id, title: titleFromContent(content, id), content };
    });
    res.json(pages);
  });

  app.get("/api/pages/:id", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const id = req.params.id;
    const filePath = pageFilePathFromId(projectDir, id);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    res.json({ id, title: titleFromContent(content, id), content });
  });

  app.get("/api/markdown-file", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const relativePath =
      typeof req.query.path === "string" ? req.query.path : "";
    const absolutePath = ensureProjectPath(projectDir, relativePath);

    if (!absolutePath?.toLowerCase().endsWith(".md")) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    if (!fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    res.json(markdownPageFromFile(relativePath, absolutePath));
  });

  app.get("/api/markdown-file/events", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const relativePath =
      typeof req.query.path === "string" ? req.query.path : "";
    const absolutePath = ensureProjectPath(projectDir, relativePath);

    if (!absolutePath?.toLowerCase().endsWith(".md")) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    if (!fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write("retry: 1000\n\n");

    // One event per distinct on-disk state: the watcher may report a single
    // write several times, and the tab recognizes its own saves by version.
    let lastVersion: string | null = fileVersionOrNull(absolutePath);
    const sendIfChanged = () => {
      const version = fileVersionOrNull(absolutePath);
      if (version === lastVersion) return;
      lastVersion = version;
      res.write(
        `event: change\ndata: ${JSON.stringify({
          path: relativePath,
          exists: version !== null,
          version,
        })}\n\n`,
      );
    };

    const stopWatching = watchFileForChanges(absolutePath, sendIfChanged);
    req.on("close", stopWatching);
  });

  app.get("/api/review-index", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const markdown = fs.readFileSync(target.absolutePath, "utf-8");
    res.json({
      documentPath: target.absolutePath,
      projectPath: target.projectDir,
      relativePath: target.relativePath,
      fileVersion: fileVersionFromFile(target.absolutePath),
      ...extractRoughdraftReviewIndex(markdown),
    });
  });

  app.post("/api/review-events", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const requestedType = req.body?.type;
    if (requestedType !== undefined && !isReviewEventType(requestedType)) {
      res.status(400).json({
        error: `Unknown review event type: ${String(requestedType)}`,
      });
      return;
    }

    if (isCommentEventType(requestedType)) {
      const commentId = requestedCommentId(req, res);
      if (!commentId) return;

      // The UI saves the file first and then posts the event, so the event is
      // built from what is on disk, never from client-supplied text.
      const markdown = fs.readFileSync(target.absolutePath, "utf-8");
      const built = buildCommentEventInput(markdown, {
        type: requestedType,
        commentId,
        documentPath: target.absolutePath,
        projectPath: target.projectDir,
        relativePath: target.relativePath,
        version: fileVersionFromFile(target.absolutePath),
      });
      if (!built.ok) {
        res.status(built.status).json({ error: built.error });
        return;
      }

      const result = reviewEvents.emitComment(built.input);
      if (!result.duplicate) {
        agentRegistry.recordEvent(result.event);
      }
      const agent = agentRegistry.status(target.absolutePath);
      res.status(result.duplicate ? 200 : 201).json({
        ...result,
        agent: {
          listening: agent.listening,
          ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
        },
      });
      return;
    }

    const overallComment = normalizeOverallComment(req.body?.overallComment);
    if (
      overallComment !== undefined &&
      overallComment.length > MAX_OVERALL_COMMENT_LENGTH
    ) {
      res.status(400).json({
        error: `overallComment must be ${MAX_OVERALL_COMMENT_LENGTH} characters or fewer`,
      });
      return;
    }

    const markdown = fs.readFileSync(target.absolutePath, "utf-8");
    const persistedMarkdown = overallComment
      ? appendRoughdraftDocumentComment(markdown, {
          message: overallComment,
          author: "user",
        })
      : markdown;
    if (persistedMarkdown !== markdown) {
      fs.writeFileSync(target.absolutePath, persistedMarkdown);
    }

    const index = extractRoughdraftReviewIndex(persistedMarkdown);
    const result = reviewEvents.emit({
      documentPath: target.absolutePath,
      projectPath: target.projectDir,
      relativePath: target.relativePath,
      version: fileVersionFromFile(target.absolutePath),
      summary: index.summary,
      overallComment,
    });

    res.status(201).json(result);
  });

  app.post("/api/review-events/watch", async (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    // Default stays Done Reviewing only, so `roughdraft open`/`watch` and the
    // MCP watch tool keep their behavior; agents opt into comment events.
    let types: ReviewEventType[] = ["review.completed"];
    if (req.body?.types !== undefined) {
      const requested: unknown = req.body.types;
      if (
        !Array.isArray(requested) ||
        requested.length === 0 ||
        !requested.every(isReviewEventType)
      ) {
        res.status(400).json({
          error:
            "types must be a non-empty array of review.completed, comment.ask, comment.change, comment.followup",
        });
        return;
      }
      types = requested;
    }
    // Skip ask/change events whose thread the agent already answered, so a
    // re-armed listener does not redo finished work.
    const skipHandled = req.body?.skipHandled === true;
    const readOpenThreadRootIds = (): Set<string> => {
      try {
        return findOpenThreadRootIds(
          fs.readFileSync(target.absolutePath, "utf-8"),
        );
      } catch {
        return new Set();
      }
    };

    if (types.some(isCommentEventType)) {
      requeueUnansweredThreads(target);
    }

    // A cursor from an earlier server process (sequences restart at 1) would
    // silently skip new events; answer at once so the client resets it.
    const requestedAfter =
      typeof req.body?.afterSequence === "number" ? req.body.afterSequence : 0;
    const knownInstanceId =
      typeof req.body?.instanceId === "string" ? req.body.instanceId : null;
    if (
      req.body?.fromNow === false &&
      (requestedAfter > reviewEvents.latestSequence() ||
        (knownInstanceId !== null && knownInstanceId !== instanceId))
    ) {
      res.json({
        events: [],
        timedOut: true,
        nextSequence: reviewEvents.latestSequence() + 1,
        instanceId,
        latestSequence: reviewEvents.latestSequence(),
        cursorReset: true,
      });
      return;
    }

    const listener = req.body?.listener;
    const listenerId =
      typeof listener?.id === "string" && listener.id.length > 0
        ? listener.id
        : null;
    const endListen = listenerId
      ? agentRegistry.beginListen(target.absolutePath, {
          listenerId,
          sessionId:
            typeof listener?.sessionId === "string" ? listener.sessionId : null,
          graceMs:
            typeof listener?.graceSeconds === "number" &&
            Number.isFinite(listener.graceSeconds)
              ? Math.min(Math.max(listener.graceSeconds, 0), 600) * 1000
              : undefined,
        })
      : null;

    // Free the waiter (and the listener's presence) as soon as the client
    // goes away instead of holding it until the round times out.
    const abort = new AbortController();
    res.on("close", () => {
      abort.abort();
      endListen?.();
    });

    const fromNow = req.body?.fromNow !== false;
    const timeoutSeconds =
      typeof req.body?.timeoutSeconds === "number"
        ? req.body.timeoutSeconds
        : undefined;
    const batchWindowSeconds =
      typeof req.body?.batchWindowSeconds === "number"
        ? req.body.batchWindowSeconds
        : 0.25;
    const afterSequence =
      typeof req.body?.afterSequence === "number" ? req.body.afterSequence : 0;

    const result = await reviewEvents.wait({
      documentPath: target.absolutePath,
      afterSequence: fromNow ? reviewEvents.latestSequence() : afterSequence,
      timeoutMs:
        timeoutSeconds !== undefined ? timeoutSeconds * 1000 : undefined,
      batchWindowMs: batchWindowSeconds * 1000,
      types,
      filter: skipHandled
        ? (event: ReviewEvent) => {
            if (!isCommentEvent(event)) return true;
            if (agentRegistry.isHandled(event)) return false;
            // Resolved (or deleted) in the tab before any agent got to it.
            return readOpenThreadRootIds().has(event.threadRootId);
          }
        : undefined,
      signal: abort.signal,
    });

    if (abort.signal.aborted) return;

    if (listenerId) {
      for (const event of result.events) {
        if (isCommentEvent(event)) agentRegistry.recordDelivered(event);
      }
    }

    res.json({
      ...result,
      instanceId,
      latestSequence: reviewEvents.latestSequence(),
    });
  });

  app.get("/api/review-events/status", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const watcherCount = reviewEvents.waiterCountForDocument(
      target.absolutePath,
    );
    res.json({
      documentPath: target.absolutePath,
      projectPath: target.projectDir,
      relativePath: target.relativePath,
      watching: watcherCount > 0,
      watcherCount,
    });
  });

  app.get("/api/agent/status", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    res.json({
      ...agentRegistry.status(target.absolutePath),
      projectPath: target.projectDir,
      relativePath: target.relativePath,
      latestSequence: reviewEvents.latestSequence(),
      instanceId,
    });
  });

  app.get("/api/agent/events", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write("retry: 1000\n\n");

    // instanceId lets the tab tell a server restart (thread status and queued
    // events gone) from a reconnect to the same process.
    const send = (status: object) => {
      res.write(
        `event: status\ndata: ${JSON.stringify({ ...status, instanceId })}\n\n`,
      );
    };
    send(agentRegistry.status(target.absolutePath));
    const unsubscribe = agentRegistry.subscribe(target.absolutePath, send);
    const keepalive = setInterval(() => {
      res.write(": keepalive\n\n");
    }, AGENT_EVENTS_KEEPALIVE_MS);
    keepalive.unref?.();

    res.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  app.post("/api/agent/ack", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const commentId = requestedCommentId(req, res);
    if (!commentId) return;

    const lookup = lookupComment(
      fs.readFileSync(target.absolutePath, "utf-8"),
      commentId,
    );
    if (!lookup.ok) {
      res.status(lookup.status).json({ error: lookup.error });
      return;
    }

    agentRegistry.setThreadStatus(
      target.absolutePath,
      lookup.threadRootId,
      "working",
    );
    res.json({
      commentId,
      threadRootId: lookup.threadRootId,
      status: "working",
    });
  });

  app.post("/api/comments/reply", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const commentId = requestedCommentId(req, res);
    if (!commentId) return;

    const body = typeof req.body?.body === "string" ? req.body.body : "";
    if (body.trim().length === 0) {
      res.status(400).json({ error: "body is required" });
      return;
    }
    if (body.length > MAX_AGENT_REPLY_LENGTH) {
      res.status(400).json({
        error: `body must be ${MAX_AGENT_REPLY_LENGTH} characters or fewer`,
      });
      return;
    }

    const requestedStatus: unknown = req.body?.status ?? "answered";
    if (
      typeof requestedStatus !== "string" ||
      !(AGENT_REPLY_STATUSES as readonly string[]).includes(requestedStatus)
    ) {
      res.status(400).json({ error: "status must be answered or applied" });
      return;
    }
    const status = requestedStatus as AgentThreadStatus;
    const author =
      typeof req.body?.author === "string" && req.body.author.trim()
        ? req.body.author.trim()
        : "AI";

    let threadRootId = "";
    let replyId = "";
    const outcome = rewriteMarkdownFile(
      target.absolutePath,
      req.body?.expectedVersion,
      (markdown) => {
        const lookup = lookupComment(markdown, commentId);
        if (!lookup.ok) return lookup;
        threadRootId = lookup.threadRootId;
        const before = new Set(lookup.items.map((item) => item.id));
        const next = appendRoughdraftReply(markdown, {
          parentId: lookup.threadRootId,
          message: body,
          author,
        });
        replyId =
          extractRoughdraftReviewIndex(next).items.find(
            (item) => !before.has(item.id),
          )?.id ?? "";
        return { ok: true, markdown: next };
      },
    );
    if (!outcome.ok) {
      res.status(outcome.status).json(outcome.payload);
      return;
    }

    agentRegistry.setThreadStatus(target.absolutePath, threadRootId, status);
    res.status(201).json({
      commentId,
      threadRootId,
      replyId,
      status,
      version: outcome.version,
    });
  });

  app.post("/api/comments/resolve", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const commentId = requestedCommentId(req, res);
    if (!commentId) return;
    const summary =
      typeof req.body?.summary === "string" && req.body.summary.trim()
        ? req.body.summary.trim()
        : undefined;

    let threadRootId = "";
    const outcome = rewriteMarkdownFile(
      target.absolutePath,
      req.body?.expectedVersion,
      (markdown) => {
        const lookup = lookupComment(markdown, commentId);
        if (!lookup.ok) return lookup;
        threadRootId = lookup.threadRootId;
        return {
          ok: true,
          markdown: markRoughdraftResolved(markdown, {
            targetId: lookup.threadRootId,
            summary,
          }),
        };
      },
    );
    if (!outcome.ok) {
      res.status(outcome.status).json(outcome.payload);
      return;
    }

    agentRegistry.clearThread(target.absolutePath, threadRootId);
    res.json({
      commentId,
      threadRootId,
      status: "resolved",
      version: outcome.version,
    });
  });

  app.put("/api/pages/:id", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const id = req.params.id;
    const filePath = pageFilePathFromId(projectDir, id);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    const { content } = req.body as { content: string };
    fs.writeFileSync(filePath, content);
    res.json({ id, title: titleFromContent(content, id), content });
  });

  app.put("/api/markdown-file", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const relativePath =
      typeof req.query.path === "string" ? req.query.path : "";
    const absolutePath = ensureProjectPath(projectDir, relativePath);

    if (!absolutePath?.toLowerCase().endsWith(".md")) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    if (!fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    const { content, expectedVersion } = req.body as {
      content: string;
      expectedVersion?: string;
    };
    const currentVersion = fileVersionFromFile(absolutePath);

    if (expectedVersion && expectedVersion !== currentVersion) {
      res.status(409).json({
        error: "Markdown file changed on disk",
        current: markdownPageFromFile(relativePath, absolutePath),
      });
      return;
    }

    fs.writeFileSync(absolutePath, content);
    res.json(markdownPageFromFile(relativePath, absolutePath));
  });

  app.post("/api/pages", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const { title, content: bodyContent } = req.body as {
      title?: string;
      content?: string;
    };
    const id = nextUntitledId(projectDir);
    const content = bodyContent || `# ${title || "Untitled"}\n`;
    const filePath = path.join(projectDir, `${id}.md`);
    fs.writeFileSync(filePath, content);

    res.status(201).json(markdownPageFromFile(`${id}.md`, filePath));
  });

  app.delete("/api/pages/:id", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const id = req.params.id;
    const filePath = pageFilePathFromId(projectDir, id);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    fs.unlinkSync(filePath);

    res.json({ ok: true });
  });

  app.get("/api/status", (_req, res) => {
    res.json({
      backend: "local-files",
      pid: process.pid,
      port,
      projectDir: options.projectDir
        ? path.resolve(options.projectDir)
        : undefined,
      serverRoot,
      stateless: true,
      capabilities: {
        projectPathRequired: true,
        fileSystemBrowsing: true,
        remoteDocuments: true,
        remoteDocumentTokenRequired: remoteDocumentToken !== null,
      },
    });
  });

  app.get("/api/open-requests", (req, res) => {
    const requestedPath =
      typeof req.query.path === "string" && req.query.path.trim().length > 0
        ? req.query.path.trim()
        : null;
    const client: OpenRequestClient = {
      id: nextOpenRequestClientId,
      path: requestedPath,
      response: res,
    };
    nextOpenRequestClientId += 1;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(
      `event: connected\ndata: ${JSON.stringify({ id: client.id })}\n\n`,
    );

    openRequestClients.add(client);
    const keepAlive = setInterval(() => {
      res.write(": keep-alive\n\n");
    }, 15_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      openRequestClients.delete(client);
    });
  });

  app.post("/api/open-request", (req, res) => {
    const payload = req.body as OpenRequestPayload;
    const targetPath =
      typeof payload.path === "string" && payload.path.trim().length > 0
        ? payload.path.trim()
        : null;
    const targetUrl =
      typeof payload.url === "string" && payload.url.trim().length > 0
        ? payload.url.trim()
        : null;

    if (!targetPath || !targetUrl) {
      res.status(400).json({ error: "path and url are required" });
      return;
    }

    const matchingClient = Array.from(openRequestClients)
      .reverse()
      .find((client) => client.path === targetPath);

    if (!matchingClient) {
      res.json({ delivered: false });
      return;
    }

    matchingClient.response.write(
      `event: open-request\ndata: ${JSON.stringify({
        path: targetPath,
        url: targetUrl,
      })}\n\n`,
    );
    res.json({ delivered: true });
  });

  app.post("/api/remote-document", (req, res) => {
    if (!isAuthorizedRemoteDocumentRequest(req)) {
      rejectUnauthorizedRemoteDocumentRequest(res);
      return;
    }
    const payload = req.body as RemoteDocumentRegisterPayload;
    const sessionId =
      typeof payload.sessionId === "string" &&
      payload.sessionId.trim().length > 0
        ? payload.sessionId.trim()
        : null;
    const originPath =
      typeof payload.originPath === "string" &&
      payload.originPath.trim().length > 0
        ? payload.originPath.trim()
        : null;
    const content =
      typeof payload.content === "string" ? payload.content : null;

    if (!sessionId || !originPath || content === null) {
      res
        .status(400)
        .json({ error: "sessionId, originPath, and content are required" });
      return;
    }

    if (remoteSessions.has(sessionId)) {
      res.status(409).json({ error: "session already exists" });
      return;
    }

    const session: RemoteSession = {
      id: sessionId,
      originPath,
      content,
      version: remoteSessionVersion(content),
      saveClient: null,
      viewers: new Set<Response>(),
      disconnectedAt: null,
    };
    remoteSessions.set(sessionId, session);

    const host = req.get("host");
    const viewerUrl =
      host !== undefined
        ? `${req.protocol}://${host}/?session=${encodeURIComponent(sessionId)}`
        : null;

    res.status(201).json({
      id: session.id,
      version: session.version,
      viewerUrl,
    });
  });

  app.get("/api/remote-document/:id", (req, res) => {
    if (!isAuthorizedRemoteDocumentRequest(req)) {
      rejectUnauthorizedRemoteDocumentRequest(res);
      return;
    }
    const session = remoteSessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Remote document session not found" });
      return;
    }
    res.json(remoteSessionView(session));
  });

  app.put("/api/remote-document/:id", (req, res) => {
    if (!isAuthorizedRemoteDocumentRequest(req)) {
      rejectUnauthorizedRemoteDocumentRequest(res);
      return;
    }
    const session = remoteSessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Remote document session not found" });
      return;
    }

    const payload = req.body as RemoteDocumentSavePayload;
    const content =
      typeof payload.content === "string" ? payload.content : null;

    if (content === null) {
      res.status(400).json({ error: "content is required" });
      return;
    }

    if (
      typeof payload.expectedVersion === "string" &&
      payload.expectedVersion !== session.version
    ) {
      res.status(409).json({
        error: "Remote document changed",
        current: remoteSessionView(session),
      });
      return;
    }

    session.content = content;
    session.version = remoteSessionVersion(content);

    let deliveredToClient = true;
    if (session.saveClient) {
      try {
        writeRemoteSessionEvent(session.saveClient, "save", {
          content: session.content,
          version: session.version,
        });
      } catch {
        deliveredToClient = false;
        session.saveClient = null;
        session.disconnectedAt = Date.now();
      }
    } else {
      deliveredToClient = false;
    }

    if (!deliveredToClient) {
      res.status(503).json({
        error: "No active CLI session; save not delivered to disk.",
        version: session.version,
      });
      return;
    }

    res.json({ id: session.id, version: session.version });
  });

  app.get("/api/remote-document/:id/events", (req, res) => {
    if (!isAuthorizedRemoteDocumentRequest(req)) {
      rejectUnauthorizedRemoteDocumentRequest(res);
      return;
    }
    const session = remoteSessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Remote document session not found" });
      return;
    }

    const role = req.query.role === "viewer" ? "viewer" : "cli";

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    if (role === "cli") {
      if (session.saveClient) {
        session.saveClient.end();
      }

      session.saveClient = res;
      session.disconnectedAt = null;

      writeRemoteSessionEvent(res, "connected", {
        id: session.id,
        role,
        version: session.version,
      });
      for (const viewer of session.viewers) {
        writeRemoteSessionEvent(viewer, "connected", {
          id: session.id,
          role: "viewer",
          version: session.version,
        });
      }
    } else {
      session.viewers.add(res);
      writeRemoteSessionEvent(
        res,
        session.saveClient ? "connected" : "disconnected",
        {
          id: session.id,
          role,
          version: session.version,
        },
      );
    }

    const keepAlive = setInterval(() => {
      res.write(": keep-alive\n\n");
    }, REMOTE_SESSION_KEEPALIVE_MS);

    req.on("close", () => {
      clearInterval(keepAlive);
      if (role === "cli" && session.saveClient === res) {
        session.saveClient = null;
        session.disconnectedAt = Date.now();
        for (const viewer of session.viewers) {
          writeRemoteSessionEvent(viewer, "disconnected", {
            id: session.id,
            role: "viewer",
            version: session.version,
          });
        }
      } else if (role === "viewer") {
        session.viewers.delete(res);
      }
    });
  });

  app.get("/api/update-status", async (_req, res) => {
    const updateStatus = await resolveUpdateStatus({
      fetchImpl,
      packageJsonPath: options.packageJsonPath,
      packageName: options.packageName,
    });
    res.json(updateStatus);
  });

  app.get("/api/directories", (req, res) => {
    const requestedPath =
      typeof req.query.path === "string" && req.query.path.trim().length > 0
        ? path.resolve(req.query.path)
        : homeDir;

    if (!isExistingDirectory(requestedPath)) {
      res.status(404).json({ error: "Directory not found" });
      return;
    }

    res.json(listDirectories(requestedPath));
  });

  app.get("/api/fs/list", (req, res) => {
    const requestedPath =
      typeof req.query.path === "string" && req.query.path.trim().length > 0
        ? path.resolve(req.query.path)
        : homeDir;

    if (!fs.existsSync(requestedPath)) {
      res.status(404).json({ error: "Directory not found" });
      return;
    }

    if (!isExistingDirectory(requestedPath)) {
      res.status(400).json({ error: "Path is not a directory" });
      return;
    }

    try {
      res.json(listFileSystem(requestedPath, homeDir));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to read directory listing";
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/file-tree", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    res.json(listProjectTree(projectDir));
  });

  app.post("/api/project/open", (req, res) => {
    const requestedPath =
      typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (!requestedPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const absolutePath = path.resolve(requestedPath);
    if (!isExistingDirectory(absolutePath)) {
      res.status(404).json({ error: "Directory not found" });
      return;
    }

    res.json({
      backend: "local-files",
      projectDir: absolutePath,
      port,
    });
  });

  app.post("/api/project/create", (req, res) => {
    const requestedPath =
      typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (!requestedPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const absolutePath = path.resolve(requestedPath);
    ensureDirectoryExists(absolutePath);

    res.status(201).json({
      backend: "local-files",
      projectDir: absolutePath,
      port,
    });
  });

  app.get("/api/files", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const relativePath =
      typeof req.query.path === "string" ? req.query.path : "";
    const absolutePath = ensureProjectPath(projectDir, relativePath);

    if (!absolutePath || !fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    // `ensureProjectPath` already confined the path to the project boundary, so
    // serve it even when the project lives under a dot-directory (e.g.
    // ~/.claude/skills/...). Without this, sendFile's default `dotfiles:
    // "ignore"` 404s every file whose path traverses a dot-directory.
    res.sendFile(absolutePath, { dotfiles: "allow" });
  });

  app.post("/api/assets", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const payload = req.body as AssetPayload;
    if (!payload.filename || !payload.dataBase64) {
      res.status(400).json({ error: "filename and dataBase64 are required" });
      return;
    }

    const relativePath = nextAssetPath(projectDir, payload.filename);
    const absolutePath = ensureProjectPath(projectDir, relativePath);
    if (!absolutePath) {
      res.status(400).json({ error: "Invalid asset path" });
      return;
    }

    const buffer = Buffer.from(payload.dataBase64, "base64");
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, buffer);

    res.status(201).json({
      markdownPath: `./${relativePath}`,
      previewUrl: `/api/files?projectPath=${encodeURIComponent(projectDir)}&path=${encodeURIComponent(relativePath)}`,
      mimeType: payload.mimeType || "application/octet-stream",
    });
  });

  // --- Static files & SPA fallback ---

  app.use(express.static(staticDirPath));

  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(staticDirPath, "index.html"));
  });

  return { app, port };
}

export const ROUGHDRAFT_TOKEN_ENV = "ROUGHDRAFT_TOKEN";

export async function createServer(
  port = ROUGHDRAFT_DEFAULT_PORT,
  projectDir?: string,
): Promise<void> {
  const bindHosts = resolveBindHosts();
  const remoteDocumentToken = process.env[ROUGHDRAFT_TOKEN_ENV] ?? "";

  if (hasNonLoopbackHost(bindHosts) && remoteDocumentToken.length === 0) {
    throw new Error(
      [
        `Roughdraft refuses to bind ${bindHosts.join(", ")} without a token.`,
        "Non-loopback bindings expose the remote-document endpoints, which can",
        "rewrite files on every connected CLI machine. Set ROUGHDRAFT_TOKEN to",
        "a strong secret and pass the same value to your CLI before retrying,",
        "or remove ROUGHDRAFT_BIND_HOST to keep loopback-only.",
      ].join(" "),
    );
  }

  const { app } = createApp({
    port,
    projectDir,
    remoteDocumentToken:
      remoteDocumentToken.length > 0 ? remoteDocumentToken : undefined,
  });
  const listeningHosts: string[] = [];

  await Promise.all(
    bindHosts.map(
      (host) =>
        new Promise<void>((resolve, reject) => {
          const server = createHttpServer(app);

          server.once("error", (error: NodeJS.ErrnoException) => {
            if (
              error.code === "EAFNOSUPPORT" ||
              error.code === "EADDRNOTAVAIL"
            ) {
              resolve();
              return;
            }

            reject(error);
          });

          server.listen(port, host, () => {
            listeningHosts.push(host);
            resolve();
          });
        }),
    ),
  );

  if (listeningHosts.length === 0) {
    throw new Error(
      `Roughdraft could not bind to any host (tried: ${bindHosts.join(", ")}).`,
    );
  }

  console.log(
    `\n  Roughdraft running at http://${ROUGHDRAFT_PUBLIC_HOST}:${port}`,
  );
  console.log("  No active project is stored on the server.\n");
}
