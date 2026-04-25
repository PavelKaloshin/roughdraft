import { act } from "react";
import type { Editor } from "@tiptap/react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Canvas } from "../src/Canvas";
import { PageCard, shouldDismissCommentThread } from "../src/PageCard";
import type { Page, StorageBackend } from "../src/storage";

function createDomRect({
  left = 0,
  top = 0,
  width = 120,
  height = 24,
}: {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
} = {}) {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON() {
      return this;
    },
  } as DOMRect;
}

function createBackend(): StorageBackend {
  return {
    info: {
      kind: "local-storage",
      label: "Test backend",
      detail: "In-memory",
    },
    canManageProjects: false,
    async listPages() {
      return [];
    },
    async getPage(id) {
      return { id, title: id, content: "" };
    },
    async getMarkdownFile(relativePath) {
      return { id: relativePath, title: relativePath, content: "" };
    },
    async savePage() {},
    async saveMarkdownFile() {},
    async createPage(title = "Untitled", content = "") {
      return { id: title, title, content };
    },
    async deletePage() {},
    async getProject() {
      return { pages: {} };
    },
    async saveProject() {},
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
    async listDirectories(path = ".") {
      return {
        path,
        parentPath: null,
        directories: [],
      };
    },
    async listFileSystem(path = ".") {
      return {
        path,
        displayPath: path,
        parentPath: null,
        directories: [],
        files: [],
      };
    },
    async listProjectTree() {
      return { paths: [] };
    },
    async openProject() {},
    async createProject() {},
  };
}

function findTextRange(editor: Editor, text: string) {
  let range: { from: number; to: number } | null = null;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;

    const offset = node.text.indexOf(text);
    if (offset < 0) return;

    range = {
      from: pos + offset,
      to: pos + offset + text.length,
    };

    return false;
  });

  return range;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function flushAnimationFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

async function selectText(editor: Editor, text: string) {
  const range = findTextRange(editor, text);
  expect(range).not.toBeNull();
  if (!range) {
    throw new Error(`Could not find text range for "${text}"`);
  }

  await act(async () => {
    editor.commands.focus();
    editor.commands.setTextSelection(range);
  });

  await flushReact();
}

async function insertTextAtEnd(editor: Editor, text: string) {
  await act(async () => {
    editor.chain().focus("end").insertContent(text).run();
  });

  await flushReact();
}

function getEditable(container: HTMLElement) {
  const editable = container.querySelector(".ProseMirror");
  expect(editable).not.toBeNull();
  return editable as HTMLElement;
}

function getBlockTypeTrigger(container: HTMLElement) {
  const trigger = container.querySelector('[aria-label="Block type"]');
  expect(trigger).not.toBeNull();
  return trigger as HTMLElement;
}

function getToolbarButton(container: HTMLElement, label: string) {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

type PageCardTestOptions = Partial<{
  page: Page;
  mode: "canvas" | "document";
  editorViewMode: "rich-text" | "code";
  selected: boolean;
  focusRequestKey: string | null;
}>;

type RenderedPageCard = {
  container: HTMLDivElement;
  onSave: ReturnType<typeof vi.fn>;
  onSaveStateChange: ReturnType<typeof vi.fn>;
  onReposition: ReturnType<typeof vi.fn>;
  getEditor: () => Editor;
  rerender: (overrides?: PageCardTestOptions) => Promise<void>;
  unmount: () => Promise<void>;
};

const cleanups: Array<() => Promise<void>> = [];

async function renderPageCard(
  options: PageCardTestOptions = {},
): Promise<RenderedPageCard> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const backend = createBackend();
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onSaveStateChange = vi.fn();
  const onReposition = vi.fn();
  let editor: Editor | null = null;

  let props = {
    page: options.page ?? {
      id: "page-1",
      title: "Page 1",
      content: "Start",
    },
    x: 12,
    y: 18,
    selected: options.selected ?? options.mode === "canvas",
    focusRequestKey: options.focusRequestKey ?? null,
    canDelete: true,
    mode: options.mode ?? "document",
    editorViewMode: options.editorViewMode ?? "rich-text",
    onSelect: vi.fn(),
    onSave,
    onReposition,
    onDelete: vi.fn(),
    onSaveStateChange,
    backend,
    onEditorReady: (nextEditor: Editor | null) => {
      editor = nextEditor;
    },
  } as const;

  const render = async () => {
    await act(async () => {
      const pageCard = <PageCard {...props} />;

      root.render(
        props.mode === "canvas" ? <Canvas>{pageCard}</Canvas> : pageCard,
      );

      await Promise.resolve();
    });
  };

  await render();

  const unmount = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };

  cleanups.push(unmount);

  return {
    container,
    onSave,
    onSaveStateChange,
    onReposition,
    getEditor() {
      expect(editor).not.toBeNull();
      return editor as Editor;
    },
    async rerender(overrides = {}) {
      props = {
        ...props,
        ...overrides,
        page: overrides.page ?? props.page,
      };
      await render();
    },
    unmount,
  };
}

