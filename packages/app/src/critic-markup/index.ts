import { generateHTML, generateJSON, type JSONContent } from "@tiptap/core";
import {
  Marked,
  type RendererThis,
  type Token,
  type TokenizerAndRendererExtension,
  type TokenizerThis,
  type Tokens,
} from "marked";
import type TurndownService from "turndown";
import {
  isMap,
  isScalar,
  parseDocument,
  parse as parseYaml,
  Document as YamlDocument,
} from "yaml";

// Endmatter is read by people too: write multiline bodies as literal `|`
// blocks and never re-wrap long lines (the default folds them with `>`).
const ENDMATTER_YAML_OPTIONS = { blockQuote: "literal", lineWidth: 0 } as const;
import {
  type BlockSource,
  buildBlockSource,
  planBlockPieces,
  type ReviewStateDescriber,
} from "./block-source";
import {
  createEditorExtensions,
  type CriticChangeAttrs,
  type CriticChangeKind,
} from "../editor-extensions";
import {
  createMarkedRenderer,
  createMathExtensions,
  createTurndownService,
  detectHeadingSpacing,
  type HeadingSpacing,
  normalizeBlockSpacing,
  appendYamlEndmatter,
  prependYamlFrontmatter,
  protectRichTextRoundTripMarkdown,
  splitYamlDocumentMetadata,
  type MarkdownOptions,
} from "../markdown";

export interface CriticComment {
  id: string;
  content: string;
  createdAt: string;
  authorType?: "user" | "ai";
  authorId?: string | null;
  parentCommentId?: string | null;
  scope?: "document";
  /**
   * What a root comment asks of a connected agent. Absent means a plain
   * `comment`; only known non-default intents are kept on the model. Ignored on
   * replies (a thread's intent is its root's).
   */
  intent?: CriticCommentIntent;
  /** Review state from metadata, e.g. `resolved`. */
  status?: string | null;
  /**
   * Inline-attribute metadata keys the app does not model (for example the
   * `resolved` summary), kept so a rewrite does not drop them.
   */
  extraAttributes?: [string, string][];
  /**
   * Set when the source comment had no usable metadata (a bare `{>>…<<}`, or
   * a `{#id}` reference with no endmatter entry). While the comment is left
   * untouched it is written back exactly as it was instead of gaining
   * generated id/by/at metadata.
   */
  verbatimSource?: { metadata: string; content: string };
}

export type CriticCommentIntent = "ask" | "change";

export function parseCriticCommentIntent(
  value: unknown,
): CriticCommentIntent | undefined {
  return value === "ask" || value === "change" ? value : undefined;
}

export function isCriticCommentResolved(
  comment: Pick<CriticComment, "status">,
): boolean {
  return comment.status === "resolved";
}

const modeledAttributeKeys = new Set([
  "id",
  "by",
  "at",
  "re",
  "intent",
  "status",
]);

export interface CriticCommentThread {
  comment: CriticComment;
  replies: CriticCommentThread[];
}

export type { CriticChangeAttrs, CriticChangeKind };

interface CriticCommentToken {
  type: "criticCommentAnchor";
  raw: string;
  commentIds: string[];
  tokens: Token[];
}

interface CriticStandaloneCommentToken {
  type: "criticStandaloneComment";
  raw: string;
  commentIds: string[];
}

interface CriticChangeToken {
  type: "criticChange";
  raw: string;
  change: CriticChangeAttrs;
  commentIds: string[];
  tokens?: Token[];
  oldTokens?: Token[];
  newTokens?: Token[];
}

const extensions = createEditorExtensions("");
const criticCommentAnchorPattern = /^\{==([\s\S]+?)==\}/;
const criticCommentBlockPattern =
  /^\{>>([\s\S]*?)<<\}(?:(\{@([\s\S]+?)@\})|(\{(?:\s*[A-Za-z][A-Za-z0-9_-]*="(?:\\[\s\S]|[^"\\])*")+\s*\})|(\{#[A-Za-z][A-Za-z0-9_-]*\}))?/;
const criticAdditionPattern = /^\{\+\+([\s\S]+?)\+\+\}/;
const criticDeletionPattern = /^\{--([\s\S]+?)--\}/;
const criticSubstitutionPattern = /^\{~~([\s\S]+?)~>([\s\S]+?)~~\}/;
const attributeMetadataBlockPattern =
  /^\{(?:\s*[A-Za-z][A-Za-z0-9_-]*="(?:\\[\s\S]|[^"\\])*")+\s*\}/;
const metadataAttributePattern =
  /([A-Za-z][A-Za-z0-9_-]*)="((?:\\[\s\S]|[^"\\])*)"/g;
