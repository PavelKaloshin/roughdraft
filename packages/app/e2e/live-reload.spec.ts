import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
  codeEditor,
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

// An agent (Claude Code) edits the markdown file on disk while the user is
// reading or typing in Roughdraft. The open editor must update in place, like
// a live artifact: no remount, caret and scroll kept, the change flashed.

const paragraphCount = 40;
const buildDocument = (overrides: Record<number, string> = {}) =>
  [
    "# Live reload",
    "",
    ...Array.from({ length: paragraphCount }, (_, index) => [
      overrides[index + 1] ??
        `Paragraph ${index + 1} is ordinary review text for the live reload check.`,
      "",
    ]).flat(),
  ].join("\n");

function trackMarkdownWrites(page: Page) {
  const writes: Array<{ status: number; body: string }> = [];
  page.on("response", async (response) => {
    const request = response.request();
    if (
      request.method() === "PUT" &&
      new URL(request.url()).pathname === "/api/markdown-file"
    ) {
      writes.push({
        status: response.status(),
        body: request.postData() ?? "",
      });
    }
  });
  return writes;
}

/** Which tagged paragraph holds the caret, and the caret's text offset. */
async function readCaret(page: Page) {
  return page.evaluate(() => {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode ?? null;
    const element =
      anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
    const paragraph = element?.closest("p") as
      | (Element & { __e2eTag?: string })
      | null;
    return {
      paragraph: paragraph?.__e2eTag ?? null,
      text: anchor?.textContent?.slice(0, 20) ?? null,
      offset: selection?.anchorOffset ?? -1,
    };
  });
}

/** The element that scrolls the document (nearest scrollable ancestor). */
async function readDocumentScrollTop(page: Page) {
  return page.evaluate(() => {
    let element = document.querySelector(".ProseMirror")?.parentElement;
    while (element) {
      const style = getComputedStyle(element);
      if (
        /(auto|scroll)/.test(style.overflowY) &&
        element.scrollHeight > element.clientHeight
      ) {
        return element.scrollTop;
      }
      element = element.parentElement;
    }
    return document.scrollingElement?.scrollTop ?? 0;
  });
}

async function scrollDocumentBy(page: Page, delta: number) {
  await page.evaluate((amount) => {
    let element = document.querySelector(".ProseMirror")?.parentElement;
    while (element) {
      const style = getComputedStyle(element);
      if (
        /(auto|scroll)/.test(style.overflowY) &&
        element.scrollHeight > element.clientHeight
      ) {
        element.scrollTop += amount;
        return;
      }
      element = element.parentElement;
    }
    document.scrollingElement?.scrollBy(0, amount);
  }, delta);
}

