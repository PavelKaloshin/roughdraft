import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  createMarkdownProject,
  openMarkdownFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

/**
 * Set ROUGHDRAFT_SCREENSHOT_DIR (see docs/spec/ui-state-screenshot-guide.md)
 * to also capture the reader states while the flow runs.
 */
async function snap(page: Page, name: string) {
  const dir = process.env.ROUGHDRAFT_SCREENSHOT_DIR;
  if (!dir) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.resolve(dir, `${name}.png`) });
}

const answerParagraph = (index: number) =>
  `${index}. **Step ${index}** — the request waits for the tokenizer cache, then maps the model weights lazily, so the first forward pass pays for page faults across the whole file.`;

const longAnswer = [
  "Short version: the cold start is dominated by two things, and both can be measured separately.",
  "",
  ...Array.from({ length: 14 }, (_, index) => answerParagraph(index + 1)),
  "",
  "```ts",
  "const model = await loadModel({ lazy: false, prefetch: true, cache: 'warm', path: '/models/large.bin' });",
  "```",
  "",
  "If you want, I can measure both and add the numbers here.",
].join("\n");

const doc = [
  "# Cold start",
  "",
  "Cold start {==takes about four seconds==}{>>Why is it slow?<<}{#c1} on a fresh container.",
  "",
  "---",
  "comments:",
  "  c1:",
  "    by: user",
  '    at: "2026-10-18T12:00:00.000Z"',
  "    intent: ask",
  "  c2:",
  "    body: |",
  ...longAnswer.split("\n").map((line) => (line ? `      ${line}` : "")),
  "    by: AI",
  '    at: "2026-10-18T12:00:20.000Z"',
  "    re: c1",
  "",
].join("\n");

test.describe("thread reader", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("comment-reader");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("clamps a long AI reply in the rail and reads it in a scrolling dialog @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(projectDir, "reader.md", doc);
    await openMarkdownFile(page, filePath);

    await page.getByTestId("comment-thread-c1").click();
    const clamp = page.getByTestId("comment-rail-c2-body-clamp");
    await expect(clamp).toHaveAttribute("data-clamped", "true");
    // The clamp really limits the height in the rail.
    const clampHeight = await clamp.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(clampHeight).toBeLessThanOrEqual(121);
    await expect(page.getByTestId("comment-rail-c2-read-more")).toHaveText(
      "Read more",
    );
    await snap(page, "40-comment-rail-long-body-clamped");

    await page.getByTestId("comment-rail-c2-read-in-reader").click();
    const dialog = page.getByTestId("comment-reader");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("comment-reader-anchor")).toHaveText(
      "takes about four seconds",
    );
    await expect(
      page.getByTestId("comment-reader-agent-status-label"),
    ).toHaveText("Answered");

    // The thread scrolls inside the dialog, not the page.
    const body = page.getByTestId("comment-reader-body");
    const metrics = await body.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    const dialogBox = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(dialogBox?.width).toBeLessThanOrEqual(720);
    expect(dialogBox?.height ?? 0).toBeLessThanOrEqual(
      (viewport?.height ?? 0) * 0.8 + 1,
    );
    // Code blocks scroll horizontally instead of widening the dialog.
    const pre = page
      .getByTestId("comment-reader-comment-c2-body")
      .locator("pre"); // selector-check-ignore
    const preOverflow = await pre.evaluate((element) => ({
      overflowX: getComputedStyle(element).overflowX,
      fits: element.getBoundingClientRect().width <= 720,
    }));
    expect(preOverflow).toEqual({ overflowX: "auto", fits: true });
    await snap(page, "41-comment-reader-light");

    await page.emulateMedia({ colorScheme: "dark" });
    await snap(page, "42-comment-reader-dark");
    await page.emulateMedia({ colorScheme: "light" });

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("comment-rail-c1")).toBeFocused();

    // O on the focused thread reopens it; on a phone it fills the screen.
    await page.keyboard.press("o");
    await expect(dialog).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(async () => (await dialog.boundingBox())?.width)
      .toBeGreaterThanOrEqual(389);
    await snap(page, "43-comment-reader-narrow");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // Reply from the reader hands off to the rail composer, focused.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByTestId("comment-thread-c1").click();
    await page.getByTestId("comment-rail-c1-action-open").click();
    await expect(dialog).toBeVisible();
    await page.getByTestId("comment-reader-reply").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("comment-rail-c3-editor")).toBeFocused();
  });
});
