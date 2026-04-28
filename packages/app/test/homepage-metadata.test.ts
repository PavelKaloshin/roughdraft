import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const indexHtmlPath = resolve("index.html");
const previewImageUrl = "https://roughdraft.page/sneak-peek.png";
const pageTitle = "Roughdraft - Markdown reviews for coding agents";
const pageDescription =
  "A local-first Markdown review app for commenting, suggesting edits, and collaborating with your coding agent.";

function readIndexDocument() {
  return new DOMParser().parseFromString(
    readFileSync(indexHtmlPath, "utf8"),
    "text/html",
  );
}

function metaContent(
  document: Document,
  selector: `meta[${string}]`,
): string | null {
  return document.querySelector(selector)?.getAttribute("content") ?? null;
}

describe("homepage metadata", () => {
  it("uses the homepage screenshot for social previews", () => {
    const document = readIndexDocument();

    expect(document.querySelector("title")?.textContent).toBe(pageTitle);
    expect(metaContent(document, 'meta[name="description"]')).toBe(
      pageDescription,
    );
    expect(
      document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
    ).toBe("https://roughdraft.page/");

    expect(metaContent(document, 'meta[property="og:title"]')).toBe(pageTitle);
    expect(metaContent(document, 'meta[property="og:description"]')).toBe(
      pageDescription,
    );
    expect(metaContent(document, 'meta[property="og:type"]')).toBe("website");
    expect(metaContent(document, 'meta[property="og:url"]')).toBe(
      "https://roughdraft.page/",
    );
    expect(metaContent(document, 'meta[property="og:image"]')).toBe(
      previewImageUrl,
    );
    expect(metaContent(document, 'meta[property="og:image:alt"]')).toBe(
      "Roughdraft markdown review workspace",
    );
    expect(metaContent(document, 'meta[property="og:image:width"]')).toBe(
      "3456",
    );
    expect(metaContent(document, 'meta[property="og:image:height"]')).toBe(
      "2234",
    );

    expect(metaContent(document, 'meta[name="twitter:card"]')).toBe(
      "summary_large_image",
    );
    expect(metaContent(document, 'meta[name="twitter:title"]')).toBe(pageTitle);
    expect(metaContent(document, 'meta[name="twitter:description"]')).toBe(
      pageDescription,
    );
    expect(metaContent(document, 'meta[name="twitter:image"]')).toBe(
      previewImageUrl,
    );
    expect(metaContent(document, 'meta[name="twitter:image:alt"]')).toBe(
      "Roughdraft markdown review workspace",
    );
  });
});
