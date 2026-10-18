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
  mine,
  theirs,
}: {
  base: string;
  mine: string;
  theirs: string;
}): MarkdownMergeResult {
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
