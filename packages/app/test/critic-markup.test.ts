import { describe, expect, it } from "vitest";
import {
  createNextCommentId,
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
  getCommentDescendantIds,
} from "../src/critic-markup";

describe("CriticMarkup comments", () => {
  it("round-trips a highlighted comment anchor", () => {
    const input =
      "This is {==highlighted==}{>>comment text<<}{@id:cmt1;by:AI;at:2024-01-15T10:30:00.000Z@} text.\n";

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("cmt1")).toMatchObject({
      id: "cmt1",
      content: "comment text",
      authorType: "ai",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("preserves formatting nested inside a comment anchor", () => {
    const input =
      "The {==**important**==}{>>Review this phrasing<<}{@id:cmt2;by:user@example.com;at:2024-01-15T10:31:00.000Z@} section stays bold.\n";

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("keeps the anchor attached when nearby text changes", () => {
    const input =
      "Before {==target==}{>>Check this<<}{@id:cmt3;by:AI;at:2024-01-15T10:32:00.000Z@} after.\n";
    const { doc, comments } = criticMarkdownToEditorState(input);
    const nextDoc = structuredClone(doc);
    const firstParagraph = nextDoc.content?.[0];
    const firstTextNode = firstParagraph?.content?.[0];

    if (firstTextNode?.type !== "text") {
      throw new Error("Expected leading text node in parsed paragraph");
    }

    firstTextNode.text = "Before nearby ";

    expect(editorStateToCriticMarkdown(nextDoc, comments)).toBe(
      "Before nearby {==target==}{>>Check this<<}{@id:cmt3;by:AI;at:2024-01-15T10:32:00.000Z@} after.\n",
    );
  });

  it("round-trips comments inside list items and headings", () => {
    const input = `## Sprint Notes

* First item
* {==Second item==}{>>Needs review<<}{@id:cmt4;by:AI;at:2024-01-15T10:33:00.000Z@}
`;

    const { doc, comments } = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(doc, comments);

    expect(output).toContain("## Sprint Notes");
    expect(output).toContain(
      "{==Second item==}{>>Needs review<<}{@id:cmt4;by:AI;at:2024-01-15T10:33:00.000Z@}",
    );
    expect(output).toContain("*   First item");
  });

  it("does not import a trailing blank line into fenced code blocks", () => {
    const input = `\`\`\`text
Use Roughdraft when I want to open, review, comment on, or compare markdown files.

Start it with \`roughdraft start\` if needed.
Open files or folders with \`roughdraft open "/absolute/path/to/file.md"\`.
After I finish reviewing in Roughdraft, continue by reading the markdown files from disk and making the requested changes there.
Use CriticMarkup for inline review feedback in markdown.
\`\`\`
`;

    const { doc } = criticMarkdownToEditorState(input);
    const codeBlock = doc.content?.[0];
    const textNode = codeBlock?.content?.[0];

    expect(codeBlock?.type).toBe("codeBlock");
    expect(textNode).toMatchObject({
      type: "text",
      text: `Use Roughdraft when I want to open, review, comment on, or compare markdown files.

Start it with \`roughdraft start\` if needed.
Open files or folders with \`roughdraft open "/absolute/path/to/file.md"\`.
After I finish reviewing in Roughdraft, continue by reading the markdown files from disk and making the requested changes there.
Use CriticMarkup for inline review feedback in markdown.`,
    });
    expect(editorStateToCriticMarkdown(doc, new Map())).toBe(input);
  });

  it("round-trips an anchored reply thread", () => {
    const input =
      "Please revisit {==this sentence==}{>>Needs a source<<}{@id:c1;by:user;at:2024-01-15T10:30:00.000Z@}{>>I can add one from the intro.<<}{@id:c2;by:AI;at:2024-01-15T10:31:00.000Z;re:c1@}.\n";

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c2")).toMatchObject({
      id: "c2",
      parentCommentId: "c1",
      authorType: "ai",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("round-trips nested replies in preorder", () => {
    const input =
      "Please revisit {==this sentence==}{>>Needs a source<<}{@id:c1;by:user;at:2024-01-15T10:30:00.000Z@}{>>I can add one from the intro.<<}{@id:c2;by:AI;at:2024-01-15T10:31:00.000Z;re:c1@}{>>Use the market report too.<<}{@id:c3;by:user;at:2024-01-15T10:32:00.000Z;re:c2@}.\n";

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c3")).toMatchObject({
      id: "c3",
      parentCommentId: "c2",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("allocates simple document-local ids", () => {
    expect(
      createNextCommentId([{ id: "c2" }, { id: "note-1" }, { id: "c7" }]),
    ).toBe("c8");
  });

  it("collects descendants in nested reply order", () => {
    const comments = new Map([
      [
        "c1",
        {
          id: "c1",
          content: "Root",
          createdAt: "2024-01-15T10:30:00.000Z",
        },
      ],
      [
        "c2",
        {
          id: "c2",
          content: "Reply",
          createdAt: "2024-01-15T10:31:00.000Z",
          parentCommentId: "c1",
        },
      ],
      [
        "c3",
        {
          id: "c3",
          content: "Nested reply",
          createdAt: "2024-01-15T10:32:00.000Z",
          parentCommentId: "c2",
        },
      ],
      [
        "c4",
        {
          id: "c4",
          content: "Sibling reply",
          createdAt: "2024-01-15T10:33:00.000Z",
          parentCommentId: "c1",
        },
      ],
    ]);

    expect(getCommentDescendantIds("c1", comments)).toEqual(["c2", "c3", "c4"]);
  });
});
