import { describe, expect, it } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "../src/critic-markup";
import { toHtml } from "../src/markdown";

function roundTrip(input: string): string {
  const { doc, comments } = criticMarkdownToEditorState(input);
  return editorStateToCriticMarkdown(doc, comments);
}

describe("LaTeX math rendering", () => {
  it("renders inline $...$ as KaTeX with the source preserved", () => {
    const html = toHtml("Score is $x^2$ here.");
    expect(html).toContain("data-math-inline");
    expect(html).toContain('data-latex="x^2"');
    // KaTeX emits a `.katex` wrapper around the rendered formula.
    expect(html).toContain('class="katex"');
  });

  it("renders block $$...$$ as KaTeX", () => {
    const html = toHtml("$$\n\\sum_{n=1}^{N} w_n\n$$");
    expect(html).toContain("data-math-block");
    expect(html).toContain('class="katex');
  });

  it("does not treat a lone dollar sign as math", () => {
    const html = toHtml("It costs $5 today.");
    expect(html).not.toContain("data-math-inline");
    expect(html).toContain("$5");
  });
});

describe("LaTeX math round-trip", () => {
  it("round-trips an inline formula", () => {
    const input =
      "BLEU is $BP \\cdot \\exp(\\sum_{n=1}^{N} w_n \\ln p_n)$ overall.\n";
    expect(roundTrip(input)).toBe(input);
  });

  it("round-trips a standalone block formula", () => {
    const input = ["$$", "F = \\frac{2 P R}{P + R}", "$$", ""].join("\n");
    expect(roundTrip(input)).toBe(input);
  });
});
