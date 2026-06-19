import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

test.describe("markdown links and layout", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("links-and-layout");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("clicking a sibling markdown link navigates and keeps directory mode @smoke", async ({
    page,
  }) => {
    writeProjectFile(
      projectDir,
      "alpha.md",
      "# Alpha\n\nSee [the beta doc](beta.md) for more.\n",
    );
    writeProjectFile(projectDir, "beta.md", "# Beta\n\nBeta body text.\n");

    await page.goto(`/?${new URLSearchParams({ dir: projectDir }).toString()}`);
    await page.getByTestId("directory-file-alpha.md").click();

    const editor = richTextEditor(page);
    await expect(editor).toContainText("See the beta doc for more.");

    // The link is clickable and navigates to the sibling document.
    await editor.getByRole("link", { name: "the beta doc" }).click();
    await expect(editor).toContainText("Beta body text.");

    // Navigation stays in directory mode (sidebar preserved) and points at beta.
    await expect(page).toHaveURL(/[?&]dir=/);
    await expect(page).toHaveURL(/[?&]path=.*beta\.md/);
    await expect(page.getByTestId("directory-file-beta.md")).toBeVisible();
  });

  test("a sibling link inside a table cell is clickable @smoke", async ({
    page,
  }) => {
    writeProjectFile(
      projectDir,
      "index.md",
      [
        "# Index",
        "",
        "| ID | Ref |",
        "|----|-----|",
        "| R1 | see [the beta doc](beta.md) |",
        "",
      ].join("\n"),
    );
    writeProjectFile(projectDir, "beta.md", "# Beta\n\nBeta body text.\n");

    await page.goto(`/?${new URLSearchParams({ dir: projectDir }).toString()}`);
    await page.getByTestId("directory-file-index.md").click();

    const editor = richTextEditor(page);
    await expect(editor.locator("table")).toBeVisible();

    await editor.getByRole("link", { name: "the beta doc" }).click();
    await expect(editor).toContainText("Beta body text.");
    await expect(page).toHaveURL(/[?&]path=.*beta\.md/);
  });

  test("a code-span sibling link with an anchor resolves @smoke", async ({
    page,
  }) => {
    writeProjectFile(
      projectDir,
      "index.md",
      "# Index\n\nSee ([`AC-E`](beta.md#AC-E)) for details.\n",
    );
    writeProjectFile(projectDir, "beta.md", "# Beta\n\nBeta body text.\n");

    await page.goto(`/?${new URLSearchParams({ dir: projectDir }).toString()}`);
    await page.getByTestId("directory-file-index.md").click();

    const editor = richTextEditor(page);
    const link = editor.getByRole("link", { name: "AC-E" });
    await expect(link).toBeVisible();

    await link.click();
    await expect(editor).toContainText("Beta body text.");
    await expect(page).toHaveURL(/[?&]path=.*beta\.md/);
  });

  test("a link to an anchor in another document scrolls to it @smoke", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const filler = Array.from(
      { length: 60 },
      (_, i) => `Filler line ${i}.`,
    ).join("\n\n");
    writeProjectFile(
      projectDir,
      "index.md",
      "# Index\n\nGo to [the rule](target.md#REQ-11).\n",
    );
    writeProjectFile(
      projectDir,
      "target.md",
      `# Target\n\n${filler}\n\n**<a id="REQ-11"></a>REQ-11** is the rule.\n`,
    );

    await page.goto(`/?${new URLSearchParams({ dir: projectDir }).toString()}`);
    await page.getByTestId("directory-file-index.md").click();

    const editor = richTextEditor(page);
    await editor.getByRole("link", { name: "the rule" }).click();
    await expect(page).toHaveURL(/[?&]path=.*target\.md/);

    // The anchor target exists and the view scrolled to it.
    await expect(editor.locator("#REQ-11")).toHaveCount(1);
    await expect(editor.getByText("REQ-11 is the rule.")).toBeInViewport();
  });

  test("full-width toggle widens the document and persists @smoke", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    writeProjectFile(projectDir, "alpha.md", "# Alpha\n\nAlpha body.\n");

    await page.goto(`/?${new URLSearchParams({ dir: projectDir }).toString()}`);
    await page.getByTestId("directory-file-alpha.md").click();

    const editor = page.getByTestId("rich-text-editor");
    await expect(editor).toBeVisible();
    const toggle = page.getByTestId("document-full-width-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    const cappedWidth = (await editor.boundingBox())?.width ?? 0;

    // Enabling full width actually widens the document body, not just the chip.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => (await editor.boundingBox())?.width ?? 0)
      .toBeGreaterThan(cappedWidth + 40);

    // The preference survives a full reload (persisted in localStorage).
    await page.reload();
    await page.getByTestId("directory-file-alpha.md").click();
    await expect(
      page.getByTestId("document-full-width-toggle"),
    ).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => (await editor.boundingBox())?.width ?? 0)
      .toBeGreaterThan(cappedWidth + 40);
  });
});
