import { diff3Merge } from "node-diff3";

export type MarkdownMergeResult =
  | { status: "merged"; markdown: string }
  | { status: "conflict" };

/**
 * Line-based three-way merge of markdown.
 *
 * - `base`: the version both sides started from (last saved / accepted).
 * - `mine`: the local draft (the editor's current markdown).
 * - `theirs`: what is on disk now (for example an agent's edit).
 *
 * Edits to different lines merge. Edits that touch the same or adjacent lines
 * are a conflict unless both sides made the identical change; Roughdraft then
 * falls back to its conflict banner instead of guessing.
 */
export function mergeMarkdown({
  base,
  mine: editorMine,
  theirs,
  normalize,
}: {
  base: string;
  mine: string;
  theirs: string;
  /**
   * How the editor re-serializes markdown it did not change. The rich-text
   * editor's draft is a full re-serialization, so serializer normalizations
   * of untouched regions (bullet style, emphasis markers, heading spacing)
   * would otherwise count as user edits, widen the changed ranges, and cause
   * false conflicts. With `normalize`, only real user edits are merged and
   * untouched regions keep their source bytes.
   */
  normalize?: (markdown: string) => string;
}): MarkdownMergeResult {
  const mine = normalize
    ? restoreUntouchedSource({
        source: base,
        normalized: normalize(base),
        edited: editorMine,
      })
    : editorMine;

  if (mine === theirs || theirs === base) {
    return { status: "merged", markdown: mine };
  }
  if (mine === base) {
    return { status: "merged", markdown: theirs };
  }

  const regions = diff3Merge(
    mine.split("\n"),
    base.split("\n"),
    theirs.split("\n"),
    { excludeFalseConflicts: true },
  );

  const lines: string[] = [];
  for (const region of regions) {
    if (region.conflict) return { status: "conflict" };
    lines.push(...(region.ok ?? []));
  }

  return { status: "merged", markdown: lines.join("\n") };
}

/**
 * Maps an edit of `normalized` (the serializer's rendering of `source`) back
 * onto `source`: lines the user did not change keep the source bytes, lines
 * the user changed take the edited text. Where a user edit touches a region
 * the serializer also rewrote, the edited text wins for that region.
 */
export function restoreUntouchedSource({
  source,
  normalized,
  edited,
}: {
  source: string;
  normalized: string;
  edited: string;
}): string {
  if (edited === normalized) return source;
  if (source === normalized) return edited;

  const regions = diff3Merge(
    edited.split("\n"),
    normalized.split("\n"),
    source.split("\n"),
    { excludeFalseConflicts: true },
  );

  const lines: string[] = [];
  for (const region of regions) {
    if (region.conflict) {
      lines.push(...region.conflict.a);
    } else {
      lines.push(...(region.ok ?? []));
    }
  }
  return lines.join("\n");
}