const metadataReferencePattern = /^\{#([A-Za-z][A-Za-z0-9_-]*)\}$/;
const unanchoredCommentSentinel = "\u2060";

interface ParsedEndmatter {
  comments: Map<string, Record<string, unknown>>;
  suggestions: Map<string, Record<string, unknown>>;
  data: Record<string, unknown> | null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseLegacyMetadata(
  metadataText?: string,
): Partial<Omit<CriticComment, "content">> {
  const fields = new Map<string, string>();

  for (const part of metadataText?.split(";") ?? []) {
    const [rawKey, ...valueParts] = part.split(":");
    const key = rawKey?.trim();
    const value = valueParts.join(":").trim();

    if (!key || !value) continue;
    fields.set(key, value);
  }

  const author = fields.get("by") ?? "user";

  return {
    id: fields.get("id"),
    createdAt: fields.get("at") ?? new Date().toISOString(),
    authorType: author.toUpperCase() === "AI" ? "ai" : "user",
    authorId: author.toUpperCase() === "AI" ? null : author,
    parentCommentId: fields.get("re") ?? null,
  };
}

function unescapeMetadataAttributeValue(value: string): string {
  return value.replaceAll(/\\([\s\S])/g, "$1");
}

function escapeMetadataAttributeValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function parseAttributeMetadata(
  metadataText?: string,
): Partial<Omit<CriticComment, "content">> {
  if (!metadataText?.startsWith("{") || !metadataText.endsWith("}")) {
    return {};
  }

  const fields = new Map<string, string>();
  const content = metadataText.slice(1, -1);

  for (const match of content.matchAll(metadataAttributePattern)) {
    fields.set(match[1], unescapeMetadataAttributeValue(match[2]));
  }

  const author = fields.get("by") ?? "user";
  const parentCommentId = fields.get("re") ?? null;
  const intent = parentCommentId
    ? undefined
    : parseCriticCommentIntent(fields.get("intent"));
  const extraAttributes = [...fields].filter(
    ([key]) => !modeledAttributeKeys.has(key),
  );
  // An intent value the app does not know is preserved verbatim.
  const rawIntent = fields.get("intent");
  if (rawIntent !== undefined && !intent) {
    extraAttributes.push(["intent", rawIntent]);
  }

  return {
    id: fields.get("id"),
    createdAt: fields.get("at") ?? new Date().toISOString(),
    authorType: author.toUpperCase() === "AI" ? "ai" : "user",
    authorId: author.toUpperCase() === "AI" ? null : author,
    parentCommentId,
    ...(intent ? { intent } : {}),
    ...(fields.has("status") ? { status: fields.get("status") } : {}),
    ...(extraAttributes.length > 0 ? { extraAttributes } : {}),
  };
}

function commentPartialFromEndmatterEntry(
  id: string,
  entry?: Record<string, unknown>,
  options?: { includeParent?: boolean },
): Partial<Omit<CriticComment, "content">> {
  const author = typeof entry?.by === "string" ? entry.by : "user";
  const includeParent = options?.includeParent ?? true;
  const intent =
    typeof entry?.re === "string"
      ? undefined
      : parseCriticCommentIntent(entry?.intent);

  return {
    id,
    createdAt:
      typeof entry?.at === "string" ? entry.at : new Date().toISOString(),
    authorType: author.toUpperCase() === "AI" ? "ai" : "user",
    authorId: author.toUpperCase() === "AI" ? null : author,
    parentCommentId:
      includeParent && typeof entry?.re === "string" ? entry.re : null,
    ...(intent ? { intent } : {}),
    ...(typeof entry?.status === "string" ? { status: entry.status } : {}),
  };
}

function parseMetadata(
  legacyMetadataText?: string,
  attributeMetadataText?: string,
  referenceMetadataText?: string,
  endmatter?: ParsedEndmatter,
  kind: "comment" | "suggestion" = "comment",
): Partial<Omit<CriticComment, "content">> {
  const reference = referenceMetadataText?.match(metadataReferencePattern);
  if (reference) {
    const id = reference[1] ?? "";
    const entry =
      kind === "comment"
        ? endmatter?.comments.get(id)
        : endmatter?.suggestions.get(id);
    return commentPartialFromEndmatterEntry(id, entry, {
      includeParent: false,
    });
  }

  if (attributeMetadataText) {
    return parseAttributeMetadata(attributeMetadataText);
  }

  return parseLegacyMetadata(legacyMetadataText);
}

function serializeMetadata(comment: CriticComment): string {
  const fields = [
    ["id", comment.id],
    ["by", comment.authorType === "ai" ? "AI" : comment.authorId || "user"],
    ["at", comment.createdAt || new Date().toISOString()],
  ];

  if (comment.parentCommentId) {
    fields.push(["re", comment.parentCommentId]);
  } else if (comment.intent) {
    fields.push(["intent", comment.intent]);
  }
  if (comment.status) {
    fields.push(["status", comment.status]);
  }
  for (const [key, value] of comment.extraAttributes ?? []) {
    // A reopened thread drops its resolution summary along with its status.
    if (key === "resolved" && !comment.status) continue;
    fields.push([key, value]);
  }

  return `{${fields
    .map(([key, value]) => `${key}="${escapeMetadataAttributeValue(value)}"`)
    .join(" ")}}`;
}

function serializeChangeMetadata(change: CriticChangeAttrs): string {
  return serializeMetadata({
    id: change.changeId,
    content: "",
    createdAt: change.createdAt,
    authorType: change.authorType,
    authorId: change.authorId,
  });
}

function parseReviewEndmatter(endmatter?: string | null): ParsedEndmatter {
  if (!endmatter) {
    return { comments: new Map(), suggestions: new Map(), data: null };
  }

  const yamlText = endmatter.replace(/^---[ \t]*(?:\r\n|\n)/, "");
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return { comments: new Map(), suggestions: new Map(), data: null };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { comments: new Map(), suggestions: new Map(), data: null };
  }

  const record = parsed as Record<string, unknown>;
  return {
    comments: parseEndmatterMap(record.comments),
    suggestions: parseEndmatterMap(record.suggestions),
    data: record,
  };
}

function parseEndmatterMap(
  value: unknown,
): Map<string, Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new Map();
  }

  return new Map(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        Boolean(entry[1]) &&
        typeof entry[1] === "object" &&
        !Array.isArray(entry[1]),
    ),
  );
}

function addEndmatterFeedback(
  comments: Map<string, CriticComment>,
  endmatter: ParsedEndmatter,
) {
  for (const [id, entry] of endmatter.comments) {
    if (typeof entry.body !== "string") {
      continue;
    }
    if (comments.has(id)) {
      continue;
    }

    comments.set(
      id,
      createCommentWithContext({
        ...commentPartialFromEndmatterEntry(id, entry),
        content: entry.body,
        parentCommentId: typeof entry.re === "string" ? entry.re : null,
        scope: typeof entry.re === "string" ? undefined : "document",
      }),
    );
  }
}

function areEndmatterEntriesEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);

  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }

  return true;
}

function areEndmatterMapsEqual(
  left: Map<string, Record<string, unknown>>,
  right: Map<string, Record<string, unknown>>,
): boolean {
  if (left.size !== right.size) return false;

  for (const [id, leftEntry] of left) {
    const rightEntry = right.get(id);
    if (!rightEntry || !areEndmatterEntriesEqual(leftEntry, rightEntry)) {
      return false;
    }
  }

  return true;
}

function endmatterEntryForComment(
  comment: CriticComment,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  const by = comment.authorType === "ai" ? "AI" : comment.authorId || "user";
  const next: Record<string, unknown> = {
    ...existing,
    by,
    at: comment.createdAt,
  };

  if (comment.scope === "document") {
    next.body = comment.content;
    delete next.re;
  } else if (comment.parentCommentId) {
    next.body = comment.content;
    next.re = comment.parentCommentId;
  } else {
    delete next.body;
    delete next.re;
  }

  // Unknown intent values already in the file survive via `existing`.
  if (comment.intent && !next.re) {
    next.intent = comment.intent;
  }
  if (comment.status) {
    next.status = comment.status;
  } else {
    delete next.status;
    delete next.resolved;
  }

  return next;
}

function endmatterEntryForChange(
  change: CriticChangeAttrs,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  const by = change.authorType === "ai" ? "AI" : change.authorId || "user";

  return {
    ...existing,
    by,
    at: change.createdAt,
  };
}

function serializeReviewEndmatter(
  existingEndmatter: string | null,
  comments: Map<string, CriticComment>,
  changes: Map<string, CriticChangeAttrs>,
  createIfMissing = false,
): string | null {
  if (!existingEndmatter && !createIfMissing) return null;

  const parsed = parseReviewEndmatter(existingEndmatter);
  const commentEntries = new Map<string, Record<string, unknown>>();
  const suggestionEntries = new Map<string, Record<string, unknown>>();

  for (const comment of comments.values()) {
    if (isWrittenVerbatim(comment, comments)) continue;
    commentEntries.set(
      comment.id,
      endmatterEntryForComment(comment, parsed.comments.get(comment.id)),
    );
  }

  for (const change of changes.values()) {
    suggestionEntries.set(
      change.changeId,
      endmatterEntryForChange(change, parsed.suggestions.get(change.changeId)),
    );
  }

  if (
    existingEndmatter &&
    areEndmatterMapsEqual(parsed.comments, commentEntries) &&
    areEndmatterMapsEqual(parsed.suggestions, suggestionEntries)
  ) {
    return existingEndmatter;
  }

  // Edit the existing YAML in place (Document API), so entries and keys the
  // user did not change keep their exact bytes: quotes, comments, blank
  // lines, flow style. Only changed keys and new entries are re-serialized.
  const document = parseEndmatterDocument(existingEndmatter);
  updateEndmatterSection(document, "comments", parsed.comments, commentEntries);
  updateEndmatterSection(
    document,
    "suggestions",
    parsed.suggestions,
    suggestionEntries,
  );

  if (!isMap(document.contents) || document.contents.items.length === 0) {
    return null;
  }

  return `---\n${document.toString(ENDMATTER_YAML_OPTIONS)}`;
}

function parseEndmatterDocument(endmatter: string | null): YamlDocument {
  if (endmatter) {
    const parsed = parseDocument(
      endmatter.replace(/^---[ \t]*(?:\r\n|\n)/, ""),
    );
    if (parsed.errors.length === 0 && isMap(parsed.contents)) {
      return parsed as unknown as YamlDocument;
    }
  }
  // Unparseable endmatter was never usable review state; start over, as the
  // previous whole-object writer did.
  return new YamlDocument({});
}

