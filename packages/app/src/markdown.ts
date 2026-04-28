import { tables, taskListItems } from "@joplin/turndown-plugin-gfm";
import { marked } from "marked";
import TurndownService from "turndown";

export interface MarkdownOptions {
  resolveFileUrl?: (path: string) => string | null;
}

export interface YamlFrontmatterSplit {
  frontmatter: string | null;
  body: string;
}

function isExternalUrl(path: string): boolean {
  return /^(?:[a-z]+:)?\/\//i.test(path) || path.startsWith("data:");
}

function isInPageAnchor(path: string): boolean {
  return path.startsWith("#");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeMarkdownPath(path: string): string {
  if (path.startsWith("./") || path.startsWith("../")) return path;
  return `./${path.replace(/^\/+/, "")}`;
}

function resolveRenderedUrl(
  path: string,
  resolveFileUrl?: MarkdownOptions["resolveFileUrl"],
) {
  if (isExternalUrl(path) || isInPageAnchor(path)) return path;
  return resolveFileUrl?.(path) ?? path;
}

function isYamlFrontmatterDelimiter(line: string): boolean {
  return /^(?:---|\.\.\.)[ \t]*$/.test(line.replace(/\r$/, ""));
}

export function splitYamlFrontmatter(markdown: string): YamlFrontmatterSplit {
  const openingDelimiter = markdown.match(/^---[ \t]*(?:\r\n|\n)/);
  if (!openingDelimiter) return { frontmatter: null, body: markdown };

  let lineStart = openingDelimiter[0].length;

  while (lineStart < markdown.length) {
    const nextLineBreak = markdown.indexOf("\n", lineStart);
    const lineEnd = nextLineBreak === -1 ? markdown.length : nextLineBreak + 1;
    const line = markdown.slice(
      lineStart,
      nextLineBreak === -1 ? lineEnd : lineEnd - 1,
    );

    if (isYamlFrontmatterDelimiter(line)) {
      let bodyStart = lineEnd;

      while (bodyStart < markdown.length) {
        const blankLineBreak = markdown.indexOf("\n", bodyStart);
        const blankLineEnd =
          blankLineBreak === -1 ? markdown.length : blankLineBreak + 1;
        const blankLine = markdown.slice(
          bodyStart,
          blankLineBreak === -1 ? blankLineEnd : blankLineEnd - 1,
        );

        if (blankLine.replace(/\r$/, "").trim() !== "") break;
        bodyStart = blankLineEnd;
      }

      return {
        frontmatter: markdown.slice(0, bodyStart),
        body: markdown.slice(bodyStart),
      };
    }

    lineStart = lineEnd;
  }

  return { frontmatter: null, body: markdown };
}

export function prependYamlFrontmatter(
  markdown: string,
  frontmatter?: string | null,
): string {
  return frontmatter ? `${frontmatter}${markdown}` : markdown;
}

export function createMarkedRenderer(options?: MarkdownOptions) {
  const renderer = new marked.Renderer();
  const baseRenderer = new marked.Renderer();
  const resolveFileUrl = options?.resolveFileUrl;

  renderer.code = ({ text, lang, escaped }) => {
    const language = (lang || "").match(/\S+/)?.[0];
    const content = escaped ? text : escapeHtml(text);
    const classAttr = language
      ? ` class="language-${escapeHtml(language)}"`
      : "";

    return `<pre><code${classAttr}>${content}</code></pre>\n`;
  };

  renderer.link = function ({ href, title, tokens }) {
    const rawHref = href || "";
    const renderedHref = resolveRenderedUrl(rawHref, resolveFileUrl);
    const text = this.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const markdownSrcAttr = ` data-markdown-src="${escapeHtml(rawHref)}"`;
    const externalAttr =
      isExternalUrl(rawHref) && !rawHref.startsWith("mailto:")
        ? ' target="_blank" rel="noreferrer noopener"'
        : "";

    return `<a href="${escapeHtml(renderedHref)}"${titleAttr}${markdownSrcAttr}${externalAttr}>${text}</a>`;
  };

  renderer.image = ({ href, title, text }) => {
    const rawHref = href || "";
    const renderedHref = resolveRenderedUrl(rawHref, resolveFileUrl);
    const alt = text || "";
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const markdownSrcAttr = ` data-markdown-src="${escapeHtml(rawHref)}"`;

    return `<img src="${escapeHtml(renderedHref)}" alt="${escapeHtml(alt)}"${titleAttr}${markdownSrcAttr}>`;
  };

  renderer.list = function (token) {
    const hasTaskItems = token.items.some((item) => item.task);
    if (!hasTaskItems) {
      return baseRenderer.list.call(this, token);
    }

    const items = token.items
      .map((item) => {
        const checked = item.checked ? "true" : "false";
        const inner = this.parser.parse(item.tokens, false);
        return `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"${
          item.checked ? ' checked="checked"' : ""
        }><span></span></label><div>${inner}</div></li>`;
      })
      .join("");

    return `<ul data-type="taskList">${items}</ul>`;
  };

  return renderer;
}

export function createTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });

  service.use(tables as Parameters<TurndownService["use"]>[0]);
  service.use(taskListItems as Parameters<TurndownService["use"]>[0]);

  // We own the markdown parser and want stable round-trips without doubled escapes.
  service.escape = (value: string) => value;

  service.addRule("markdownAwareLinks", {
    filter: "a",
    replacement(content, node) {
      const element = node as HTMLAnchorElement;
      const href =
        element.getAttribute("data-markdown-src") ||
        element.getAttribute("href") ||
        "";
      const normalizedHref =
        isExternalUrl(href) || isInPageAnchor(href)
          ? href
          : normalizeMarkdownPath(href);
      return `[${content}](${normalizedHref})`;
    },
  });

  service.addRule("markdownAwareImages", {
    filter: "img",
    replacement(_content, node) {
      const element = node as HTMLImageElement;
      const src =
        element.getAttribute("data-markdown-src") ||
        element.getAttribute("src") ||
        "";
      const normalizedSrc = isExternalUrl(src)
        ? src
        : normalizeMarkdownPath(src);
      const alt = element.getAttribute("alt") || "";
      return `![${alt}](${normalizedSrc})`;
    },
  });

  return service;
}

const turndown = createTurndownService();

export function toMarkdown(html: string): string {
  return `${turndown.turndown(html).trimEnd()}\n`;
}

export function toHtml(markdown: string, options?: MarkdownOptions): string {
  return marked.parse(markdown, {
    async: false,
    gfm: true,
    renderer: createMarkedRenderer(options),
  }) as string;
}
