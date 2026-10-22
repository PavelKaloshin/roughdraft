import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { findOpenThreadRootIds } from "./comment-events.js";
import {
  isCommentEvent,
  REVIEW_EVENT_TYPES,
  type ReviewEvent,
  type ReviewEventQueue,
} from "./review-events.js";
import type { SessionOwnership } from "./session-ownership.js";

/**
 * HTTP surface for session-scoped listening (ADR 0007):
 * - `POST /api/sessions/claim`   claim (auto or `force`) a document for a session
 * - `POST /api/sessions/release` give a document up
 * - `POST /api/sessions/listen`  long-poll: events for every owned document,
 *   plus claimed/released notices
 * - `POST /api/sessions/printed` which of those lines a monitor printed
 * - `GET  /api/sessions`         live sessions and what they own
 */

const MAX_CLAIMS_PER_REQUEST = 200;
const MAX_TITLE_CHARS = 200;

export interface SessionRoutesDeps {
  ownership: SessionOwnership;
  reviewEvents: ReviewEventQueue;
  instanceId: string;
  isHandled: (event: ReviewEvent) => boolean;
  recordDelivered: (event: ReviewEvent) => void;
  /** Queues unanswered ask/change threads from the file (once per process). */
  requeueUnansweredThreads: (target: {
    absolutePath: string;
    projectDir: string;
    relativePath: string;
  }) => void;
  /** Resolves `projectPath` + `path` the way the document routes do. */
  resolveProjectDocument: (
    projectPath: string,
    relativePath: string,
  ) => string | null;
}

const MAX_PRINTED_SEQUENCES = 2_000;
const MAX_PRINTED_SESSIONS = 500;

interface PrintedRecord {
  monitorId: string;
  /** Event sequences of this server process printed to the session. */
  sequences: Set<number>;
  /** Highest ownership notice printed. */
  noticeCursor: number;
}

/**
 * What each session's monitor (the plugin's wrapper: one per Claude Code
 * process, `listen --monitor-id`) printed, so its next `listen` round, whose
 * cursor starts over, does not wake the session with the same lines again.
 * One monitor per session: a different one (a new Claude Code process) gets
 * everything again. In memory only (ADR 0004): after a server restart lines
 * are printed again rather than lost.
 */
export class PrintedLines {
  private readonly bySession = new Map<string, PrintedRecord>();

  get(sessionId: string, monitorId: string): PrintedRecord | null {
    const record = this.bySession.get(sessionId);
    return record?.monitorId === monitorId ? record : null;
  }

  record(
    sessionId: string,
    monitorId: string,
    sequences: number[],
    noticeCursor: number,
  ): void {
    let record = this.get(sessionId, monitorId);
    if (!record) {
      record = { monitorId, sequences: new Set(), noticeCursor: 0 };
      this.bySession.delete(sessionId);
      this.bySession.set(sessionId, record);
      if (this.bySession.size > MAX_PRINTED_SESSIONS) {
        const oldest = this.bySession.keys().next().value;
        if (oldest !== undefined) this.bySession.delete(oldest);
      }
    }
    for (const sequence of sequences) record.sequences.add(sequence);
    // Oldest first: forgetting one prints it again at worst.
    for (const sequence of record.sequences) {
      if (record.sequences.size <= MAX_PRINTED_SEQUENCES) break;
      record.sequences.delete(sequence);
    }
    record.noticeCursor = Math.max(record.noticeCursor, noticeCursor);
  }
}

function text(value: unknown, max = 1000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : null;
}

