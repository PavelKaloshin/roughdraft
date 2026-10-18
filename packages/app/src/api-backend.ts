import {
  AGENT_THREAD_STATUSES,
  type AgentSessionOwner,
  type AgentSessionSummary,
  type AgentStatusSnapshot,
  type AgentThreadStatus,
  type AgentThreadTiming,
  type CommentEventResult,
  type CommentEventType,
} from "./comment-agent";
import { getLiveConnection, type LiveConnection } from "./live-connection";
import {
  type BackendInfo,
  type CompleteReviewOptions,
  type CompleteReviewResult,
  type FileTreeListing,
  type MarkdownFileChangeEvent,
  MarkdownFileConflictError,
  type Page,
  type ReviewWatchStatus,
  type StorageBackend,
  type StoredAsset,
} from "./storage";

export class ApiBackend implements StorageBackend {
  info: BackendInfo;
  canManageProjects = true;
  private readonly live: LiveConnection;

  constructor(info: BackendInfo, live: LiveConnection = getLiveConnection()) {
    this.info = info;
    this.live = live;
  }

  private updateProjectInfo(projectPath?: string): void {
    this.info = {
      ...this.info,
      detail: projectPath || "Markdown file on disk",
      projectPath,
    };
  }

  private buildUrl(route: string, params?: Record<string, string>): string {
    const url = new URL(route, window.location.origin);
    const projectPath = this.info.projectPath?.trim();

    if (projectPath) {
      url.searchParams.set("projectPath", projectPath);
    }

    Object.entries(params ?? {}).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    return `${url.pathname}${url.search}`;
  }

  async getMarkdownFile(relativePath: string): Promise<Page> {
    // `no-store` so a manual reload or watcher-triggered refresh always reads
    // the current file from disk rather than a cached HTTP response.
    const res = await fetch(
      this.buildUrl("/api/markdown-file", {
        path: relativePath,
      }),
      { cache: "no-store" },
    );
    if (!res.ok) {
      throw new Error(
        `Failed to get markdown file ${relativePath}: ${res.status}`,
      );
    }
    return res.json();
  }

