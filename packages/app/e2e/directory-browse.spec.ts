import fs from "node:fs";
import { expect, test } from "@playwright/test";
import {
  appendInCodeEditor,
  codeEditor,
  createMarkdownProject,
  logE2eEvent,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("browsing a directory of markdown files", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("directory-browse");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("lists, opens, switches, and navigates back between files @smoke", async ({
    page,
  }) => {
    writeProjectFile(projectDir, "alpha.md", "# Alpha\n\nAlpha body text.\n");
    writeProjectFile(
      projectDir,
      "notes/beta.md",
      "# Beta\n\nBeta body text.\n",
    );

    await page.goto(`/?${new URLSearchParams({ dir: projectDir }).toString()}`);

    // The tree lists both the top-level file and the nested folder.
    await expect(page.getByTestId("directory-file-alpha.md")).toBeVisible();
    await expect(page.getByTestId("directory-folder-notes")).toBeVisible();
    await expect(
      page.getByTestId("directory-file-notes/beta.md"),
    ).toBeVisible();

    // No file selected yet.
    await expect(page.getByTestId("directory-empty-state")).toBeVisible();

    // Open the top-level file.
    await page.getByTestId("directory-file-alpha.md").click();
    const editor = page.getByTestId("rich-text-editor");
    await expect(editor).toContainText("Alpha body text.");
    await expect(page).toHaveURL(/path=.*alpha\.md/);

    // Switch to the nested file.
    await page.getByTestId("directory-file-notes/beta.md").click();
    await expect(editor).toContainText("Beta body text.");
    await expect(page).toHaveURL(/path=.*beta\.md/);

    // Browser back returns to the previously opened file.
    await page.goBack();
    await expect(editor).toContainText("Alpha body text.");
    await expect(page).toHaveURL(/path=.*alpha\.md/);

    logE2eEvent("directory-browse.navigated", {
      projectDir,
      files: ["alpha.md", "notes/beta.md"],
    });
  });

  test("shows markdown files created on disk after the directory loads @smoke", async ({
    page,
  }) => {
    writeProjectFile(projectDir, "alpha.md", "# Alpha\n");

    await page.goto(`/?${new URLSearchParams({ dir: projectDir }).toString()}`);
    await expect(page.getByTestId("directory-file-alpha.md")).toBeVisible();

    // A coding agent (or any process) writes a new file into the directory.
    writeProjectFile(projectDir, "gamma.md", "# Gamma\n");

    await expect(page.getByTestId("directory-file-gamma.md")).toBeVisible({
      timeout: 10_000,
    });

    logE2eEvent("directory-browse.live-tree", {
      projectDir,
      added: "gamma.md",
    });
  });

  test("live-reloads the open file when it changes on disk @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "alpha.md",
      "# Alpha\n\nOriginal body.\n",
    );

    const params = new URLSearchParams({
      dir: projectDir,
      path: filePath,
      editor: "code",
    });
    await page.goto(`/?${params.toString()}`);
    await expect(codeEditor(page)).toContainText("Original body.");

    // The file is rewritten on disk while the browser copy is clean.
    fs.writeFileSync(filePath, "# Alpha\n\nUpdated body.\n");

    await expect(codeEditor(page)).toContainText("Updated body.", {
      timeout: 10_000,
    });

    logE2eEvent("directory-browse.live-file", { projectDir, file: "alpha.md" });
  });

  test("switches files even when the current file has unsaved edits @smoke", async ({
    page,
  }) => {
    const alpha = writeProjectFile(
      projectDir,
      "alpha.md",
      "# Alpha\n\nAlpha body.\n",
    );
    writeProjectFile(projectDir, "beta.md", "# Beta\n\nBeta body.\n");

    await page.goto(
      `/?${new URLSearchParams({
        dir: projectDir,
        path: alpha,
        editor: "code",
      }).toString()}`,
    );
    await expect(codeEditor(page)).toContainText("Alpha body.");

    // Leave an unsaved local edit in the current file.
    await appendInCodeEditor(page, "\nLocal unsaved edit.\n");

    // Switching files must still work (no blocking confirm dialog).
    await page.getByTestId("directory-file-beta.md").click();
    await expect(codeEditor(page)).toContainText("Beta body.");
    await expect(page).toHaveURL(/path=.*beta\.md/);

    logE2eEvent("directory-browse.switch-with-unsaved", {
      projectDir,
      from: "alpha.md",
      to: "beta.md",
    });
  });

  test("reuses an existing window for a repeated directory open request @smoke", async ({
    page,
  }) => {
    writeProjectFile(projectDir, "alpha.md", "# Alpha\n");

    await page.goto(`/?${new URLSearchParams({ dir: projectDir }).toString()}`);
    await expect(page.getByTestId("directory-file-alpha.md")).toBeVisible();

    // The CLI keys the open request on the directory path.
    const targetUrl = `/?${new URLSearchParams({ dir: projectDir }).toString()}`;
    const response = await page.request.post("/api/open-request", {
      data: { path: projectDir, url: targetUrl },
    });

    expect(response.ok()).toBe(true);
    await expect(response.json()).resolves.toEqual({ delivered: true });

    logE2eEvent("directory-browse.reused-window", { projectDir });
  });
});
