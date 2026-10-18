import { describe, expect, it } from "vitest";
import {
  type CriticComment,
  createCriticComment,
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "../src/critic-markup";

function roundTrip(
  markdown: string,
  edit?: (comments: Map<string, CriticComment>) => void,
) {
  const { doc, comments } = criticMarkdownToEditorState(markdown);
  const nextComments = new Map(comments);
  edit?.(nextComments);
  return editorStateToCriticMarkdown(doc, nextComments);
}

function update(
  comments: Map<string, CriticComment>,
  id: string,
  patch: Partial<CriticComment>,
) {
  const current = comments.get(id);
  if (!current) throw new Error(`missing ${id}`);
  comments.set(id, { ...current, ...patch });
}

const askDocument = [
  "Cold start takes {==about four seconds==}{>>What is included?<<}{#c3}.",
  "",
  "---",
  "comments:",
  "  c3:",
  "    by: pavel",
  '    at: "2026-10-18T12:00:00.000Z"',
  "    intent: ask",
  "  c4:",
  "    body: |",
  "      It is the time to the **first request**:",
  "      - cache warm-up",
  "    by: AI",
  '    at: "2026-10-18T12:00:20.000Z"',
  "    re: c3",
  "",
].join("\n");

describe("comment intent", () => {
  it("reads intent from endmatter on the root comment only", () => {
    const { comments } = criticMarkdownToEditorState(askDocument);

    expect(comments.get("c3")?.intent).toBe("ask");
    expect(comments.get("c4")?.intent).toBeUndefined();
    expect(comments.get("c4")?.content).toBe(
      "It is the time to the **first request**:\n- cache warm-up\n",
    );
  });

  it("writes an untouched intent document back byte for byte", () => {
    expect(roundTrip(askDocument)).toBe(askDocument);
  });

  it("keeps intent when a reply is added to the thread", () => {
    const output = roundTrip(askDocument, (comments) => {
      comments.set(
        "c5",
        createCriticComment({
          id: "c5",
          content: "And the model load?",
          parentCommentId: "c3",
          createdAt: "2026-10-18T12:01:00.000Z",
        }),
      );
    });

    expect(output).toContain("    intent: ask\n");
    expect(output).toContain("  c5:\n    by: user\n");
    expect(output).toContain("re: c3");
  });

  it("writes intent for a new Ask comment in an endmatter-backed document", () => {
    const input = [
      "One {==two==}{>>Plain note<<}{#c1} three.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      '    at: "2026-10-18T12:00:00.000Z"',
      "",
    ].join("\n");

    const output = roundTrip(input, (comments) => {
      update(comments, "c1", { intent: "change" });
    });

    expect(output).toContain("{>>Plain note<<}{#c1}");
    expect(output).toMatch(/ {2}c1:\n(?: {4}.*\n)*? {4}intent: change\n/);
  });

  it("creates endmatter for an Ask comment in a document that had none", () => {
    const input =
      'Keep {==this==}{>>Old note<<}{id="c1" by="user" at="2026-10-18T11:00:00.000Z"} and {==that==}{>>Why?<<}{id="c2" by="user" at="2026-10-18T12:00:00.000Z"}.\n';

    const output = roundTrip(input, (comments) => {
      update(comments, "c2", { intent: "ask" });
    });

    // The spec's preferred compact form: inline reference + YAML endmatter.
    expect(output).toContain("{==that==}{>>Why?<<}{#c2}");
    expect(output).toContain("\n---\ncomments:\n");
    expect(output).toMatch(/ {2}c2:\n(?: {4}.*\n)*? {4}intent: ask\n/);
    // Once the document has endmatter, its other comments use it too.
    expect(output).toContain("{==this==}{>>Old note<<}{#c1}");
    expect(output).not.toContain('{id="c1"');

    const reparsed = criticMarkdownToEditorState(output).comments;
    expect(reparsed.get("c2")).toMatchObject({
      content: "Why?",
      intent: "ask",
    });
    expect(reparsed.get("c1")?.intent).toBeUndefined();
  });

  it("leaves a plain comment inline when no comment has an intent", () => {
    const input =
      'Keep {==this==}{>>Old note<<}{id="c1" by="user" at="2026-10-18T11:00:00.000Z"}.\n';

    expect(roundTrip(input)).toBe(input);
  });

  it("gives a bare comment real metadata once it gets an intent", () => {
    const input = "Paragraph {==here==}{>>Bare note<<}.\n";

    expect(roundTrip(input)).toBe(input);

    const output = roundTrip(input, (comments) => {
      const [id] = [...comments.keys()];
      if (!id) throw new Error("no comment");
      update(comments, id, { intent: "ask" });
    });
    expect(output).toMatch(/\{>>Bare note<<\}\{#c\d+\}/);
    expect(output).toContain("intent: ask");
  });

  it("preserves an unknown intent value already in the file", () => {
    const input = [
      "One {==two==}{>>Note<<}{#c1} three.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      '    at: "2026-10-18T12:00:00.000Z"',
      "    intent: brainstorm",
      "",
    ].join("\n");

    const { comments } = criticMarkdownToEditorState(input);
    expect(comments.get("c1")?.intent).toBeUndefined();

    const output = roundTrip(input, (next) => {
      update(next, "c1", { content: "Edited note" });
    });
    expect(output).toContain("intent: brainstorm");
  });
});

describe("comment resolved status", () => {
  it("writes status: resolved into endmatter and drops it on reopen", () => {
    const resolved = roundTrip(askDocument, (comments) => {
      update(comments, "c3", { status: "resolved" });
    });

    expect(resolved).toContain("    status: resolved\n");
    expect(resolved).toContain("    intent: ask\n");
    expect(
      criticMarkdownToEditorState(resolved).comments.get("c3"),
    ).toMatchObject({ status: "resolved", intent: "ask" });

    const withSummary = resolved.replace(
      "    status: resolved\n",
      "    status: resolved\n    resolved: Added a source\n",
    );
    const reopened = roundTrip(withSummary, (comments) => {
      update(comments, "c3", { status: null });
    });
    expect(reopened).not.toContain("status:");
    expect(reopened).not.toContain("resolved:");
  });

  it("preserves inline status and resolution summary attributes", () => {
    const input =
      'Keep {==this==}{>>Old note<<}{id="c1" by="user" at="2026-10-18T11:00:00.000Z" status="resolved" resolved="Done"}.\n';

    const { comments } = criticMarkdownToEditorState(input);
    expect(comments.get("c1")?.status).toBe("resolved");
    expect(roundTrip(input)).toBe(input);

    expect(
      roundTrip(input, (next) => update(next, "c1", { status: null })),
    ).toBe(
      'Keep {==this==}{>>Old note<<}{id="c1" by="user" at="2026-10-18T11:00:00.000Z"}.\n',
    );
  });
});

// The app saves the whole document; its endmatter write must only touch the
// entries the user changed, so agent/merge diffs stay small (like rfm).
describe("endmatter writes keep untouched entries byte-identical", () => {
  const body = [
    "Keep {==this claim==}{>>Why?<<}{#c1} and {==that==}{>>Note<<}{#c5}.",
    "",
  ];
  const endmatter = [
    "---",
    "# review state",
    "comments:",
    "  c1:",
    "    by: pavel",
    '    at: "2026-10-18T12:00:00.000Z"',
    "    intent: ask",
    "",
    "  c2:",
    "    body: 'Single-quoted: kept'",
    "    by: AI",
    "    at: 2026-10-18T12:01:00.000Z",
    "    re: c1",
    "  c5:",
    "    by: user",
    '    at: "2026-10-18T12:02:00.000Z"',
    "workflow:",
    "  owner: editorial # who triages",
    "",
  ];
  const markdown = [...body, ...endmatter].join("\n");

  it("resolving one thread adds a line to that entry only", () => {
    const output = roundTrip(markdown, (comments) =>
      update(comments, "c5", { status: "resolved" }),
    );

    expect(output).toBe(
      [
        ...body,
        ...endmatter.slice(0, 16),
        "    status: resolved",
        ...endmatter.slice(16),
      ].join("\n"),
    );
  });

  it("a new reply appends its own lines (literal block, quoted at)", () => {
    const output = roundTrip(markdown, (comments) => {
      comments.set(
        "c6",
        createCriticComment({
          id: "c6",
          content: "Line one\nline two",
          parentCommentId: "c1",
          createdAt: "2026-10-18T12:03:00.000Z",
        }),
      );
    });

    expect(output).toBe(
      [
        ...body,
        ...endmatter.slice(0, 16),
        "  c6:",
        "    by: user",
        '    at: "2026-10-18T12:03:00.000Z"',
        "    body: |-",
        "      Line one",
        "      line two",
        "    re: c1",
        ...endmatter.slice(16),
      ].join("\n"),
    );
  });
});
