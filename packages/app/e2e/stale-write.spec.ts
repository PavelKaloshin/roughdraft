import fs from "node:fs";
import { expect, type Locator, test } from "@playwright/test";
import {
  appendInCodeEditor,
  blockMarkdownFileEvents,
  codeEditor,
  createMarkdownProject,
  documentSaveStatus,
  fileConflictNotice,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("stale writes", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("stale-write");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("surfaces a save conflict when the file changed externally @smoke", async ({
    page,
  }) => {
    await blockMarkdownFileEvents(page);

    const filePath = writeProjectFile(
      projectDir,
      "conflict.md",
      "# Conflict\n\nOriginal body.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original body.");

    fs.writeFileSync(
      filePath,
      "# Conflict\n\nExternal body.\n\nExternal tail.\n",
    );
    await appendInCodeEditor(page, "\nLocal body.\n");

    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Save conflict",
    );
    await expect(page.getByTestId("file-conflict-action-reload")).toBeVisible();
    await expect(
      page.getByTestId("file-conflict-action-keep-editing"),
    ).toBeVisible();
    expect(readProjectFile(projectDir, "conflict.md")).toBe(
      "# Conflict\n\nExternal body.\n\nExternal tail.\n",
    );

    await page.getByTestId("file-conflict-action-keep-editing").click();
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Autosave paused",
    );
    await appendInCodeEditor(page, "\nStill local.\n");
    await expect(codeEditor(page)).toContainText("Local body.");
    await expect(codeEditor(page)).toContainText("Still local.");
    await expect
      .poll(() => readProjectFile(projectDir, "conflict.md"))
      .toBe("# Conflict\n\nExternal body.\n\nExternal tail.\n");

    logE2eEvent("stale-write.conflict-surfaced", {
      file: "conflict.md",
    });
  });

  test("auto-merges a non-overlapping external change on save conflict @smoke", async ({
    page,
  }) => {
    await blockMarkdownFileEvents(page);

    const filePath = writeProjectFile(
      projectDir,
      "merge-conflict.md",
      "# Conflict\n\nOriginal body.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original body.");

    // Another writer changes the body; the local draft only appends. The
    // save gets a 409, merges the disk version in, and saves the merge.
    fs.writeFileSync(filePath, "# Conflict\n\nExternal body.\n");
    await appendInCodeEditor(page, "\nLocal body.\n");

    await expect
      .poll(() => readProjectFile(projectDir, "merge-conflict.md"))
      .toBe("# Conflict\n\nExternal body.\n\nLocal body.\n");
    await expect(codeEditor(page)).toContainText("External body.");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect(fileConflictNotice(page)).toHaveCount(0);

    logE2eEvent("stale-write.auto-merged", { file: "merge-conflict.md" });
  });

  test("overwrite after conflict marks the current draft saved", async ({
    page,
  }) => {
    await blockMarkdownFileEvents(page);

    const filePath = writeProjectFile(
      projectDir,
      "overwrite-conflict.md",
      "# Conflict\n\nOriginal body.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original body.");

    fs.writeFileSync(
      filePath,
      "# Conflict\n\nExternal body.\n\nExternal tail.\n",
    );
    await appendInCodeEditor(page, "\nLocal overwrite body.\n");

    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Save conflict",
    );
    await page.getByTestId("file-conflict-action-overwrite").click();

    await expect
      .poll(() => readProjectFile(projectDir, "overwrite-conflict.md"))
      .toContain("Local overwrite body.");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect(documentSaveStatus(page)).not.toHaveAttribute(
      "aria-label",
      "Save failed",
    );
    await expect(documentSaveStatus(page)).not.toHaveAttribute(
      "aria-label",
      "Unsaved changes",
    );

    logE2eEvent("stale-write.overwrite-saved", {
      file: "overwrite-conflict.md",
      size: fs.statSync(filePath).size,
    });
  });

  test("manual save preserves expected-version conflict behavior", async ({
    page,
  }) => {
    await blockMarkdownFileEvents(page);

    const filePath = writeProjectFile(
      projectDir,
      "manual-conflict.md",
      "# Manual Conflict\n\nOriginal body.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original body.");

    fs.writeFileSync(
      filePath,
      "# Manual Conflict\n\nExternal body.\n\nExternal tail.\n",
    );
    await appendInCodeEditor(page, "\nLocal body.\n");
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S",
    );

    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Save conflict",
    );
    await expect(fileConflictNotice(page)).toContainText(
      "This file changed on disk while you have unsaved edits.",
    );
    expect(readProjectFile(projectDir, "manual-conflict.md")).toBe(
      "# Manual Conflict\n\nExternal body.\n\nExternal tail.\n",
    );

    logE2eEvent("stale-write.manual-conflict", {
      file: "manual-conflict.md",
    });
  });

  test("rejects autosave after external content changes with stable metadata", async ({
    page,
  }) => {
    // Without this, the live file channel (which compares content versions,
    // not mtime and size) reloads the external edit before the user types, so
    // the save would correctly succeed and the conflict path is never taken.
    await blockMarkdownFileEvents(page);

    const fixedTimestamp = new Date("2026-01-01T00:00:00.000Z");
    const filePath = writeProjectFile(
      projectDir,
      "metadata-conflict.md",
      "# Original\n",
    );
    fs.utimesSync(filePath, fixedTimestamp, fixedTimestamp);

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original");

    // Same size and mtime as the original, so only the content version
    // differs. The external edit also ends where the local draft appends, so
    // the two cannot be merged automatically.
    fs.writeFileSync(filePath, "# Externa\n\n");
    fs.utimesSync(filePath, fixedTimestamp, fixedTimestamp);
    await appendInCodeEditor(page, "\nLocal body.\n");

    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Save conflict",
    );
    expect(readProjectFile(projectDir, "metadata-conflict.md")).toBe(
      "# Externa\n\n",
    );

    logE2eEvent("stale-write.metadata-conflict-surfaced", {
      file: "metadata-conflict.md",
    });
  });

  test("keeps explanatory conflict choices visible while scrolled in a long document", async ({
    page,
  }) => {
    await blockMarkdownFileEvents(page);

    const longBody = Array.from(
      { length: 120 },
      (_, index) => `Paragraph ${index + 1}: local review text.`,
    ).join("\n\n");
    const filePath = writeProjectFile(
      projectDir,
      "long-conflict.md",
      `# Long conflict\n\n${longBody}\n`,
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Paragraph 1");

    await codeEditor(page).click();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+End" : "Control+End",
    );
    fs.writeFileSync(
      filePath,
      "# Long conflict\n\nExternal body from another editor.\n",
    );
    await page.keyboard.type("\nLocal draft at the bottom.\n");

    const conflictNotice = fileConflictNotice(page);
    await expect(conflictNotice).toBeVisible();
    await expect(conflictNotice).toHaveCSS("position", "fixed");
    await expect(conflictNotice).toContainText(
      "This file changed on disk while you have unsaved edits.",
    );
    await expect(conflictNotice).toContainText(
      "Autosave is paused so your draft will not overwrite those changes.",
    );
    await expect(page.getByTestId("file-conflict-action-reload")).toBeVisible();
    await expect(
      page.getByTestId("file-conflict-action-keep-editing"),
    ).toBeVisible();
    await expect(
      page.getByTestId("file-conflict-action-overwrite"),
    ).toBeVisible();
  });

  test("keeps conflict banner clear of the save status and the handoff stack", async ({
    page,
    request,
  }) => {
    await blockMarkdownFileEvents(page);

    const relativePath = "layout-conflict.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      "# Layout conflict\n\nOriginal body.\n",
    );
    // The right-hand status stack only holds the review handoff button, which
    // shows while an agent watches the document; the save status sits in its
    // own top-left corner. Keep a watcher connected so both are on screen.
    const pendingWatch = request
      .post("/api/review-events/watch", {
        data: {
          projectPath: projectDir,
          path: relativePath,
          timeoutSeconds: 25,
        },
      })
      .catch(() => undefined);

    const boxOf = async (locator: Locator) => {
      const box = await locator.boundingBox();
      if (!box) throw new Error("Expected element bounds");
      return box;
    };
    const intersects = (
      a: { x: number; y: number; width: number; height: number },
      b: { x: number; y: number; width: number; height: number },
    ) =>
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y;

    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 390, height: 844 },
    ]) {
      fs.writeFileSync(filePath, "# Layout conflict\n\nOriginal body.\n");
      await page.setViewportSize(viewport);
      await openMarkdownFile(page, filePath, "code");
      await expect(codeEditor(page)).toContainText("Original body.");

      fs.writeFileSync(
        filePath,
        "# Layout conflict\n\nExternal body.\n\nExternal tail.\n",
      );
      await appendInCodeEditor(page, `\nLocal body ${viewport.width}.\n`);

      const conflictNotice = fileConflictNotice(page);
      const handoffStack = page.getByTestId("review-handoff-split-button");
      const saveStatus = documentSaveStatus(page);
      await expect(conflictNotice).toBeVisible();
      await expect(handoffStack).toBeVisible();
      await expect(saveStatus).toHaveAttribute("aria-label", "Save conflict");

      const conflictBox = await boxOf(conflictNotice);
      expect(
        intersects(conflictBox, await boxOf(handoffStack)),
        `handoff stack overlaps the conflict banner at ${viewport.width}px`,
      ).toBe(false);
      expect(
        intersects(conflictBox, await boxOf(saveStatus)),
        `save status overlaps the conflict banner at ${viewport.width}px`,
      ).toBe(false);

      await page.getByTestId("file-conflict-action-reload").click();
      await expect(conflictNotice).toBeHidden();
    }

    // The watcher only has to stay connected for the checks above.
    void pendingWatch;
  });
});
