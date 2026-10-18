import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageCard } from "../src/PageCard";
import type { Page, StorageBackend } from "../src/storage";

/**
 * Long agent answers are hard to read in the ~280px rail: long bodies clamp
 * with "Read more", and a centered thread reader dialog shows the whole
 * thread (anchor quote, authors, status, full Markdown) with prev/next
 * navigation in document order. Rendered through the real PageCard, so the
 * dialog reads the same comment state the rail does.
 */

const LONG_ANSWER = [
  "Short version: the cold start is dominated by two things.",
  "",
  "1. **Cache warm-up** — the first request has to fill the tokenizer cache,",
  "   which takes roughly 400 ms on a cold container.",
  "2. **Model load** — weights are mapped lazily, so the first forward pass",
  "   pays for page faults across the whole file.",
  "",
  "```ts",
  "const model = await loadModel({ lazy: false, prefetch: true });",
  "```",
  "",
  "If you want, I can measure both separately and add the numbers here.",
  "That would tell us whether prefetching alone hits the target.",
].join("\n");

function endmatterBody(body: string) {
  return ["    body: |", ...body.split("\n").map((line) => `      ${line}`)];
}

const askDoc = (withAnswer = true) =>
  [
    "Cold start {==target==}{>>Why is it slow?<<}{#c1}.",
    "",
    "---",
    "comments:",
    "  c1:",
    "    by: user",
    '    at: "2026-10-18T12:00:00.000Z"',
    "    intent: ask",
    ...(withAnswer
      ? [
          "  c2:",
          ...endmatterBody(LONG_ANSWER),
          "    by: AI",
          '    at: "2026-10-18T12:00:20.000Z"',
          "    re: c1",
        ]
      : []),
    "",
  ].join("\n");

// Ids deliberately not in document order: c5 comes first in the text.
const twoThreadDoc = [
  "First {==alpha==}{>>Thread A<<}{#c5} paragraph.",
  "",
  "Second {==beta==}{>>Thread B<<}{#c2} paragraph.",
  "",
  "---",
  "comments:",
  "  c2:",
  "    by: user",
  '    at: "2026-10-18T12:00:00.000Z"',
  "  c5:",
  "    by: user",
  '    at: "2026-10-18T12:01:00.000Z"',
  "",
].join("\n");

function createBackend(): StorageBackend {
  return {
    info: { kind: "local-storage", label: "Test", detail: "In-memory" },
    canManageProjects: false,
    async getMarkdownFile(relativePath) {
      return { id: relativePath, title: relativePath, content: "" };
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
  };
}

function rect(width = 80, height = 20) {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width,
    height,
    right: width,
    bottom: height,
    toJSON() {
      return this;
    },
  } as DOMRect;
}

let container: HTMLDivElement;
let root: Root;
let onSave: ReturnType<
  typeof vi.fn<(id: string, content: string) => Promise<void>>
>;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    rect(),
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
      value: () => [rect()],
    });
  }
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(),
  });
  Object.defineProperty(HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value() {
      return [this.getBoundingClientRect()];
    },
  });
  window.scrollBy = vi.fn();
  // jsdom has no layout; the composer only auto-focuses a visible textarea.
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(
    document.body,
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onSave = vi.fn(async () => {});
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
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

async function renderPage(content: string) {
  const page: Page = { id: "plan.md", title: "Plan", content };
  await act(async () => {
    root.render(
      <PageCard
        page={page}
        selected
        editorViewMode="rich-text"
        interactionMode="editing"
        onSave={onSave}
        backend={createBackend()}
      />,
    );
    await Promise.resolve();
  });
  await flush();
  await flushAnimationFrame();
  await flushAnimationFrame();
  await flush();
}

/** The dialog renders in a portal, so look in the whole document. */
function query<T extends Element = HTMLElement>(testId: string) {
  return document.querySelector<T>(`[data-testid="${testId}"]`);
}

function get<T extends Element = HTMLElement>(testId: string) {
  const element = query<T>(testId);
  expect(element, testId).not.toBeNull();
  return element as T;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
  await flush();
}

async function press(
  target: Element,
  key: string,
  init: KeyboardEventInit = {},
) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
    await Promise.resolve();
  });
  await flush();
}

/** Selecting a rail thread expands it (only the selected one is interactive). */
async function selectThread(rootId: string) {
  await click(get(`comment-thread-${rootId}`));
  await flushAnimationFrame();
  await flush();
}

async function openReaderFor(commentId: string) {
  await click(get(`comment-rail-${commentId}-action-open`));
  await flushAnimationFrame();
  await flush();
  return get("comment-reader");
}

describe("long comment bodies in the rail", () => {
  it("clamps a long body with Read more, and expands it in place", async () => {
    await renderPage(askDoc());
    await selectThread("c1");

    const clamp = get("comment-rail-c2-body-clamp");
    expect(clamp.dataset.clamped).toBe("true");
    const readMore = get("comment-rail-c2-read-more");
    expect(readMore.textContent).toBe("Read more");
    // A short body is not clamped.
    expect(query("comment-rail-c1-read-more")).toBeNull();

    await click(readMore);
    expect(get("comment-rail-c2-body-clamp").dataset.clamped).toBe("false");
    expect(get("comment-rail-c2-read-more").textContent).toBe("Show less");
  });
});

