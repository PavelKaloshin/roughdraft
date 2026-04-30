export type RfmDiagnosticSeverity = "error" | "warning";

export interface RfmDiagnostic {
  severity: RfmDiagnosticSeverity;
  code: string;
  message: string;
  offset: number;
  line: number;
  column: number;
}

export interface RfmValidationSummary {
  comments: number;
  suggestions: number;
  legacyMetadata: number;
}

export interface RfmValidationResult {
  format: "roughdraft-flavored-markdown";
  version: "0.1";
  ok: boolean;
  diagnostics: RfmDiagnostic[];
  errors: RfmDiagnostic[];
  warnings: RfmDiagnostic[];
  summary: RfmValidationSummary;
}

interface Metadata {
  attrs: Map<string, string>;
  kind: "canonical" | "legacy";
  offset: number;
  endOffset: number;
}

interface IdReference {
  id: string;
  kind: "comment" | "suggestion";
  offset: number;
}

interface ReplyReference {
  id: string;
  parentId: string;
  offset: number;
}

interface FenceState {
  marker: "`" | "~";
  length: number;
}

const requiredMetadataAttributes = ["id", "by", "at"] as const;
const dateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const attributeNamePattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function validateRoughdraftMarkdown(
  markdown: string,
): RfmValidationResult {
  const lineStarts = createLineStarts(markdown);
  const diagnostics: RfmDiagnostic[] = [];
  const ids = new Map<string, IdReference>();
  const replies: ReplyReference[] = [];
  const summary: RfmValidationSummary = {
    comments: 0,
    suggestions: 0,
    legacyMetadata: 0,
  };

  const addDiagnostic = (
    severity: RfmDiagnosticSeverity,
    code: string,
    message: string,
    offset: number,
  ) => {
    diagnostics.push({
      severity,
      code,
      message,
      offset,
      ...locationForOffset(lineStarts, offset),
    });
  };

  const validateMetadata = (
    metadata: Metadata | null,
    kind: "comment" | "suggestion",
    markerOffset: number,
  ) => {
    if (!metadata) {
      for (const attribute of requiredMetadataAttributes) {
        addDiagnostic(
          "error",
          `missing-metadata-${attribute}`,
          `Missing required metadata attribute \`${attribute}\`.`,
          markerOffset,
        );
      }
      return;
    }

    if (metadata.kind === "legacy") {
      summary.legacyMetadata += 1;
      addDiagnostic(
        "warning",
        "legacy-metadata",
        "Legacy metadata is accepted, but canonical attribute metadata is preferred.",
        metadata.offset,
      );
    }

    for (const attribute of requiredMetadataAttributes) {
      if (!metadata.attrs.get(attribute)) {
        addDiagnostic(
          "error",
          `missing-metadata-${attribute}`,
          `Missing required metadata attribute \`${attribute}\`.`,
          metadata.offset,
        );
      }
    }

    const at = metadata.attrs.get("at");
    if (at && !isValidDateTime(at)) {
      addDiagnostic(
        "error",
        "invalid-metadata-at",
        `Metadata attribute \`at\` must be an ISO 8601 date-time.`,
        metadata.offset,
      );
    }

    const id = metadata.attrs.get("id");
    if (id) {
      const existing = ids.get(id);
      if (existing) {
        addDiagnostic(
          "error",
          "duplicate-id",
          `Duplicate review id \`${id}\`.`,
          metadata.offset,
        );
      } else {
        ids.set(id, { id, kind, offset: metadata.offset });
      }
    }

    const parentId = metadata.attrs.get("re");
    if (kind === "comment" && id && parentId) {
      replies.push({ id, parentId, offset: metadata.offset });
    }
  };

  let offset = 0;
  let fence: FenceState | null = null;

  while (offset < markdown.length) {
    if (isLineStart(markdown, offset)) {
      const fenceMatch = matchFence(markdown, offset, fence);
      if (fenceMatch) {
        fence = fence ? null : fenceMatch.fence;
        offset = nextLineOffset(markdown, offset);
        continue;
      }
    }

    if (fence) {
      offset = nextLineOffset(markdown, offset);
      continue;
    }

    const codeSpanEnd = matchInlineCodeSpan(markdown, offset);
    if (codeSpanEnd !== null) {
      offset = codeSpanEnd;
      continue;
    }

    if (markdown.startsWith("{==", offset)) {
      const end = markdown.indexOf("==}", offset + 3);
      if (end === -1) {
        addDiagnostic(
          "error",
          "unclosed-highlight",
          "Highlight marker is missing closing `==}`.",
          offset,
        );
        offset += 3;
        continue;
      }

      let nextOffset = end + 3;
      let anchoredComments = 0;
      while (markdown.startsWith("{>>", nextOffset)) {
        const parsed = parseComment(markdown, nextOffset, addDiagnostic);
        if (!parsed) break;
        summary.comments += 1;
        anchoredComments += 1;
        validateMetadata(parsed.metadata, "comment", nextOffset);
        nextOffset = parsed.endOffset;
      }

      offset = anchoredComments > 0 ? nextOffset : end + 3;
      continue;
    }

    if (markdown.startsWith("{>>", offset)) {
      const parsed = parseComment(markdown, offset, addDiagnostic);
      if (parsed) {
        summary.comments += 1;
        validateMetadata(parsed.metadata, "comment", offset);
        offset = parsed.endOffset;
        continue;
      }
    }

    const parsedSuggestion = parseSuggestion(markdown, offset, addDiagnostic);
    if (parsedSuggestion) {
      summary.suggestions += 1;
      validateMetadata(parsedSuggestion.metadata, "suggestion", offset);
      offset = parsedSuggestion.endOffset;
      continue;
    }

    offset += 1;
  }

  for (const reply of replies) {
    if (reply.id === reply.parentId) {
      addDiagnostic(
        "error",
        "self-reply",
        `Comment \`${reply.id}\` must not reply to itself.`,
        reply.offset,
      );
      continue;
    }

    if (!ids.has(reply.parentId)) {
      addDiagnostic(
        "warning",
        "missing-reply-target",
        `Comment reply \`re="${reply.parentId}"\` points to a missing id.`,
        reply.offset,
      );
    }
  }

  diagnostics.sort((a, b) => a.offset - b.offset);
  const errors = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  const warnings = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "warning",
  );

  return {
    format: "roughdraft-flavored-markdown",
    version: "0.1",
    ok: errors.length === 0,
    diagnostics,
    errors,
    warnings,
    summary,
  };
}

