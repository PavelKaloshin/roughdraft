import { describe, expect, it } from "vitest";
import { buildMarkdownFileTree } from "./DirectoryWorkspace";

describe("buildMarkdownFileTree", () => {
  it("nests markdown files under their directories", () => {
    const tree = buildMarkdownFileTree(["notes/", "notes/alpha.md", "zeta.md"]);

    expect(tree).toEqual([
      {
        name: "notes",
        relativePath: "notes",
        kind: "directory",
        children: [
          {
            name: "alpha.md",
            relativePath: "notes/alpha.md",
            kind: "file",
            children: [],
          },
        ],
      },
      {
        name: "zeta.md",
        relativePath: "zeta.md",
        kind: "file",
        children: [],
      },
    ]);
  });

  it("drops non-markdown files and directories without markdown", () => {
    const tree = buildMarkdownFileTree([
      "empty/",
      "empty/nested/",
      "assets/",
      "assets/diagram.png",
      "draft.md",
    ]);

    expect(tree).toEqual([
      {
        name: "draft.md",
        relativePath: "draft.md",
        kind: "file",
        children: [],
      },
    ]);
  });

  it("orders directories before files and sorts numerically", () => {
    const tree = buildMarkdownFileTree([
      "b.md",
      "a.md",
      "10-late.md",
      "2-early.md",
      "docs/z.md",
    ]);

    expect(tree.map((node) => node.name)).toEqual([
      "docs",
      "2-early.md",
      "10-late.md",
      "a.md",
      "b.md",
    ]);
  });

  it("uses the canonical relative path as the file identifier", () => {
    const tree = buildMarkdownFileTree(["a/b/c/deep.md"]);

    const deep = tree[0]?.children[0]?.children[0]?.children[0];
    expect(deep?.relativePath).toBe("a/b/c/deep.md");
    expect(deep?.kind).toBe("file");
  });
});
