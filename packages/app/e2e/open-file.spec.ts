import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("opening local markdown files", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("open-file");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("renders core Markdown blocks from a real file @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "review.md",
      [
        "# Smoke Fixture",
        "",
        "A paragraph with [local link](./notes.md), [anchor](#smoke-fixture), and [mail](mailto:review@example.com).",
        "",
        "- first",
        "- second",
        "",
        "- [x] shipped",
        "- [ ] pending",
        "",
        "| Name | Status |",
        "| --- | --- |",
        "| Roughdraft | ready |",
        "",
        '![Sketch](./images/sketch.png "Sketch title")',
        "",
        "```ts",
        "const value = 1;",
        "```",
        "",
      ].join("\n"),
    );
    writeProjectFile(
      projectDir,
      "images/sketch.png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    );

    await openMarkdownFile(page, filePath);

    await expect(
      page.getByRole("heading", { name: "Smoke Fixture" }),
    ).toBeVisible();
    await expect(page.getByText("first")).toBeVisible();
    await expect(page.getByRole("cell", { name: "Roughdraft" })).toBeVisible();
    await expect(
      page.locator('a[data-markdown-src="./notes.md"]', {
        hasText: "local link",
      }),
    ).toBeVisible();
    await expect(
      page.locator(
        'img[alt="Sketch"][data-markdown-src="./images/sketch.png"]',
      ),
    ).toBeVisible();
    await expect(page.getByText("const value = 1;")).toBeVisible();

    logE2eEvent("open-file.rendered", {
      projectDir,
      file: "review.md",
    });
  });

  test("focuses an existing window for a repeated open request", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "repeat.md",
      "# Repeat Open\n\nExisting window body.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(page.locator(".cm-content")).toContainText(
      "Existing window body.",
    );

    const targetUrl = `/?${new URLSearchParams({
      path: filePath,
      editor: "code",
    }).toString()}`;
    const response = await page.request.post("/api/open-request", {
      data: { path: filePath, url: targetUrl },
    });

    expect(response.ok()).toBe(true);
    await expect(response.json()).resolves.toEqual({ delivered: true });
    await expect(page.locator(".cm-content")).toContainText(
      "Existing window body.",
    );

    logE2eEvent("open-file.reused-existing-window", {
      projectDir,
      file: "repeat.md",
    });
  });
});