function createLineStarts(markdown: string): number[] {
  const lineStarts = [0];

  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}

function locationForOffset(
  lineStarts: readonly number[],
  offset: number,
): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const lineStart = lineStarts[middle] ?? 0;
    const nextLineStart = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY;

    if (offset < lineStart) {
      high = middle - 1;
    } else if (offset >= nextLineStart) {
      low = middle + 1;
    } else {
      return {
        line: middle + 1,
        column: offset - lineStart + 1,
      };
    }
  }

  const lastLineStart = lineStarts[lineStarts.length - 1] ?? 0;
  return {
    line: lineStarts.length,
    column: offset - lastLineStart + 1,
  };
}

function isLineStart(markdown: string, offset: number): boolean {
  return offset === 0 || markdown[offset - 1] === "\n";
}

function nextLineOffset(markdown: string, offset: number): number {
  const nextNewline = markdown.indexOf("\n", offset);
  return nextNewline === -1 ? markdown.length : nextNewline + 1;
}

function matchFence(
  markdown: string,
  offset: number,
  fence: FenceState | null,
): { fence: FenceState } | null {
  const lineEnd = nextLineOffset(markdown, offset);
  const line = markdown.slice(offset, lineEnd).replace(/\r?\n$/, "");
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!match) return null;

  const markerText = match[1] ?? "";
  const marker = markerText[0] as "`" | "~";

  if (!fence) {
    return {
      fence: {
        marker,
        length: markerText.length,
      },
    };
  }

  if (fence.marker !== marker || markerText.length < fence.length) {
    return null;
  }

  return { fence };
}

function matchInlineCodeSpan(markdown: string, offset: number): number | null {
  if (markdown[offset] !== "`") return null;

  let length = 1;
  while (markdown[offset + length] === "`") {
    length += 1;
  }

  const closing = markdown.indexOf("`".repeat(length), offset + length);
  return closing === -1 ? null : closing + length;
}

function parseComment(
  markdown: string,
  offset: number,
  addDiagnostic: (
    severity: RfmDiagnosticSeverity,
    code: string,
    message: string,
    offset: number,
  ) => void,
): { metadata: Metadata | null; endOffset: number } | null {
  const close = markdown.indexOf("<<}", offset + 3);
  if (close === -1) {
    addDiagnostic(
      "error",
      "unclosed-comment",
      "Comment marker is missing closing `<<}`.",
      offset,
    );
    return null;
  }

  const metadata = parseMetadata(markdown, close + 3, true, addDiagnostic);

  return {
    metadata,
    endOffset: metadata?.endOffset ?? close + 3,
  };
}

