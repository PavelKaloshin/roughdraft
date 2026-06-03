import { afterEach, describe, expect, it } from "vitest";
import {
  buildLocationForDirectorySelection,
  buildLocationForLinkedMarkdownDocument,
  getRequestedPathState,
  getWorkspaceState,
  PREVIEW_PATH,
  ROUGHDRAFT_FLAVORED_MARKDOWN_PATH,
  syncRequestedPathInUrl,
} from "./app-navigation";

describe("app navigation", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("reads absolute markdown paths from the path query parameter", () => {
    window.history.replaceState(
      null,
      "",
      "/?path=%2FUsers%2Fme%2F.claude%2Fplans%2Fexample.md",
    );

    expect(getRequestedPathState()).toEqual({
      rawPath: "/Users/me/.claude/plans/example.md",
      projectPath: "/Users/me/.claude/plans",
      documentPath: "example.md",
    });
  });

  it("keeps absolute paths in the path query parameter", () => {
    window.history.replaceState(null, "", "/");

    syncRequestedPathInUrl("/Users/me/.claude/plans/example.md");

    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe(
      "?path=%2FUsers%2Fme%2F.claude%2Fplans%2Fexample.md",
    );
  });

  it("does not treat reserved app pages as file paths", () => {
    window.history.replaceState(null, "", ROUGHDRAFT_FLAVORED_MARKDOWN_PATH);

    expect(getRequestedPathState()).toEqual({
      rawPath: null,
      projectPath: null,
      documentPath: null,
    });

    window.history.replaceState(null, "", PREVIEW_PATH);

    expect(getRequestedPathState()).toEqual({
      rawPath: null,
      projectPath: null,
      documentPath: null,
    });
  });

  it("builds Roughdraft routes for linked markdown documents", () => {
    window.history.replaceState(
      null,
      "",
      "/?path=%2FUsers%2Fme%2Fproject%2F.context%2Flocal-link-source.md",
    );

    expect(
      buildLocationForLinkedMarkdownDocument({
        projectPath: "/Users/me/project/.context",
        currentDocumentPath: "local-link-source.md",
        href: "local-link-target.md",
      }),
    ).toBe("/?path=%2FUsers%2Fme%2Fproject%2F.context%2Flocal-link-target.md");
  });

  it("resolves nested markdown links relative to the current document", () => {
    window.history.replaceState(null, "", "/");

    expect(
      buildLocationForLinkedMarkdownDocument({
        projectPath: "/Users/me/project",
        currentDocumentPath: "notes/source.md",
        href: "../index.md#summary",
      }),
    ).toBe("/?path=%2FUsers%2Fme%2Fproject%2Findex.md#summary");
  });

  it("leaves non-markdown links for the file resolver", () => {
    expect(
      buildLocationForLinkedMarkdownDocument({
        projectPath: "/Users/me/project",
        currentDocumentPath: "source.md",
        href: "diagram.png",
      }),
    ).toBeNull();
  });

  it("reports single-file workspace state for a path query parameter", () => {
    window.history.replaceState(
      null,
      "",
      "/?path=%2FUsers%2Fme%2Fproject%2Fdraft.md",
    );

    expect(getWorkspaceState()).toEqual({
      mode: "single",
      rawPath: "/Users/me/project/draft.md",
      directoryPath: null,
      projectPath: "/Users/me/project",
      documentPath: "draft.md",
    });
  });

  it("reports directory workspace state with no file selected", () => {
    window.history.replaceState(null, "", "/?dir=%2FUsers%2Fme%2Fproject");

    expect(getWorkspaceState()).toEqual({
      mode: "directory",
      rawPath: null,
      directoryPath: "/Users/me/project",
      projectPath: "/Users/me/project",
      documentPath: null,
    });
  });

  it("resolves a selected file relative to the directory root", () => {
    window.history.replaceState(
      null,
      "",
      "/?dir=%2FUsers%2Fme%2Fproject&path=%2FUsers%2Fme%2Fproject%2Fnotes%2Falpha.md",
    );

    expect(getWorkspaceState()).toEqual({
      mode: "directory",
      rawPath: "/Users/me/project/notes/alpha.md",
      directoryPath: "/Users/me/project",
      projectPath: "/Users/me/project",
      documentPath: "notes/alpha.md",
    });
  });

  it("ignores a path outside the directory root", () => {
    window.history.replaceState(
      null,
      "",
      "/?dir=%2FUsers%2Fme%2Fproject&path=%2FUsers%2Fme%2Fother%2Falpha.md",
    );

    expect(getWorkspaceState().documentPath).toBeNull();
  });

  it("builds directory selection locations preserving the directory root", () => {
    window.history.replaceState(null, "", "/?dir=%2FUsers%2Fme%2Fproject");

    const location = buildLocationForDirectorySelection(
      "/Users/me/project",
      "/Users/me/project/notes/alpha.md",
    );
    const params = new URLSearchParams(location.split("?")[1]);

    expect(params.get("dir")).toBe("/Users/me/project");
    expect(params.get("path")).toBe("/Users/me/project/notes/alpha.md");
  });

  it("clears the selected file when building a directory-only location", () => {
    window.history.replaceState(
      null,
      "",
      "/?dir=%2FUsers%2Fme%2Fproject&path=%2FUsers%2Fme%2Fproject%2Fdraft.md",
    );

    const location = buildLocationForDirectorySelection(
      "/Users/me/project",
      null,
    );
    const params = new URLSearchParams(location.split("?")[1]);

    expect(params.get("dir")).toBe("/Users/me/project");
    expect(params.has("path")).toBe(false);
  });
});