describe("PageCard comment thread dismissal", () => {
  it("keeps the thread open for clicks inside the thread container", () => {
    const container = document.createElement("div");
    container.dataset.commentThreadContainer = "true";
    const child = document.createElement("button");
    container.appendChild(child);

    expect(shouldDismissCommentThread(child)).toBe(false);
  });

  it("keeps the thread open for clicks on comment anchors", () => {
    const anchor = document.createElement("span");
    anchor.className = "comment-anchor";
    anchor.dataset.commentIds = JSON.stringify(["c1"]);

    expect(shouldDismissCommentThread(anchor)).toBe(false);
  });

  it("dismisses the thread for background clicks", () => {
    const background = document.createElement("div");

    expect(shouldDismissCommentThread(background)).toBe(true);
  });
});

describe("PageCard editor integration", () => {
  beforeEach(() => {
    vi.useRealTimers();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect() {
        const isEditor = this.classList.contains("ProseMirror");
        const isAnchor = this.classList.contains("comment-anchor");

        return createDomRect({
          width: isEditor ? 640 : isAnchor ? 80 : 120,
          height: isEditor ? 240 : 24,
        });
      },
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
      value: {
        ready: Promise.resolve(),
      },
    });

    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value() {
        return createDomRect({
          width: 80,
          height: 20,
        });
      },
    });

    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value() {
        return [createDomRect({ width: 80, height: 20 })];
      },
    });

    Object.defineProperty(HTMLElement.prototype, "getClientRects", {
      configurable: true,
      value() {
        return [this.getBoundingClientRect()];
      },
    });

    Object.defineProperty(Text.prototype, "getClientRects", {
      configurable: true,
      value() {
        return [createDomRect({ width: 80, height: 20 })];
      },
    });

    window.scrollBy = vi.fn();
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }

    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("document mode edits trigger autosave", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-1",
        title: "Doc 1",
        content: "Start",
      },
      mode: "document",
      selected: true,
    });

    vi.useFakeTimers();

    await insertTextAtEnd(rendered.getEditor(), " now");

    expect(rendered.onSaveStateChange).toHaveBeenCalledWith("saving");

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(rendered.onSave).toHaveBeenCalledTimes(1);
    expect(rendered.onSave).toHaveBeenCalledWith(
      "doc-1",
      expect.stringContaining("Start now"),
    );
    expect(rendered.onSaveStateChange.mock.calls.at(-1)?.[0]).toBe("idle");
  });

  it("document code mode shows raw markdown and hides rich text chrome", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-code-1",
        title: "Doc Code 1",
        content: "{==alpha==}{>>Comment body<<}\n\n# Heading\n\n`inline`",
      },
      mode: "document",
      editorViewMode: "code",
      selected: true,
    });

    expect(rendered.container.textContent).toContain("{==alpha==}");
    expect(rendered.container.textContent).toContain("{>>Comment body<<}");
    expect(
      rendered.container.querySelector('[aria-label="Block type"]'),
    ).toBeNull();
    expect(
      rendered.container
        .querySelector(".document-comment-rail")
        ?.classList.contains("invisible"),
    ).toBe(true);
  });

  it("document code mode keeps rail space when comments exist", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-code-2",
        title: "Doc Code 2",
        content: "{==alpha==}{>>Comment body<<}\n\nParagraph",
      },
      mode: "document",
      editorViewMode: "code",
      selected: true,
    });

    expect(
      rendered.container
        .querySelector(".document-page-shell")
        ?.classList.contains("document-page-shell-no-comments"),
    ).toBe(false);
    expect(
      rendered.container.querySelector(".document-comment-rail"),
    ).not.toBeNull();
  });

  it("document code mode shows line numbers without the default dotted focus outline", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-code-3",
        title: "Doc Code 3",
        content: "# Heading\n\nParagraph",
      },
      mode: "document",
      editorViewMode: "code",
      selected: true,
    });

    const editor = rendered.container.querySelector(".cm-editor");
    expect(editor).not.toBeNull();

    const gutters = rendered.container.querySelector(".cm-gutters");
    expect(gutters).not.toBeNull();
    expect(gutters?.textContent).toContain("1");
    expect(getComputedStyle(gutters as Element).display).not.toBe("none");
    expect(getComputedStyle(editor as Element).outlineStyle).not.toBe("dotted");
  });

  it("selection updates toolbar state", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-2",
        title: "Doc 2",
        content: "# Heading\n\nParagraph with **bold** text",
      },
      mode: "document",
      selected: true,
    });

    const editor = rendered.getEditor();

    await selectText(editor, "Heading");
    await flushAnimationFrame();
    expect(rendered.container.textContent).toContain("Comment");

    await selectText(editor, "bold");
    await flushAnimationFrame();
    expect(
      getToolbarButton(rendered.container, "Bold").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("external page content updates replace editor content when unfocused", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-3",
        title: "Doc 3",
        content: "Alpha",
      },
      mode: "document",
      selected: true,
    });

    expect(getEditable(rendered.container).textContent).toContain("Alpha");

    await rendered.rerender({
      page: {
        id: "doc-3",
        title: "Doc 3",
        content: "Beta",
      },
    });

    expect(getEditable(rendered.container).textContent).toContain("Beta");
    expect(getEditable(rendered.container).textContent).not.toContain("Alpha");
  });

  it("recent local save echo does not immediately overwrite current editor state", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-4",
        title: "Doc 4",
        content: "{==alpha==}{>>Comment body<<}\n\nTail",
      },
      mode: "document",
      selected: true,
    });

    vi.useFakeTimers();

    const editor = rendered.getEditor();
    await insertTextAtEnd(editor, " updated");

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    const savedMarkdown = rendered.onSave.mock.calls[0]?.[1];
    expect(typeof savedMarkdown).toBe("string");

    await selectText(editor, "alpha");
    expect(
      rendered.container.querySelector(".document-comment-fallback")
        ?.textContent,
    ).toContain("Comment body");

    await act(async () => {
      editor.commands.blur();
    });

    await rendered.rerender({
      page: {
        id: "doc-4",
        title: "Doc 4",
        content: savedMarkdown as string,
      },
    });

    expect(
      rendered.container.querySelector(".document-comment-fallback")
        ?.textContent,
    ).toContain("Comment body");
  });

  it("comment selection still updates fallback UI", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-5",
        title: "Doc 5",
        content: "{==alpha==}{>>Comment body<<}\n\nParagraph",
      },
      mode: "document",
      selected: true,
    });

    await selectText(rendered.getEditor(), "alpha");

    expect(
      rendered.container.querySelector(".document-comment-fallback")
        ?.textContent,
    ).toContain("Comment body");
    expect(rendered.container.textContent).toContain("Me");
  });

  it("centers document layout when there are no comments", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-6",
        title: "Doc 6",
        content: "Just text",
      },
      mode: "document",
      selected: true,
    });

    expect(
      rendered.container
        .querySelector(".document-page-shell")
        ?.classList.contains("document-page-shell-no-comments"),
    ).toBe(true);

    await rendered.rerender({
      page: {
        id: "doc-6",
        title: "Doc 6",
        content: "{==alpha==}{>>Comment body<<}\n\nJust text",
      },
    });

    expect(
      rendered.container
        .querySelector(".document-page-shell")
        ?.classList.contains("document-page-shell-no-comments"),
    ).toBe(false);
  });

  it("canvas props churn does not lose editor content or selection", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "canvas-1",
        title: "Canvas 1",
        content: "Hello canvas",
      },
      mode: "canvas",
      selected: true,
    });

    const editor = rendered.getEditor();
    await insertTextAtEnd(editor, " updated");
    await selectText(editor, "Hello");

    const initialEditable = getEditable(rendered.container);
    const initialSelection = {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };

    await rendered.rerender({ x: 50, y: 60, selected: false });
    await rendered.rerender({ x: 90, y: 120, selected: true });
    await rendered.rerender({ x: 140, y: 180, selected: false });

    expect(rendered.getEditor().getText()).toContain("Hello canvas updated");
    expect(rendered.getEditor().state.selection.from).toBe(
      initialSelection.from,
    );
    expect(rendered.getEditor().state.selection.to).toBe(initialSelection.to);
    expect(getEditable(rendered.container)).toBe(initialEditable);
  });

  it("focus request changes focus the editor without recreating document state", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "canvas-2",
        title: "Canvas 2",
        content: "Focus target",
      },
      mode: "canvas",
      selected: true,
      focusRequestKey: null,
    });

    const editor = rendered.getEditor();
    const initialEditable = getEditable(rendered.container);
    const initialSelection = editor.state.selection.from;

    await rendered.rerender({
      selected: true,
      focusRequestKey: "focus-1",
    });
    await flushAnimationFrame();

    expect(rendered.getEditor()).toBe(editor);
    expect(getEditable(rendered.container)).toBe(initialEditable);
    expect(rendered.getEditor().state.selection.from).toBeGreaterThan(
      initialSelection,
    );
    expect(rendered.getEditor().getText()).toContain("Focus target");
  });

  it("non-editor prop churn does not drop toolbar state", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "canvas-3",
        title: "Canvas 3",
        content: "# Heading",
      },
      mode: "canvas",
      selected: true,
    });

    await selectText(rendered.getEditor(), "Heading");
    expect(getBlockTypeTrigger(rendered.container).textContent).toContain(
      "Heading 1",
    );

    await rendered.rerender({ x: 240, y: 320 });

    expect(getBlockTypeTrigger(rendered.container).textContent).toContain(
      "Heading 1",
    );
  });
});
