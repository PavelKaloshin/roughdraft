import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import {
  buildExternalContentTransaction,
  syncSelectionFromDom,
} from "./external-content-sync";

const editors: Editor[] = [];

function createEditor(markdown: string) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: createEditorExtensions(""),
    content: criticMarkdownToEditorState(markdown).doc,
  });
  editors.push(editor);
  return editor;
}

function parseDoc(editor: Editor, markdown: string) {
  return editor.schema.nodeFromJSON(criticMarkdownToEditorState(markdown).doc);
}

function applyExternal(
  editor: Editor,
  markdown: string,
  ignoredCommentIds: string[] = [],
) {
  const change = buildExternalContentTransaction(
    editor.state,
    parseDoc(editor, markdown),
    { ignoredCommentIds },
  );
  if (change) editor.view.dispatch(change.tr);
  return change;
}

function findText(editor: Editor, text: string) {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found != null || !node.isText || !node.text) return;
    const offset = node.text.indexOf(text);
    if (offset >= 0) found = pos + offset;
  });
  if (found == null) throw new Error(`Text not found: ${text}`);
  return found;
}

const paragraphs = (count: number, edit?: { index: number; text: string }) =>
  Array.from({ length: count }, (_, index) =>
    edit?.index === index ? edit.text : `Paragraph ${index + 1} text.`,
  ).join("\n\n");

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
});

describe("buildExternalContentTransaction", () => {
  it("replaces only the changed paragraph and keeps untouched nodes", () => {
    const editor = createEditor(`# Doc\n\n${paragraphs(6)}\n`);
    const before = editor.state.doc;

    const change = applyExternal(
      editor,
      `# Doc\n\n${paragraphs(6, { index: 4, text: "Paragraph 5 rewritten by the agent." })}\n`,
    );

    expect(change).not.toBeNull();
    const after = editor.state.doc;
    expect(after.textContent).toContain("Paragraph 5 rewritten by the agent.");
    // Every top-level node other than paragraph 5 (child 5 after the heading)
    // is the very same node object, so ProseMirror does not redraw it.
    for (let index = 0; index < before.childCount; index += 1) {
      if (index === 5) continue;
      expect(after.child(index)).toBe(before.child(index));
    }
    expect(after.child(5)).not.toBe(before.child(5));
    // The inserted range covers just the new words, not the whole document.
    const inserted = after.textBetween(
      change?.insertedFrom ?? 0,
      change?.insertedTo ?? 0,
    );
    expect(inserted).not.toContain("Paragraph 1");
    expect(inserted).toContain("rewritten by the");
  });

  it("maps the caret through the change instead of resetting it", () => {
    const editor = createEditor(`${paragraphs(6)}\n`);
    const caret = findText(editor, "graph 2") + 3;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, caret),
      ),
    );

    // An edit above the caret shifts it; an edit below leaves it in place.
    applyExternal(
      editor,
      `${paragraphs(6, { index: 0, text: "Paragraph 1 text, now longer." })}\n`,
    );
    expect(editor.state.selection.from).toBe(caret + ", now longer".length);

    const shifted = editor.state.selection.from;
    applyExternal(
      editor,
      `${paragraphs(6, { index: 0, text: "Paragraph 1 text, now longer." }).replace("Paragraph 6 text.", "Paragraph 6 changed.")}\n`,
    );
    expect(editor.state.selection.from).toBe(shifted);
  });

  it("leaves the body untouched for an endmatter-only change", () => {
    const original = [
      "Please revisit {==this claim==}{>>Needs a source.<<}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: Nora",
      '    at: "2026-05-24T10:45:00.000Z"',
      "",
    ].join("\n");
    const withReply = [
      original.trimEnd(),
      "  c2:",
      "    body: Added the source.",
      "    by: AI",
      '    at: "2026-05-24T11:00:00.000Z"',
      "    re: c1",
      "",
    ].join("\n");
    const editor = createEditor(original);
    const before = editor.state.doc;

    expect(applyExternal(editor, withReply)).toBeNull();
    expect(editor.state.doc).toBe(before);
  });

  it("is a no-op for docs with YAML front/endmatter that did not change", () => {
    const markdown = [
      "---",
      "title: Plan",
      "---",
      "",
      "Body {==text==}{>>Note<<}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: Nora",
      "",
    ].join("\n");
    const editor = createEditor(markdown);

    expect(applyExternal(editor, markdown)).toBeNull();
  });

  it("does not let a trailing list widen the change to the end of the doc", () => {
    const editor = createEditor(`${paragraphs(3)}\n\n- a\n- b\n`);
    // Any transaction lets TrailingNode append its empty paragraph.
    editor.view.dispatch(editor.state.tr.setMeta("touch", true));
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    const list = editor.state.doc.child(editor.state.doc.childCount - 2);

    const change = applyExternal(
      editor,
      `${paragraphs(3, { index: 0, text: "Changed first." })}\n\n- a\n- b\n`,
    );

    expect(
      change?.tr.doc.textBetween(change.insertedFrom, change.insertedTo),
    ).not.toContain("b");
    expect(editor.state.doc.child(editor.state.doc.childCount - 2)).toBe(list);
  });

  it("keeps an open comment draft's anchor when the change lands elsewhere", () => {
    const editor = createEditor(`${paragraphs(4)}\n`);
    const from = findText(editor, "Paragraph 1");
    editor
      .chain()
      .setTextSelection({ from, to: from + "Paragraph 1".length })
      .setCommentRef({ commentIds: ["draft-1"] })
      .run();
    const draftParagraph = editor.state.doc.child(0);

    const change = applyExternal(
      editor,
      `${paragraphs(4, { index: 3, text: "Paragraph 4 changed." })}\n`,
      ["draft-1"],
    );

    expect(
      change?.tr.doc.textBetween(change.insertedFrom, change.insertedTo),
    ).not.toContain("Paragraph 1");
    expect(editor.state.doc.child(0)).toBe(draftParagraph);
    expect(editor.getHTML()).toContain("draft-1");
    expect(editor.state.doc.textContent).toContain("Paragraph 4 changed.");
  });

  it("does not create an undo step for the external change", () => {
    const editor = createEditor(`${paragraphs(2)}\n`);
    applyExternal(
      editor,
      `${paragraphs(2, { index: 1, text: "Changed on disk." })}\n`,
    );

    editor.commands.undo();

    expect(editor.state.doc.textContent).toContain("Changed on disk.");
  });
});

describe("syncSelectionFromDom", () => {
  it("adopts a caret the browser moved before ProseMirror read it", () => {
    const editor = createEditor(paragraphs(6));
    editor.view.focus();
    const target = findText(editor, "Paragraph 1 text") + "Paragraph 1".length;
    // The browser moved the caret (an arrow key) but ProseMirror has not yet
    // processed the selectionchange: its state still has the old caret.
    const { node, offset } = editor.view.domAtPos(target);
    const domSelection = window.getSelection();
    domSelection?.collapse(node, offset);
    expect(editor.state.selection.from).not.toBe(target);

    syncSelectionFromDom(editor.view);
    applyExternal(
      editor,
      paragraphs(6, { index: 4, text: "Paragraph 5 rewritten on disk." }),
    );

    // An external edit further down keeps the caret where the user put it.
    expect(editor.state.selection.from).toBe(target);
  });
});
