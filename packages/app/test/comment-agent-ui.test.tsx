import type { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentStatusSnapshot,
  CommentEventResult,
  CommentEventType,
} from "../src/comment-agent";
import { DocumentWorkspace } from "../src/DocumentWorkspace";
import type { StorageBackend } from "../src/storage";

/**
 * The comment ↔ Claude handoff through the real DocumentWorkspace, PageCard
 * and CommentEditorList. The backend is faked at the StorageBackend boundary
 * (what ApiBackend implements): `disk` is what the server would read when it
 * builds the event.
 */

interface FakeServer {
  backend: StorageBackend;
  disk: { content: string };
  postCommentEvent: ReturnType<
    typeof vi.fn<
      (
        path: string,
        input: { type: CommentEventType; commentId: string },
      ) => Promise<CommentEventResult>
    >
  >;
  diskAtEachEvent: string[];
  pushStatus: (status: AgentStatusSnapshot) => void;
}

function createFakeServer({
  initialContent,
  listening = false,
}: {
  initialContent: string;
  listening?: boolean;
}): FakeServer {
  const disk = { content: initialContent };
  const diskAtEachEvent: string[] = [];
  let statusListener: ((status: AgentStatusSnapshot) => void) | null = null;
  const postCommentEvent = vi.fn(
    async (
      _path: string,
      _input: { type: CommentEventType; commentId: string },
    ): Promise<CommentEventResult> => {
      diskAtEachEvent.push(disk.content);
      return { duplicate: false, agent: { listening } };
    },
  );

  const backend: StorageBackend = {
    info: { kind: "local-files", label: "Test", detail: "Test" },
    canManageProjects: false,
    async getMarkdownFile(relativePath) {
      return { id: relativePath, title: relativePath, content: disk.content };
    },
    async saveMarkdownFile() {
      return undefined;
    },
    async saveAsset(file) {
      return {
        markdownPath: file.name,
        previewUrl: `file://${file.name}`,
        mimeType: file.type || "application/octet-stream",
      };
    },
    resolveFileUrl(path) {
      return `file://${path}`;
    },
    async openProject() {},
    postCommentEvent,
    watchAgentStatus(_path, onStatus) {
      statusListener = onStatus;
      onStatus({ listening, listenerCount: listening ? 1 : 0, threads: {} });
      return () => {
        statusListener = null;
      };
    },
  };

  return {
    backend,
    disk,
    postCommentEvent,
    diskAtEachEvent,
    pushStatus(status) {
      statusListener?.(status);
    },
  };
}

function setupDomMocks() {
  const rect = {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: 80,
    height: 20,
    right: 80,
    bottom: 20,
    toJSON() {
      return this;
    },
  } as DOMRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    rect,
  );
  if (!("ResizeObserver" in globalThis)) {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
  }
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  for (const proto of [Range.prototype, Text.prototype]) {
    Object.defineProperty(proto, "getClientRects", {
      configurable: true,
      value: () => [rect],
    });
  }
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
  Object.defineProperty(HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value() {
      return [this.getBoundingClientRect()];
    },
  });
  window.scrollBy = vi.fn();
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  setupDomMocks();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function flushAnimationFrame() {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
}

async function renderWorkspace(server: FakeServer) {
  const onSaveDocument = vi.fn(async (_id: string, content: string) => {
    server.disk.content = content;
  });
  await act(async () => {
    root.render(
      <DocumentWorkspace
        documentPage={{
          id: "plan.md",
          title: "Plan",
          content: server.disk.content,
        }}
        activeDocumentPath="plan.md"
        documentCopyPath="/work/plan.md"
        documentFilenameLabel="plan.md"
        documentEditorViewMode="rich-text"
        onDocumentEditorViewModeChange={() => {}}
        onSaveDocument={onSaveDocument}
        onDocumentSaveStateChange={() => {}}
        onDocumentDirtyStateChange={() => {}}
        onDocumentLocalContentChange={() => {}}
        documentDiskChangeState="clean"
        documentForceResetKey={null}
        onReloadDocumentFromDisk={() => {}}
        onKeepEditingWithoutAutosave={() => {}}
        onOverwriteDocumentOnDisk={() => {}}
        onCompleteReview={async () => ({ delivered: false })}
        backend={server.backend}
      />,
    );
    await Promise.resolve();
  });
  await flush();
  // The review rail measures anchors on the next frames before it renders.
  await flushAnimationFrame();
  await flushAnimationFrame();
  await flush();
  return { onSaveDocument };
}

