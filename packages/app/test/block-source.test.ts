import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Editor, type JSONContent } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import {
  type CriticComment,
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "../src/critic-markup";
import { createEditorExtensions } from "../src/editor-extensions";

// Block source preservation: the rich-text editor writes every top-level block
// it did not touch back with its original bytes, and re-serializes only the
// blocks that changed (ADR 0003).

const repoRoot = path.resolve(process.cwd(), "../..");

function readFixture(name: string): string {
  return fs.readFileSync(
    path.join(process.cwd(), "test", "fixtures", "markdown", name),
    "utf8",
  );
}

function openInEditor(markdown: string) {
  const parsed = criticMarkdownToEditorState(markdown, undefined, {
    blockSource: true,
  });
  const editor = new Editor({
    extensions: createEditorExtensions(""),
    content: parsed.doc,
  });
  let comments = parsed.comments;

  return {
    editor,
    get comments() {
      return comments;
    },
    updateComment(id: string, patch: Partial<CriticComment>) {
      const existing = comments.get(id);
      if (!existing) throw new Error(`no comment ${id}`);
      comments = new Map(comments);
      comments.set(id, { ...existing, ...patch });
    },
    addComment(comment: CriticComment) {
      comments = new Map(comments);
      comments.set(comment.id, comment);
    },
    save(
      options: {
        doc?: JSONContent;
        onBlockSourceFallback?: (reason: string) => void;
      } = {},
    ) {
      return editorStateToCriticMarkdown(
        options.doc ?? editor.getJSON(),
        comments,
        {
          frontmatter: parsed.frontmatter,
          endmatter: parsed.endmatter,
          headingSpacing: parsed.headingSpacing,
          blockSource: parsed.blockSource,
          onBlockSourceFallback: options.onBlockSourceFallback,
        },
      );
    },
  };
}

function findText(editor: Editor, text: string): { from: number; to: number } {
  let range: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (range || !node.isText || !node.text) return;
    const offset = node.text.indexOf(text);
    if (offset >= 0) {
      range = { from: pos + offset, to: pos + offset + text.length };
    }
  });
  if (!range) throw new Error(`text not found: ${text}`);
  return range;
}

function appendAfter(editor: Editor, text: string, addition: string) {
  const { to } = findText(editor, text);
  editor.chain().insertContentAt(to, addition).run();
}

/** Top-level node index of the block containing `text`. */
function topLevelIndexOf(editor: Editor, text: string): number {
  const { from } = findText(editor, text);
  return editor.state.doc.resolve(from).index(0);
}

function topLevelRange(editor: Editor, index: number) {
  let from = 0;
  for (let i = 0; i < index; i += 1) {
    from += editor.state.doc.child(i).nodeSize;
  }
  return { from, to: from + editor.state.doc.child(index).nodeSize };
}

function corpusFiles(): string[] {
  const tracked = execFileSync("git", ["ls-files", "*.md"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .map((file) => path.join(repoRoot, file));
  const contextDir = path.join(repoRoot, ".context");
  const context = fs.existsSync(contextDir)
    ? fs
        .readdirSync(contextDir)
        .filter((file) => file.endsWith(".md"))
        .map((file) => path.join(contextDir, file))
    : [];
  return [...tracked, ...context];
}

function specFixtureMarkdown(): Array<[string, string]> {
  const dir = path.join(repoRoot, "docs", "spec", "fixtures");
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const fixture = JSON.parse(
        fs.readFileSync(path.join(dir, file), "utf8"),
      ) as { source: { markdown: string } };
      const markdown = fixture.source.markdown;
      // Some fixtures store the Markdown with escaped newlines (`\\n`).
      return [
        file,
        markdown.includes("\n") ? markdown : markdown.replaceAll("\\n", "\n"),
      ];
    });
}

describe("block source preservation: unedited documents", () => {
  it("writes every repo Markdown file back byte-for-byte when nothing was edited", () => {
    const changed: string[] = [];
    for (const file of corpusFiles()) {
      const source = fs.readFileSync(file, "utf8");
      const opened = openInEditor(source);
      try {
        if (opened.save() !== source) {
          changed.push(path.relative(repoRoot, file));
        }
      } finally {
        opened.editor.destroy();
      }
    }
    expect(changed).toEqual([]);
  });

  it.each(
    specFixtureMarkdown(),
  )("writes spec fixture %s back byte-for-byte", (_name, source) => {
    const opened = openInEditor(source);
    try {
      expect(opened.save()).toBe(source);
    } finally {
      opened.editor.destroy();
    }
  });
});

