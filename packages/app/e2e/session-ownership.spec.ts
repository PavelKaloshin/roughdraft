import crypto from "node:crypto";
import path from "node:path";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  createMarkdownProject,
  openMarkdownFile,
  removeMarkdownProject,
  selectRichText,
  writeProjectFile,
} from "./helpers";

/** See docs/spec/ui-state-screenshot-guide.md (ROUGHDRAFT_SCREENSHOT_DIR). */
async function snap(page: Page, name: string) {
  const dir = process.env.ROUGHDRAFT_SCREENSHOT_DIR;
  if (!dir) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.resolve(dir, `${name}.png`) });
}

interface SessionListenBody {
  events: Array<{ type: string; commentId?: string; documentPath: string }>;
  notices: Array<{ type: string; documentPath: string }>;
  nextSequence: number;
  noticeCursor: number;
}

/**
 * Document ownership (ADR 0007) through the real UI and server: two Claude
 * Code sessions listen the way the plugin's `roughdraft listen --session`
 * does; the header names the owner, and "Connect session" moves the file's
 * next Ask to the other session.
 */
test.describe("Session ownership", () => {
  let projectDir: string;
  const pending: Array<Promise<unknown>> = [];

  test.beforeEach(() => {
    projectDir = createMarkdownProject("session-ownership");
  });

  test.afterEach(async () => {
    await Promise.allSettled(pending.splice(0));
    removeMarkdownProject(projectDir);
  });

  function listen(
    request: APIRequestContext,
    sessionId: string,
    data: Record<string, unknown>,
  ): Promise<SessionListenBody> {
    const response = request
      .post("/api/sessions/listen", {
        data: {
          sessionId,
          listenerId: `e2e-${sessionId}`,
          afterSequence: 0,
          afterNotice: 0,
          timeoutSeconds: 0,
          batchWindowSeconds: 0,
          ...data,
        },
      })
      .then((result) => result.json() as Promise<SessionListenBody>);
    pending.push(response);
    return response;
  }

  const after = (body: SessionListenBody) => ({
    afterSequence: body.nextSequence - 1,
    afterNotice: body.noticeCursor,
  });

  test("names the owning session and routes the next Ask to the session the user connects @smoke", async ({
    page,
    request,
  }) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const sessionA = `aaaa${suffix}`;
    const sessionB = `bbbb${suffix}`;
    const filePath = writeProjectFile(
      projectDir,
      "plan.md",
      ["# Plan", "", "Cold start takes about four seconds.", ""].join("\n"),
    );
    const folder = path.basename(projectDir);

    // Session A wrote the file (its claims come with the listener); session
    // B works elsewhere. Both are live.
    const a0 = await listen(request, sessionA, {
      claims: [filePath],
      title: "auth refactor",
      cwd: projectDir,
    });
    const b0 = await listen(request, sessionB, {
      title: "docs pass",
      cwd: "/work/other-project",
    });

    await openMarkdownFile(page, filePath);
    const indicator = page.getByTestId("agent-connection-indicator");
    await expect(indicator).toHaveText(`Claude · auth refactor · ${folder}`);
    await expect(indicator).toHaveAttribute("data-listening", "true");
    await snap(page, "40-session-owner-header");

    await indicator.click();
    await expect(page.getByTestId("agent-session-menu")).toBeVisible();
    await expect(
      page.getByTestId(`agent-session-option-${sessionA}`),
    ).toHaveAttribute("data-owner", "true");
    await snap(page, "41-session-connect-menu");
    await page.getByTestId(`agent-session-option-${sessionB}`).click();
    await expect(indicator).toHaveText("Claude · docs pass · other-project");

    // The previous owner is told; the new owner hears about the file.
    const a1 = await listen(request, sessionA, after(a0));
    expect(a1.notices).toEqual([
      expect.objectContaining({ type: "released", documentPath: filePath }),
    ]);
    const b1 = await listen(request, sessionB, after(b0));
    expect(b1.notices).toEqual([
      expect.objectContaining({ type: "claimed", documentPath: filePath }),
    ]);

    const aWait = listen(request, sessionA, {
      ...after(a1),
      timeoutSeconds: 4,
    });
    const bWait = listen(request, sessionB, {
      ...after(b1),
      timeoutSeconds: 20,
    });

    await selectRichText(page, "about four seconds");
    await page.getByTestId("selection-menu-action-comment").click();
    await page.getByTestId("comment-rail-c1-mode-ask").click();
    await page
      .getByTestId("comment-rail-c1-editor")
      .fill("What is included in that time?");
    await page.getByTestId("comment-rail-c1-action-save").click();

    expect((await bWait).events).toEqual([
      expect.objectContaining({
        type: "comment.ask",
        commentId: "c1",
        documentPath: filePath,
      }),
    ]);
    expect((await aWait).events).toEqual([]);
    await expect(page.getByTestId("comment-rail-c1-agent-notice")).toHaveCount(
      0,
    );
  });

  test("explains how to connect a session when none is running @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "lonely.md",
      ["# Lonely", "", "Nobody listens here.", ""].join("\n"),
    );
    await openMarkdownFile(page, filePath);
    const indicator = page.getByTestId("agent-connection-indicator");
    await expect(indicator).toHaveText("Claude · No session");
    await indicator.click();
    await expect(page.getByTestId("agent-session-menu")).toBeVisible();
    // Other tests' sessions may be live on the shared server; the setup
    // hint is only shown when there are none, so check the hint or a list.
    const empty = page.getByTestId("agent-session-menu-empty");
    if ((await empty.count()) > 0) {
      await expect(
        page.getByTestId("agent-session-menu-setup-command"),
      ).toHaveText("roughdraft setup claude");
      await snap(page, "42-session-menu-empty");
    }
  });
});
