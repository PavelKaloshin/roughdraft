import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appendRoughdraftReply,
  appendRoughdraftDocumentComment,
  extractRoughdraftReviewIndex,
  markRoughdraftResolved,
  validateRoughdraftMarkdown,
} from "./index";

function codes(markdown: string): string[] {
  return validateRoughdraftMarkdown(markdown).diagnostics.map(
    (diagnostic) => diagnostic.code,
  );
}

describe("validateRoughdraftMarkdown", () => {
  it("accepts valid comments, anchored comments, and suggestions", () => {
    const result = validateRoughdraftMarkdown(
      [
        'Please revisit {==this sentence==}{>>Needs a source.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.',
        'Add {++one concrete example++}{id="s1" by="AI" at="2026-04-28T12:05:00.000Z"}.',
        'Use {~~rough~>specific~~}{id="s2" by="user" at="2026-04-28T12:07:00.000Z"} wording.',
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({
      comments: 1,
      suggestions: 2,
      legacyMetadata: 0,
    });
  });

  it("accepts root comments and suggestions backed by YAML endmatter", () => {
    const result = validateRoughdraftMarkdown(
      [
        "Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.",
        "Add {++one concrete example++}{#s1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "suggestions:",
        "  s1:",
        "    by: AI",
        '    at: "2026-04-28T12:05:00.000Z"',
        "",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({
      comments: 1,
      suggestions: 1,
    });
  });

  it("does not validate CriticMarkup-looking text inside YAML endmatter bodies", () => {
    const result = validateRoughdraftMarkdown(
      [
        "Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "  c2:",
        "    body: Contains {++not a live suggestion++} in the reply.",
        "    by: AI",
        '    at: "2026-04-28T12:05:00.000Z"',
        "    re: c1",
        "",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toMatchObject({
      comments: 2,
      suggestions: 0,
    });
  });

  it("reports the RFM 0.2 format version", () => {
    expect(validateRoughdraftMarkdown("").version).toBe("0.2");
  });

  it("reports a missing YAML endmatter entry for compact references", () => {
    expect(codes("{>>Needs metadata<<}{#c1}\n")).toContain(
      "missing-endmatter-entry",
    );
  });

  it("accepts body-only endmatter comments as document-level feedback", () => {
    const result = validateRoughdraftMarkdown(
      [
        "{>>Root<<}{#c1}",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "  c2:",
        "    body: Reply without parent",
        "    by: AI",
        '    at: "2026-04-28T12:01:00.000Z"',
        "",
      ].join("\n"),
    );

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({ comments: 2 });
  });

  it("ignores review markers inside fenced code blocks and inline code spans", () => {
    const result = validateRoughdraftMarkdown(
      [
        "```md",
        "This is {>>not a comment<<}.",
        "This is {++not a suggestion++}.",
        "```",
        "Literal `{>>not a comment<<}` text.",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toMatchObject({
      comments: 0,
      suggestions: 0,
    });
  });

  it("does not treat fenced YAML examples as invalid review endmatter", () => {
    const result = validateRoughdraftMarkdown(
      [
        "Doc",
        "",
        "```yaml",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "```",
        "",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toMatchObject({
      comments: 0,
      suggestions: 0,
    });
  });

  it("does not treat ordinary final comments sections as review endmatter without compact references", () => {
    const result = validateRoughdraftMarkdown(
      [
        "Release notes",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: docs",
        '    at: "not review metadata"',
        "",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toMatchObject({
      comments: 0,
      suggestions: 0,
    });
  });

  it("accepts document-level comments backed only by YAML endmatter", () => {
    const result = validateRoughdraftMarkdown(
      [
        "# Draft",
        "",
        "---",
        "comments:",
        "  c1:",
        "    body: Please address the risk section.",
        "    by: user",
        '    at: "2026-05-24T12:00:00.000Z"',
        "",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({
      comments: 1,
      suggestions: 0,
    });
  });

  it("reports missing canonical metadata attributes", () => {
    expect(codes("{>>Needs metadata<<}\n")).toEqual([
      "missing-metadata-id",
      "missing-metadata-by",
      "missing-metadata-at",
    ]);
  });

  it("reports invalid timestamps", () => {
    expect(
      codes('{>>Bad time<<}{id="c1" by="user" at="yesterday"}\n'),
    ).toContain("invalid-metadata-at");
  });

  it("reports unclosed review markers", () => {
    expect(codes("{++unfinished\n")).toEqual(["unclosed-addition"]);
    expect(codes("{--unfinished\n")).toEqual(["unclosed-deletion"]);
    expect(codes("{~~old text\n")).toEqual(["unclosed-substitution"]);
  });

  it("reports duplicate ids across comments and suggestions", () => {
    expect(
      codes(
        [
          '{>>First<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}',
          '{++Second++}{id="c1" by="user" at="2026-04-28T12:01:00.000Z"}',
        ].join("\n"),
      ),
    ).toContain("duplicate-id");
  });

  it("reports self replies as errors and missing reply targets as warnings", () => {
    const result = validateRoughdraftMarkdown(
      [
        '{>>Self<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z" re="c1"}',
        '{>>Missing parent<<}{id="c2" by="user" at="2026-04-28T12:01:00.000Z" re="missing"}',
      ].join("\n"),
    );

    expect(result.errors.map((diagnostic) => diagnostic.code)).toContain(
      "self-reply",
    );
    expect(result.warnings.map((diagnostic) => diagnostic.code)).toContain(
      "missing-reply-target",
    );
    expect(result.ok).toBe(false);
  });

  it("accepts legacy metadata with a warning", () => {
    const result = validateRoughdraftMarkdown(
      "{>>Legacy<<}{@id:c1; by:AI; at:2026-04-28T12:00:00.000Z@}\n",
    );

    expect(result.ok).toBe(true);
    expect(result.warnings.map((diagnostic) => diagnostic.code)).toEqual([
      "legacy-metadata",
    ]);
    expect(result.summary.legacyMetadata).toBe(1);
  });

  it("reports CRLF source locations with one-based line and column", () => {
    const result = validateRoughdraftMarkdown(
      "First line\r\n{>>Needs metadata<<}\r\n",
    );

    expect(result.errors[0]).toMatchObject({
      line: 2,
      column: 1,
    });
  });
});

describe("extractRoughdraftReviewIndex", () => {
  it("extracts comments, anchored comments, replies, and suggestions", () => {
    const index = extractRoughdraftReviewIndex(
      [
        'Please revisit {==this sentence==}{>>Needs a source.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.',
        '{>>I added one.<<}{id="c2" by="AI" at="2026-04-28T12:02:00.000Z" re="c1"}',
        'Add {++one concrete example++}{id="s1" by="AI" at="2026-04-28T12:05:00.000Z"}.',
        'Use {~~rough~>specific~~}{id="s2" by="user" at="2026-04-28T12:07:00.000Z"} wording.',
      ].join("\n"),
    );

    expect(index.summary).toMatchObject({
      comments: 1,
      replies: 1,
      suggestions: 2,
      unresolved: 4,
    });
    expect(index.items.map((item) => [item.id, item.kind])).toEqual([
      ["c1", "comment"],
      ["c2", "reply"],
      ["s1", "suggestion"],
      ["s2", "suggestion"],
    ]);
    expect(index.items[0]).toMatchObject({
      anchorText: "this sentence",
      author: "user",
      line: 1,
      column: 35,
      text: "Needs a source.",
    });
    expect(index.items[3]).toMatchObject({
      suggestionKind: "substitution",
      originalText: "rough",
      replacementText: "specific",
    });
  });

  it("extracts equivalent review items from YAML endmatter metadata", () => {
    const index = extractRoughdraftReviewIndex(
      [
        "Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.",
        "Add {++one concrete example++}{#s1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "  c2:",
        "    body: I added one.",
        "    by: AI",
        '    at: "2026-04-28T12:02:00.000Z"',
        "    re: c1",
        "suggestions:",
        "  s1:",
        "    by: AI",
        '    at: "2026-04-28T12:05:00.000Z"',
        "    status: resolved",
        "",
      ].join("\n"),
    );

    expect(index.summary).toMatchObject({
      comments: 1,
      replies: 1,
      suggestions: 1,
      unresolved: 2,
    });
    expect(index.items.map((item) => [item.id, item.kind])).toEqual([
      ["c1", "comment"],
      ["s1", "suggestion"],
      ["c2", "reply"],
    ]);
    expect(index.items[0]).toMatchObject({
      anchorText: "this sentence",
      author: "user",
      text: "Needs a source.",
    });
    expect(index.items[2]).toMatchObject({
      parentId: "c1",
      author: "AI",
      text: "I added one.",
    });
  });

  it("extracts document-level comments backed only by YAML endmatter", () => {
    const index = extractRoughdraftReviewIndex(
      [
        "# Draft",
        "",
        "---",
        "comments:",
        "  c1:",
        "    body: Please address the risk section.",
        "    by: user",
        '    at: "2026-05-24T12:00:00.000Z"',
        "",
      ].join("\n"),
    );

    expect(index.summary).toMatchObject({
      comments: 1,
      replies: 0,
      suggestions: 0,
      unresolved: 1,
    });
    expect(index.items[0]).toMatchObject({
      id: "c1",
      kind: "comment",
      parentId: null,
      author: "user",
      createdAt: "2026-05-24T12:00:00.000Z",
      text: "Please address the risk section.",
    });
  });

  it("does not extract CriticMarkup-looking text inside YAML endmatter bodies", () => {
    const index = extractRoughdraftReviewIndex(
      [
        "Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "  c2:",
        "    body: Contains {++not a live suggestion++} in the reply.",
        "    by: AI",
        '    at: "2026-04-28T12:05:00.000Z"',
        "    re: c1",
        "",
      ].join("\n"),
    );

    expect(index.version).toBe("0.2");
    expect(index.summary).toMatchObject({
      comments: 1,
      replies: 1,
      suggestions: 0,
    });
    expect(index.items.map((item) => [item.id, item.kind])).toEqual([
      ["c1", "comment"],
      ["c2", "reply"],
    ]);
    expect(index.items[1]).toMatchObject({
      text: "Contains {++not a live suggestion++} in the reply.",
    });
  });

  it("preserves literal CriticMarkup inside inline code and fenced code blocks", () => {
    const index = extractRoughdraftReviewIndex(
      [
        "```md",
        '{>>not a comment<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}',
        "```",
        'Literal `{++not a suggestion++}{id="s1" by="AI" at="2026-04-28T12:01:00.000Z"}` text.',
      ].join("\n"),
    );

    expect(index.items).toEqual([]);
    expect(index.summary).toMatchObject({
      comments: 0,
      replies: 0,
      suggestions: 0,
      unresolved: 0,
    });
  });

  it("uses only the final YAML block as Roughdraft endmatter", () => {
    const index = extractRoughdraftReviewIndex(
      [
        "Intro",
        "",
        "---",
        "",
        "Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "",
      ].join("\n"),
    );

    expect(index.items).toHaveLength(1);
    expect(index.items[0]).toMatchObject({
      id: "c1",
      author: "user",
    });
  });
});

describe("RFM mutation helpers", () => {
  it("appends a reply without rewriting unrelated Markdown", () => {
    const markdown =
      '# Plan\n\nKeep {==this claim==}{>>Needs proof<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"} as written.\n';

    const updated = appendRoughdraftReply(markdown, {
      parentId: "c1",
      id: "c2",
      author: "AI",
      at: "2026-04-28T12:10:00.000Z",
      message: "Added a citation in the next paragraph.",
    });

    expect(updated).toBe(
      '# Plan\n\nKeep {==this claim==}{>>Needs proof<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}{>>Added a citation in the next paragraph.<<}{id="c2" by="AI" at="2026-04-28T12:10:00.000Z" re="c1"} as written.\n',
    );
  });

  it("writes a long multiline reply as a readable literal block", () => {
    const markdown = [
      "Keep {==this claim==}{>>Needs proof<<}{#c1} as written.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      '    at: "2026-04-28T12:00:00.000Z"',
      "",
    ].join("\n");
    const message =
      "Two reasons:\n\n- the cache is empty after a deploy, so the first request always goes to the origin server;\n- later requests are served from the cache.";

    const updated = appendRoughdraftReply(markdown, {
      parentId: "c1",
      id: "c2",
      author: "AI",
      at: "2026-04-28T12:10:00.000Z",
      message,
    });

    // People read endmatter too: no folded `>` style, no re-wrapped lines.
    expect(updated).toContain(
      [
        "    body: |-",
        "      Two reasons:",
        "",
        "      - the cache is empty after a deploy, so the first request always goes to the origin server;",
        "      - later requests are served from the cache.",
      ].join("\n"),
    );
    expect(
      extractRoughdraftReviewIndex(updated).items.find(
        (item) => item.id === "c2",
      )?.text,
    ).toBe(message);
  });

  it("appends a reply to YAML endmatter without adding inline reply markup", () => {
    const markdown = [
      "# Plan",
      "",
      "Keep {==this claim==}{>>Needs proof<<}{#c1} as written.",
      "",
      "---",
      "workflow:",
      "  owner: editorial",
      "comments:",
      "  c1:",
      "    by: user",
      '    at: "2026-04-28T12:00:00.000Z"',
      "",
    ].join("\n");

    const updated = appendRoughdraftReply(markdown, {
      parentId: "c1",
      id: "c2",
      author: "AI",
      at: "2026-04-28T12:10:00.000Z",
      message: "Added a citation in the next paragraph.",
    });

    expect(updated).not.toContain("{>>Added a citation");
    expect(updated).toContain("workflow:\n  owner: editorial");
    expect(updated).toContain("body: Added a citation in the next paragraph.");
    expect(extractRoughdraftReviewIndex(updated).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "c2",
          kind: "reply",
          parentId: "c1",
        }),
      ]),
    );
  });

  it("appends a document-level comment to YAML endmatter with the next comment id", () => {
    const output = appendRoughdraftDocumentComment(
      [
        "# Draft",
        "",
        "Needs {==support==}{>>Add a source<<}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "workflow:",
        "  owner: editorial",
        "",
      ].join("\n"),
      {
        message: "Please address the risk section.",
        author: "user",
        at: "2026-05-24T12:00:00.000Z",
      },
    );

    expect(output).toContain("workflow:\n  owner: editorial");
    expect(output).toContain("  c2:");
    expect(output).toContain("    body: Please address the risk section.");
    expect(output).toContain("    by: user");
    expect(output).toContain("    at: 2026-05-24T12:00:00.000Z");
  });

  it("rejects reply text that would close CriticMarkup early", () => {
    const markdown =
      '{>>Needs proof<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}\n';

    expect(() =>
      appendRoughdraftReply(markdown, {
        parentId: "c1",
        id: "c2",
        author: "AI",
        at: "2026-04-28T12:10:00.000Z",
        message: "This closes early <<} and corrupts the thread.",
      }),
    ).toThrow(/CriticMarkup close delimiter/);
  });

  it("marks a target resolved without changing unrelated markup", () => {
    const markdown =
      'Add {++one example++}{id="s1" by="AI" at="2026-04-28T12:05:00.000Z"} and keep {>>open question<<}{id="c1" by="user" at="2026-04-28T12:06:00.000Z"}.\n';

    const updated = markRoughdraftResolved(markdown, {
      targetId: "s1",
      summary: "Accepted in draft.",
    });

    expect(updated).toBe(
      'Add {++one example++}{id="s1" by="AI" at="2026-04-28T12:05:00.000Z" status="resolved" resolved="Accepted in draft."} and keep {>>open question<<}{id="c1" by="user" at="2026-04-28T12:06:00.000Z"}.\n',
    );
  });

  it("marks an endmatter-backed target resolved in YAML", () => {
    const markdown = [
      "Add {++one example++}{#s1}.",
      "",
      "---",
      "workflow:",
      "  owner: editorial",
      "suggestions:",
      "  s1:",
      "    by: AI",
      '    at: "2026-04-28T12:05:00.000Z"',
      "",
    ].join("\n");

    const updated = markRoughdraftResolved(markdown, {
      targetId: "s1",
      summary: "Accepted in draft.",
    });

    expect(updated).toContain("status: resolved");
    expect(updated).toContain("resolved: Accepted in draft.");
    expect(updated).toContain("workflow:\n  owner: editorial");
    expect(extractRoughdraftReviewIndex(updated).items[0]).toMatchObject({
      id: "s1",
      status: "resolved",
    });
  });
});

describe("comment intent", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      fileURLToPath(
        new URL(
          "../../../docs/spec/fixtures/ask-intent-with-multiline-reply.json",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  ) as {
    source: { markdown: string };
    comments: Array<{ id: string; body: string; intent?: string }>;
  };

  function withIntent(intent: string, extra: string[] = []): string {
    return [
      "Cold start takes {==four seconds==}{>>Why?<<}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      '    at: "2026-10-18T12:00:00.000Z"',
      `    intent: ${intent}`,
      ...extra,
      "",
    ].join("\n");
  }

  it("exposes a known intent on the root comment of the spec fixture", () => {
    const index = extractRoughdraftReviewIndex(fixture.source.markdown);

    expect(index.diagnostics).toEqual([]);
    expect(index.items.find((item) => item.id === "c3")).toMatchObject({
      kind: "comment",
      intent: "ask",
      anchorText: "about four seconds",
    });
  });

  it("reads a multiline YAML block-scalar reply body verbatim", () => {
    const index = extractRoughdraftReviewIndex(fixture.source.markdown);
    const expected = fixture.comments.find((comment) => comment.id === "c4");

    expect(index.items.find((item) => item.id === "c4")).toMatchObject({
      kind: "reply",
      parentId: "c3",
      text: expected?.body,
    });
  });

  it("treats a comment without intent as having no intent", () => {
    const index = extractRoughdraftReviewIndex(
      'Hi {==there==}{>>Note<<}{#c1}.\n\n---\ncomments:\n  c1:\n    by: user\n    at: "2026-10-18T12:00:00.000Z"\n',
    );

    expect(index.items[0]).not.toHaveProperty("intent");
  });

  it("warns about an unknown intent value and degrades it to a plain comment", () => {
    const markdown = withIntent("shout");
    const result = validateRoughdraftMarkdown(markdown);

    expect(result.ok).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "unknown-intent",
    ]);
    expect(extractRoughdraftReviewIndex(markdown).items[0]).not.toHaveProperty(
      "intent",
    );
  });

  it("warns about and ignores intent on a reply", () => {
    const markdown = withIntent("ask", [
      "  c2:",
      "    body: Because of the cache.",
      "    by: AI",
      '    at: "2026-10-18T12:00:20.000Z"',
      "    re: c1",
      "    intent: change",
    ]);

    expect(codes(markdown)).toEqual(["ignored-intent"]);
    const reply = extractRoughdraftReviewIndex(markdown).items.find(
      (item) => item.id === "c2",
    );
    expect(reply).not.toHaveProperty("intent");
  });

  it("reads intent from older inline attribute metadata", () => {
    const index = extractRoughdraftReviewIndex(
      'Fix {==this==}{>>Please tighten<<}{id="c1" by="user" at="2026-10-18T12:00:00.000Z" intent="change"}.\n',
    );

    expect(index.diagnostics).toEqual([]);
    expect(index.items[0]).toMatchObject({ id: "c1", intent: "change" });
  });

  it("preserves intent and round-trips a multiline reply when appending and resolving", () => {
    const message = "Two parts:\n- warm-up\n- `model.load()`\n\nThat's it.";
    const replied = appendRoughdraftReply(withIntent("ask"), {
      parentId: "c1",
      message,
      author: "AI",
      at: "2026-10-18T12:01:00.000Z",
    });
    const resolved = markRoughdraftResolved(replied, { targetId: "c1" });

    expect(resolved).toContain("    intent: ask\n");
    expect(resolved).toContain("    body: |-\n      Two parts:\n");
    expect(validateRoughdraftMarkdown(resolved).diagnostics).toEqual([]);
    const items = extractRoughdraftReviewIndex(resolved).items;
    expect(items.find((item) => item.id === "c1")).toMatchObject({
      intent: "ask",
      status: "resolved",
    });
    expect(items.find((item) => item.id === "c2")).toMatchObject({
      parentId: "c1",
      text: message,
    });
  });

  it("appends a reply to an endmatter-only document comment inside the endmatter", () => {
    const markdown = appendRoughdraftDocumentComment("# Draft\n", {
      message: "Overall: shorter please.",
      author: "user",
      at: "2026-10-18T12:00:00.000Z",
    });

    const replied = appendRoughdraftReply(markdown, {
      parentId: "c1",
      message: "Will do.",
      at: "2026-10-18T12:01:00.000Z",
    });

    expect(replied.startsWith("# Draft\n\n---\n")).toBe(true);
    expect(replied).not.toContain("{>>");
    expect(extractRoughdraftReviewIndex(replied).items).toMatchObject([
      { id: "c1", kind: "comment" },
      { id: "c2", kind: "reply", parentId: "c1", text: "Will do." },
    ]);
  });
});