function updateEndmatterSection(
  document: YamlDocument,
  section: "comments" | "suggestions",
  existing: Map<string, Record<string, unknown>>,
  next: Map<string, Record<string, unknown>>,
) {
  if (next.size === 0) {
    document.deleteIn([section]);
    return;
  }
  // A section that is missing or not a map is rewritten as a whole.
  if (!isMap(document.getIn([section], true))) {
    document.setIn([section], document.createNode({}));
  }

  for (const id of existing.keys()) {
    if (!next.has(id)) document.deleteIn([section, id]);
  }

  for (const [id, entry] of next) {
    const current = existing.get(id);
    if (!current || !isMap(document.getIn([section, id], true))) {
      const node = document.createNode(entry);
      // Match the spec's examples (and rfm): quote `at`.
      const at = node.get("at", true);
      if (isScalar(at)) at.type = "QUOTE_DOUBLE";
      document.setIn([section, id], node);
      continue;
    }

    for (const key of Object.keys(current)) {
      if (!(key in entry)) document.deleteIn([section, id, key]);
    }
    for (const [key, value] of Object.entries(entry)) {
      if (current[key] === value) continue;
      document.setIn([section, id, key], value);
    }
  }
}

export function createNextCommentId(
  existingComments: Iterable<Pick<CriticComment, "id">>,
): string {
  let maxId = 0;

  for (const comment of existingComments) {
    const match = comment.id.match(/^c(\d+)$/);
    if (!match) continue;

    const parsed = Number.parseInt(match[1] || "0", 10);
    if (parsed > maxId) {
      maxId = parsed;
    }
  }

  return `c${maxId + 1}`;
}

export function createNextChangeId(
  existingChanges: Iterable<Pick<CriticChangeAttrs, "changeId">>,
): string {
  let maxId = 0;

  for (const change of existingChanges) {
    const match = change.changeId.match(/^s(\d+)$/);
    if (!match) continue;

    const parsed = Number.parseInt(match[1] || "0", 10);
    if (parsed > maxId) {
      maxId = parsed;
    }
  }

  return `s${maxId + 1}`;
}

function endmatterOwnedIds(
  endmatter: ParsedEndmatter | undefined,
): Array<Pick<CriticComment, "id">> {
  if (!endmatter) return [];
  return [...endmatter.comments.keys(), ...endmatter.suggestions.keys()].map(
    (id) => ({ id }),
  );
}

function endmatterOwnedChangeIds(
  endmatter: ParsedEndmatter | undefined,
): Array<Pick<CriticChangeAttrs, "changeId">> {
  if (!endmatter) return [];
  return [...endmatter.suggestions.keys(), ...endmatter.comments.keys()].map(
    (changeId) => ({ changeId }),
  );
}

function parseCommentBlockMatch(
  match: RegExpMatchArray,
  endmatter: ParsedEndmatter | undefined,
  existingComments: Iterable<Pick<CriticComment, "id">>,
): CriticComment {
  const [
    ,
    commentText,
    ,
    legacyMetadataText,
    attributeMetadataText,
    referenceMetadataText,
  ] = match;
  const comment = createCommentWithContext(
    {
      ...parseMetadata(
        legacyMetadataText,
        attributeMetadataText,
        referenceMetadataText,
        endmatter,
        "comment",
      ),
      content: commentText,
    },
    // A metadata-less comment gets a generated id; never one that endmatter
    // already owns (an agent's reply, say), or it would replace that entry.
    [...existingComments, ...endmatterOwnedIds(endmatter)],
  );
  const referenceId = referenceMetadataText?.match(
    metadataReferencePattern,
  )?.[1];
  const hasNoMetadata =
    !legacyMetadataText && !attributeMetadataText && !referenceMetadataText;
  const hasDanglingReference =
    referenceId !== undefined && !endmatter?.comments.has(referenceId);
  if (hasNoMetadata || hasDanglingReference) {
    comment.verbatimSource = {
      metadata: referenceMetadataText ?? "",
      content: commentText ?? "",
    };
  }
  return comment;
}

function isWrittenVerbatim(
  comment: CriticComment,
  comments: ReadonlyMap<string, CriticComment>,
): boolean {
  if (!comment.verbatimSource) return false;
  if (comment.verbatimSource.content !== comment.content) return false;
  // Gaining an intent or a status needs real metadata to be written.
  if (comment.intent || comment.status) return false;
  for (const other of comments.values()) {
    if (other.parentCommentId === comment.id) return false;
  }
  return true;
}

function createCommentWithContext(
  partial?: Partial<CriticComment>,
  existingComments: Iterable<Pick<CriticComment, "id">> = [],
): CriticComment {
  const authorType = partial?.authorType ?? "user";

  return {
    id: partial?.id ?? createNextCommentId(existingComments),
    content: partial?.content ?? "",
    createdAt: partial?.createdAt ?? new Date().toISOString(),
    authorType,
    authorId: partial?.authorId ?? (authorType === "ai" ? null : "user"),
    parentCommentId: partial?.parentCommentId ?? null,
    scope: partial?.scope,
    ...(partial?.intent && !partial.parentCommentId
      ? { intent: partial.intent }
      : {}),
    ...(partial?.status ? { status: partial.status } : {}),
    ...(partial?.extraAttributes?.length
      ? { extraAttributes: partial.extraAttributes }
      : {}),
  };
}

function createChangeWithContext(
  kind: CriticChangeKind,
  partial?: Partial<CriticChangeAttrs>,
  existingChanges: Iterable<Pick<CriticChangeAttrs, "changeId">> = [],
): CriticChangeAttrs {
  const authorType = partial?.authorType ?? "user";

  return {
    kind,
    changeId: partial?.changeId ?? createNextChangeId(existingChanges),
    createdAt: partial?.createdAt ?? new Date().toISOString(),
    authorType,
    authorId: partial?.authorId ?? (authorType === "ai" ? null : "user"),
  };
}

function parseChangeMetadata(
  metadataText?: string,
  endmatter?: ParsedEndmatter,
): Partial<CriticChangeAttrs> {
  const reference = metadataText?.match(metadataReferencePattern);
  if (reference) {
    const id = reference[1] ?? "";
    const entry = endmatter?.suggestions.get(id);
    const parsed = commentPartialFromEndmatterEntry(id, entry);
    return {
      changeId: parsed.id,
      createdAt: parsed.createdAt,
      authorType: parsed.authorType,
      authorId: parsed.authorId,
    };
  }

  const parsed = parseAttributeMetadata(metadataText);

  return {
    changeId: parsed.id,
    createdAt: parsed.createdAt,
    authorType: parsed.authorType,
    authorId: parsed.authorId,
  };
}

function buildCommentThreadsFromOrderedComments(
  orderedComments: CriticComment[],
): CriticCommentThread[] {
  const validCommentIds = new Set(orderedComments.map((comment) => comment.id));
  const repliesByParentId = new Map<string, CriticComment[]>();
  const rootComments: CriticComment[] = [];

  for (const comment of orderedComments) {
    const parentCommentId = comment.parentCommentId;

    if (
      !parentCommentId ||
      parentCommentId === comment.id ||
      !validCommentIds.has(parentCommentId)
    ) {
      rootComments.push(comment);
      continue;
    }

    const replies = repliesByParentId.get(parentCommentId) ?? [];
    replies.push(comment);
    repliesByParentId.set(parentCommentId, replies);
  }

  const buildNode = (comment: CriticComment): CriticCommentThread => ({
    comment,
    replies: (repliesByParentId.get(comment.id) ?? []).map(buildNode),
  });

  return rootComments.map(buildNode);
}

export function buildCommentThreads(
  comments: Iterable<CriticComment>,
): CriticCommentThread[] {
  return buildCommentThreadsFromOrderedComments([...comments]);
}

