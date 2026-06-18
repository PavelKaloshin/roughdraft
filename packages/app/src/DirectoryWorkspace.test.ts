import { describe, expect, it } from "vitest";
import { buildFileTree } from "./DirectoryWorkspace";

describe("buildFileTree", () => {
  it("nests files under their directories", () => {
    const tree = buildFileTree(["notes/", "notes/alpha.md", "zeta.md"]);

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

  it("keeps non-markdown files and prunes only empty directories", () => {
    const tree = buildFileTree([
      "empty/",
      "empty/nested/",
      "assets/",
      "assets/diagram.png",
      "src/app.ts",
      "draft.md",
    ]);

    expect(tree.map((node) => node.name)).toEqual([
      "assets",
      "src",
      "draft.md",
    ]);
    expect(tree[0]?.children.map((node) => node.name)).toEqual(["diagram.png"]);
    expect(tree[1]?.children.map((node) => node.name)).toEqual(["app.ts"]);
  });

  it("orders directories before files and sorts numerically", () => {
    const tree = buildFileTree([
      "b.md",
      "a.txt",
      "10-late.md",
      "2-early.md",
      "docs/z.md",
    ]);

    expect(tree.map((node) => node.name)).toEqual([
      "docs",
      "2-early.md",
      "10-late.md",
      "a.txt",
      "b.md",
    ]);
  });

  it("uses the canonical relative path as the file identifier", () => {
    const tree = buildFileTree(["a/b/c/deep.rs"]);

    const deep = tree[0]?.children[0]?.children[0]?.children[0];
    expect(deep?.relativePath).toBe("a/b/c/deep.rs");
    expect(deep?.kind).toBe("file");
  });
});