describe("block source preservation: edits stay local", () => {
  it("changes only the edited paragraph in a document full of non-canonical syntax", () => {
    const source = readFixture("non-canonical.md");
    const opened = openInEditor(source);
    try {
      appendAfter(opened.editor, "Edit this paragraph.", " Edited.");
      expect(opened.save()).toBe(
        source.replace(
          "Edit this paragraph.\n",
          "Edit this paragraph. Edited.\n",
        ),
      );
    } finally {
      opened.editor.destroy();
    }
  });

  it("re-serializes only the edited block when it is itself non-canonical", () => {
    const source = readFixture("non-canonical.md");
    const opened = openInEditor(source);
    try {
      appendAfter(opened.editor, "star bullet two", " more");
      const saved = opened.save();
      const listStart = source.indexOf("* star bullet one");
      const listEnd = source.indexOf("1) paren ordered one");
      // Everything outside the list keeps its bytes.
      expect(saved.startsWith(source.slice(0, listStart))).toBe(true);
      expect(saved.endsWith(source.slice(listEnd))).toBe(true);
      expect(saved).toContain("star bullet two more");
    } finally {
      opened.editor.destroy();
    }
  });

  it("keeps duplicate identical blocks when a different block is edited", () => {
    const source = "Same *text* here.\n\nMiddle *one*.\n\nSame *text* here.\n";
    const opened = openInEditor(source);
    try {
      appendAfter(opened.editor, "Middle ", "edited ");
      expect(opened.save()).toBe(
        "Same *text* here.\n\nMiddle edited _one_.\n\nSame *text* here.\n",
      );
    } finally {
      opened.editor.destroy();
    }
  });

  it("re-serializes only the duplicate that was edited", () => {
    const source = "Same *text* here.\n\nSame *text* here.\n";
    const opened = openInEditor(source);
    try {
      const second = topLevelRange(opened.editor, 1);
      opened.editor
        .chain()
        .insertContentAt(second.to - 1, " Changed.")
        .run();
      expect(opened.save()).toBe(
        "Same *text* here.\n\nSame _text_ here. Changed.\n",
      );
    } finally {
      opened.editor.destroy();
    }
  });

  it("deletes a block without rewriting its neighbours", () => {
    const source =
      "Setext title\n============\n\nDelete *me*.\n\n* keep\n* list\n";
    const opened = openInEditor(source);
    try {
      const index = topLevelIndexOf(opened.editor, "Delete");
      const { from, to } = topLevelRange(opened.editor, index);
      opened.editor.chain().deleteRange({ from, to }).run();
      expect(opened.save()).toBe(
        "Setext title\n============\n\n* keep\n* list\n",
      );
    } finally {
      opened.editor.destroy();
    }
  });

  it("inserts a new block between untouched blocks", () => {
    const source = "First __bold__.\n\n***\n\nLast *em*.\n";
    const opened = openInEditor(source);
    try {
      const { to } = topLevelRange(opened.editor, 0);
      opened.editor
        .chain()
        .insertContentAt(to, {
          type: "paragraph",
          content: [{ type: "text", text: "New paragraph." }],
        })
        .run();
      expect(opened.save()).toBe(
        "First __bold__.\n\nNew paragraph.\n\n***\n\nLast *em*.\n",
      );
    } finally {
      opened.editor.destroy();
    }
  });

  it("moves a block and keeps the bytes of both", () => {
    const source = "Alpha __one__.\n\nBeta *two*.\n";
    const opened = openInEditor(source);
    try {
      const first = topLevelRange(opened.editor, 0);
      const node = opened.editor.state.doc.child(0);
      const tr = opened.editor.state.tr;
      tr.delete(first.from, first.to);
      tr.insert(tr.doc.content.size, node);
      opened.editor.view.dispatch(tr);
      expect(opened.save()).toBe("Beta *two*.\n\nAlpha __one__.\n");
    } finally {
      opened.editor.destroy();
    }
  });

  it("keeps a missing final newline and leading blank lines of untouched edges", () => {
    const source = "\n\nTop __b__.\n\nEdit me.\n\nBottom *e*.";
    const opened = openInEditor(source);
    try {
      appendAfter(opened.editor, "Edit me.", " Done.");
      expect(opened.save()).toBe(
        "\n\nTop __b__.\n\nEdit me. Done.\n\nBottom *e*.",
      );
    } finally {
      opened.editor.destroy();
    }
  });
});