export function flattenCommentThreads(
  threads: Iterable<CriticCommentThread>,
): CriticComment[] {
  const orderedComments: CriticComment[] = [];

  const visit = (thread: CriticCommentThread) => {
    orderedComments.push(thread.comment);
    for (const reply of thread.replies) {
      visit(reply);
    }
  };

  for (const thread of threads) {
    visit(thread);
  }

  return orderedComments;
}

function getOrderedAnchorComments(
  commentIds: string[],
  comments: ReadonlyMap<string, CriticComment>,
): CriticComment[] {
  const visibleComments = commentIds
    .map((commentId) => comments.get(commentId))
    .filter((comment): comment is CriticComment => Boolean(comment));

  return flattenCommentThreads(buildCommentThreads(visibleComments));
}

function serializeCommentBlocks(
  commentIds: string[],
  comments: ReadonlyMap<string, CriticComment>,
  useEndmatter = false,
): string {
  const orderedComments = useEndmatter
    ? commentIds
        .map((commentId) => comments.get(commentId))
        .filter(
          (comment): comment is CriticComment =>
            comment !== undefined && !comment.parentCommentId,
        )
    : getOrderedAnchorComments(commentIds, comments);
  let result = "";

  for (const comment of orderedComments) {
    if (isWrittenVerbatim(comment, comments)) {
      result += `{>>${comment.content}<<}${comment.verbatimSource?.metadata}`;
      continue;
    }
    result += `{>>${comment.content}<<}${
      useEndmatter ? `{#${comment.id}}` : serializeMetadata(comment)
    }`;
  }

  return result;
}

export function getCommentDescendantIds(
  commentId: string,
  comments: ReadonlyMap<string, CriticComment>,
): string[] {
  const childrenByParentId = new Map<string, string[]>();

  for (const comment of comments.values()) {
    if (!comment.parentCommentId || comment.parentCommentId === comment.id) {
      continue;
    }

    const childIds = childrenByParentId.get(comment.parentCommentId) ?? [];
    childIds.push(comment.id);
    childrenByParentId.set(comment.parentCommentId, childIds);
  }

  const descendantIds: string[] = [];
  const stack = [...(childrenByParentId.get(commentId) ?? [])].reverse();

  while (stack.length > 0) {
    const nextCommentId = stack.pop();
    if (!nextCommentId) continue;

    descendantIds.push(nextCommentId);

    const childIds = childrenByParentId.get(nextCommentId) ?? [];
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      const childId = childIds[index];
      if (childId) {
        stack.push(childId);
      }
    }
  }

  return descendantIds;
}

function tokenizeCriticCommentAnchor(
  lexer: TokenizerThis["lexer"],
  src: string,
  existingComments: Iterable<Pick<CriticComment, "id">>,
  endmatter?: ParsedEndmatter,
):
  | {
      token: CriticCommentToken;
      comments: CriticComment[];
    }
  | undefined {
  const anchorMatch = src.match(criticCommentAnchorPattern);

  if (!anchorMatch) return undefined;

  const [, anchor] = anchorMatch;
  let raw = anchorMatch[0];
  let offset = raw.length;
  const parsedComments: CriticComment[] = [];

  while (offset < src.length) {
    const nextMatch = src.slice(offset).match(criticCommentBlockPattern);
    if (!nextMatch) break;

    const comment = parseCommentBlockMatch(nextMatch, endmatter, [
      ...existingComments,
      ...parsedComments,
    ]);
    parsedComments.push(comment);
    raw += nextMatch[0];
    offset += nextMatch[0].length;
  }

  if (parsedComments.length === 0) return undefined;

  const anchoredIds = parsedComments.map((comment) => comment.id);

  return {
    token: {
      type: "criticCommentAnchor",
      raw,
      // Endmatter-only replies are not added to the mark: the rail finds
      // them through `parentCommentId`, so an agent reply changes no body
      // marks and a live reload leaves the body untouched.
      commentIds: anchoredIds,
      tokens: lexer.inlineTokens(anchor),
    },
    comments: parsedComments,
  };
}

function getTrailingAttributeMetadata(src: string, offset: number) {
  const reference = src.slice(offset).match(/^\{#[A-Za-z][A-Za-z0-9_-]*\}/);
  if (reference) {
    return {
      metadataText: reference[0],
      raw: reference[0],
    };
  }

  const match = src.slice(offset).match(attributeMetadataBlockPattern);

  if (!match) {
    return {
      metadataText: undefined,
      raw: "",
    };
  }

  return {
    metadataText: match[0],
    raw: match[0],
  };
}

function tokenizeCriticCommentBlocks(
  src: string,
  offset: number,
  existingComments: Iterable<Pick<CriticComment, "id">>,
  endmatter?: ParsedEndmatter,
) {
  let raw = "";
  let nextOffset = offset;
  const parsedComments: CriticComment[] = [];

  while (nextOffset < src.length) {
    const nextMatch = src.slice(nextOffset).match(criticCommentBlockPattern);
    if (!nextMatch) break;

    const comment = parseCommentBlockMatch(nextMatch, endmatter, [
      ...existingComments,
      ...parsedComments,
    ]);
    parsedComments.push(comment);
    raw += nextMatch[0];
    nextOffset += nextMatch[0].length;
  }

  return {
    raw,
    comments: parsedComments,
  };
}

function tokenizeCriticStandaloneComment(
  src: string,
  existingComments: Iterable<Pick<CriticComment, "id">>,
  endmatter?: ParsedEndmatter,
):
  | {
      token: CriticStandaloneCommentToken;
      comments: CriticComment[];
    }
  | undefined {
  const result = tokenizeCriticCommentBlocks(
    src,
    0,
    existingComments,
    endmatter,
  );

  if (result.comments.length === 0) return undefined;

  const anchoredIds = result.comments.map((comment) => comment.id);

  return {
    token: {
      type: "criticStandaloneComment",
      raw: result.raw,
      commentIds: anchoredIds,
    },
    comments: result.comments,
  };
}

function tokenizeCriticChange(
  lexer: TokenizerThis["lexer"],
  src: string,
  existingChanges: Iterable<Pick<CriticChangeAttrs, "changeId">>,
  existingComments: Iterable<Pick<CriticComment, "id">>,
  endmatter?: ParsedEndmatter,
):
  | {
      token: CriticChangeToken;
      comments: CriticComment[];
    }
  | undefined {
  const additionMatch = src.match(criticAdditionPattern);

  if (additionMatch) {
    const [, text] = additionMatch;
    const metadata = getTrailingAttributeMetadata(src, additionMatch[0].length);
    const trailingComments = tokenizeCriticCommentBlocks(
      src,
      additionMatch[0].length + metadata.raw.length,
      existingComments,
      endmatter,
    );
    const change = createChangeWithContext(
      "addition",
      parseChangeMetadata(metadata.metadataText, endmatter),
      [...existingChanges, ...endmatterOwnedChangeIds(endmatter)],
    );

    return {
      token: {
        type: "criticChange",
        raw: additionMatch[0] + metadata.raw + trailingComments.raw,
        change,
        commentIds: trailingComments.comments.map((comment) => comment.id),
        tokens: lexer.inlineTokens(text),
      },
      comments: trailingComments.comments,
    };
  }

  const deletionMatch = src.match(criticDeletionPattern);

  if (deletionMatch) {
    const [, text] = deletionMatch;
    const metadata = getTrailingAttributeMetadata(src, deletionMatch[0].length);
    const trailingComments = tokenizeCriticCommentBlocks(
      src,
      deletionMatch[0].length + metadata.raw.length,
      existingComments,
      endmatter,
    );
    const change = createChangeWithContext(
      "deletion",
      parseChangeMetadata(metadata.metadataText, endmatter),
      [...existingChanges, ...endmatterOwnedChangeIds(endmatter)],
    );

    return {
      token: {
        type: "criticChange",
        raw: deletionMatch[0] + metadata.raw + trailingComments.raw,
        change,
        commentIds: trailingComments.comments.map((comment) => comment.id),
        tokens: lexer.inlineTokens(text),
      },
      comments: trailingComments.comments,
    };
  }

  const substitutionMatch = src.match(criticSubstitutionPattern);

  if (substitutionMatch) {
    const [, oldText, newText] = substitutionMatch;
    const metadata = getTrailingAttributeMetadata(
      src,
      substitutionMatch[0].length,
    );
    const trailingComments = tokenizeCriticCommentBlocks(
      src,
      substitutionMatch[0].length + metadata.raw.length,
      existingComments,
      endmatter,
    );
    const change = createChangeWithContext(
      "substitution-old",
      parseChangeMetadata(metadata.metadataText, endmatter),
      [...existingChanges, ...endmatterOwnedChangeIds(endmatter)],
    );

    return {
      token: {
        type: "criticChange",
        raw: substitutionMatch[0] + metadata.raw + trailingComments.raw,
        change,
        commentIds: trailingComments.comments.map((comment) => comment.id),
        oldTokens: lexer.inlineTokens(oldText),
        newTokens: lexer.inlineTokens(newText),
      },
      comments: trailingComments.comments,
    };
  }

  return undefined;
}

function renderCriticChangeSpan(
  change: CriticChangeAttrs,
  content: string,
  kind: CriticChangeKind = change.kind,
  commentIds: string[] = [],
) {
  const by = change.authorType === "ai" ? "AI" : change.authorId || "user";
  const changeSpan = `<span data-critic-change-kind="${escapeHtml(kind)}" data-critic-change-id="${escapeHtml(
    change.changeId,
  )}" data-critic-change-by="${escapeHtml(by)}" data-critic-change-at="${escapeHtml(
    change.createdAt,
  )}">${content}</span>`;

  if (commentIds.length === 0) {
    return changeSpan;
  }

  return `<span data-comment-ids="${escapeHtml(
    JSON.stringify(commentIds),
  )}">${changeSpan}</span>`;
}

