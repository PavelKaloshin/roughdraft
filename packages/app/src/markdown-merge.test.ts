import { describe, expect, it } from "vitest";
import { mergeMarkdown } from "./markdown-merge";

const base = [
  "# Plan",
  "",
  "First paragraph.",
  "",
  "Second paragraph.",
  "",
  "Third paragraph.",
  "",
].join("\n");

describe("mergeMarkdown", () => {
  it("keeps both sides when the user and the agent edit different paragraphs", () => {
    const mine = base.replace("First paragraph.", "First paragraph, edited.");
    const theirs = base.replace("Third paragraph.", "Third, by the agent.");

    expect(mergeMarkdown({ base, mine, theirs })).toEqual({
      status: "merged",
      markdown: base
        .replace("First paragraph.", "First paragraph, edited.")
        .replace("Third paragraph.", "Third, by the agent."),
    });
  });

  it("reports a conflict when both sides change the same paragraph differently", () => {
    const mine = base.replace("Second paragraph.", "Second, mine.");
    const theirs = base.replace("Second paragraph.", "Second, theirs.");

    expect(mergeMarkdown({ base, mine, theirs })).toEqual({
      status: "conflict",
    });
  });

  it("reports a conflict when both sides append at the end of the file", () => {
    const mine = `${base}\nLocal tail.\n`;
    const theirs = `${base}\nAgent tail.\n`;

    expect(mergeMarkdown({ base, mine, theirs })).toEqual({
      status: "conflict",
    });
  });

  it("treats the identical change on both sides as no conflict", () => {
    const edited = base.replace("Second paragraph.", "Same edit.");

    expect(
      mergeMarkdown({
        base,
        mine: `${edited}Local tail.\n`,
        theirs: edited,
      }),
    ).toEqual({ status: "merged", markdown: `${edited}Local tail.\n` });
  });

  it("merges an endmatter-only reply with a body edit", () => {
    const withEndmatter = `${base}\n---\ncomments:\n  c1:\n    by: pavel\n`;
    const mine = withEndmatter.replace("First paragraph.", "First, edited.");
    const theirs = `${withEndmatter}  c2:\n    body: Done.\n    by: AI\n    re: c1\n`;

    expect(mergeMarkdown({ base: withEndmatter, mine, theirs })).toEqual({
      status: "merged",
      markdown: `${mine}  c2:\n    body: Done.\n    by: AI\n    re: c1\n`,
    });
  });

  it("takes the other side wholesale when one side is unchanged", () => {
    const changed = base.replace("Second paragraph.", "Changed.");

    expect(mergeMarkdown({ base, mine: base, theirs: changed })).toEqual({
      status: "merged",
      markdown: changed,
    });
    expect(mergeMarkdown({ base, mine: changed, theirs: base })).toEqual({
      status: "merged",
      markdown: changed,
    });
  });
});