/** An existing absolute `.md` file, resolved. */
function markdownFile(value: unknown): string | null {
  const raw = text(value, 4096);
  if (!raw || !path.isAbsolute(raw)) return null;
  const resolved = path.resolve(raw);
  if (!resolved.toLowerCase().endsWith(".md")) return null;
  try {
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function registerSessionRoutes(
  app: Express,
  deps: SessionRoutesDeps,
): void {
  const { ownership, reviewEvents, instanceId } = deps;
  const printedLines = new PrintedLines();

  const targetFor = (absolutePath: string) => ({
    absolutePath,
    projectDir: path.dirname(absolutePath),
    relativePath: path.basename(absolutePath),
  });

  function documentFromBody(req: Request, res: Response): string | null {
    const body = req.body ?? {};
    if (body.documentPath !== undefined) {
      const file = markdownFile(body.documentPath);
      if (!file) res.status(404).json({ error: "Markdown file not found" });
      return file;
    }
    const projectPath = text(body.projectPath, 4096);
    const relativePath = typeof body.path === "string" ? body.path : "";
    const file = projectPath
      ? deps.resolveProjectDocument(projectPath, relativePath)
      : null;
    if (!file) {
      res.status(404).json({
        error:
          "Markdown file not found (send documentPath, or projectPath and path)",
      });
    }
    return file;
  }

  function sessionFromBody(req: Request, res: Response): string | null {
    const sessionId = text(req.body?.sessionId, 200);
    if (!sessionId) res.status(400).json({ error: "sessionId is required" });
    return sessionId;
  }

  app.post("/api/sessions/claim", (req, res) => {
    const sessionId = sessionFromBody(req, res);
    if (!sessionId) return;
    const documentPath = documentFromBody(req, res);
    if (!documentPath) return;

    const result = ownership.claim(documentPath, sessionId, {
      force: req.body?.force === true,
      meta: {
        title: text(req.body?.title, MAX_TITLE_CHARS),
        cwd: text(req.body?.cwd, 4096),
      },
    });
    res.json({ documentPath, ...result });
  });

  app.post("/api/sessions/release", (req, res) => {
    const sessionId = sessionFromBody(req, res);
    if (!sessionId) return;
    const documentPath = documentFromBody(req, res);
    if (!documentPath) return;
    res.json({
      documentPath,
      released: ownership.release(documentPath, sessionId),
      owner: ownership.owner(documentPath),
    });
  });

  app.get("/api/sessions", (_req, res) => {
    res.json({ sessions: ownership.liveSessions(), instanceId });
  });

  app.post("/api/sessions/printed", (req, res) => {
    const sessionId = sessionFromBody(req, res);
    if (!sessionId) return;
    const monitorId = text(req.body?.monitorId, 200);
    if (!monitorId) {
      res.status(400).json({ error: "monitorId is required" });
      return;
    }
    // Sequences of another server process name other events here.
    if (text(req.body?.instanceId, 200) !== instanceId) {
      res.json({ recorded: false, instanceId });
      return;
    }
    const sequences: number[] = Array.isArray(req.body?.sequences)
      ? req.body.sequences
          .slice(0, MAX_PRINTED_SEQUENCES)
          .filter(
            (value: unknown): value is number =>
              typeof value === "number" && Number.isInteger(value),
          )
      : [];
    printedLines.record(
      sessionId,
      monitorId,
      sequences,
      Math.max(0, numberOr(req.body?.noticeCursor, 0)),
    );
    res.json({ recorded: true, instanceId });
  });

  app.post("/api/sessions/listen", async (req, res) => {
    const sessionId = sessionFromBody(req, res);
    if (!sessionId) return;
    const monitorId = text(req.body?.monitorId, 200);
    const printed = monitorId ? printedLines.get(sessionId, monitorId) : null;
    const listenerId = text(req.body?.listenerId, 200) ?? `anon-${sessionId}`;
    const meta = {
      title: text(req.body?.title, MAX_TITLE_CHARS),
      cwd: text(req.body?.cwd, 4096),
    };

    // A cursor from an earlier server process would skip new events.
    const knownInstanceId = text(req.body?.instanceId, 200);
    let afterSequence = Math.max(0, numberOr(req.body?.afterSequence, 0));
    if (
      afterSequence > reviewEvents.latestSequence() ||
      (knownInstanceId !== null && knownInstanceId !== instanceId)
    ) {
      afterSequence = 0;
    }

    const endPresence = ownership.beginPresence(sessionId, listenerId, meta);

    // Claims the plugin kept across a server restart; not news to the session.
    const rejectedClaims: Array<{ documentPath: string; owner: string }> = [];
    const claims: unknown[] = Array.isArray(req.body?.claims)
      ? req.body.claims.slice(0, MAX_CLAIMS_PER_REQUEST)
      : [];
    for (const claim of claims) {
      const file = markdownFile(claim);
      if (!file) continue;
      const result = ownership.claim(file, sessionId, { restore: true, meta });
      if (!result.claimed && result.owner) {
        rejectedClaims.push({
          documentPath: file,
          owner: result.owner.sessionId,
        });
      }
    }

    for (const documentPath of ownership.documentsOf(sessionId)) {
      try {
        deps.requeueUnansweredThreads(targetFor(documentPath));
      } catch {
        // The file went away; its events (if any) stay queued.
      }
    }

    let afterNotice = Math.max(
      0,
      numberOr(req.body?.afterNotice, 0),
      printed?.noticeCursor ?? 0,
    );
    // The session record was forgotten (it was dead and owned nothing).
    if (afterNotice > ownership.noticeCursor(sessionId)) afterNotice = 0;

    const openThreads = new Map<string, Set<string>>();
    const isOpenThread = (event: ReviewEvent): boolean => {
      if (!isCommentEvent(event)) return true;
      let open = openThreads.get(event.documentPath);
      if (!open) {
        try {
          open = findOpenThreadRootIds(
            fs.readFileSync(event.documentPath, "utf-8"),
          );
        } catch {
          open = new Set();
        }
        openThreads.set(event.documentPath, open);
      }
      return open.has(event.threadRootId);
    };

    const filter = (event: ReviewEvent): boolean => {
      const documentPath = path.resolve(event.documentPath);
      if (ownership.ownerId(documentPath) !== sessionId) return false;
      // A document this session just took over: show its unanswered events
      // again, whatever the cursor says.
      const replay =
        isCommentEvent(event) && ownership.needsReplay(sessionId, documentPath);
      if (event.sequence <= afterSequence && !replay) return false;
      // Printed to this monitor by an earlier round.
      if (!replay && printed?.sequences.has(event.sequence)) return false;
      if (!isCommentEvent(event)) return true;
      if (deps.isHandled(event)) return false;
      return isOpenThread(event);
    };

    const abort = new AbortController();
    res.on("close", () => {
      abort.abort();
      endPresence();
    });

    const timeoutSeconds = Math.min(
      Math.max(0, numberOr(req.body?.timeoutSeconds, 50)),
      300,
    );
    const batchWindowSeconds = Math.min(
      Math.max(0, numberOr(req.body?.batchWindowSeconds, 0.1)),
      10,
    );

    const pendingNotices = ownership.noticesAfter(sessionId, afterNotice);
    const roundAbort = new AbortController();
    abort.signal.addEventListener("abort", () => roundAbort.abort(), {
      once: true,
    });
    let noticeArrived = false;
    const noticeWait =
      pendingNotices.length > 0
        ? null
        : ownership.waitForNotice(sessionId, roundAbort.signal).then(() => {
            if (!roundAbort.signal.aborted) {
              noticeArrived = true;
              roundAbort.abort();
            }
          });

    const result = await reviewEvents.wait({
      afterSequence: 0,
      timeoutMs: pendingNotices.length > 0 ? 0 : timeoutSeconds * 1000,
      batchWindowMs: batchWindowSeconds * 1000,
      types: REVIEW_EVENT_TYPES,
      filter,
      signal: roundAbort.signal,
    });
    roundAbort.abort();
    await noticeWait;

    if (abort.signal.aborted) return;

    for (const event of result.events) deps.recordDelivered(event);
    if (result.events.length > 0) ownership.clearReplay(sessionId);

    // When a notice cut the round short, events may have been mid-batch:
    // keep the cursor so the next round picks them up.
    const nextSequence =
      noticeArrived && result.events.length === 0
        ? afterSequence + 1
        : result.nextSequence;

    res.json({
      events: result.events,
      notices: ownership.noticesAfter(sessionId, afterNotice),
      noticeCursor: ownership.noticeCursor(sessionId),
      documents: ownership.documentsOf(sessionId),
      rejectedClaims,
      timedOut: result.events.length === 0,
      nextSequence,
      latestSequence: reviewEvents.latestSequence(),
      instanceId,
    });
  });
}
