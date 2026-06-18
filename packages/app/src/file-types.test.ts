import { describe, expect, it } from "vitest";
import { classifyFile, isMarkdownPath, isOpenableFile } from "./file-types";

describe("classifyFile", () => {
  it("treats only .md as the interactive markdown unit of work", () => {
    expect(classifyFile("notes/plan.md").kind).toBe("markdown");
    expect(classifyFile("PLAN.MD").kind).toBe("markdown");
    // `.markdown`/`.mdx` are read-only text because the server only serves .md.
    expect(classifyFile("readme.markdown").kind).toBe("text");
    expect(classifyFile("doc.mdx").kind).toBe("text");
  });

  it("classifies source files as code", () => {
    for (const path of [
      "src/app.ts",
      "src/App.tsx",
      "main.py",
      "lib.rs",
      "styles.css",
      "config.yaml",
      "Dockerfile",
      "Makefile",
    ]) {
      expect(classifyFile(path).kind, path).toBe("code");
    }
  });

  it("classifies images so they can be previewed", () => {
    expect(classifyFile("assets/diagram.png").kind).toBe("image");
    expect(classifyFile("logo.SVG").kind).toBe("image");
  });

  it("classifies known non-text files as binary", () => {
    expect(classifyFile("report.pdf").kind).toBe("binary");
    expect(classifyFile("archive.zip").kind).toBe("binary");
    expect(classifyFile("font.woff2").kind).toBe("binary");
  });

  it("falls back to readable text for plain and extensionless files", () => {
    expect(classifyFile("notes.txt").kind).toBe("text");
    expect(classifyFile("server.log").kind).toBe("text");
    expect(classifyFile("LICENSE").kind).toBe("text");
    expect(classifyFile("data.csv").kind).toBe("text");
  });
});

describe("isMarkdownPath", () => {
  it("matches the server's .md gate", () => {
    expect(isMarkdownPath("a.md")).toBe(true);
    expect(isMarkdownPath("a.markdown")).toBe(false);
    expect(isMarkdownPath("a.txt")).toBe(false);
  });
});

describe("isOpenableFile", () => {
  it("opens everything except non-previewable binaries", () => {
    expect(isOpenableFile("a.md")).toBe(true);
    expect(isOpenableFile("a.ts")).toBe(true);
    expect(isOpenableFile("a.png")).toBe(true);
    expect(isOpenableFile("a.zip")).toBe(false);
  });
});
