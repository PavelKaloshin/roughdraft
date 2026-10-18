import type { JSONContent } from "@tiptap/core";
import { decodeRawMarkdownBlock, rawMarkdownBlockAttribute } from "../markdown";

/**
 * Block source preservation (ADR 0003).
 *
 * The rich-text editor holds a tree, so saving re-serializes the whole
 * document and rewrites syntax nobody touched (`*` bullets, setext headings,
 * wrapped lines, table padding, ...). To avoid that, parsing remembers the
 * source text of every top-level block, keyed by a fingerprint of the
 * ProseMirror node(s) it produced. Serializing writes a block whose
 * fingerprint is still known back with its original bytes and re-serializes
 * only the blocks that changed.
 */

export interface SourceBlock {
  /** Original source text of the block, without trailing newlines. */
  raw: string;
  /** Number of consecutive top-level nodes this block produced. */
  nodeCount: number;
  /** Fingerprint of the block's nodes (and the review state they show). */
  key: string;
  /** Fingerprint of the block's first node alone, used to find candidates. */
  firstKey: string;
  /** Original text between this block and the next one (whitespace only). */
  separatorAfter: string;
}

export interface BlockSource {
  blocks: SourceBlock[];
  /** Text before the first block (blank lines). */
  leading: string;
  /** Text after the last block (the final newline(s), or nothing). */
  trailing: string;
  /** firstKey → block indexes, in document order. */
  byFirstKey: Map<string, number[]>;
}

/** Describes the review state a group of nodes depends on (see index.ts). */
export type ReviewStateDescriber = (nodes: readonly JSONContent[]) => string;

/**
 * cyrb53: a small, fast, well-distributed 53-bit string hash. A collision can
 * at worst pick another block's bytes; the serializer's guard re-parses the
 * output and falls back to the full serialization on any mismatch.
 */
export function hashString(value: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function fingerprintNodes(
  nodes: readonly JSONContent[],
  describeReviewState: ReviewStateDescriber,
): string {
  return hashString(
    `${JSON.stringify(nodes)}\u0000${describeReviewState(nodes)}`,
  );
}

const rawBlockDivPattern = new RegExp(
  `<div ${rawMarkdownBlockAttribute}="([^"]*)"></div>\\n?`,
  "g",
);

function unescapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

/**
 * Token `raw` comes from the protected body, where some regions were replaced
 * by raw-markdown placeholder divs. Put the original text back.
 */
function restoreProtectedRaw(raw: string): string {
  return raw.replace(rawBlockDivPattern, (_match, encoded: string) =>
    decodeRawMarkdownBlock(unescapeHtmlAttribute(encoded)),
  );
}

export interface TokenNodes {
  /** The token's `raw`, taken from the protected body. */
  raw: string;
  /** Top-level nodes the token produced (may be empty). */
  nodes: JSONContent[];
}

/**
 * Builds the side table from the top-level tokens of the protected body and
 * the nodes each one produced. Returns null (no preservation for this
 * document) whenever the tokens cannot be located in the original body
 * unambiguously — it never guesses.
 */
export function buildBlockSource(
  body: string,
  tokens: readonly TokenNodes[],
  describeReviewState: ReviewStateDescriber,
): BlockSource | null {
  // CRLF bodies: marked normalizes line endings, so raws would not match.
  if (body.includes("\r")) return null;

  interface Located {
    start: number;
    end: number;
    nodes: JSONContent[];
  }
  const located: Located[] = [];
  let cursor = 0;
  let skippedContent = false;

  for (const token of tokens) {
    if (token.nodes.length === 0) {
      // Space tokens and anything else that renders nothing (link
      // definitions are not tokens at all) stay in the gap before the next
      // block and travel with it.
      if (token.raw.trim() !== "") skippedContent = true;
      continue;
    }
    const raw = restoreProtectedRaw(token.raw).replace(/\n+$/, "");
    if (raw === "") return null;
    const found = locateRaw(body, raw, cursor);
    if (!found) return null;
    const { start, length } = found;
    const gap = body.slice(cursor, start);
    if (gap.trim() !== "" && !skippedContent && !isLinkDefinitionGap(gap)) {
      return null;
    }
    skippedContent = false;

    // Non-blank gap text (link definitions, skipped tokens) becomes part of
    // the following block, starting at the beginning of its line, so that
    // separators are always whitespace.
    let blockStart = start;
    const firstContent = gap.search(/\S/);
    if (firstContent >= 0) {
      const lineStart = gap.lastIndexOf("\n", firstContent) + 1;
      blockStart = cursor + lineStart;
    }
    located.push({
      start: blockStart,
      end: start + length,
      nodes: token.nodes,
    });
    cursor = start + length;
  }

  if (body.slice(cursor).trim() !== "") return null;
  if (located.length === 0) return null;

  const blocks: SourceBlock[] = located.map((entry, index) => {
    const next = located[index + 1];
    return {
      raw: body.slice(entry.start, entry.end),
      nodeCount: entry.nodes.length,
      key: fingerprintNodes(entry.nodes, describeReviewState),
      firstKey: fingerprintNodes([entry.nodes[0]], describeReviewState),
      separatorAfter: next ? body.slice(entry.end, next.start) : "",
    };
  });

  const byFirstKey = new Map<string, number[]>();
  blocks.forEach((block, index) => {
    const list = byFirstKey.get(block.firstKey) ?? [];
    list.push(index);
    byFirstKey.set(block.firstKey, list);
  });

  return {
    blocks,
    leading: body.slice(0, located[0].start),
    trailing: body.slice(located[located.length - 1].end),
    byFirstKey,
  };
}

/**
 * Finds a token's raw text in the body. When a block-level extension (block
 * math) interrupts a paragraph, marked splits the paragraph there and joins
 * the pieces back with an extra "\n", so the raw holds newlines the source
 * does not; match those newlines optionally, but only right at the cursor
 * (after blank lines), never further down the document.
 */
function locateRaw(
  body: string,
  raw: string,
  cursor: number,
): { start: number; length: number } | null {
  const start = body.indexOf(raw, cursor);
  if (start >= 0) return { start, length: raw.length };

  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `[ \\t\\n]*(${escaped.replaceAll("\n", "\\n?")})`,
    "y",
  );
  pattern.lastIndex = cursor;
  const match = pattern.exec(body);
  if (!match) return null;
  const matched = match[1];
  return {
    start: cursor + match[0].length - matched.length,
    length: matched.length,
  };
}