  async readTextFile(relativePath: string): Promise<string> {
    const normalized = relativePath.replace(/^\.?\//, "");
    const res = await fetch(this.buildUrl("/api/files", { path: normalized }), {
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`Failed to read file ${relativePath}: ${res.status}`);
    }
    return res.text();
  }

  async listFileTree(): Promise<FileTreeListing> {
    const res = await fetch(this.buildUrl("/api/file-tree"));
    if (!res.ok) {
      throw new Error(`Failed to list file tree: ${res.status}`);
    }
    return res.json();
  }

  async saveMarkdownFile(
    relativePath: string,
    content: string,
    expectedVersion?: string,
  ): Promise<Page> {
    const res = await fetch(
      this.buildUrl("/api/markdown-file", { path: relativePath }),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          expectedVersion,
          projectPath: this.info.projectPath,
        }),
      },
    );
    if (res.status === 409) {
      const payload = (await res.json()) as { current?: Page };
      if (payload.current) {
        throw new MarkdownFileConflictError(payload.current);
      }
    }
    if (!res.ok) {
      throw new Error(
        `Failed to save markdown file ${relativePath}: ${res.status}`,
      );
    }
    return res.json();
  }

  watchMarkdownFile(
    relativePath: string,
    onChange: (event: MarkdownFileChangeEvent) => void,
    knownVersion?: string,
  ): () => void {
    // The newest version this subscription has seen. A reconnect re-sends
    // it, so a write that landed while the socket was down is reported.
    let latestVersion = knownVersion;
    const projectPath = this.info.projectPath;
    return this.live.subscribe(
      "markdown-file",
      () => ({
        projectPath,
        path: relativePath,
        ...(latestVersion ? { version: latestVersion } : {}),
      }),
      (event, data) => {
        if (event !== "change") return;
        const change = data as MarkdownFileChangeEvent;
        if (typeof change.version === "string") latestVersion = change.version;
        onChange(change);
      },
    );
  }

  async completeReview(
    relativePath: string,
    options: CompleteReviewOptions = {},
  ): Promise<CompleteReviewResult> {
    const overallComment = options.overallComment?.trim();
    const res = await fetch(
      this.buildUrl("/api/review-events", { path: relativePath }),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: this.info.projectPath,
          path: relativePath,
          ...(overallComment ? { overallComment } : {}),
        }),
      },
    );

    if (!res.ok) {
      throw new Error(
        `Failed to complete review ${relativePath}: ${res.status}`,
      );
    }

    const payload = (await res.json()) as { delivered?: unknown };
    return { delivered: payload.delivered === true };
  }

  async getReviewWatchStatus(relativePath: string): Promise<ReviewWatchStatus> {
    const res = await fetch(
      this.buildUrl("/api/review-events/status", { path: relativePath }),
    );

    if (!res.ok) {
      throw new Error(
        `Failed to get review watch status ${relativePath}: ${res.status}`,
      );
    }

    const payload = (await res.json()) as {
      watching?: unknown;
      watcherCount?: unknown;
    };
    return {
      watching: payload.watching === true,
      watcherCount:
        typeof payload.watcherCount === "number" ? payload.watcherCount : 0,
    };
  }

  async postCommentEvent(
    relativePath: string,
    input: { type: CommentEventType; commentId: string },
  ): Promise<CommentEventResult> {
    const res = await fetch(
      this.buildUrl("/api/review-events", { path: relativePath }),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: this.info.projectPath,
          path: relativePath,
          type: input.type,
          commentId: input.commentId,
        }),
      },
    );

    if (!res.ok) {
      throw new Error(
        `Failed to send ${input.type} for ${input.commentId}: ${res.status}`,
      );
    }

    const payload = (await res.json()) as {
      duplicate?: unknown;
      agent?: { listening?: unknown; sessionId?: unknown };
    };
    const sessionId = payload.agent?.sessionId;
    return {
      duplicate: payload.duplicate === true,
      agent: {
        listening: payload.agent?.listening === true,
        ...(typeof sessionId === "string" ? { sessionId } : {}),
      },
    };
  }

  async connectSession(relativePath: string, sessionId: string): Promise<void> {
    const res = await fetch(this.buildUrl("/api/sessions/claim"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: this.info.projectPath,
        path: relativePath,
        sessionId,
        force: true,
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to connect session ${sessionId}: ${res.status}`);
    }
  }

  watchAgentStatus(
    relativePath: string,
    onStatus: (status: AgentStatusSnapshot) => void,
  ): () => void {
    const projectPath = this.info.projectPath;
    return this.live.subscribe(
      "agent-status",
      () => ({ projectPath, path: relativePath }),
      (event, data) => {
        if (event === "status") onStatus(parseAgentStatusSnapshot(data));
      },
    );
  }

  async saveAsset(file: File): Promise<StoredAsset> {
    const buffer = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      if (byte === undefined) continue;
      binary += String.fromCharCode(byte);
    }

    const res = await fetch(this.buildUrl("/api/assets"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        dataBase64: btoa(binary),
        projectPath: this.info.projectPath,
      }),
    });

    if (!res.ok) throw new Error(`Failed to save asset: ${res.status}`);
    return res.json();
  }

  resolveFileUrl(path: string): string | null {
    const normalized = path.replace(/^\.?\//, "");
    return this.buildUrl("/api/files", { path: normalized });
  }

  async openProject(path: string): Promise<void> {
    this.updateProjectInfo(path);
  }
}

const agentThreadStatuses = new Set<AgentThreadStatus>(AGENT_THREAD_STATUSES);

export function parseAgentStatusSnapshot(value: unknown): AgentStatusSnapshot {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const threads: Record<string, AgentThreadStatus> = {};
  if (record.threads && typeof record.threads === "object") {
    for (const [id, status] of Object.entries(
      record.threads as Record<string, unknown>,
    )) {
      if (agentThreadStatuses.has(status as AgentThreadStatus)) {
        threads[id] = status as AgentThreadStatus;
      }
    }
  }
  // Timing for threads with a known status; each timestamp is optional, and
  // older servers send none at all.
  let threadDetails: Record<string, AgentThreadTiming> | undefined;
  if (record.threadDetails && typeof record.threadDetails === "object") {
    threadDetails = {};
    for (const [id, detail] of Object.entries(
      record.threadDetails as Record<string, unknown>,
    )) {
      if (!threads[id] || !detail || typeof detail !== "object") continue;
      const { since, requestedAt } = detail as Record<string, unknown>;
      threadDetails[id] = {
        ...(typeof since === "string" ? { since } : {}),
        ...(typeof requestedAt === "string" ? { requestedAt } : {}),
      };
    }
  }
  return {
    listening: record.listening === true,
    listenerCount:
      typeof record.listenerCount === "number" ? record.listenerCount : 0,
    ...(typeof record.sessionId === "string"
      ? { sessionId: record.sessionId }
      : {}),
    threads,
    ...(threadDetails ? { threadDetails } : {}),
    ...("owner" in record ? { owner: parseSessionOwner(record.owner) } : {}),
    ...(Array.isArray(record.sessions)
      ? {
          sessions: record.sessions.flatMap((entry) => {
            const session = parseSessionSummary(entry);
            return session ? [session] : [];
          }),
        }
      : {}),
  };
}

function optionalString<K extends string>(
  record: Record<string, unknown>,
  key: K,
): Partial<Record<K, string>> {
  const value = record[key];
  return typeof value === "string" && value.length > 0
    ? ({ [key]: value } as Record<K, string>)
    : {};
}

function parseSessionOwner(value: unknown): AgentSessionOwner | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || !record.sessionId) return null;
  return {
    sessionId: record.sessionId,
    ...optionalString(record, "title"),
    ...optionalString(record, "cwd"),
    live: record.live === true,
    ...optionalString(record, "lastActiveAt"),
  };
}

function parseSessionSummary(value: unknown): AgentSessionSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || !record.sessionId) return null;
  return {
    sessionId: record.sessionId,
    ...optionalString(record, "title"),
    ...optionalString(record, "cwd"),
    lastActiveAt:
      typeof record.lastActiveAt === "string" ? record.lastActiveAt : "",
    documents: Array.isArray(record.documents)
      ? record.documents.filter(
          (document): document is string => typeof document === "string",
        )
      : [],
  };
}
