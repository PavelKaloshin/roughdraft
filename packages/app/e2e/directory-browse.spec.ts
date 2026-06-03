import { expect, test } from "@playwright/test";
import {
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
});
