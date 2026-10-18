import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentThreadStatusLine } from "../src/AgentThreadStatus";
import type { ThreadAgentDisplayStatus } from "../src/comment-agent";

/**
 * The status line under an Ask/Change thread: label, live elapsed time since
 * the user's comment, and a hint when a session holds the thread in its queue
 * for a while.
 */

const ASKED_AT = Date.parse("2026-10-18T12:00:00.000Z");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(ASKED_AT);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

const testId = "comment-rail-c1-agent-status";

function part(suffix = "") {
  return container.querySelector<HTMLElement>(
    `[data-testid="${testId}${suffix}"]`,
  );
}

async function render(
  status: ThreadAgentDisplayStatus,
  options: {
    since?: string;
    requestedAt?: string;
    listening?: boolean;
    delegatedTo?: "fork-process";
  } = {},
) {
  await act(async () => {
    root.render(
      <AgentThreadStatusLine
        status={status}
        listening={options.listening ?? true}
        since={options.since}
        requestedAt={options.requestedAt}
        delegatedTo={options.delegatedTo}
        testId={testId}
      />,
    );
  });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

describe("agent thread status line", () => {
  it("shows the label and the time since the user's comment, ticking live", async () => {
    await render("queued", {
      requestedAt: iso(ASKED_AT),
      since: iso(ASKED_AT),
    });

    expect(part()?.dataset.agentStatus).toBe("queued");
    expect(part("-label")?.textContent).toBe("Queued in Claude's session");
    expect(part("-elapsed")?.textContent).toBe("0s");

    await advance(12_000);
    expect(part("-elapsed")?.textContent).toBe("12s");

    await advance(53_000);
    expect(part("-elapsed")?.textContent).toBe("1m 5s");
  });

  it("hints that Claude is busy once a thread sits queued for over a minute", async () => {
    await render("queued", {
      requestedAt: iso(ASKED_AT),
      since: iso(ASKED_AT),
    });

    await advance(59_000);
    expect(part("-busy-hint")).toBeNull();

    await advance(2_000);
    expect(part("-busy-hint")?.textContent).toBe(
      "Claude is busy; it will answer after its current step",
    );
  });

  it("drops the busy hint and keeps counting once the thread moves on", async () => {
    await render("queued", {
      requestedAt: iso(ASKED_AT),
      since: iso(ASKED_AT),
    });
    await advance(70_000);
    expect(part("-busy-hint")).not.toBeNull();

    await render("delegated", {
      requestedAt: iso(ASKED_AT),
      since: iso(ASKED_AT + 70_000),
    });

    expect(part("-label")?.textContent).toBe("Passed to a subagent");
    expect(part("-busy-hint")).toBeNull();
    expect(part("-elapsed")?.textContent).toBe("1m 10s");
  });

  it("shows no timer once answered, nor without a server timestamp", async () => {
    await render("answered", { requestedAt: iso(ASKED_AT) });
    expect(part("-label")?.textContent).toBe("Answered");
    expect(part("-elapsed")).toBeNull();

    await render("working");
    expect(part("-label")?.textContent).toBe("Claude is working…");
    expect(part("-elapsed")).toBeNull();
  });

  it("says when a headless fork answers because the session is busy", async () => {
    await render("delegated", { delegatedTo: "fork-process" });

    expect(part("-label")?.textContent).toBe("Passed to a forked Claude");
  });

  it("tells a missing session apart from one that has not picked it up yet", async () => {
    await render("pending", { listening: false });
    expect(part("-label")?.textContent).toBe("Waiting for a Claude session");

    await render("pending", { listening: true });
    expect(part("-label")?.textContent).toBe(
      "Waiting for Claude to pick it up",
    );
  });
});
