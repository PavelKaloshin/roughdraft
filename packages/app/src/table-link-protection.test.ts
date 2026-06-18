import { describe, expect, it } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import {
  protectRichTextRoundTripMarkdown,
  rawMarkdownBlockAttribute,
} from "./markdown";

const HEADER = `| ID | Metric | Notes |
|----|--------|-------|`;

function tableCount(markdown: string): number {
  const { doc } = criticMarkdownToEditorState(markdown);
  let count = 0;
  const visit = (node: { type?: string; content?: unknown[] }) => {
    if (node.type === "table") count += 1;
    for (const child of (node.content ?? []) as (typeof node)[]) visit(child);
  };
  visit(doc as never);
  return count;
}

describe("table rows with multiple code-span links", () => {
  it("renders a table when a row has two links (regression)", () => {
    // Two code-span links in one row used to false-trigger pipe protection,
    // wrapping the whole table in a raw block so it vanished from rich text.
    const markdown = `${HEADER}
| M-1 | x | see ([\`M-16\`](06-metrics.md#M-16)) and ([\`ADR-6\`](decisions/0006.md)) |
`;
    expect(tableCount(markdown)).toBe(1);
  });

  it("does not protect a table whose code spans merely sit on either side of a cell pipe", () => {
    const markdown = `${HEADER}
| M-1 | x | a (\`one\`) | b (\`two\`) |
`;
    expect(protectRichTextRoundTripMarkdown(markdown)).not.toContain(
      rawMarkdownBlockAttribute,
    );
  });

  it("still protects a table whose code span genuinely contains a pipe", () => {
    // A literal `|` inside a code span would confuse the GFM table parser, so
    // the table must stay protected as a raw block.
    const markdown = `${HEADER}
| M-1 | x | run \`a | b\` here |
`;
    expect(protectRichTextRoundTripMarkdown(markdown)).toContain(
      rawMarkdownBlockAttribute,
    );
  });
});