function isLinkDefinitionGap(gap: string): boolean {
  return gap.split("\n").every(
    (line) =>
      line.trim() === "" ||
      /^ {0,3}\[[^\]]+\]:/.test(line) ||
      /^\s+\S/.test(line), // continuation line of a definition title
  );
}

export type PlannedPiece =
  | { kind: "source"; blockIndex: number; nodes: JSONContent[] }
  | { kind: "serialize"; nodes: JSONContent[] };

/**
 * Splits the current top-level nodes into runs: blocks whose fingerprint is
 * still in the side table (each source block is used at most once, in
 * document order, so duplicates work) and runs of changed nodes.
 */
export function planBlockPieces(
  nodes: readonly JSONContent[],
  source: BlockSource,
  describeReviewState: ReviewStateDescriber,
): PlannedPiece[] {
  const used = new Set<number>();
  const pieces: PlannedPiece[] = [];
  let pending: JSONContent[] = [];
  const flush = () => {
    if (pending.length > 0) pieces.push({ kind: "serialize", nodes: pending });
    pending = [];
  };

  let index = 0;
  while (index < nodes.length) {
    const firstKey = fingerprintNodes([nodes[index]], describeReviewState);
    const candidates = source.byFirstKey.get(firstKey) ?? [];
    let matched: number | null = null;
    for (const blockIndex of candidates) {
      if (used.has(blockIndex)) continue;
      const block = source.blocks[blockIndex];
      if (index + block.nodeCount > nodes.length) continue;
      const group = nodes.slice(index, index + block.nodeCount);
      if (
        block.nodeCount === 1 ||
        fingerprintNodes(group, describeReviewState) === block.key
      ) {
        matched = blockIndex;
        break;
      }
    }

    if (matched == null) {
      pending.push(nodes[index]);
      index += 1;
      continue;
    }

    flush();
    used.add(matched);
    const block = source.blocks[matched];
    pieces.push({
      kind: "source",
      blockIndex: matched,
      nodes: nodes.slice(index, index + block.nodeCount),
    });
    index += block.nodeCount;
  }
  flush();
  return pieces;
}
