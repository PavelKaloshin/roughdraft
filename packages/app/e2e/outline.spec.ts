import fs from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

function longDocument(headings: string[]) {
  return headings
    .map(
      (heading) =>
        `${heading}\n\n${Array.from(
          { length: 30 },
          (_, index) => `Filler line ${index + 1} under ${heading}.`,
        ).join("\n\n")}\n`,
    )
    .join("\n");
}

/**
 * Viewport-relative top of a rendered top-level heading, or null when it is not
 * rendered. Measuring the real element is what proves a jump actually scrolled
 * the document rather than only updating state.
 */
function renderedHeadingTop(page: Page, text: string) {
  return page.evaluate((headingText) => {
    const root = document.querySelector(".ProseMirror");
    const heading = Array.from(root?.children ?? []).find(
      (element) =>
        /^H[1-6]$/.test(element.tagName) &&
        element.textContent?.trim() === headingText,
    );
    return heading ? heading.getBoundingClientRect().top : null;
  }, text);
}

test.describe("markdown outline", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("outline");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("expands, collapses, and jumps between files from the tree @smoke", async ({
    page,
  }) => {
    writeProjectFile(
      projectDir,
      "alpha.md",
      "# Alpha\n\nAlpha body.\n\n## Alpha details\n\nMore alpha.\n",
    );
    writeProjectFile(
      projectDir,
      "beta.md",
      "# Beta\n\nBeta body.\n\n## Beta details\n\nMore beta.\n",
    );
    writeProjectFile(projectDir, "notes.txt", "Not markdown.\n");

    await page.goto(`/?${new URLSearchParams({ dir: projectDir }).toString()}`);
    await expect(page.getByTestId("directory-file-alpha.md")).toBeVisible();

    // Headings stay out of the way until asked for, and only markdown offers them.
    await expect(page.getByTestId("directory-outline-alpha.md")).toBeHidden();
    await expect(
      page.getByTestId("directory-outline-toggle-notes.txt"),
    ).toBeHidden();

    await page.getByTestId("directory-outline-toggle-alpha.md").click();
    await expect(page.getByTestId("directory-outline-alpha.md")).toBeVisible();
    await expect(
      page.getByTestId("directory-outline-alpha.md-heading-0"),
    ).toHaveText("Alpha");
    await expect(
      page.getByTestId("directory-outline-alpha.md-heading-1"),
    ).toHaveText("Alpha details");

    // The list collapses back into the file row.
    await page.getByTestId("directory-outline-toggle-alpha.md").click();
    await expect(page.getByTestId("directory-outline-alpha.md")).toBeHidden();

    // Opening a markdown file reveals its outline without another click.
    await page.getByTestId("directory-file-alpha.md").click();
    await expect(richTextEditor(page)).toContainText("Alpha body.");
    await expect(page.getByTestId("directory-outline-alpha.md")).toBeVisible();

    // A heading in a different file opens that file and lands on the heading.
    await page.getByTestId("directory-outline-toggle-beta.md").click();
    await page.getByTestId("directory-outline-beta.md-heading-1").click();
    await expect(page).toHaveURL(/path=.*beta\.md/);
    await expect(richTextEditor(page)).toContainText("More beta.");

    logE2eEvent("outline.tree-navigation", { projectDir });
  });

  test("refreshes tree headings when files are rewritten on disk @smoke", async ({
    page,
  }) => {
    const alphaPath = writeProjectFile(
      projectDir,
      "alpha.md",
      "# Alpha\n\n## First\n\nBody.\n",
    );
    const betaPath = writeProjectFile(
      projectDir,
      "beta.md",
      "# Beta\n\n## Beta first\n",
    );

    await page.goto(
      `/?${new URLSearchParams({
        dir: projectDir,
        path: alphaPath,
      }).toString()}`,
    );
    await expect(
      page.getByTestId("directory-outline-alpha.md-heading-1"),
    ).toHaveText("First");

    // Watch a second file's headings too; that one is polled rather than
    // derived from the open document.
    await page.getByTestId("directory-outline-toggle-beta.md").click();
    await expect(
      page.getByTestId("directory-outline-beta.md-heading-1"),
    ).toHaveText("Beta first");

    // An agent rewrites both files: the open one and a merely-expanded one.
    fs.writeFileSync(alphaPath, "# Alpha\n\n## Renamed\n\nBody.\n\n## Added\n");
    fs.writeFileSync(betaPath, "# Beta\n\n## Beta renamed\n");

    await expect(
      page.getByTestId("directory-outline-alpha.md-heading-1"),
    ).toHaveText("Renamed", { timeout: 10_000 });
    await expect(
      page.getByTestId("directory-outline-alpha.md-heading-2"),
    ).toHaveText("Added", { timeout: 10_000 });
    await expect(
      page.getByTestId("directory-outline-beta.md-heading-1"),
    ).toHaveText("Beta renamed", { timeout: 10_000 });

    logE2eEvent("outline.live-headings", { projectDir });
  });

  test("jumps to a heading from the single-file outline rail @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "plan.md",
      longDocument(["# Plan", "## Goals", "## Risks"]),
    );

    await page.goto(`/?${new URLSearchParams({ path: filePath }).toString()}`);
    await expect(page.getByTestId("document-outline-rail")).toBeVisible();
    await expect(page.getByTestId("document-outline-heading-2")).toHaveText(
      "Risks",
    );

    // The last heading starts below the fold, then the outline brings it up.
    const viewportHeight = page.viewportSize()?.height ?? 720;
    expect(await renderedHeadingTop(page, "Risks")).toBeGreaterThan(
      viewportHeight,
    );

    await page.getByTestId("document-outline-heading-2").click();
    await expect
      .poll(async () => await renderedHeadingTop(page, "Risks"), {
        timeout: 5_000,
      })
      .toBeLessThan(viewportHeight / 2);

    // The rail collapses to a strip and keeps the toggle available.
    await page.getByTestId("document-outline-toggle").click();
    await expect(page.getByTestId("document-outline-box")).toBeHidden();
    await expect(page.getByTestId("document-outline-toggle")).toBeVisible();

    logE2eEvent("outline.single-file-rail", { projectDir });
  });
});
