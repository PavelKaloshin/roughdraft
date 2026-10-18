import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Transform } from "@tiptap/pm/transform";

export interface ExternalContentChange {
  tr: Transaction;
  /** Range of the replacement content in the transaction's resulting doc. */
  insertedFrom: number;
  insertedTo: number;
}

export interface ExternalContentTransactionOptions {
  /**
   * Comment ids that exist only in the editor (an open, unsubmitted comment
   * draft). Their marks are ignored while diffing, so they do not widen the
   * changed range, and they survive wherever the external change did not land.
   */
  ignoredCommentIds?: Iterable<string>;
}

function stripCommentIds(
  doc: ProseMirrorNode,
  commentIds: ReadonlySet<string>,
): ProseMirrorNode {
  const markType = doc.type.schema.marks.commentRef;
  if (!markType || commentIds.size === 0) return doc;

  const transform = new Transform(doc);
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type !== markType) continue;
      const ids = Array.isArray(mark.attrs.commentIds)
        ? (mark.attrs.commentIds as string[])
        : [];
      if (!ids.some((id) => commentIds.has(id))) continue;

      const from = pos;
      const to = pos + node.nodeSize;
      const nextIds = ids.filter((id) => !commentIds.has(id));
      transform.removeMark(from, to, markType);
      if (nextIds.length > 0) {
        transform.addMark(from, to, markType.create({ commentIds: nextIds }));
      }
    }
  });

  return transform.doc;
}

/**
 * TipTap's TrailingNode keeps an empty paragraph after a final list, table or
 * fence. A freshly parsed doc lacks it, which would make the diff end at the
 * very bottom of the document. Mirror the editor's trailing paragraph instead.
 */
function matchTrailingNode(
  currentDoc: ProseMirrorNode,
  nextDoc: ProseMirrorNode,
): ProseMirrorNode {
  const defaultType = nextDoc.type.contentMatch.defaultType;
  const currentLast = currentDoc.lastChild;
  const nextLast = nextDoc.lastChild;
  if (
    !defaultType ||
    !currentLast ||
    currentLast.type !== defaultType ||
    currentLast.content.size !== 0 ||
    nextLast?.type === defaultType
  ) {
    return nextDoc;
  }

  return nextDoc.copy(nextDoc.content.addToEnd(defaultType.create()));
}

/**
 * Builds the smallest single-step transaction that turns the editor's doc into
 * `nextDoc`, so an external file change updates the document in place: nodes
 * outside the changed range keep their identity (and their DOM), and the
 * selection maps through the step instead of resetting.
 *
 * Returns null when the docs are already equal (for example an endmatter-only
 * change, such as a new reply in a comment thread).
 */
export function buildExternalContentTransaction(
  state: EditorState,
  nextDoc: ProseMirrorNode,
  options: ExternalContentTransactionOptions = {},
): ExternalContentChange | null {
  const ignoredCommentIds = new Set(options.ignoredCommentIds ?? []);
  const currentDoc = state.doc;
  const diffBase = stripCommentIds(currentDoc, ignoredCommentIds);
  const target = matchTrailingNode(diffBase, nextDoc);

  const start = diffBase.content.findDiffStart(target.content);
  if (start == null) return null;

  const end = diffBase.content.findDiffEnd(target.content);
  let endA = end?.a ?? diffBase.content.size;
  let endB = end?.b ?? target.content.size;
  // findDiffEnd can overlap findDiffStart when the change repeats adjacent
  // content ("aa" -> "aaa"); push both ends forward by the overlap.
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }

  let tr = state.tr;
  try {
    tr.replace(start, endA, target.slice(start, endB));
  } catch {
    tr = state.tr;
  }

  let insertedFrom = start;
  let insertedTo = endB;
  if (
    !tr.docChanged ||
    !stripCommentIds(tr.doc, ignoredCommentIds).eq(target)
  ) {
    // The minimal replace could not be fitted exactly (rare schema edge
    // cases). Fall back to replacing the whole body; the selection still maps.
    tr = state.tr.replaceWith(0, currentDoc.content.size, target.content);
    insertedFrom = 0;
    insertedTo = tr.doc.content.size;
  }

  tr.setMeta("addToHistory", false);
  // TipTap: do not emit `update`, so the change is not treated as a user edit
  // (no dirty state, no autosave).
  tr.setMeta("preventUpdate", true);

  return { tr, insertedFrom, insertedTo };
}
