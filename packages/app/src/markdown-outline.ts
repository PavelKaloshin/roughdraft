import { marked } from "marked";
import type { Tokens } from "marked";
import { splitYamlDocumentMetadata } from "./markdown";

export interface OutlineHeading {
  /**
   * Zero-based position among the document's top-level headings. This is the
   * handle used to find the matching rendered heading element, so it counts
   * every heading the editor renders — including ones with empty text.
   */
  index: number;
  /** Heading level, 1-6. */
  level: number;
  /** Display text with CriticMarkup and inline markdown syntax removed. */
  text: string;
  /** 1-based line of the heading in the full markdown source. */
  line: number;
}

/**
 * Remove CriticMarkup review markers so a heading under review reads as the
 * text it will become: insertions and highlights keep their content,
 * deletions and comments drop out, substitutions keep the replacement.
 */
function stripCriticMarkup(value: string): string {
  return value
    .replace(/\{>>[\s\S]*?<<\}/g, "")
    .replace(/\{~~([\s\S]*?)~>([\s\S]*?)~~\}/g, "$2")
    .replace(/\{--[\s\S]*?--\}/g, "")
    .replace(/\{\+\+([\s\S]*?)\+\+\}/g, "$1")
    .replace(/\{==([\s\S]*?)==\}/g, "$1")
    .replace(/\{#[^{}\s]+\}/g, "");
}

/**
 * Flatten inline markdown to plain text. The outline is a navigation list, so
 * emphasis, code spans, links, and inline anchors are noise there.
 */
function stripInlineMarkdown(value: string): string {
  return value
    .replace(/<[^<>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*\*|___)([\s\S]*?)\1/g, "$2")
    .replace(/(\*\*|__)([\s\S]*?)\1/g, "$2")
    .replace(/(\*|_)([\s\S]*?)\1/g, "$2")
    .replace(/~~([\s\S]*?)~~/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function formatOutlineHeadingText(rawHeadingText: string): string {
  return stripInlineMarkdown(stripCriticMarkup(rawHeadingText));
}

function countNewlines(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") count += 1;
  }
  return count;
}

/**
 * List the top-level headings of a markdown document in document order.
 *
 * The document is split the same way the editor splits it (YAML frontmatter and
 * review endmatter first, then `marked` over the body), so heading positions
 * line up 1:1 with the headings the rich-text editor renders. Headings nested
 * inside blockquotes, list items, or HTML blocks are intentionally left out:
 * they are not top-level document structure, and excluding them keeps the
 * index-to-element mapping exact.
 */
export function extractMarkdownOutline(markdown: string): OutlineHeading[] {
  if (!markdown.trim()) return [];

  const { frontmatter, body } = splitYamlDocumentMetadata(markdown);
  const frontmatterLines = frontmatter ? countNewlines(frontmatter) : 0;

  let tokens: ReturnType<typeof marked.lexer>;
  try {
    tokens = marked.lexer(body);
  } catch {
    // A malformed document must not break the sidebar; it just has no outline.
    return [];
  }

  const headings: OutlineHeading[] = [];
  let lineOffset = frontmatterLines;

  for (const token of tokens) {
    if (token.type === "heading") {
      const heading = token as Tokens.Heading;
      headings.push({
        index: headings.length,
        level: Math.min(Math.max(heading.depth, 1), 6),
        text: formatOutlineHeadingText(heading.text ?? ""),
        line: lineOffset + 1,
      });
    }

    lineOffset += countNewlines(token.raw ?? "");
  }

  return headings;
}

export function outlineHeadingsEqual(
  left: OutlineHeading[],
  right: OutlineHeading[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  return left.every((heading, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      heading.level === other.level &&
      heading.text === other.text &&
      heading.line === other.line
    );
  });
}

/** Smallest heading level in the list, used to left-align shallow outlines. */
export function outlineBaseLevel(headings: OutlineHeading[]): number {
  return headings.reduce(
    (smallest, heading) => Math.min(smallest, heading.level),
    6,
  );
}