function renderCriticCodeText(
  text: string,
  comments: Map<string, CriticComment>,
  endmatter?: ParsedEndmatter,
) {
  let result = "";
  let offset = 0;

  while (offset < text.length) {
    const anchorMatch = text.slice(offset).match(criticCommentAnchorPattern);

    if (!anchorMatch || anchorMatch.index !== 0) {
      result += escapeHtml(text[offset] ?? "");
      offset += 1;
      continue;
    }

    const [, anchor] = anchorMatch;
    let nextOffset = offset + anchorMatch[0].length;
    const parsedComments: CriticComment[] = [];

    while (nextOffset < text.length) {
      const commentMatch = text
        .slice(nextOffset)
        .match(criticCommentBlockPattern);
      if (!commentMatch) break;

      const comment = parseCommentBlockMatch(commentMatch, endmatter, [
        ...comments.values(),
        ...parsedComments,
      ]);
      parsedComments.push(comment);
      nextOffset += commentMatch[0].length;
    }

    if (parsedComments.length === 0) {
      result += escapeHtml(anchorMatch[0]);
      offset += anchorMatch[0].length;
      continue;
    }

    for (const comment of parsedComments) {
      comments.set(comment.id, comment);
    }

    result += `<span data-comment-ids="${escapeHtml(
      JSON.stringify(parsedComments.map((comment) => comment.id)),
    )}">${escapeHtml(anchor)}</span>`;
    offset = nextOffset;
  }

  return result;
}

function renderCriticCodeBlock(
  token: Tokens.Code,
  comments: Map<string, CriticComment>,
  endmatter?: ParsedEndmatter,
) {
  const language = (token.lang || "").match(/\S+/)?.[0];
  const classAttr = language ? ` class="language-${escapeHtml(language)}"` : "";
  const content = token.escaped
    ? token.text
    : renderCriticCodeText(token.text, comments, endmatter);

  return `<pre><code${classAttr}>${content}</code></pre>\n`;
}

function addCriticCommentRule(
  service: TurndownService,
  comments: Map<string, CriticComment>,
  useEndmatter = false,
) {
  service.addRule("criticComment", {
    filter: (node) =>
      node.nodeName === "SPAN" &&
      (node as HTMLElement).hasAttribute("data-comment-ids"),
    replacement(content, node) {
      const commentIdsText = (node as HTMLElement).getAttribute(
        "data-comment-ids",
      );

      if (!commentIdsText) return content;

      let commentIds: string[] = [];

      try {
        commentIds = JSON.parse(commentIdsText) as string[];
      } catch {
        return content;
      }

      const criticChangeElement = (node as HTMLElement).querySelector(
        "span[data-critic-change-kind]",
      );
      if (criticChangeElement instanceof HTMLElement) {
        return serializeCriticChangeElement(
          service,
          criticChangeElement,
          service.turndown(criticChangeElement.innerHTML).trim(),
          comments,
          commentIds,
          useEndmatter,
        );
      }

      const commentBlocks = serializeCommentBlocks(
        commentIds,
        comments,
        useEndmatter,
      );
      if (!commentBlocks) return content;
      if (content === unanchoredCommentSentinel) return commentBlocks;

      return `{==${content}==}${commentBlocks}`;
    },
  });
}

function addCriticCodeBlockRule(service: TurndownService) {
  service.addRule("criticCodeBlock", {
    filter: (node) => {
      if (node.nodeName !== "PRE") return false;
      const codeElement = (node as HTMLElement).firstElementChild;
      return (
        codeElement?.nodeName === "CODE" &&
        Boolean(
          codeElement.querySelector(
            "span[data-comment-ids], span[data-critic-change-kind]",
          ),
        )
      );
    },
    replacement(_content, node) {
      const codeElement = (node as HTMLElement)
        .firstElementChild as HTMLElement | null;

      if (!codeElement) return "";

      const language =
        [...codeElement.classList]
          .find((className) => className.startsWith("language-"))
          ?.slice("language-".length) ?? "";
      // Code text is taken verbatim: running it through Turndown as HTML
      // collapses newlines and escapes Markdown characters. Only the review
      // spans inside it are serialized by their Turndown rules.
      const serializeCode = (parent: Node): string =>
        Array.from(parent.childNodes)
          .map((child) => {
            if (child.nodeType === 3) return child.textContent ?? "";
            if (child.nodeType !== 1) return "";
            const element = child as HTMLElement;
            if (
              element.matches(
                "span[data-comment-ids], span[data-critic-change-kind]",
              )
            ) {
              return service.turndown(element.outerHTML);
            }
            return serializeCode(element);
          })
          .join("");
      const content = serializeCode(codeElement).replace(/\n+$/, "");

      return `\n\n\`\`\`${language}\n${content}\n\`\`\`\n\n`;
    },
  });
}

function getElementChangeAttrs(element: HTMLElement): CriticChangeAttrs | null {
  const kind = element.getAttribute("data-critic-change-kind");
  const changeId = element.getAttribute("data-critic-change-id");
  const createdAt = element.getAttribute("data-critic-change-at");

  if (
    kind !== "addition" &&
    kind !== "deletion" &&
    kind !== "substitution-old" &&
    kind !== "substitution-new"
  ) {
    return null;
  }

  if (!changeId || !createdAt) return null;

  const rawBy = element.getAttribute("data-critic-change-by") || "user";
  const authorType = rawBy.toUpperCase() === "AI" ? "ai" : "user";

  return {
    kind,
    changeId,
    createdAt,
    authorType,
    authorId: authorType === "ai" ? null : rawBy,
  };
}

function isPairedSubstitutionElement(
  element: Element | null,
  kind: CriticChangeKind,
  changeId: string,
) {
  return (
    element instanceof HTMLElement &&
    element.getAttribute("data-critic-change-kind") === kind &&
    element.getAttribute("data-critic-change-id") === changeId
  );
}