function getEditor(): Editor {
  const editable = container.querySelector<HTMLElement & { editor?: Editor }>(
    ".ProseMirror",
  );
  expect(editable?.editor).toBeDefined();
  return editable?.editor as Editor;
}

function query<T extends Element = HTMLElement>(testId: string) {
  return container.querySelector<T>(`[data-testid="${testId}"]`);
}

/** The banner and the rail both render a thread; either one is the UI. */
function queryThreadPart<T extends Element = HTMLElement>(suffix: string) {
  return container.querySelector<T>(
    `[data-testid="comment-banner-${suffix}"], [data-testid="comment-rail-${suffix}"]`,
  );
}

function getThreadPart<T extends Element = HTMLElement>(suffix: string) {
  const element = queryThreadPart<T>(suffix);
  expect(element, suffix).not.toBeNull();
  return element as T;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

async function typeInto(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function addCommentOn(text: string) {
  const editor = getEditor();
  let range: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (range || !node.isText || !node.text) return;
    const offset = node.text.indexOf(text);
    if (offset >= 0)
      range = { from: pos + offset, to: pos + offset + text.length };
  });
  expect(range).not.toBeNull();
  await act(async () => {
    editor.commands.focus();
    editor.commands.setTextSelection(
      range as unknown as { from: number; to: number },
    );
  });
  await flush();
  await flushAnimationFrame();
  const isApple = /mac|iphone|ipad|ipod/i.test(navigator.platform);
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "m",
        code: "KeyM",
        altKey: true,
        ctrlKey: !isApple,
        metaKey: isApple,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await flush();
}

