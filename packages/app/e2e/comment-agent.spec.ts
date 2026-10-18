import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  createMarkdownProject,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  selectRichText,
  writeProjectFile,
} from "./helpers";

/**
 * Set ROUGHDRAFT_SCREENSHOT_DIR (see docs/spec/ui-state-screenshot-guide.md)
 * to also capture the new UI states while the flow runs.
 */
async function snap(page: Page, name: string) {
  const dir = process.env.ROUGHDRAFT_SCREENSHOT_DIR;
  if (!dir) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.resolve(dir, `${name}.png`) });
}

/**
 * The comment ↔ Claude handoff through the real UI and a real server: the
 * exact submit path (composer mode → Save) has to put the comment on disk and
 * produce the event a `roughdraft listen` session would receive.
 */
test.describe("Ask / Change comments", () => {
  let projectDir: string;
  let pendingWatch: Promise<unknown> | null = null;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("comment-agent");
    pendingWatch = null;
  });

  test.afterEach(async () => {
    await pendingWatch?.catch(() => undefined);
    removeMarkdownProject(projectDir);
  });

  test("sends an Ask comment to the agent, shows the reply as Markdown and resolves the thread @smoke", async ({
    page,
    request,
  }) => {
    const relativePath = "ask.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      ["# Ask", "", "Cold start takes about four seconds.", ""].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("agent-connection-indicator")).toHaveText(
      "No Claude session listening",
    );

    // An agent-style watcher for comment events (no listener id, so the UI
    // still reports that no session is listening).
    const watch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        types: ["comment.ask"],
        timeoutSeconds: 20,
      },
    });
    pendingWatch = watch;

    await selectRichText(page, "about four seconds");
    await page.getByTestId("selection-menu-action-comment").click();
    await snap(page, "20-agent-composer-mode-comment");
    await page.getByTestId("comment-rail-c1-mode-ask").click();
    await page
      .getByTestId("comment-rail-c1-editor")
      .fill("What is included in that time?");
    await snap(page, "21-agent-composer-mode-ask");
    await page.getByTestId("comment-rail-c1-action-save").click();

    await expect
      .poll(() => readProjectFile(projectDir, relativePath))
      .toMatch(
        /\{==about four seconds==\}\{>>What is included in that time\?<<\}\{#c1\}[\s\S]*\n---\ncomments:\n {2}c1:\n(?: {4}.*\n)*? {4}intent: ask\n/,
      );

    const watchResponse = await watch;
    const payload = (await (
      watchResponse as { json: () => Promise<unknown> }
    ).json()) as { events: Array<Record<string, unknown>> };
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({
      type: "comment.ask",
      commentId: "c1",
    });

    // Nobody listens: the thread and the header say so, with the command.
    await expect(
      page.getByTestId("comment-rail-c1-agent-notice"),
    ).toContainText("No Claude session is listening");
    await expect(
      page.getByTestId("agent-no-listener-notice-command"),
    ).toHaveText(`roughdraft listen ${filePath}`);
    await expect(page.getByTestId("comment-rail-c1-agent-status")).toHaveText(
      "Waiting for Claude",
    );
    await snap(page, "22-agent-no-listener-notice-waiting");

    // The agent answers through the server, which rewrites the file.
    const reply = await request.post("/api/comments/reply", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        commentId: "c1",
        body: "The time to the **first request**:\n- cache warm-up\n- `model` load",
      },
    });
    expect(reply.status()).toBe(201);

    await expect(page.getByTestId("comment-rail-c1-agent-status")).toHaveText(
      "Answered",
    );
    const answer = page.getByTestId("comment-rail-c2-body");
    await expect(answer.locator("strong")).toHaveText("first request");
    await expect(answer.locator("li")).toHaveCount(2);
    await expect(answer.locator("li code")).toHaveText("model");
    // Answered threads no longer wait for a listener.
    await expect(page.getByTestId("comment-rail-c1-agent-notice")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("agent-no-listener-notice")).toHaveCount(0);
    await page.getByTestId("comment-thread-c1").click();
    await snap(page, "23-agent-answered-markdown-reply");

    await page.getByTestId("comment-thread-c1").click();
    await page.getByTestId("comment-rail-c1-action-resolve").click();
    await expect
      .poll(() => readProjectFile(projectDir, relativePath))
      .toMatch(/ {2}c1:\n(?: {4}.*\n)*? {4}status: resolved\n/);
    await expect(page.getByTestId("comment-rail-c1-resolved")).toContainText(
      "Resolved",
    );
    await snap(page, "24-agent-resolved-collapsed");
    await page.getByTestId("comment-thread-c1").click();
    await page.getByTestId("comment-rail-c1-show-resolved").click();
    await expect(
      page.getByTestId("comment-rail-c1-resolved-badge"),
    ).toBeVisible();
    await snap(page, "25-agent-resolved-shown");
  });

  test("reports a listening Claude session in the header and sends without a notice", async ({
    page,
    request,
  }) => {
    const relativePath = "listening.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      ["# Listening", "", "Rewrite this sentence please.", ""].join("\n"),
    );

    // What `roughdraft listen` does: a long-poll that names a listener.
    const watch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        types: ["comment.ask", "comment.change", "comment.followup"],
        timeoutSeconds: 20,
        listener: { id: "e2e-listener", sessionId: "abcd1234-0000-1111" },
      },
    });
    pendingWatch = watch;

    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("agent-connection-indicator")).toHaveText(
      "Claude listening · session abcd1234",
    );

    await selectRichText(page, "this sentence");
    await page.getByTestId("selection-menu-action-comment").click();
    await page.getByTestId("comment-rail-c1-mode-change").click();
    await page.getByTestId("comment-rail-c1-editor").fill("Make it shorter.");
    await snap(page, "26-agent-listening-composer-change");
    await page.getByTestId("comment-rail-c1-action-save").click();

    const payload = (await (
      (await watch) as { json: () => Promise<unknown> }
    ).json()) as { events: Array<Record<string, unknown>> };
    expect(payload.events[0]).toMatchObject({
      type: "comment.change",
      commentId: "c1",
    });
    await expect(page.getByTestId("comment-rail-c1-intent")).toHaveText(
      "Change",
    );
    await expect(page.getByTestId("comment-rail-c1-agent-notice")).toHaveCount(
      0,
    );
    await snap(page, "27-agent-listening-change-sent");
    expect(readProjectFile(projectDir, relativePath)).toContain(
      "intent: change",
    );
  });

  test("escalates a plain thread to Ask from a reply and sends a follow-up @smoke", async ({
    page,
    request,
  }) => {
    const relativePath = "escalate.md";
    writeProjectFile(
      projectDir,
      relativePath,
      [
        "# Escalate",
        "",
        "Cold start {==takes about four seconds==}{>>Seems slow.<<}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-10-18T12:00:00.000Z"',
        "",
      ].join("\n"),
    );
    const watch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        types: ["comment.followup"],
        timeoutSeconds: 20,
      },
    });
    pendingWatch = watch;

    await openMarkdownFile(page, path.join(projectDir, relativePath));
    await page.getByTestId("comment-thread-c1").click();
    await page.getByTestId("comment-rail-c1-action-reply").click();
    await expect(
      page.getByTestId("comment-rail-c2-mode-comment"),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("comment-rail-c2-mode-ask").click();
    await page
      .getByTestId("comment-rail-c2-editor")
      .fill("Claude, what dominates it?");
    await snap(page, "28-agent-reply-escalates-plain-thread");
    await page.getByTestId("comment-rail-c2-action-save").click();

    const payload = (await (
      (await watch) as { json: () => Promise<unknown> }
    ).json()) as { events: Array<Record<string, unknown>> };
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({
      type: "comment.followup",
      commentId: "c2",
      intent: "ask",
    });
    const saved = readProjectFile(projectDir, relativePath);
    expect(saved).toMatch(/ {2}c1:\n(?: {4}.*\n)*? {4}intent: ask\n/);
    expect(saved).toMatch(
      / {2}c2:\n(?: {4}.*\n)*? {4}body: Claude, what dominates it\?\n/,
    );
    await expect(page.getByTestId("comment-rail-c1-intent")).toHaveText("Ask");
    await expect(page.getByTestId("comment-rail-c1-agent-status")).toHaveText(
      "Waiting for Claude",
    );
  });
});