test.describe("live reload of external file changes", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("live-reload");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("updates a clean document in place, keeping caret and scroll @smoke", async ({
    page,
  }) => {
    const writes = trackMarkdownWrites(page);
    const filePath = writeProjectFile(projectDir, "live.md", buildDocument());
    await openMarkdownFile(page, filePath, "rich-text");
    const editor = richTextEditor(page);
    await expect(editor).toContainText("Paragraph 40");

    // Caret inside paragraph 1, placed the way a person does it (a click),
    // then wait until ProseMirror itself has registered it.
    const paragraphOne = editor
      .locator("p") // selector-check-ignore
      .filter({ hasText: "Paragraph 1 is ordinary" });
    const box = await paragraphOne.boundingBox();
    if (!box) throw new Error("paragraph 1 is not laid out");
    await page.mouse.click(box.x + 60, box.y + box.height / 2);
    await page.waitForFunction(() => {
      const dom = document.querySelector(".ProseMirror") as
        | (Element & {
            editor?: { state: { selection: { empty: boolean; from: number } } };
          })
        | null;
      const selection = dom?.editor?.state.selection;
      return selection?.empty === true && selection.from > 1;
    });
    // Tag DOM nodes with JS properties, not attributes: ProseMirror observes
    // attribute mutations and would redraw a node it sees changed.
    await page.evaluate(() => {
      const tag = (element: Element | null | undefined, value: string) => {
        if (element)
          (element as Element & { __e2eTag?: string }).__e2eTag = value;
      };
      tag(document.querySelector(".ProseMirror"), "original-editor");
      tag(
        [...(document.querySelector(".ProseMirror")?.children ?? [])].find(
          (p) => p.textContent?.startsWith("Paragraph 1 "),
        ),
        "paragraph-1",
      );
    });
    const caretBefore = await readCaret(page);
    expect(caretBefore.paragraph).toBe("paragraph-1");

    await scrollDocumentBy(page, 240);
    const scrollTopBefore = await readDocumentScrollTop(page);
    expect(scrollTopBefore).toBeGreaterThan(0);

    const agentEdit = buildDocument({
      5: "Paragraph 5 was rewritten on disk by the agent just now.",
    });
    fs.writeFileSync(filePath, agentEdit);

    await expect(editor).toContainText("rewritten on disk by the agent");
    const highlight = editor.getByTestId("external-change-highlight");
    await expect(highlight).toHaveCount(1);
    await expect(highlight).toContainText("rewritten on disk by the agent");

    // Same editor DOM, same untouched paragraph DOM, caret and scroll kept.
    expect(
      await page.evaluate(() => {
        const tagOf = (element: Element | null | undefined) =>
          (element as (Element & { __e2eTag?: string }) | null | undefined)
            ?.__e2eTag ?? null;
        return {
          editor: tagOf(document.querySelector(".ProseMirror")),
          paragraph: tagOf(
            [...(document.querySelector(".ProseMirror")?.children ?? [])].find(
              (p) => p.textContent?.startsWith("Paragraph 1 "),
            ),
          ),
        };
      }),
    ).toEqual({ editor: "original-editor", paragraph: "paragraph-1" });
    expect(await readCaret(page)).toEqual(caretBefore);
    expect(await readDocumentScrollTop(page)).toBe(scrollTopBefore);

    // The highlight fades and is removed.
    await expect(highlight).toHaveCount(0, { timeout: 4_000 });

    // Give autosave (500ms debounce) ample time: nothing may be written back.
    await page.waitForTimeout(1_000);
    expect(writes).toEqual([]);
    expect(readProjectFile(projectDir, "live.md")).toBe(agentEdit);

    logE2eEvent("live-reload.clean-in-place", { file: "live.md" });
  });

  test("flashes an external change in the raw editor too @smoke", async ({
    page,
  }) => {
    const writes = trackMarkdownWrites(page);
    const filePath = writeProjectFile(projectDir, "raw.md", buildDocument());
    await openMarkdownFile(page, filePath, "code");
    const editor = codeEditor(page);
    await expect(editor).toContainText("Paragraph 3 is ordinary");

    const agentEdit = buildDocument({
      3: "Paragraph 3 was rewritten on disk by the agent just now.",
    });
    fs.writeFileSync(filePath, agentEdit);

    await expect(editor).toContainText("rewritten on disk by the agent");
    const highlight = editor.getByTestId("external-change-highlight");
    await expect(highlight).toHaveCount(1);
    await expect(highlight).toContainText("rewritten on disk by the agent");
    await expect(highlight).toHaveCount(0, { timeout: 4_000 });

    await page.waitForTimeout(1_000);
    expect(writes).toEqual([]);
    expect(readProjectFile(projectDir, "raw.md")).toBe(agentEdit);

    logE2eEvent("live-reload.raw-highlight", { file: "raw.md" });
  });

  test("merges local typing with a concurrent agent edit and saves once @smoke", async ({
    page,
  }) => {
    const writes = trackMarkdownWrites(page);
    const filePath = writeProjectFile(projectDir, "merge.md", buildDocument());
    await openMarkdownFile(page, filePath, "rich-text");
    const editor = richTextEditor(page);
    await expect(editor).toContainText("Paragraph 40");

    await selectRichText(page, "Paragraph 1 is ordinary");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.type(" Typed locally.");
    // The agent writes before the local autosave has landed.
    fs.writeFileSync(
      filePath,
      buildDocument({
        5: "Paragraph 5 was rewritten on disk by the agent just now.",
      }),
    );

    await expect(editor).toContainText("rewritten on disk by the agent");
    await expect(editor).toContainText("Typed locally.");
    await expect
      .poll(() => readProjectFile(projectDir, "merge.md"))
      .toContain("Typed locally.");
    await page.waitForTimeout(1_500);

    const saved = readProjectFile(projectDir, "merge.md");
    expect(saved).toContain("Typed locally.");
    expect(saved).toContain(
      "Paragraph 5 was rewritten on disk by the agent just now.",
    );
    expect(writes.filter((write) => write.status === 200)).toHaveLength(1);
    await expect(page.getByTestId("file-conflict-notice")).toHaveCount(0);

    logE2eEvent("live-reload.merged", {
      file: "merge.md",
      writes: writes.map((write) => write.status),
    });
  });
});