function parseSuggestion(
  markdown: string,
  offset: number,
  addDiagnostic: (
    severity: RfmDiagnosticSeverity,
    code: string,
    message: string,
    offset: number,
  ) => void,
): { metadata: Metadata | null; endOffset: number } | null {
  const addition = parseWrappedMarker(markdown, offset, "{++", "++}");
  if (addition) {
    const metadata = parseMetadata(
      markdown,
      addition.endOffset,
      false,
      addDiagnostic,
    );
    return {
      metadata,
      endOffset: metadata?.endOffset ?? addition.endOffset,
    };
  }
  if (markdown.startsWith("{++", offset)) {
    addDiagnostic(
      "error",
      "unclosed-addition",
      "Addition marker is missing closing `++}`.",
      offset,
    );
    return null;
  }

  const deletion = parseWrappedMarker(markdown, offset, "{--", "--}");
  if (deletion) {
    const metadata = parseMetadata(
      markdown,
      deletion.endOffset,
      false,
      addDiagnostic,
    );
    return {
      metadata,
      endOffset: metadata?.endOffset ?? deletion.endOffset,
    };
  }
  if (markdown.startsWith("{--", offset)) {
    addDiagnostic(
      "error",
      "unclosed-deletion",
      "Deletion marker is missing closing `--}`.",
      offset,
    );
    return null;
  }

  if (markdown.startsWith("{~~", offset)) {
    const separator = markdown.indexOf("~>", offset + 3);
    const close =
      separator === -1 ? -1 : markdown.indexOf("~~}", separator + 2);

    if (separator === -1 || close === -1) {
      addDiagnostic(
        "error",
        "unclosed-substitution",
        "Substitution marker is missing `~>` or closing `~~}`.",
        offset,
      );
      return null;
    }

    const endOffset = close + 3;
    const metadata = parseMetadata(markdown, endOffset, false, addDiagnostic);
    return {
      metadata,
      endOffset: metadata?.endOffset ?? endOffset,
    };
  }

  return null;
}

function parseWrappedMarker(
  markdown: string,
  offset: number,
  open: string,
  close: string,
): { endOffset: number } | null {
  if (!markdown.startsWith(open, offset)) return null;

  const closeOffset = markdown.indexOf(close, offset + open.length);
  return closeOffset === -1 ? null : { endOffset: closeOffset + close.length };
}

function parseMetadata(
  markdown: string,
  offset: number,
  allowLegacy: boolean,
  addDiagnostic: (
    severity: RfmDiagnosticSeverity,
    code: string,
    message: string,
    offset: number,
  ) => void,
): Metadata | null {
  if (allowLegacy && markdown.startsWith("{@", offset)) {
    const close = markdown.indexOf("@}", offset + 2);
    if (close === -1) {
      addDiagnostic(
        "error",
        "invalid-metadata-syntax",
        "Legacy metadata is missing closing `@}`.",
        offset,
      );
      return null;
    }

    return {
      attrs: parseLegacyAttributes(markdown.slice(offset + 2, close)),
      kind: "legacy",
      offset,
      endOffset: close + 2,
    };
  }

  if (markdown[offset] !== "{") return null;

  const parsed = parseCanonicalMetadata(markdown, offset);
  if (parsed) return parsed;

  if (looksLikeMetadata(markdown, offset)) {
    addDiagnostic(
      "error",
      "invalid-metadata-syntax",
      'Metadata must use quoted attributes such as `{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}`.',
      offset,
    );
  }

  return null;
}

function parseCanonicalMetadata(
  markdown: string,
  offset: number,
): Metadata | null {
  let cursor = offset + 1;
  const attrs = new Map<string, string>();
  let sawAttribute = false;

  while (cursor < markdown.length) {
    cursor = skipSpaces(markdown, cursor);

    if (markdown[cursor] === "}") {
      if (!sawAttribute) return null;
      return {
        attrs,
        kind: "canonical",
        offset,
        endOffset: cursor + 1,
      };
    }

    const nameStart = cursor;
    while (
      cursor < markdown.length &&
      /[A-Za-z0-9_-]/.test(markdown[cursor] ?? "")
    ) {
      cursor += 1;
    }
    const name = markdown.slice(nameStart, cursor);
    if (!attributeNamePattern.test(name) || markdown[cursor] !== "=") {
      return null;
    }
    cursor += 1;

    if (markdown[cursor] !== '"') return null;
    cursor += 1;

    let value = "";
    while (cursor < markdown.length) {
      const character = markdown[cursor];
      if (character === "\\") {
        const next = markdown[cursor + 1];
        if (next === undefined) return null;
        value += next;
        cursor += 2;
        continue;
      }

      if (character === '"') {
        cursor += 1;
        attrs.set(name, value);
        sawAttribute = true;
        break;
      }

      if (character === "\n" || character === "\r") return null;
      value += character;
      cursor += 1;
    }

    if (!attrs.has(name)) return null;
  }

  return null;
}

function parseLegacyAttributes(metadata: string): Map<string, string> {
  const attrs = new Map<string, string>();

  for (const part of metadata.split(";")) {
    const [rawKey, ...valueParts] = part.split(":");
    const key = rawKey?.trim();
    const value = valueParts.join(":").trim();
    if (!key || !value) continue;
    attrs.set(key, value);
  }

  return attrs;
}

function skipSpaces(markdown: string, offset: number): number {
  let cursor = offset;
  while (markdown[cursor] === " " || markdown[cursor] === "\t") {
    cursor += 1;
  }
  return cursor;
}

function looksLikeMetadata(markdown: string, offset: number): boolean {
  const close = markdown.indexOf("}", offset + 1);
  if (close === -1) return false;

  const content = markdown.slice(offset + 1, close);
  return /\b(?:id|by|at|re)\b/.test(content);
}

function isValidDateTime(value: string): boolean {
  return dateTimePattern.test(value) && !Number.isNaN(Date.parse(value));
}
