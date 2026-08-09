import type { OutlineHeading } from "./markdown-outline";

/**
 * A request to move the open document to one outline heading. `requestId` makes
 * repeat clicks on the same heading distinct so effects re-run.
 */
export interface OutlineJumpRequest {
  headingIndex: number;
  level: number;
  text: string;
  line: number;
  requestId: number;
}

export function createOutlineJumpRequest(
  heading: OutlineHeading,
  requestId: number,
): OutlineJumpRequest {
  return {
    headingIndex: heading.index,
    level: heading.level,
    text: heading.text,
    line: heading.line,
    requestId,
  };
}

const HEADING_TAG_NAMES = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

function normalizeHeadingText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Top-level rendered headings, in document order.
 *
 * Only direct children of a block container count, which mirrors
 * `extractMarkdownOutline`: both skip headings nested inside blockquotes, list
 * items, and other wrappers, so heading N in the outline is heading N here.
 */
function topLevelHeadingElements(root: ParentNode): HTMLElement[] {
  const headings: HTMLElement[] = [];

  for (const child of Array.from(root.children)) {
    if (HEADING_TAG_NAMES.has(child.tagName)) {
      headings.push(child as HTMLElement);
      continue;
    }
    // The editor DOM sits a couple of wrappers below the card, so descend
    // until the level that actually holds block nodes is found.
    if (headings.length === 0 && child.children.length > 0) {
      const nested = topLevelHeadingElements(child);
      if (nested.length > 0) return nested;
    }
  }

  return headings;
}

/**
 * Find the rendered heading a jump request points at.
 *
 * Position is the primary key because it is exact for duplicate titles. Text
 * matching is the fallback for the rare document whose rendered heading count
 * drifts from the parsed outline (for example a heading inside a protected raw
 * HTML block), so a click still lands somewhere sensible.
 */
export function findOutlineHeadingElement(
  root: ParentNode,
  request: Pick<OutlineJumpRequest, "headingIndex" | "level" | "text">,
): HTMLElement | null {
  const headings = topLevelHeadingElements(root);
  if (headings.length === 0) return null;

  const byPosition = headings[request.headingIndex];
  if (
    byPosition &&
    byPosition.tagName === `H${request.level}` &&
    (request.text === "" ||
      normalizeHeadingText(byPosition.textContent ?? "") === request.text)
  ) {
    return byPosition;
  }

  if (request.text !== "") {
    const byText = headings.find(
      (heading) =>
        heading.tagName === `H${request.level}` &&
        normalizeHeadingText(heading.textContent ?? "") === request.text,
    );
    if (byText) return byText;
  }

  return byPosition ?? null;
}

/**
 * Scroll the open document to an outline heading. Returns false when the
 * heading is not rendered yet, so the caller can retry on the next frame.
 */
export function scrollToOutlineHeading(
  root: ParentNode,
  request: Pick<OutlineJumpRequest, "headingIndex" | "level" | "text">,
): boolean {
  const target = findOutlineHeadingElement(root, request);
  if (!target) return false;

  target.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}
