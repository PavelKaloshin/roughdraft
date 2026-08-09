import { describe, expect, it } from "vitest";
import {
  extractMarkdownOutline,
  outlineBaseLevel,
  outlineHeadingsEqual,
} from "./markdown-outline";

describe("extractMarkdownOutline", () => {
  it("lists headings with level, text, and source line", () => {
    const outline = extractMarkdownOutline(
      ["# Title", "", "Intro text.", "", "## Section", "", "### Detail"].join(
        "\n",
      ),
    );

    expect(outline).toEqual([
      { index: 0, level: 1, text: "Title", line: 1 },
      { index: 1, level: 2, text: "Section", line: 5 },
      { index: 2, level: 3, text: "Detail", line: 7 },
    ]);
  });

  it("ignores '#' lines inside fenced code blocks", () => {
    const outline = extractMarkdownOutline(
      [
        "# Real heading",
        "",
        "```sh",
        "# not a heading",
        "```",
        "",
        "## Also real",
      ].join("\n"),
    );

    expect(outline.map((heading) => heading.text)).toEqual([
      "Real heading",
      "Also real",
    ]);
  });

  it("counts frontmatter lines toward heading line numbers", () => {
    const outline = extractMarkdownOutline(
      ["---", "title: Plan", "---", "", "# Goals"].join("\n"),
    );

    expect(outline).toEqual([{ index: 0, level: 1, text: "Goals", line: 5 }]);
  });

  it("keeps inline formatting out of the display text", () => {
    const outline = extractMarkdownOutline(
      "## The **bold** `code` [link](https://example.com) heading\n",
    );

    expect(outline[0]?.text).toBe("The bold code link heading");
  });

  it("resolves CriticMarkup in heading text to the reviewed result", () => {
    const outline = extractMarkdownOutline(
      [
        "# {~~Old~>New~~} plan",
        "",
        "## Keep {--dropped --}this{>>note<<}",
        "",
        "### {++Added++} section {#h3}",
      ].join("\n"),
    );

    expect(outline.map((heading) => heading.text)).toEqual([
      "New plan",
      "Keep this",
      "Added section",
    ]);
  });

  it("indexes headings by document position so empty titles still count", () => {
    const outline = extractMarkdownOutline(
      ["# One", "", "##", "", "# Two"].join("\n"),
    );

    expect(outline.map((heading) => [heading.index, heading.text])).toEqual([
      [0, "One"],
      [1, ""],
      [2, "Two"],
    ]);
  });

  it("skips headings nested inside blockquotes and list items", () => {
    const outline = extractMarkdownOutline(
      ["# Top", "", "> # Quoted", "", "- # Listed", "", "## Bottom"].join("\n"),
    );

    expect(outline.map((heading) => heading.text)).toEqual(["Top", "Bottom"]);
  });

  it("includes setext headings", () => {
    const outline = extractMarkdownOutline(
      ["Title", "=====", "", "Section", "-------"].join("\n"),
    );

    expect(outline).toEqual([
      { index: 0, level: 1, text: "Title", line: 1 },
      { index: 1, level: 2, text: "Section", line: 4 },
    ]);
  });

  it("has no outline for an empty document", () => {
    expect(extractMarkdownOutline("")).toEqual([]);
    expect(extractMarkdownOutline("Just a paragraph.\n")).toEqual([]);
  });
});

describe("outlineHeadingsEqual", () => {
  it("treats equal-content outlines as unchanged", () => {
    const markdown = "# One\n\n## Two\n";
    expect(
      outlineHeadingsEqual(
        extractMarkdownOutline(markdown),
        extractMarkdownOutline(markdown),
      ),
    ).toBe(true);
  });

  it("detects a renamed heading", () => {
    expect(
      outlineHeadingsEqual(
        extractMarkdownOutline("# One\n"),
        extractMarkdownOutline("# Uno\n"),
      ),
    ).toBe(false);
  });

  it("detects a heading added to the document", () => {
    expect(
      outlineHeadingsEqual(
        extractMarkdownOutline("# One\n"),
        extractMarkdownOutline("# One\n\n## Two\n"),
      ),
    ).toBe(false);
  });
});

describe("outlineBaseLevel", () => {
  it("reports the shallowest heading level", () => {
    expect(
      outlineBaseLevel(extractMarkdownOutline("## Two\n\n### Three\n")),
    ).toBe(2);
  });

  it("falls back to 6 for an empty outline", () => {
    expect(outlineBaseLevel([])).toBe(6);
  });
});