describe("block source preservation: review items", () => {
  const inlineDoc = [
    '* item with {==first==}{>>First note.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}',
    "* another item",
    "",
    'Second __block__ with {==second==}{>>Second note.<<}{id="c2" by="user" at="2026-04-28T12:01:00.000Z"}.',
    "",
    "Untouched *tail*.",
    "",
  ].join("\n");

  it("editing a comment rewrites only the block that holds it (inline metadata)", () => {
    const opened = openInEditor(inlineDoc);
    try {
      opened.updateComment("c2", { content: "Second note, edited." });
      expect(opened.save()).toBe(
        inlineDoc.replace(
          "Second __block__ with {==second==}{>>Second note.<<}",
          "Second **block** with {==second==}{>>Second note, edited.<<}",
        ),
      );
    } finally {
      opened.editor.destroy();
    }
  });

  it("resolving a comment rewrites only the block that holds it (inline metadata)", () => {
    const opened = openInEditor(inlineDoc);
    try {
      opened.updateComment("c1", { status: "resolved" });
      const saved = opened.save();
      expect(saved).toBe(
        inlineDoc
          .replace("* item with", "- item with")
          .replace("* another item", "- another item")
          .replace(
            'at="2026-04-28T12:00:00.000Z"}',
            'at="2026-04-28T12:00:00.000Z" status="resolved"}',
          ),
      );
    } finally {
      opened.editor.destroy();
    }
  });

  it("replying to a comment rewrites only the block that holds it (inline metadata)", () => {
    const opened = openInEditor(inlineDoc);
    try {
      opened.addComment({
        id: "c3",
        content: "A reply.",
        createdAt: "2026-04-28T12:05:00.000Z",
        authorType: "ai",
        authorId: null,
        parentCommentId: "c2",
      });
      // The UI adds a reply id to its thread's anchor mark.
      const { editor } = opened;
      const markType = editor.schema.marks.commentRef;
      const tr = editor.state.tr;
      editor.state.doc.descendants((node, pos) => {
        if (!node.isText) return;
        for (const mark of node.marks) {
          const ids = mark.attrs.commentIds as string[] | undefined;
          if (mark.type !== markType || !ids?.includes("c2")) continue;
          tr.addMark(
            pos,
            pos + node.nodeSize,
            markType.create({ commentIds: [...ids, "c3"] }),
          );
        }
      });
      editor.view.dispatch(tr);
      const saved = opened.save();
      expect(
        saved.startsWith(inlineDoc.slice(0, inlineDoc.indexOf("Second"))),
      ).toBe(true);
      expect(saved.endsWith("\n\nUntouched *tail*.\n")).toBe(true);
      expect(saved).toContain('{>>A reply.<<}{id="c3" by="AI"');
    } finally {
      opened.editor.destroy();
    }
  });

  const endmatterDoc = [
    "* bullet with {==anchor==}{>>Root note.<<}{#c1}",
    "* second bullet",
    "",
    "Paragraph __bold__.",
    "",
    "---",
    "comments:",
    "  c1:",
    "    by: user",
    '    at: "2026-04-28T12:00:00.000Z"',
    "",
  ].join("\n");

  it("resolving a comment changes only the endmatter (endmatter metadata)", () => {
    const opened = openInEditor(endmatterDoc);
    try {
      opened.updateComment("c1", { status: "resolved" });
      const saved = opened.save();
      const bodyEnd = endmatterDoc.indexOf("---\n");
      expect(saved.slice(0, bodyEnd)).toBe(endmatterDoc.slice(0, bodyEnd));
      expect(saved.slice(bodyEnd)).toContain("status: resolved");
    } finally {
      opened.editor.destroy();
    }
  });

  it("replying changes only the endmatter (endmatter metadata)", () => {
    const opened = openInEditor(endmatterDoc);
    try {
      opened.addComment({
        id: "c2",
        content: "Agent reply.",
        createdAt: "2026-04-28T12:05:00.000Z",
        authorType: "ai",
        authorId: null,
        parentCommentId: "c1",
      });
      const saved = opened.save();
      const bodyEnd = endmatterDoc.indexOf("---\n");
      expect(saved.slice(0, bodyEnd)).toBe(endmatterDoc.slice(0, bodyEnd));
      expect(saved.slice(bodyEnd)).toContain("body: Agent reply.");
    } finally {
      opened.editor.destroy();
    }
  });

  it("editing a root comment body rewrites only its block (endmatter metadata)", () => {
    const opened = openInEditor(endmatterDoc);
    try {
      opened.updateComment("c1", { content: "Root note, edited." });
      const saved = opened.save();
      expect(saved).toContain(
        "- bullet with {==anchor==}{>>Root note, edited.<<}{#c1}",
      );
      expect(saved).toContain("\n\nParagraph __bold__.\n");
    } finally {
      opened.editor.destroy();
    }
  });
});

describe("block source preservation: safety guard", () => {
  it("falls back to the full serialization when the spliced output would parse differently", () => {
    // The reference definition sits between blocks and travels with the block
    // after it; editing that block drops it, which would break the untouched
    // reference link above. The guard must notice and write the full,
    // self-contained serialization instead.
    const source = [
      "See [the docs][d] and __bold__.",
      "",
      "[d]: https://example.com/docs",
      "",
      "Edit me.",
      "",
    ].join("\n");
    const opened = openInEditor(source);
    const onFallback = vi.fn();
    try {
      appendAfter(opened.editor, "Edit me.", " Now.");
      const saved = opened.save({ onBlockSourceFallback: onFallback });
      expect(onFallback).toHaveBeenCalledTimes(1);
      expect(saved).toBe(
        "See [the docs](https://example.com/docs) and **bold**.\n\nEdit me. Now.\n",
      );
    } finally {
      opened.editor.destroy();
    }
  });

  it("does not report a fallback for an ordinary local edit", () => {
    const opened = openInEditor(readFixture("non-canonical.md"));
    const onFallback = vi.fn();
    try {
      appendAfter(opened.editor, "Edit this paragraph.", " Edited.");
      opened.save({ onBlockSourceFallback: onFallback });
      expect(onFallback).not.toHaveBeenCalled();
    } finally {
      opened.editor.destroy();
    }
  });
});
