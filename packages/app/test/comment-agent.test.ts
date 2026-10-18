import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAgentStatusSnapshot } from "../src/api-backend";
import { renderCommentMarkdown } from "../src/CommentMarkdown";
import {
  buildListenCommand,
  getCommentSubmitEventType,
  getThreadAgentDisplayStatus,
  readComposerModePreference,
  writeComposerModePreference,
} from "../src/comment-agent";
import { matchComposerModeShortcut } from "../src/comment-shortcuts";
import { criticMarkdownToEditorState } from "../src/critic-markup";
import { buildCommentThreadRailItems } from "../src/document-comments";

describe("which event a submitted comment sends", () => {
  it("maps a new root comment's mode to ask/change and Comment to nothing", () => {
    expect(getCommentSubmitEventType({ isRoot: true, intent: "ask" })).toBe(
      "comment.ask",
    );
    expect(getCommentSubmitEventType({ isRoot: true, intent: "change" })).toBe(
      "comment.change",
    );
    expect(
      getCommentSubmitEventType({ isRoot: true, intent: "comment" }),
    ).toBeNull();
  });

  it("sends a follow-up only for a user reply inside an Ask/Change thread", () => {
    expect(
      getCommentSubmitEventType({
        isRoot: false,
        rootIntent: "ask",
        authorType: "user",
      }),
    ).toBe("comment.followup");
    expect(
      getCommentSubmitEventType({ isRoot: false, authorType: "user" }),
    ).toBeNull();
    expect(
      getCommentSubmitEventType({
        isRoot: false,
        rootIntent: "change",
        authorType: "ai",
      }),
    ).toBeNull();
  });
});

describe("thread status line", () => {
  const base = {
    intent: "ask" as const,
    resolved: false,
    sending: false,
    latestCommentIsFromAgent: false,
  };

  it("shows the live server status", () => {
    expect(
      getThreadAgentDisplayStatus({ ...base, serverStatus: "pending" }),
    ).toBe("pending");
    expect(
      getThreadAgentDisplayStatus({ ...base, serverStatus: "working" }),
    ).toBe("working");
    expect(
      getThreadAgentDisplayStatus({
        ...base,
        intent: "change",
        serverStatus: "applied",
      }),
    ).toBe("applied");
  });

  it("shows sending while the comment is saved and posted", () => {
    expect(
      getThreadAgentDisplayStatus({
        ...base,
        sending: true,
        serverStatus: "answered",
      }),
    ).toBe("sending");
  });

  it("falls back to the file when the server has no state for the thread", () => {
    expect(
      getThreadAgentDisplayStatus({ ...base, latestCommentIsFromAgent: true }),
    ).toBe("answered");
    expect(
      getThreadAgentDisplayStatus({
        ...base,
        intent: "change",
        latestCommentIsFromAgent: true,
      }),
    ).toBe("applied");
    expect(getThreadAgentDisplayStatus(base)).toBeNull();
  });

  it("shows nothing for plain or resolved threads", () => {
    expect(
      getThreadAgentDisplayStatus({
        ...base,
        intent: undefined,
        serverStatus: "pending",
      }),
    ).toBeNull();
    expect(
      getThreadAgentDisplayStatus({
        ...base,
        resolved: true,
        serverStatus: "answered",
      }),
    ).toBeNull();
  });
});

describe("agent status snapshot", () => {
  it("keeps known fields and drops unknown thread states", () => {
    expect(
      parseAgentStatusSnapshot({
        listening: true,
        listenerCount: 1,
        sessionId: "abc",
        threads: { c1: "working", c2: "bogus" },
        latestSequence: 4,
      }),
    ).toEqual({
      listening: true,
      listenerCount: 1,
      sessionId: "abc",
      threads: { c1: "working" },
    });
    expect(parseAgentStatusSnapshot(null)).toEqual({
      listening: false,
      listenerCount: 0,
      threads: {},
    });
  });
});

