import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConnectionIndicator } from "../src/AgentConnection";
import { parseAgentStatusSnapshot } from "../src/api-backend";
import type {
  AgentStatusSnapshot,
  CommentAgentContextValue,
} from "../src/comment-agent";

/**
 * The header control for document ownership (ADR 0007): who receives this
 * file's comments, and the "Connect session" menu that reassigns it.
 */

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const DOC = "/work/roughdraft/docs/plan.md";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
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

const byTestId = (id: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

const sessions = [
  {
    sessionId: "elsewhere-0000",
    cwd: "/work/other-project",
    lastActiveAt: ago(2),
    documents: [],
  },
  {
    sessionId: "aaaa1111-2222",
    title: "auth refactor",
    cwd: "/work/roughdraft",
    lastActiveAt: ago(30),
    documents: [DOC],
  },
];

function statusWith(patch: Partial<AgentStatusSnapshot>): AgentStatusSnapshot {
  return {
    listening: false,
    listenerCount: 0,
    threads: {},
    owner: null,
    sessions: [],
    ...patch,
  };
}

async function render(
  status: AgentStatusSnapshot,
  connectSession?: CommentAgentContextValue["connectSession"],
) {
  await act(async () => {
    root.render(
      <AgentConnectionIndicator
        agent={{
          available: true,
          status,
          documentAbsolutePath: DOC,
          ...(connectSession ? { connectSession } : {}),
        }}
      />,
    );
  });
}

async function openMenu() {
  const trigger = byTestId("agent-connection-indicator");
  if (!trigger) throw new Error("no trigger");
  await act(async () => {
    trigger.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    trigger.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
  const menu = byTestId("agent-session-menu");
  if (!menu) throw new Error("menu did not open");
  return menu;
}

describe("session ownership header", () => {
  it("names the owning session and its folder", async () => {
    await render(
      statusWith({
        listening: true,
        sessionId: "aaaa1111-2222",
        owner: {
          sessionId: "aaaa1111-2222",
          title: "auth refactor",
          cwd: "/work/roughdraft",
          live: true,
        },
        sessions,
      }),
    );
    const trigger = byTestId("agent-connection-indicator");
    expect(trigger?.textContent).toBe("Claude · auth refactor · roughdraft");
    expect(trigger?.dataset.listening).toBe("true");
  });

  it("falls back to the short session id without a name", async () => {
    await render(
      statusWith({
        listening: true,
        owner: { sessionId: "abcd1234-0000-1111", live: true },
      }),
    );
    expect(byTestId("agent-connection-indicator")?.textContent).toBe(
      "Claude · abcd1234",
    );
  });

  it("says there is no session when nobody, or only a stopped session, owns the file", async () => {
    await render(statusWith({}));
    expect(byTestId("agent-connection-indicator")?.textContent).toBe(
      "Claude · No session",
    );

    await render(
      statusWith({ owner: { sessionId: "dead0000-1111", live: false } }),
    );
    expect(byTestId("agent-connection-indicator")?.textContent).toBe(
      "Claude · No session",
    );
    const menu = await openMenu();
    expect(
      menu.querySelector('[data-testid="agent-session-menu-offline-owner"]')
        ?.textContent,
    ).toBe("dead0000 owned this file but is not running.");
  });

  it("lists sessions working in the document's folder first and connects the chosen one", async () => {
    const connectSession = vi.fn(async (_sessionId: string) => {});
    await render(statusWith({ sessions }), connectSession);

    await openMenu();
    const local = byTestId("agent-session-option-aaaa1111-2222");
    const elsewhere = byTestId("agent-session-option-elsewhere-0000");
    if (!local || !elsewhere) throw new Error("options missing");
    // Same folder first, although the other session was active more recently.
    expect(
      local.compareDocumentPosition(elsewhere) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(local.textContent).toBe(
      "auth refactorthis folderroughdraft · active 30s ago · 1 file",
    );

    await act(async () => {
      elsewhere.click();
    });
    expect(connectSession).toHaveBeenCalledWith("elsewhere-0000");
  });

  it("explains how to get a session when none is running", async () => {
    await render(statusWith({}), vi.fn());
    const menu = await openMenu();
    const empty = menu.querySelector(
      '[data-testid="agent-session-menu-empty"]',
    );
    expect(empty?.textContent).toContain(
      "No Claude Code sessions are running Roughdraft live review.",
    );
    expect(byTestId("agent-session-menu-setup-command")?.textContent).toBe(
      "roughdraft setup claude",
    );
  });

  it("keeps the old listening label for servers without ownership", async () => {
    await render({
      listening: true,
      listenerCount: 1,
      sessionId: "abcd1234-ffff",
      threads: {},
    });
    expect(byTestId("agent-connection-indicator")?.textContent).toBe(
      "Claude listening · session abcd1234",
    );
  });
});

describe("parseAgentStatusSnapshot", () => {
  it("reads owner and sessions, and leaves them out for older servers", () => {
    expect(
      parseAgentStatusSnapshot({
        listening: true,
        listenerCount: 0,
        threads: {},
        owner: { sessionId: "s1", live: true, cwd: "/w", bogus: 1 },
        sessions: [
          { sessionId: "s1", lastActiveAt: ago(1), documents: [DOC, 3] },
          { nope: true },
        ],
      }),
    ).toMatchObject({
      owner: { sessionId: "s1", live: true, cwd: "/w" },
      sessions: [{ sessionId: "s1", documents: [DOC] }],
    });
    expect(
      parseAgentStatusSnapshot({ listening: false, owner: null }).owner,
    ).toBeNull();
    expect(
      "owner" in parseAgentStatusSnapshot({ listening: false, threads: {} }),
    ).toBe(false);
  });
});