describe("Ask / Change comments", () => {
  it("saves an Ask comment, then sends exactly one comment.ask event", async () => {
    const server = createFakeServer({ initialContent: "Cold start target.\n" });
    await renderWorkspace(server);

    await addCommentOn("target");
    await click(getThreadPart("c1-mode-ask"));
    expect(getThreadPart("c1-mode-hint").textContent).toContain(
      "without editing the document",
    );
    await typeInto(getThreadPart<HTMLTextAreaElement>("c1-editor"), "Why?");
    await click(getThreadPart("c1-action-save"));
    await flush(6);

    expect(server.postCommentEvent).toHaveBeenCalledTimes(1);
    expect(server.postCommentEvent).toHaveBeenCalledWith("plan.md", {
      type: "comment.ask",
      commentId: "c1",
    });
    // The event went out only after the comment (with its intent) was on disk.
    expect(server.diskAtEachEvent[0]).toContain("{>>Why?<<}{#c1}");
    expect(server.diskAtEachEvent[0]).toContain("intent: ask");
    expect(getThreadPart("c1-intent").textContent).toBe("Ask");

    // Later autosaves and status pushes never re-send it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    await act(async () => {
      server.pushStatus({
        listening: false,
        listenerCount: 0,
        threads: { c1: "pending" },
      });
    });
    await flush();
    expect(server.postCommentEvent).toHaveBeenCalledTimes(1);
    expect(getThreadPart("c1-agent-status").textContent).toBe(
      "Waiting for Claude",
    );
  });

  it("shows the no-listener notice with the listen command, then clears it when a session connects", async () => {
    const server = createFakeServer({ initialContent: "Cold start target.\n" });
    await renderWorkspace(server);

    await addCommentOn("target");
    await click(getThreadPart("c1-mode-change"));
    await typeInto(
      getThreadPart<HTMLTextAreaElement>("c1-editor"),
      "Tighten this",
    );
    await click(getThreadPart("c1-action-save"));
    await flush(6);

    expect(server.postCommentEvent).toHaveBeenCalledWith("plan.md", {
      type: "comment.change",
      commentId: "c1",
    });
    expect(getThreadPart("c1-agent-notice").textContent).toContain(
      "No Claude session is listening",
    );
    expect(query("agent-no-listener-notice-command")?.textContent).toBe(
      "roughdraft listen /work/plan.md",
    );
    expect(query("agent-connection-indicator")?.textContent).toBe(
      "No Claude session listening",
    );

    await act(async () => {
      server.pushStatus({
        listening: true,
        listenerCount: 1,
        sessionId: "abcd1234-ffff",
        threads: { c1: "working" },
      });
    });
    await flush();

    expect(queryThreadPart("c1-agent-notice")).toBeNull();
    expect(query("agent-no-listener-notice")).toBeNull();
    expect(query("agent-connection-indicator")?.textContent).toBe(
      "Claude listening · session abcd1234",
    );
    expect(getThreadPart("c1-agent-status").textContent).toBe(
      "Claude is working…",
    );
  });

  it("does not notify Claude for a plain Comment", async () => {
    const server = createFakeServer({ initialContent: "Cold start target.\n" });
    const { onSaveDocument } = await renderWorkspace(server);

    await addCommentOn("target");
    expect(getThreadPart("c1-mode-comment").getAttribute("aria-pressed")).toBe(
      "true",
    );
    await typeInto(getThreadPart<HTMLTextAreaElement>("c1-editor"), "Note");
    await click(getThreadPart("c1-action-save"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    await flush();

    expect(onSaveDocument).toHaveBeenCalled();
    expect(server.disk.content).not.toContain("intent");
    expect(server.postCommentEvent).not.toHaveBeenCalled();
  });

  it("picks Ask and back to Comment with the keyboard shortcut", async () => {
    const server = createFakeServer({ initialContent: "Cold start target.\n" });
    await renderWorkspace(server);
    await addCommentOn("target");

    const editor = getThreadPart<HTMLTextAreaElement>("c1-editor");
    const isApple = /mac|iphone|ipad|ipod/i.test(navigator.platform);
    const pressModeShortcut = async () => {
      await act(async () => {
        editor.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "A",
            code: "KeyA",
            shiftKey: true,
            metaKey: isApple,
            ctrlKey: !isApple,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    };

    await pressModeShortcut();
    expect(getThreadPart("c1-mode-ask").getAttribute("aria-pressed")).toBe(
      "true",
    );
    await pressModeShortcut();
    expect(getThreadPart("c1-mode-comment").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("sends a follow-up for a user reply in an Ask thread, keyed by the reply id", async () => {
    const server = createFakeServer({
      initialContent: [
        "Cold start {==target==}{>>Why?<<}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-10-18T12:00:00.000Z"',
        "    intent: ask",
        "  c2:",
        "    body: |",
        "      Because of:",
        "      - **cache** warm-up",
        "      - `model` load",
        "    by: AI",
        '    at: "2026-10-18T12:00:20.000Z"',
        "    re: c1",
        "",
      ].join("\n"),
    });
    await renderWorkspace(server);
    await click(getThreadPart("c1"));
    await flush();
    expect(getThreadPart("c1-agent-status").textContent).toBe("Answered");

    // The agent's answer renders as Markdown.
    const answer = getThreadPart("c2-body");
    expect(answer.querySelector("li strong")?.textContent).toBe("cache");
    expect(answer.querySelector("li code")?.textContent).toBe("model");
    await click(getThreadPart("c1-action-reply"));
    await flush();
    await typeInto(
      getThreadPart<HTMLTextAreaElement>("c3-editor"),
      "And the model load?",
    );
    await click(getThreadPart("c3-action-save"));
    await flush(6);

    expect(server.postCommentEvent).toHaveBeenCalledTimes(1);
    expect(server.postCommentEvent).toHaveBeenCalledWith("plan.md", {
      type: "comment.followup",
      commentId: "c3",
    });
    expect(server.diskAtEachEvent[0]).toContain("body: And the model load?");
  });

  it("resolves a thread into the file and collapses it until shown", async () => {
    const server = createFakeServer({
      initialContent: [
        "Cold start {==target==}{>>Why?<<}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-10-18T12:00:00.000Z"',
        "    intent: ask",
        "",
      ].join("\n"),
    });
    await renderWorkspace(server);

    await click(getThreadPart("c1"));
    await flush();
    await click(getThreadPart("c1-action-resolve"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    await flush();

    expect(server.disk.content).toContain("    status: resolved\n");
    expect(server.disk.content).toContain("    intent: ask\n");
    expect(getThreadPart("c1-resolved").textContent).toContain("Resolved");
    expect(queryThreadPart("c1-body")).toBeNull();
    expect(server.postCommentEvent).not.toHaveBeenCalled();
  });
});