function getElementCommentIds(element: HTMLElement): string[] {
  const commentIdsText = element.getAttribute("data-comment-ids");
  if (!commentIdsText) return [];

  try {
    const parsed = JSON.parse(commentIdsText) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function getChangeCommentBlocks(
  element: HTMLElement,
  comments: Map<string, CriticComment>,
  extraCommentIds: string[] = [],
  useEndmatter = false,
) {
  return serializeCommentBlocks(
    [...new Set([...getElementCommentIds(element), ...extraCommentIds])],
    comments,
    useEndmatter,
  );
}

function serializeCriticChangeElement(
  service: TurndownService,
  element: HTMLElement,
  content: string,
  comments: Map<string, CriticComment>,
  extraCommentIds: string[] = [],
  useEndmatter = false,
) {
  const change = getElementChangeAttrs(element);

  if (!change) return content;

  const commentBlocks = getChangeCommentBlocks(
    element,
    comments,
    extraCommentIds,
    useEndmatter,
  );
  const metadata = useEndmatter
    ? `{#${change.changeId}}`
    : serializeChangeMetadata(change);

  if (change.kind === "addition") {
    return `{++${content}++}${metadata}${commentBlocks}`;
  }

  if (change.kind === "deletion") {
    return `{--${content}--}${metadata}${commentBlocks}`;
  }

  if (change.kind === "substitution-new") {
    return isPairedSubstitutionElement(
      element.previousElementSibling,
      "substitution-old",
      change.changeId,
    )
      ? ""
      : `{++${content}++}${
          useEndmatter
            ? `{#${change.changeId}}`
            : serializeChangeMetadata({
                ...change,
                kind: "addition",
              })
        }${commentBlocks}`;
  }

  const nextElement = element.nextElementSibling;

  if (
    nextElement instanceof HTMLElement &&
    isPairedSubstitutionElement(
      nextElement,
      "substitution-new",
      change.changeId,
    )
  ) {
    const replacement = service.turndown(nextElement.innerHTML).trim();
    return `{~~${content}~>${replacement}~~}${metadata}${commentBlocks}`;
  }

  return `{--${content}--}${
    useEndmatter
      ? `{#${change.changeId}}`
      : serializeChangeMetadata({
          ...change,
          kind: "deletion",
        })
  }${commentBlocks}`;
}

function addCriticChangeRule(
  service: TurndownService,
  comments: Map<string, CriticComment>,
  useEndmatter = false,
) {
  service.addRule("criticChange", {
    filter: (node) =>
      node.nodeName === "SPAN" &&
      (node as HTMLElement).hasAttribute("data-critic-change-kind"),
    replacement(content, node) {
      const element = node as HTMLElement;
      return serializeCriticChangeElement(
        service,
        element,
        content,
        comments,
        [],
        useEndmatter,
      );
    },
  });
}

function createCriticMarked(
  markdownOptions?: MarkdownOptions,
  endmatter?: ParsedEndmatter,
) {
  const comments = new Map<string, CriticComment>();
  const changes = new Map<string, CriticChangeAttrs>();
  const renderer = createMarkedRenderer(markdownOptions);
  renderer.code = (token) => renderCriticCodeBlock(token, comments, endmatter);
  const parser = new Marked({
    gfm: true,
    async: false,
    renderer,
  });

  parser.use({
    extensions: [
      ...createMathExtensions(),
      {
        name: "criticCommentAnchor",
        level: "inline",
        start(src: string) {
          return src.indexOf("{==");
        },
        tokenizer(this: TokenizerThis, src: string) {
          const result = tokenizeCriticCommentAnchor(
            this.lexer,
            src,
            comments.values(),
            endmatter,
          );
          if (!result) return undefined;

          for (const comment of result.comments) {
            comments.set(comment.id, comment);
          }
          return result.token;
        },
        renderer(this: RendererThis, token: Tokens.Generic) {
          const criticToken = token as CriticCommentToken;
          return `<span data-comment-ids="${escapeHtml(
            JSON.stringify(criticToken.commentIds),
          )}">${this.parser.parseInline(criticToken.tokens)}</span>`;
        },
        childTokens: ["tokens"],
      } satisfies TokenizerAndRendererExtension,
      {
        name: "criticStandaloneComment",
        level: "inline",
        start(src: string) {
          return src.indexOf("{>>");
        },
        tokenizer(src: string) {
          const result = tokenizeCriticStandaloneComment(
            src,
            comments.values(),
            endmatter,
          );
          if (!result) return undefined;

          for (const comment of result.comments) {
            comments.set(comment.id, comment);
          }
          return result.token;
        },
        renderer(token: Tokens.Generic) {
          const criticToken = token as CriticStandaloneCommentToken;
          return `<span data-comment-ids="${escapeHtml(
            JSON.stringify(criticToken.commentIds),
          )}" data-comment-anchorless="true">${unanchoredCommentSentinel}</span>`;
        },
      } satisfies TokenizerAndRendererExtension,
      {
        name: "criticChange",
        level: "inline",
        start(src: string) {
          const starts = ["{++", "{--", "{~~"]
            .map((marker) => src.indexOf(marker))
            .filter((index) => index >= 0);

          return starts.length > 0 ? Math.min(...starts) : undefined;
        },
        tokenizer(this: TokenizerThis, src: string) {
          const result = tokenizeCriticChange(
            this.lexer,
            src,
            changes.values(),
            comments.values(),
            endmatter,
          );
          if (!result) return undefined;

          for (const comment of result.comments) {
            comments.set(comment.id, comment);
          }
          changes.set(result.token.change.changeId, result.token.change);
          return result.token;
        },
        renderer(this: RendererThis, token: Tokens.Generic) {
          const criticToken = token as CriticChangeToken;

          if (criticToken.change.kind === "substitution-old") {
            const oldContent = this.parser.parseInline(
              criticToken.oldTokens ?? [],
            );
            const newContent = this.parser.parseInline(
              criticToken.newTokens ?? [],
            );
            const substitutionHtml = `${renderCriticChangeSpan(
              criticToken.change,
              oldContent,
              "substitution-old",
            )}${renderCriticChangeSpan(
              criticToken.change,
              newContent,
              "substitution-new",
            )}`;

            if (criticToken.commentIds.length === 0) {
              return substitutionHtml;
            }

            return `<span data-comment-ids="${escapeHtml(
              JSON.stringify(criticToken.commentIds),
            )}">${substitutionHtml}</span>`;
          }

          return renderCriticChangeSpan(
            criticToken.change,
            this.parser.parseInline(criticToken.tokens ?? []),
            criticToken.change.kind,
            criticToken.commentIds,
          );
        },
        childTokens: ["tokens", "oldTokens", "newTokens"],
      } satisfies TokenizerAndRendererExtension,
    ],
  });

  return { parser, comments, changes };
}

export function criticMarkdownHasReviewRail(
  markdown: string,
  options?: MarkdownOptions,
): boolean {
  const { body, endmatter } = splitYamlDocumentMetadata(markdown);
  const parsedEndmatter = parseReviewEndmatter(endmatter);
  const { parser, comments, changes } = createCriticMarked(
    options,
    parsedEndmatter,
  );
  parser.parse(protectRichTextRoundTripMarkdown(body));
  addEndmatterFeedback(comments, parsedEndmatter);
  return comments.size > 0 || changes.size > 0;
}

/** Only the comments of a document (inline and endmatter), without a doc. */
export function criticMarkdownComments(
  markdown: string,
): Map<string, CriticComment> {
  const { body, endmatter } = splitYamlDocumentMetadata(markdown);
  const parsedEndmatter = parseReviewEndmatter(endmatter);
  const { parser, comments } = createCriticMarked(undefined, parsedEndmatter);
  parser.parse(protectRichTextRoundTripMarkdown(body));
  addEndmatterFeedback(comments, parsedEndmatter);
  return comments;
}

