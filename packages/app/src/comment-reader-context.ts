import { createContext, useContext } from "react";

/**
 * Lets a comment card open the thread reader dialog, which lives in PageCard
 * next to the comment state. Absent (null) where no reader exists, e.g. the
 * homepage demo outside a page, so cards hide the Open action.
 */
export interface CommentReaderContextValue {
  /** Whether `commentId` belongs to a comment thread the reader can show. */
  canOpen: (commentId: string) => boolean;
  /** Opens the reader on the thread of `commentId`, scrolled to it. */
  open: (commentId: string) => void;
}

export const CommentReaderContext =
  createContext<CommentReaderContextValue | null>(null);

export function useCommentReader() {
  return useContext(CommentReaderContext);
}

/** Escapes a value for a double-quoted CSS attribute selector. */
export function escapeAttributeValue(value: string) {
  return value.replace(/["\\]/g, "\\$&");
}

/** Bodies longer than this clamp in the rail behind "Read more". */
const LONG_COMMENT_CHARACTERS = 400;
const LONG_COMMENT_LINES = 6;

/**
 * Rendered height isn't known before layout (and jsdom has none), so the
 * clamp is decided from the source: many characters or many lines.
 */
export function isLongCommentBody(content: string) {
  const trimmed = content.trim();
  return (
    trimmed.length > LONG_COMMENT_CHARACTERS ||
    trimmed.split("\n").length > LONG_COMMENT_LINES
  );
}