describe("thread reader dialog", () => {
  it("opens the whole thread with the anchor quote, intent, status and full Markdown", async () => {
    await renderPage(askDoc());
    await selectThread("c1");

    const dialog = await openReaderFor("c2");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(get("comment-reader-anchor").textContent).toContain("target");
    expect(get("comment-reader-intent").textContent).toBe("Ask");
    expect(get("comment-reader-agent-status-label").textContent).toBe(
      "Answered",
    );
    expect(get("comment-reader-comment-c1").textContent).toContain(
      "Why is it slow?",
    );
    const answer = get("comment-reader-comment-c2-body");
    // The full body, not a clamp: the last sentence is there.
    expect(answer.textContent).toContain("prefetching alone hits the target");
    // Rendered Markdown has no data-testid by design.
    const code = answer.querySelector("pre code"); // selector-check-ignore
    expect(code?.textContent).toContain("loadModel");
    expect(get("comment-reader-comment-c2").textContent).toContain("AI");
    expect(
      get<HTMLTimeElement>("comment-reader-comment-c2-time").dateTime,
    ).toBe("2026-10-18T12:00:20.000Z");
  });

  it("closes on Escape and returns focus to the thread", async () => {
    await renderPage(askDoc());
    await selectThread("c1");
    const dialog = await openReaderFor("c2");

    await press(dialog, "Escape");
    await flushAnimationFrame();
    await flush();

    expect(query("comment-reader")).toBeNull();
    expect(document.activeElement).toBe(get("comment-rail-c1"));
  });

  it("closes with the close button", async () => {
    await renderPage(askDoc());
    await selectThread("c1");
    await openReaderFor("c1");

    await click(get("comment-reader-close"));
    await flushAnimationFrame();
    await flush();

    expect(query("comment-reader")).toBeNull();
  });

  it("moves between threads in document order with the arrows, J/K and the buttons", async () => {
    await renderPage(twoThreadDoc);
    await selectThread("c5");
    const dialog = await openReaderFor("c5");

    expect(get("comment-reader-position").textContent).toBe("1 of 2");
    expect(get("comment-reader-comment-c5")).toBeTruthy();

    await press(dialog, "ArrowRight");
    expect(get("comment-reader-position").textContent).toBe("2 of 2");
    expect(get("comment-reader-comment-c2")).toBeTruthy();
    expect(query("comment-reader-comment-c5")).toBeNull();
    expect(get("comment-reader-anchor").textContent).toContain("beta");
    expect(get<HTMLButtonElement>("comment-reader-next").disabled).toBe(true);

    await press(get("comment-reader"), "k");
    expect(get("comment-reader-position").textContent).toBe("1 of 2");
    await press(get("comment-reader"), "j");
    expect(get("comment-reader-position").textContent).toBe("2 of 2");
    await click(get("comment-reader-prev"));
    expect(get("comment-reader-position").textContent).toBe("1 of 2");
    await press(get("comment-reader"), "ArrowLeft");
    // Already at the first thread: stays.
    expect(get("comment-reader-position").textContent).toBe("1 of 2");
  });

  it("shows a reply that arrives while it is open", async () => {
    await renderPage(askDoc(false));
    await selectThread("c1");
    await openReaderFor("c1");
    expect(query("comment-reader-comment-c2")).toBeNull();

    // The agent's answer reaches the file; the page live-reloads.
    await act(async () => {
      root.render(
        <PageCard
          page={{ id: "plan.md", title: "Plan", content: askDoc(true) }}
          selected
          editorViewMode="rich-text"
          interactionMode="editing"
          onSave={onSave}
          backend={createBackend()}
        />,
      );
      await Promise.resolve();
    });
    await flush(6);

    expect(get("comment-reader-comment-c2-body").textContent).toContain(
      "Cache warm-up",
    );
  });

  it("resolves and reopens the thread from the dialog", async () => {
    await renderPage(askDoc());
    await selectThread("c1");
    await openReaderFor("c1");

    await click(get("comment-reader-resolve"));
    expect(get("comment-reader-resolved-badge").textContent).toContain(
      "Resolved",
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    await flush();
    expect(onSave.mock.calls.at(-1)?.[1]).toContain("    status: resolved\n");

    await click(get("comment-reader-reopen"));
    expect(query("comment-reader-resolved-badge")).toBeNull();
    expect(get("comment-reader-resolve")).toBeTruthy();
  });

  it("closes and starts a reply in the rail composer from Reply", async () => {
    await renderPage(askDoc());
    await selectThread("c1");
    await openReaderFor("c2");

    await click(get("comment-reader-reply"));
    await flushAnimationFrame();
    await flushAnimationFrame();
    await flush();

    expect(query("comment-reader")).toBeNull();
    const composer = get<HTMLTextAreaElement>("comment-rail-c3-editor");
    expect(document.activeElement).toBe(composer);
  });

  it("opens from the keyboard: O on the focused thread", async () => {
    await renderPage(askDoc());
    await selectThread("c1");
    const thread = get("comment-rail-c1");
    await act(async () => {
      thread.focus();
    });

    await press(thread, "o");
    await flushAnimationFrame();
    await flush();

    expect(get("comment-reader-comment-c1")).toBeTruthy();
  });

  it("opens from the keyboard: Mod+Alt+O for the selected thread", async () => {
    await renderPage(askDoc());
    await selectThread("c1");
    const isApple = /mac|iphone|ipad|ipod/i.test(navigator.platform);

    await press(document.body, "o", {
      code: "KeyO",
      altKey: true,
      metaKey: isApple,
      ctrlKey: !isApple,
    });
    await flushAnimationFrame();
    await flush();

    expect(get("comment-reader-comment-c2")).toBeTruthy();
  });
});
