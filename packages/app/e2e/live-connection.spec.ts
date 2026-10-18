import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  createMarkdownProject,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

/**
 * Every open Roughdraft tab keeps live updates (file changes, agent status,
 * open requests) flowing from the server. Browsers allow only six HTTP/1.1
 * connections per host across all tabs, so long-lived per-tab HTTP streams
 * starve every other request once a few tabs are open: saves and comment
 * events queue until a stream reconnects. These tests run several tabs of one
 * browser context (one shared connection pool) against the real server.
 */
test.describe("Live connection with several tabs", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("live-connection");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  async function openTabs(
    context: BrowserContext,
    files: string[],
  ): Promise<Page[]> {
    const pages: Page[] = [];
    for (const filePath of files) {
      const tab = await context.newPage();
      await openMarkdownFile(tab, filePath);
      await expect(richTextEditor(tab)).toBeVisible();
      pages.push(tab);
    }
    return pages;
  }

  test("an Ask comment saves and reaches the server promptly with four tabs open @smoke", async ({
    context,
  }) => {
    const otherFiles = [1, 2, 3].map((index) =>
      writeProjectFile(
        projectDir,
        `other-${index}.md`,
        `# Other ${index}\n\nBackground tab ${index}.\n`,
      ),
    );
    const relativePath = "ask.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      ["# Ask", "", "Cold start takes about four seconds.", ""].join("\n"),
    );

    await openTabs(context, otherFiles);
    const [tab] = await openTabs(context, [filePath]);
    if (!tab) throw new Error("tab did not open");
    await expect(tab.getByTestId("agent-connection-indicator")).toHaveText(
      "No Claude session listening",
    );

    await selectRichText(tab, "about four seconds");
    await tab.getByTestId("selection-menu-action-comment").click();
    await tab
      .getByTestId("comment-rail-c1-editor")
      .fill("What is included in that time?");
    await tab.getByTestId("comment-rail-c1-mode-ask").click();
    await tab.getByTestId("comment-rail-c1-action-save").click();

    await expect
      .poll(() => readProjectFile(projectDir, relativePath), {
        timeout: 2_500,
      })
      .toContain("intent: ask");
    await expect(
      tab.getByTestId("comment-rail-c1-agent-status-label"),
    ).toHaveText("Waiting for a Claude session", { timeout: 2_500 });
  });

  test("an external write reaches every tab showing the file @smoke", async ({
    context,
  }) => {
    const relativePath = "shared.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      "# Shared\n\nFirst version of the text.\n",
    );
    const tabs = await openTabs(context, [filePath, filePath, filePath]);

    writeProjectFile(
      projectDir,
      relativePath,
      "# Shared\n\nSecond version written by an agent.\n",
    );

    for (const tab of tabs) {
      await expect(richTextEditor(tab)).toContainText(
        "Second version written by an agent.",
      );
    }
  });

  test("agent status updates and open requests reach a tab among several @smoke", async ({
    context,
    request,
  }) => {
    const relativePath = "status.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      "# Status\n\nWatched document.\n",
    );
    const nextFile = writeProjectFile(
      projectDir,
      "next.md",
      "# Next\n\nThe document the CLI asked for.\n",
    );
    const otherFile = writeProjectFile(
      projectDir,
      "other.md",
      "# Other\n\nAnother tab.\n",
    );
    const [, tab] = await openTabs(context, [otherFile, filePath, otherFile]);
    if (!tab) throw new Error("tab did not open");
    await expect(tab.getByTestId("agent-connection-indicator")).toHaveText(
      "No Claude session listening",
    );

    // A listener attaching after the tab opened is a live status update.
    const watch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        types: ["comment.ask"],
        timeoutSeconds: 3,
        listener: { id: "e2e-live", sessionId: "feed5678-0000-1111" },
      },
    });
    await expect(tab.getByTestId("agent-connection-indicator")).toHaveText(
      "Claude listening · session feed5678",
    );
    await watch;

    // `roughdraft open` reuses the tab registered for this path.
    const targetUrl = `/?${new URLSearchParams({ path: nextFile }).toString()}`;
    const response = await request.post("/api/open-request", {
      data: { path: filePath, url: targetUrl },
    });
    await expect(response.json()).resolves.toEqual({ delivered: true });
    await expect(richTextEditor(tab)).toContainText(
      "The document the CLI asked for.",
    );
  });
});
