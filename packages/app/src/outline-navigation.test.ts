import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractMarkdownOutline } from "./markdown-outline";
import {
  createOutlineJumpRequest,
  findOutlineHeadingElement,
  scrollToOutlineHeading,
} from "./outline-navigation";

function renderDocument(html: string): HTMLElement {
  const container = document.createElement("div");
  // Mirrors the real nesting: the card wraps a couple of layout divs around
  // the ProseMirror element that actually holds the block nodes.
  container.innerHTML = `<div class="shell"><div class="main"><div class="ProseMirror">${html}</div></div></div>`;
  document.body.replaceChildren(container);
  return container;
}

function requestFor(markdown: string, headingIndex: number) {
  const heading = extractMarkdownOutline(markdown)[headingIndex];
  if (!heading) throw new Error(`No heading ${headingIndex} in test markdown`);
  return createOutlineJumpRequest(heading, 1);
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("findOutlineHeadingElement", () => {
  it("finds the heading at the outline position through layout wrappers", () => {
    const container = renderDocument(
      "<h1>Title</h1><p>Body</p><h2>Section</h2><h2>Other</h2>",
    );
    const markdown = "# Title\n\n Body\n\n## Section\n\n## Other\n";

    expect(
      findOutlineHeadingElement(container, requestFor(markdown, 2))
        ?.textContent,
    ).toBe("Other");
  });

  it("distinguishes two headings with the same text by position", () => {
    const container = renderDocument(
      "<h2>Notes</h2><p>First</p><h2>Notes</h2><p>Second</p>",
    );
    const markdown = "## Notes\n\nFirst\n\n## Notes\n\nSecond\n";

    const second = findOutlineHeadingElement(
      container,
      requestFor(markdown, 1),
    );
    expect(second?.nextElementSibling?.textContent).toBe("Second");
  });

  it("ignores headings nested inside a blockquote", () => {
    const container = renderDocument(
      "<h1>Top</h1><blockquote><h1>Quoted</h1></blockquote><h2>Bottom</h2>",
    );
    const markdown = "# Top\n\n> # Quoted\n\n## Bottom\n";

    expect(
      findOutlineHeadingElement(container, requestFor(markdown, 1))
        ?.textContent,
    ).toBe("Bottom");
  });

  it("falls back to matching text when rendered headings shift position", () => {
    const container = renderDocument("<p>Extra block</p><h2>Section</h2>");

    expect(
      findOutlineHeadingElement(container, {
        headingIndex: 4,
        level: 2,
        text: "Section",
      })?.textContent,
    ).toBe("Section");
  });

  it("returns null when the document has no headings yet", () => {
    const container = renderDocument("<p>Still loading</p>");

    expect(
      findOutlineHeadingElement(container, {
        headingIndex: 0,
        level: 1,
        text: "Title",
      }),
    ).toBeNull();
  });
});

describe("scrollToOutlineHeading", () => {
  it("scrolls the matched heading into view", () => {
    const container = renderDocument("<h1>Title</h1><h2>Section</h2>");
    const scrollIntoView = vi.fn();
    for (const element of Array.from(container.getElementsByTagName("h2"))) {
      element.scrollIntoView = scrollIntoView;
    }

    expect(
      scrollToOutlineHeading(container, {
        headingIndex: 1,
        level: 2,
        text: "Section",
      }),
    ).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("reports failure so the caller can retry on the next frame", () => {
    const container = renderDocument("<p>Not rendered yet</p>");

    expect(
      scrollToOutlineHeading(container, {
        headingIndex: 0,
        level: 1,
        text: "Title",
      }),
    ).toBe(false);
  });
});
