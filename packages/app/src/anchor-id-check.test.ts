import { generateHTML } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";

const extensions = createEditorExtensions("");
const SOURCE = '# Heading\n\n**<a id="REQ-11"></a>REQ-11** is a requirement.\n';

describe("in-document anchor targets", () => {
  it("keeps an empty <a id> in the rendered editor doc", () => {
    const { doc } = criticMarkdownToEditorState(SOURCE);
    expect(generateHTML(doc, extensions)).toContain('id="REQ-11"');
  });

  it("round-trips the anchor back to markdown", () => {
    const { doc, comments } = criticMarkdownToEditorState(SOURCE);
    expect(editorStateToCriticMarkdown(doc, comments)).toContain(
      '<a id="REQ-11"></a>',
    );
  });
});
