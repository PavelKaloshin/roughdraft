import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { createContext } from "react";
import { createCriticComment, type CriticComment } from "./critic-markup";

// An open, unsubmitted comment draft lives only in the editor. When an
// external change (an agent's edit or reply) introduces a comment with the
// same id, the draft is re-keyed to a fresh id instead of being lost.

export interface CommentIdRename {
  from: string;
  to: string;
}

/**
 * Append-only list of draft re-keys made by the rich-text editor. Comment
 * lists move their local draft text, edit state, and composer mode along.
 */
export const CommentDraftRenamesContext = createContext<
  readonly CommentIdRename[]
>([]);

/** True when the incoming comment is the draft itself (already on disk). */
function isSameDraft(incoming: CriticComment, draft: CriticComment) {
  return (
    incoming.content.trim().length === 0 &&
    (incoming.parentCommentId ?? null) === (draft.parentCommentId ?? null) &&
    incoming.authorType === draft.authorType
  );
}

/**
 * Decides which open drafts survive an external change and under which id.
 * Drafts whose id the incoming comments claim get a fresh id that neither
 * side uses.
 */
export function planDraftsAcrossExternalChange(
  draftIds: readonly string[],
  currentComments: ReadonlyMap<string, CriticComment>,
  incomingComments: ReadonlyMap<string, CriticComment>,
): { drafts: Map<string, CriticComment>; renames: CommentIdRename[] } {
  const drafts = new Map<string, CriticComment>();
  const renames: CommentIdRename[] = [];
  const takenIds = new Set([
    ...currentComments.keys(),
    ...incomingComments.keys(),
  ]);

  for (const id of draftIds) {
    const draft = currentComments.get(id);
    if (!draft) continue;
    const incoming = incomingComments.get(id);
    if (!incoming) {
      drafts.set(id, draft);
      continue;
    }
    if (isSameDraft(incoming, draft)) continue;

    const nextId = createCriticComment(undefined, {
      existingComments: [...takenIds].map((takenId) => ({ id: takenId })),
    }).id;
    takenIds.add(nextId);
    renames.push({ from: id, to: nextId });
    drafts.set(nextId, { ...draft, id: nextId });
  }

  return { drafts, renames };
}

export function applyCommentIdRenames(
  id: string,
  renames: readonly CommentIdRename[],
): string {
  let next = id;
  for (const rename of renames) {
    if (rename.from === next) next = rename.to;
  }
  return next;
}

/** Moves the values stored under renamed keys to their new keys. */
export function rekeyRecord<T>(
  record: Record<string, T>,
  renames: readonly CommentIdRename[],
): Record<string, T> {
  let next = record;
  for (const { from, to } of renames) {
    if (!(from in next)) continue;
    next = { ...next, [to]: next[from] as T };
    delete next[from];
  }
  return next;
}

/**
 * Renames comment ids inside `commentRef` marks, without an `update` event or
 * a history entry. Returns null when nothing changed.
 */
export function buildCommentIdRenameTransaction(
  state: EditorState,
  renames: readonly CommentIdRename[],
): Transaction | null {
  const markType = state.schema.marks.commentRef;
  if (!markType || renames.length === 0) return null;

  const tr = state.tr;
  state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type !== markType) continue;
      const ids = Array.isArray(mark.attrs.commentIds)
        ? (mark.attrs.commentIds as string[])
        : [];
      const nextIds = ids.map((id) => applyCommentIdRenames(id, renames));
      if (nextIds.every((id, index) => id === ids[index])) continue;

      const from = pos;
      const to = pos + node.nodeSize;
      tr.removeMark(from, to, markType);
      tr.addMark(
        from,
        to,
        markType.create({ ...mark.attrs, commentIds: nextIds }),
      );
    }
  });

  if (!tr.docChanged) return null;
  tr.setMeta("addToHistory", false);
  tr.setMeta("preventUpdate", true);
  return tr;
}

/** Every comment id referenced by a `commentRef` mark in the doc. */
export function collectMarkedCommentIds(doc: ProseMirrorNode): Set<string> {
  const markType = doc.type.schema.marks.commentRef;
  const ids = new Set<string>();
  if (!markType) return ids;
  doc.descendants((node) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type !== markType || !Array.isArray(mark.attrs.commentIds)) {
        continue;
      }
      for (const id of mark.attrs.commentIds as string[]) ids.add(id);
    }
  });
  return ids;
}
