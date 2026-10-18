import fs from "node:fs";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

// An agent writes a document, the user only reads it in an open tab, and the
// agent keeps editing the file. Roughdraft must never write the file back:
// any save of an untouched document can only re-serialize (and rewrite) it.
const agentDocument = `# Plan

Intro paragraph right after a heading.

## Format

{>>Agent note without metadata.<<}

\`\`\`markdown
{==anchor==}{>>Literal example inside a fence<<}{#c3}

---
comments:
  c3:
    by: pavel
\`\`\`

## Steps

1. **First** step.
2. **Second** step.
`;

test.describe("unedited documents", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("unedited-no-save");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("an open tab never writes back a document the user did not edit @smoke", async ({
    page,
  }) => {
    const markdownWrites: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "PUT" &&
        new URL(request.url()).pathname === "/api/markdown-file"
      ) {
        markdownWrites.push(request.postData() ?? "");
      }
    });

    const filePath = writeProjectFile(projectDir, "plan.md", agentDocument);
    await openMarkdownFile(page, filePath, "rich-text");
    await expect(richTextEditor(page)).toContainText("Second step.");

    // The agent edits the file on disk while the tab is open.
    const agentEdit = `${agentDocument}3. Third step added by the agent.\n`;
    fs.writeFileSync(filePath, agentEdit);
    await expect(richTextEditor(page)).toContainText(
      "Third step added by the agent.",
    );

    // Give autosave (500ms debounce) ample time to fire if it were going to.
    await page.waitForTimeout(1500);

    expect(markdownWrites).toEqual([]);
    expect(readProjectFile(projectDir, "plan.md")).toBe(agentEdit);

    logE2eEvent("unedited-no-save.verified", { file: "plan.md" });
  });

  test("opening and cancelling a comment composer never writes the file @smoke", async ({
    page,
  }) => {
    // Found on a real document: the composer created an empty draft, the
    // re-serialized document differed from the source, and Escape left a
    // pending autosave that rewrote the whole file.
    const markdownWrites: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "PUT" &&
        new URL(request.url()).pathname === "/api/markdown-file"
      ) {
        markdownWrites.push(request.postData() ?? "");
      }
    });

    const source = fs.readFileSync(
      new URL("../../skill/SKILL.md", import.meta.url),
      "utf8",
    );
    const filePath = writeProjectFile(projectDir, "SKILL.md", source);
    await openMarkdownFile(page, filePath, "rich-text");
    await expect(richTextEditor(page)).toContainText("Roughdraft live review");

    await selectRichText(page, "ordinary feedback");
    await page.getByTestId("selection-menu-action-comment").click();
    // Keep the empty composer open past the 500 ms autosave debounce.
    await page.waitForTimeout(800);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1200);

    expect(markdownWrites).toEqual([]);
    expect(readProjectFile(projectDir, "SKILL.md")).toBe(source);

    logE2eEvent("unedited-no-save.composer-cancelled", { file: "SKILL.md" });
  });
});