describe("listen command", () => {
  it("quotes paths that need it", () => {
    expect(buildListenCommand("/work/plan.md")).toBe(
      "roughdraft listen /work/plan.md",
    );
    expect(buildListenCommand("/work/my plan's.md")).toBe(
      "roughdraft listen '/work/my plan'\\''s.md'",
    );
  });
});

describe("composer mode preference", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubStorage(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    return store;
  }

  it("remembers the last chosen mode", () => {
    stubStorage();
    expect(readComposerModePreference()).toBe("comment");
    writeComposerModePreference("change");
    expect(readComposerModePreference()).toBe("change");
  });

  it("falls back to Comment when storage throws or holds junk", () => {
    stubStorage({ "roughdraft.commentComposerMode": "shout" });
    expect(readComposerModePreference()).toBe("comment");

    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    });
    expect(readComposerModePreference()).toBe("comment");
    expect(() => writeComposerModePreference("ask")).not.toThrow();
  });
});

describe("composer mode shortcut", () => {
  const key = (code: string, extra: Partial<KeyboardEventInit> = {}) => ({
    code,
    key: code.slice(3),
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: true,
    ...extra,
  });

  it("matches Mod+Shift+A and Mod+Shift+E per platform", () => {
    expect(
      matchComposerModeShortcut(key("KeyA", { metaKey: true }), "MacIntel"),
    ).toBe("ask");
    expect(
      matchComposerModeShortcut(key("KeyE", { ctrlKey: true }), "Win32"),
    ).toBe("change");
    expect(
      matchComposerModeShortcut(key("KeyA", { ctrlKey: true }), "MacIntel"),
    ).toBeNull();
    expect(
      matchComposerModeShortcut(
        key("KeyA", { metaKey: true, shiftKey: false }),
        "MacIntel",
      ),
    ).toBeNull();
  });
});

describe("comment Markdown rendering", () => {
  it("renders lists, code, emphasis and links", () => {
    const html = renderCommentMarkdown(
      "It is **fast**:\n- `cache`\n- [docs](https://example.com)",
    );
    const template = document.createElement("template");
    template.innerHTML = html;

    expect(template.content.querySelector("strong")?.textContent).toBe("fast");
    expect(template.content.querySelector("li code")?.textContent).toBe(
      "cache",
    );
    const link = template.content.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("keeps single line breaks of plain-text comments", () => {
    expect(renderCommentMarkdown("one\ntwo")).toBe("<p>one<br>two</p>\n");
  });

  it("strips scripts, event handlers and javascript: links", () => {
    const html = renderCommentMarkdown(
      '<script>alert(1)</script><img src=x onerror="alert(1)"> <a href="https://ok.example" onclick="alert(1)">ok</a>',
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://ok.example"');

    const link = renderCommentMarkdown("See [x](javascript:alert(1)) now");
    expect(link).toContain(">x</a>");
    expect(link).not.toContain("href=");
  });
});

describe("endmatter replies on an anchored comment", () => {
  it("show up in the thread rail under their anchored root", () => {
    const { doc, comments } = criticMarkdownToEditorState(
      [
        "Cold start {==target==}{>>Why?<<}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-10-18T12:00:00.000Z"',
        "  c2:",
        "    body: Because.",
        "    by: AI",
        '    at: "2026-10-18T12:00:20.000Z"',
        "    re: c1",
        "  c3:",
        "    body: Thanks.",
        "    by: user",
        '    at: "2026-10-18T12:01:00.000Z"',
        "    re: c2",
        "",
      ].join("\n"),
    );
    const anchorIds = JSON.stringify(doc).match(
      /"commentIds":(\[[^\]]*\])/,
    )?.[1];

    const items = buildCommentThreadRailItems(
      [
        {
          key: "anchor",
          commentIds: JSON.parse(anchorIds ?? "[]") as string[],
          anchorTop: 0,
          anchorBottom: 10,
        },
      ],
      comments,
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.commentIds).toEqual(["c1", "c2", "c3"]);
  });
});
