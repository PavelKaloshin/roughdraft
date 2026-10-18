import createDOMPurify, { type DOMPurify } from "dompurify";
import { Marked } from "marked";
import { useMemo } from "react";
import { cn } from "./lib/utils";

/**
 * Comment bodies are plain text in the file but often carry Markdown (agent
 * answers with lists, code and links). They render through a dedicated
 * `marked` instance — not the document renderer, so no CriticMarkup, math or
 * Mermaid — and every result is sanitized before it reaches the DOM.
 */
const commentMarked = new Marked({ gfm: true, breaks: true, async: false });

const ALLOWED_TAGS = [
  "a",
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "del",
  "s",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "input",
];

let purifier: DOMPurify | null = null;

function getPurifier(): DOMPurify | null {
  if (purifier) return purifier;
  if (typeof window === "undefined") return null;
  purifier = createDOMPurify(window);
  purifier.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    if (node.tagName === "INPUT") {
      // GFM task-list checkboxes: display only.
      if (node.getAttribute("type") !== "checkbox") {
        node.remove();
        return;
      }
      node.setAttribute("disabled", "");
    }
  });
  return purifier;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderCommentMarkdown(markdown: string): string {
  const html = commentMarked.parse(markdown) as string;
  const sanitizer = getPurifier();
  if (!sanitizer) return `<p>${escapeHtml(markdown)}</p>`;
  return sanitizer.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "title", "type", "checked", "disabled", "start"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/|\.{0,2}\/)/i,
  });
}

export function CommentMarkdown({
  content,
  className,
  testId,
}: {
  content: string;
  className?: string;
  testId?: string;
}) {
  const html = useMemo(() => renderCommentMarkdown(content), [content]);

  return (
    <div
      data-testid={testId}
      data-comment-markdown="true"
      className={cn("comment-markdown", className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
