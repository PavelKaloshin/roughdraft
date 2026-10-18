import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./index";

// The open tab learns about agent/editor writes through this SSE stream, so
// the real watcher, real filesystem, and real HTTP stream are the behavior.
describe("markdown file change events", () => {
  let projectDir: string;
  let documentPath: string;
  let server: Server;
  let baseUrl: string;
  let stream: ReadableStreamDefaultReader<Uint8Array> | null = null;

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-watch-"));
    documentPath = path.join(projectDir, "plan.md");
    fs.writeFileSync(documentPath, "# Plan\n");
    const { app } = createApp({ staticDirPath: projectDir });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await stream?.cancel().catch(() => {});
    stream = null;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  interface ChangeEvent {
    at: number;
    path: string;
    exists: boolean;
    version: string | null;
  }

  async function subscribe(): Promise<ChangeEvent[]> {
    const response = await fetch(
      `${baseUrl}/api/markdown-file/events?projectPath=${encodeURIComponent(projectDir)}&path=plan.md`,
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no event stream");
    stream = reader;
    const events: ChangeEvent[] = [];
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      for (;;) {
        const chunk = await reader
          .read()
          .catch(() => ({ done: true }) as const);
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const data = block.match(/^event: change\ndata: (.*)$/m)?.[1];
          if (data) events.push({ at: Date.now(), ...JSON.parse(data) });
        }
      }
    })();
    // Let the server attach its watcher before the test writes.
    await sleep(100);
    return events;
  }

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  function versionOnDisk(): Promise<string> {
    return fetch(
      `${baseUrl}/api/markdown-file?projectPath=${encodeURIComponent(projectDir)}&path=plan.md`,
    )
      .then((response) => response.json())
      .then((page: { version: string }) => page.version);
  }

  /** Waits past the debounce and any duplicate notifications. */
  async function settle(events: ChangeEvent[], count: number) {
    const deadline = Date.now() + 2000;
    while (events.length < count && Date.now() < deadline) await sleep(10);
    await sleep(300);
  }

  it("reports an atomic temp-file + rename write once, quickly", async () => {
    const events = await subscribe();

    // Three writes in a row: each must be seen once and well before the old
    // 500ms stat-polling interval would (measured ~400ms; P(< 200ms, 3×) ≈ 6%).
    for (const [index, content] of [
      "# One\n",
      "# Two\n",
      "# Three\n",
    ].entries()) {
      const temp = path.join(projectDir, `.plan.md.${index}.tmp`);
      const writtenAt = Date.now();
      fs.writeFileSync(temp, content);
      fs.renameSync(temp, documentPath);
      await settle(events, index + 1);

      expect(events).toHaveLength(index + 1);
      const event = events[index];
      expect(event).toMatchObject({ path: "plan.md", exists: true });
      expect(event?.version).toBe(await versionOnDisk());
      expect((event?.at ?? Number.POSITIVE_INFINITY) - writtenAt).toBeLessThan(
        200,
      );
    }
  });

  it("reports an in-place write once, quickly", async () => {
    const events = await subscribe();

    const writtenAt = Date.now();
    fs.writeFileSync(documentPath, "# Plan\n\nMore.\n");
    await settle(events, 1);

    expect(events).toHaveLength(1);
    expect(events[0]?.version).toBe(await versionOnDisk());
    expect(
      (events[0]?.at ?? Number.POSITIVE_INFINITY) - writtenAt,
    ).toBeLessThan(200);
  });

  it("does not report writes to other files in the directory", async () => {
    const events = await subscribe();

    fs.writeFileSync(path.join(projectDir, "other.md"), "# Other\n");
    fs.writeFileSync(path.join(projectDir, "plan.md.bak"), "# Backup\n");
    await sleep(700);

    expect(events).toEqual([]);
  });

  it("tags the app's own save with the version the save returned, so the tab can skip its echo", async () => {
    const events = await subscribe();

    const saved = await fetch(
      `${baseUrl}/api/markdown-file?projectPath=${encodeURIComponent(projectDir)}&path=plan.md`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: projectDir,
          content: "# Plan\n\nSaved from the tab.\n",
        }),
      },
    ).then((response) => response.json() as Promise<{ version: string }>);
    await settle(events, 1);

    expect(events).toHaveLength(1);
    expect(events[0]?.version).toBe(saved.version);
  });

  it("falls back to stat polling when native watching is unavailable", async () => {
    const watch = vi.spyOn(fs, "watch").mockImplementation(() => {
      throw Object.assign(new Error("watchers exhausted"), { code: "ENOSPC" });
    });
    try {
      const events = await subscribe();

      fs.writeFileSync(documentPath, "# Plan\n\nPolled.\n");
      await settle(events, 1);

      expect(watch).toHaveBeenCalled();
      expect(events).toHaveLength(1);
      expect(events[0]?.version).toBe(await versionOnDisk());
    } finally {
      watch.mockRestore();
    }
  });

  it("reports deletion and re-creation", async () => {
    const events = await subscribe();

    fs.rmSync(documentPath);
    await settle(events, 1);
    fs.writeFileSync(documentPath, "# Back\n");
    await settle(events, 2);

    expect(events.map(({ exists, version }) => ({ exists, version }))).toEqual([
      { exists: false, version: null },
      { exists: true, version: await versionOnDisk() },
    ]);
  });
});