export function criticMarkdownToRenderedHtml(
  markdown: string,
  options?: MarkdownOptions,
): {
  html: string;
  comments: Map<string, CriticComment>;
  changes: Map<string, CriticChangeAttrs>;
  frontmatter: string | null;
  endmatter: string | null;
} {
  const { frontmatter, body, endmatter } = splitYamlDocumentMetadata(markdown);
  const parsedEndmatter = parseReviewEndmatter(endmatter);
  const { parser, comments, changes } = createCriticMarked(
    options,
    parsedEndmatter,
  );
  const html = parser.parse(protectRichTextRoundTripMarkdown(body)) as string;
  addEndmatterFeedback(comments, parsedEndmatter);

  return { html, comments, changes, frontmatter, endmatter };
}

/** Whether serialization writes review metadata as `{#id}` + endmatter. */
function usesEndmatterMetadata(
  endmatter: string | null | undefined,
  comments: ReadonlyMap<string, CriticComment>,
): boolean {
  // A comment with an agent intent always gets compact `{#id}` + endmatter
  // metadata (the spec's preferred form), even in a document that had no
  // endmatter yet, so agent replies with multiline Markdown can live there too.
  return (
    Boolean(endmatter) ||
    [...comments.values()].some(
      (comment) => comment.intent && !comment.parentCommentId,
    )
  );
}

/**
 * What a block's source text depends on besides its nodes: the inline text
 * its comments and suggestions serialize to. Editing, resolving or replying to
 * a comment whose text lives inline changes this, so the block is written
 * fresh; an endmatter-only change (a reply, a status in endmatter mode) does
 * not, so the block keeps its bytes.
 */
function createReviewStateDescriber(
  comments: ReadonlyMap<string, CriticComment>,
  useEndmatter: boolean,
): ReviewStateDescriber {
  return (nodes) => {
    const commentIdGroups: string[] = [];
    const changeIds = new Set<string>();
    const visit = (node: JSONContent) => {
      for (const mark of node.marks ?? []) {
        const ids = mark.attrs?.commentIds;
        if (Array.isArray(ids) && ids.length > 0) {
          const group = JSON.stringify(ids);
          if (commentIdGroups.at(-1) !== group) commentIdGroups.push(group);
        }
        if (mark.type === "criticChange" && mark.attrs?.changeId) {
          changeIds.add(String(mark.attrs.changeId));
        }
      }
      for (const child of node.content ?? []) visit(child);
    };
    for (const node of nodes) visit(node);
    if (commentIdGroups.length === 0 && changeIds.size === 0) return "";

    const parts = [useEndmatter ? "endmatter" : "inline"];
    for (const group of commentIdGroups) {
      parts.push(
        serializeCommentBlocks(
          JSON.parse(group) as string[],
          comments,
          useEndmatter,
        ),
      );
    }
    for (const changeId of changeIds) {
      for (const comment of comments.values()) {
        if (comment.parentCommentId !== changeId) continue;
        parts.push(
          serializeCommentBlocks([comment.id], comments, useEndmatter),
        );
      }
    }
    return parts.join("\u0001");
  };
}

/**
 * Lexes once and renders each top-level token on its own: the concatenated
 * HTML is what `parser.parse` would produce, and the per-token HTML tells
 * which top-level nodes each token's source text produced. (Rendering twice
 * is not an option: the code-block renderer registers comments it finds.)
 */
function renderTopLevelTokens(
  parser: Marked,
  protectedBody: string,
): { html: string; tokens: Array<{ raw: string; html: string }> } {
  const lexed = parser.lexer(protectedBody);
  const tokens = lexed.map((token) => {
    const single = Object.assign([token], { links: lexed.links });
    return { raw: token.raw, html: parser.parser(single) };
  });
  return { html: tokens.map((token) => token.html).join(""), tokens };
}

interface CriticEditorState {
  doc: JSONContent;
  comments: Map<string, CriticComment>;
  frontmatter: string | null;
  endmatter: string | null;
  headingSpacing: HeadingSpacing;
  /** Null unless requested, or when the blocks could not be mapped exactly. */
  blockSource: BlockSource | null;
}

interface CriticParseOptions {
  /** Also remember each top-level block's source text (see block-source.ts). */
  blockSource?: boolean;
}

export function criticMarkdownToEditorState(
  markdown: string,
  options?: MarkdownOptions,
  parseOptions?: CriticParseOptions,
): CriticEditorState {
  return parseCriticDocumentParts(
    splitYamlDocumentMetadata(markdown),
    options,
    parseOptions,
  );
}

function parseCriticDocumentParts(
  {
    frontmatter,
    body,
    endmatter,
  }: { frontmatter: string | null; body: string; endmatter: string | null },
  options?: MarkdownOptions,
  parseOptions?: CriticParseOptions,
): CriticEditorState {
  const headingSpacing = detectHeadingSpacing(body);
  const parsedEndmatter = parseReviewEndmatter(endmatter);
  const { parser, comments } = createCriticMarked(options, parsedEndmatter);
  const rendered = renderTopLevelTokens(
    parser,
    protectRichTextRoundTripMarkdown(body),
  );
  const doc = generateJSON(rendered.html, extensions) as JSONContent & {
    yamlFrontmatter?: string;
    yamlEndmatter?: string;
  };
  addEndmatterFeedback(comments, parsedEndmatter);

  let blockSource: BlockSource | null = null;
  if (parseOptions?.blockSource) {
    blockSource = mapBlockSource(
      body,
      rendered.tokens,
      doc,
      createReviewStateDescriber(
        comments,
        usesEndmatterMetadata(endmatter, comments),
      ),
    );
  }

  if (frontmatter) {
    doc.yamlFrontmatter = frontmatter;
  }
  if (endmatter) {
    doc.yamlEndmatter = endmatter;
  }

  return { doc, comments, frontmatter, endmatter, headingSpacing, blockSource };
}

function mapBlockSource(
  body: string,
  tokens: ReadonlyArray<{ raw: string; html: string }>,
  doc: JSONContent,
  describeReviewState: ReviewStateDescriber,
): BlockSource | null {
  const tokenNodes = tokens.map((token) => ({
    raw: token.raw,
    nodes:
      token.html.trim() === ""
        ? []
        : ((generateJSON(token.html, extensions) as JSONContent).content ?? []),
  }));
  // The per-token nodes must add up to exactly the document's nodes;
  // otherwise some token's nodes depend on its neighbours and the mapping
  // would be a guess.
  const mapped = tokenNodes.flatMap((token) => token.nodes);
  if (JSON.stringify(mapped) !== JSON.stringify(doc.content ?? [])) {
    return null;
  }
  return buildBlockSource(body, tokenNodes, describeReviewState);
}

function collectCriticChangesFromDoc(
  doc: JSONContent,
): Map<string, CriticChangeAttrs> {
  const changes = new Map<string, CriticChangeAttrs>();
  const visit = (node: JSONContent) => {
    for (const mark of node.marks ?? []) {
      if (mark.type !== "criticChange") continue;

      const attrs = mark.attrs as Partial<CriticChangeAttrs> | undefined;
      if (
        attrs?.changeId &&
        attrs.kind &&
        attrs.createdAt &&
        attrs.authorType
      ) {
        changes.set(attrs.changeId, {
          kind: attrs.kind,
          changeId: attrs.changeId,
          createdAt: attrs.createdAt,
          authorType: attrs.authorType,
          authorId: attrs.authorId ?? null,
        });
      }
    }

    for (const child of node.content ?? []) {
      visit(child);
    }
  };

  visit(doc);
  return changes;
}

