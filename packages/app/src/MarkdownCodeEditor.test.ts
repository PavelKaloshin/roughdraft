import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { EXTERNAL_CHANGE_HIGHLIGHT_MS } from "./external-change-highlight";
import {
  computeMinimalTextChange,
  createMarkdownCodeEditorExtensions,
  MarkdownCodeEditor,
} from "./MarkdownCodeEditor";

describe("createMarkdownCodeEditorExtensions", () => {
  it("loads YAML frontmatter and Markdown content without rewriting the document", () => {
    const input = "---\ntitle: Code mode\n---\n\n# Body\n";
    const onChange = vi.fn();
    const state = EditorState.create({
      doc: input,
      extensions: createMarkdownCodeEditorExtensions(false, onChange, {
        current: input,
      }),
    });

    expect(state.doc.toString()).toBe(input);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("MarkdownCodeEditor external value changes", () => {
  it("applies a disk change as a minimal edit so the caret stays put", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const initial = "# Title\n\nFirst paragraph.\n\nFifth paragraph.\n";
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const onChange = vi.fn();
    const render = async (value: string) => {
      await act(async () => {
        root.render(
          createElement(MarkdownCodeEditor, { value, onChange, testId: "cm" }),
        );
      });
    };

    await render(initial);
    const view = EditorView.findFromDOM(
      host.querySelector(".cm-editor") as HTMLElement,
    );
    expect(view).not.toBeNull();
    if (!view) return;
    const caret = initial.indexOf("paragraph.") + 3;
    view.dispatch({ selection: { anchor: caret } });

    await render(initial.replace("Fifth paragraph.", "Fifth, from disk."));

    expect(view.state.doc.toString()).toContain("Fifth, from disk.");
    expect(view.state.selection.main.head).toBe(caret);
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    host.remove();
  });
});

describe("MarkdownCodeEditor external change highlight", () => {
  async function renderEditor(value: string) {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const applyValueRef: {
      current:
        | ((value: string, options?: { highlight?: boolean }) => void)
        | null;
    } = { current: null };
    const render = async (nextValue: string) => {
      await act(async () => {
        root.render(
          createElement(MarkdownCodeEditor, {
            value: nextValue,
            onChange: vi.fn(),
            applyValueRef,
          }),
        );
      });
    };
    await render(value);
    const cleanup = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    return { host, applyValueRef, render, cleanup };
  }

  const highlighted = (host: HTMLElement) => {
    // The decoration class is the behavior under test.
    const marks = host.querySelectorAll(".external-change-highlight"); // selector-check-ignore
    return Array.from(marks).map((element) => element.textContent);
  };

  it("tints the text an external change inserted, then fades it after 1.5 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const initial = "# Title\n\nFirst paragraph.\n\nFifth paragraph.\n";
    const editor = await renderEditor(initial);

    await act(async () => {
      editor.applyValueRef.current?.(
        initial.replace("Fifth paragraph.", "Fifth, from the agent."),
        { highlight: true },
      );
    });

    expect(highlighted(editor.host).join("")).toBe(", from the agent");

    await act(async () => {
      vi.advanceTimersByTime(EXTERNAL_CHANGE_HIGHLIGHT_MS);
    });
    expect(highlighted(editor.host)).toEqual([]);

    vi.useRealTimers();
    await editor.cleanup();
  });

  it("flashes the surrounding line for a pure deletion", async () => {
    const initial = "Keep this.\n\nDrop this sentence. Keep that.\n";
    const editor = await renderEditor(initial);

    await act(async () => {
      editor.applyValueRef.current?.(
        initial.replace("Drop this sentence. ", ""),
        { highlight: true },
      );
    });

    expect(highlighted(editor.host)).toEqual(["Keep that."]);
    await editor.cleanup();
  });

  it("does not highlight values that are not external changes", async () => {
    const initial = "Alpha.\n";
    const editor = await renderEditor(initial);

    await editor.render("Alpha, reset.\n");
    await act(async () => {
      editor.applyValueRef.current?.("Alpha, silent.\n");
    });

    expect(highlighted(editor.host)).toEqual([]);
    await editor.cleanup();
  });
});

describe("computeMinimalTextChange", () => {
  it("returns only the differing middle of the two strings", () => {
    expect(computeMinimalTextChange("a b c", "a X c")).toEqual({
      from: 2,
      to: 3,
      insert: "X",
    });
    expect(computeMinimalTextChange("same", "same")).toBeNull();
    expect(computeMinimalTextChange("aa", "aaa")).toEqual({
      from: 2,
      to: 2,
      insert: "a",
    });
  });
});