export interface EditorStateSerializeOptions {
  frontmatter?: string | null;
  endmatter?: string | null;
  headingSpacing?: HeadingSpacing;
  /**
   * Source text of the blocks as loaded (from `criticMarkdownToEditorState`
   * with `blockSource: true`). Untouched blocks are written back with their
   * original bytes; without it the whole document is re-serialized.
   */
  blockSource?: BlockSource | null;
  /** The options the document was parsed with (used by the safety check). */
  markdownOptions?: MarkdownOptions;
  /**
   * Called when the spliced output would not parse back to the document and
   * the full serialization is written instead. Defaults to `console.warn`.
   */
  onBlockSourceFallback?: (reason: string) => void;
}

/** Top-level nodes, minus the empty paragraph TipTap keeps at the end. */
function comparableContent(doc: JSONContent): string {
  const content = [...(doc.content ?? [])];
  while (
    content.length > 0 &&
    content.at(-1)?.type === "paragraph" &&
    !content.at(-1)?.content?.length
  ) {
    content.pop();
  }
  return JSON.stringify(content);
}

function comparableComments(comments: ReadonlyMap<string, CriticComment>) {
  // Timestamps are left out: a bare `{>>…<<}` gets a fresh one on every parse.
  return JSON.stringify(
    [...comments.values()]
      .map((comment) => [
        comment.id,
        comment.content,
        comment.parentCommentId ?? null,
        comment.intent ?? null,
        comment.status ?? null,
        comment.authorType,
        comment.authorId ?? null,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

function sameParse(
  a: { doc: JSONContent; comments: ReadonlyMap<string, CriticComment> },
  b: { doc: JSONContent; comments: ReadonlyMap<string, CriticComment> },
): boolean {
  return (
    comparableContent(a.doc) === comparableContent(b.doc) &&
    comparableComments(a.comments) === comparableComments(b.comments)
  );
}

export function editorStateToCriticMarkdown(
  doc: JSONContent,
  comments: Map<string, CriticComment>,
  options?: EditorStateSerializeOptions,
): string {
  // Not stored on the doc: PageCard compares doc JSON to decide whether to
  // reset editor content, and an extra key would force a reset every time.
  const headingSpacing = options?.headingSpacing;
  const service = createTurndownService();
  const frontmatter =
    options?.frontmatter ??
    (doc as JSONContent & { yamlFrontmatter?: string }).yamlFrontmatter ??
    null;
  const sourceEndmatter =
    options?.endmatter ??
    (doc as JSONContent & { yamlEndmatter?: string }).yamlEndmatter ??
    null;
  const changes = collectCriticChangesFromDoc(doc);
  const useEndmatter = usesEndmatterMetadata(sourceEndmatter, comments);
  addCriticCommentRule(service, comments, useEndmatter);
  addCriticChangeRule(service, comments, useEndmatter);
  addCriticCodeBlockRule(service);
  const endmatter = serializeReviewEndmatter(
    sourceEndmatter,
    comments,
    changes,
    useEndmatter,
  );
  const withMetadata = (body: string) =>
    appendYamlEndmatter(prependYamlFrontmatter(body, frontmatter), endmatter);
  const serializeHtml = (html: string) =>
    normalizeBlockSpacing(
      `${service.turndown(html).trimEnd()}\n`,
      headingSpacing,
    );
  const fullSerialization = () =>
    withMetadata(serializeHtml(generateHTML(doc, extensions)));

  const blockSource = options?.blockSource;
  if (!blockSource) return fullSerialization();

  const pieces = planBlockPieces(
    doc.content ?? [],
    blockSource,
    createReviewStateDescriber(comments, useEndmatter),
  );
  if (!pieces.some((piece) => piece.kind === "source")) {
    return fullSerialization();
  }

  // Untouched blocks: original bytes. Changed runs: serialized together, so
  // neighbouring changed blocks relate to each other as in a full save.
  const texts: Array<{ text: string; blockIndex: number | null }> = [];
  const runTexts = new Map<(typeof pieces)[number], string>();
  for (const piece of pieces) {
    if (piece.kind === "source") {
      texts.push({
        text: blockSource.blocks[piece.blockIndex].raw,
        blockIndex: piece.blockIndex,
      });
      continue;
    }
    const text = serializeHtml(
      generateHTML({ type: "doc", content: piece.nodes }, extensions),
    )
      .replace(/^\n+/, "")
      .replace(/\n+$/, "");
    if (text !== "") {
      texts.push({ text, blockIndex: null });
      runTexts.set(piece, text);
    }
  }

  const atxHeadingLine = /^#{1,6}(?: |$)/;
  let body = "";
  texts.forEach((entry, index) => {
    if (index === 0) {
      body += entry.blockIndex === 0 ? blockSource.leading : "";
      body += entry.text;
      return;
    }
    const previous = texts[index - 1];
    if (
      previous.blockIndex != null &&
      entry.blockIndex === previous.blockIndex + 1
    ) {
      // Neighbours in the source too: keep the original spacing.
      body += blockSource.blocks[previous.blockIndex].separatorAfter;
    } else {
      const previousLastLine = previous.text.slice(
        previous.text.lastIndexOf("\n") + 1,
      );
      const compact =
        headingSpacing !== "blank" &&
        (atxHeadingLine.test(previousLastLine) ||
          atxHeadingLine.test(entry.text));
      body += compact ? "\n" : "\n\n";
    }
    body += entry.text;
  });
  const last = texts.at(-1);
  body +=
    last?.blockIndex === blockSource.blocks.length - 1
      ? blockSource.trailing
      : "\n";

  const spliced = withMetadata(body);

  // Safety guard. Usually the spliced file parses straight back to the
  // document being saved. When it does not (the editor holds something
  // Markdown cannot express, e.g. an unsubmitted comment draft, or a changed
  // block whose serialization is itself lossy), the splice must at least
  // compose cleanly: it has to parse to the untouched blocks' nodes plus
  // whatever each changed run parses to on its own. Anything else means the
  // pieces affect each other (a link definition went missing, a block merged
  // into its neighbour, ...), so write the full serialization instead.
  const check = criticMarkdownToEditorState(spliced, options?.markdownOptions);
  if (sameParse(check, { doc, comments })) return spliced;
  const expected: JSONContent[] = [];
  for (const piece of pieces) {
    if (piece.kind === "source") {
      expected.push(...piece.nodes);
      continue;
    }
    const text = runTexts.get(piece);
    if (!text) continue;
    expected.push(
      ...(parseCriticDocumentParts(
        { frontmatter: null, body: `${text}\n`, endmatter },
        options?.markdownOptions,
      ).doc.content ?? []),
    );
  }
  if (
    comparableContent(check.doc) ===
    comparableContent({ type: "doc", content: expected })
  ) {
    return spliced;
  }

  const full = fullSerialization();
  const reason =
    "block source preservation: spliced Markdown parses differently; writing the full serialization";
  if (options?.onBlockSourceFallback) {
    options.onBlockSourceFallback(reason);
  } else {
    console.warn(`[roughdraft] ${reason}`);
  }
  return full;
}

export function createCriticComment(
  partial?: Partial<CriticComment>,
  options?: {
    existingComments?: Iterable<Pick<CriticComment, "id">>;
  },
): CriticComment {
  return createCommentWithContext(partial, options?.existingComments);
}

export function createCriticChange(
  kind: CriticChangeKind,
  partial?: Partial<CriticChangeAttrs>,
  options?: {
    existingChanges?: Iterable<Pick<CriticChangeAttrs, "changeId">>;
  },
): CriticChangeAttrs {
  return createChangeWithContext(kind, partial, options?.existingChanges);
}
