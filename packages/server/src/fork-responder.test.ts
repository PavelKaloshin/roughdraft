import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AnswerForkOutcome,
  buildForkArgs,
  buildForkPrompt,
  findExecutable,
  ForkScheduler,
  forkChildEnv,
  forkModelAlias,
} from "./fork-responder";
import type { CommentEvent } from "./review-events";

function event(overrides: Partial<CommentEvent> = {}): CommentEvent {
  return {
    type: "comment.ask",
    documentPath: "/work/plan.md",
    projectPath: "/work",
    relativePath: "plan.md",
    version: "v1",
    commentId: "c7",
    threadRootId: "c7",
    intent: "ask",
    anchorText: "cold start",
    body: "What does this include?",
    author: "pavel",
    contextBefore: "The ",
    contextAfter: " takes four seconds.",
    rootBody: "What does this include?",
    replies: [],
    latestReplyId: null,
    sequence: 1,
    createdAt: "2026-10-18T12:00:00.000Z",
    ...overrides,
  };
}

describe("buildForkPrompt", () => {
  it("tells the fork to ack, read around the anchor, and answer through reply without editing", () => {
    const prompt = buildForkPrompt({
      cliName: "roughdraft-dev-x",
      documentPath: "/work/my plan.md",
      threadRootId: "c7",
      anchorText: "cold start",
      contextBefore: "The ",
      contextAfter: " takes four seconds.",
      question: { author: "pavel", body: "Что сюда входит?" },
      history: [],
    });

    expect(prompt).toContain("roughdraft-dev-x ack '/work/my plan.md' c7");
    expect(prompt).toContain(
      "roughdraft-dev-x reply '/work/my plan.md' c7 --stdin <<'EOF'",
    );
    expect(prompt).toMatch(/do not edit, create or delete any file/i);
    expect(prompt).toMatch(/same language as the question/i);
    expect(prompt).toContain('Anchor: "cold start"');
    expect(prompt).toContain("The [cold start] takes four seconds.");
    expect(prompt).toContain("pavel: Что сюда входит?");
    // The ack comes before the reply.
    expect(prompt.indexOf(" ack ")).toBeLessThan(prompt.indexOf(" reply "));
  });

  it("includes the earlier thread messages for a follow-up", () => {
    const prompt = buildForkPrompt({
      cliName: "roughdraft",
      documentPath: "/work/plan.md",
      threadRootId: "c7",
      anchorText: null,
      contextBefore: "",
      contextAfter: "",
      question: { author: "pavel", body: "And the model load?" },
      history: [
        { author: "pavel", body: "What does this include?" },
        { author: "AI", body: "Cache warm-up." },
      ],
    });

    const earlier = prompt.indexOf("pavel: What does this include?");
    const answer = prompt.indexOf("AI: Cache warm-up.");
    const followUp = prompt.indexOf("pavel: And the model load?");
    expect(earlier).toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(earlier);
    expect(followUp).toBeGreaterThan(answer);
    expect(prompt).not.toContain("Anchor:");
  });
});

describe("buildForkArgs", () => {
  it("forks the session headlessly with only Read and the two roughdraft commands allowed", () => {
    const args = buildForkArgs({ sessionId: "sess-1", cliName: "rd-dev" });

    expect(args.slice(0, 4)).toEqual([
      "-p",
      "--resume",
      "sess-1",
      "--fork-session",
    ]);
    const allowed = valuesOf(args, "--allowedTools");
    expect(allowed).toEqual([
      "Read",
      "Bash(rd-dev ack:*)",
      "Bash(rd-dev reply:*)",
    ]);
    expect(valuesOf(args, "--disallowedTools")).toEqual(
      expect.arrayContaining(["Edit", "Write", "NotebookEdit"]),
    );
    expect(valuesOf(args, "--permission-mode")).toEqual(["dontAsk"]);
    expect(valuesOf(args, "--output-format")).toEqual(["json"]);
    // The prompt goes on stdin: a positional after the variadic tool lists
    // would be read as one more tool name.
    expect(args.at(-1)?.startsWith("-")).toBe(false);
    expect(args.at(-1)).toBe("NotebookEdit");
  });
});

describe("fork model", () => {
  it("maps an Ask's model to a claude --model alias, fast by default", () => {
    expect(forkModelAlias(undefined)).toBe("haiku");
    expect(forkModelAlias("fast")).toBe("haiku");
    expect(forkModelAlias("balanced")).toBe("sonnet");
    expect(forkModelAlias("session")).toBeUndefined();
  });

  it("passes --model only when a model alias is given", () => {
    const withModel = buildForkArgs({
      sessionId: "s",
      cliName: "rd",
      modelAlias: "haiku",
    });
    expect(valuesOf(withModel, "--model")).toEqual(["haiku"]);
    expect(
      buildForkArgs({ sessionId: "s", cliName: "rd" }).includes("--model"),
    ).toBe(false);
  });
});

function valuesOf(args: string[], flag: string): string[] {
  const start = args.indexOf(flag);
  if (start < 0) return [];
  const values: string[] = [];
  for (const value of args.slice(start + 1)) {
    if (value.startsWith("--")) break;
    values.push(value);
  }
  return values;
}

describe("forkChildEnv", () => {
  it("drops the parent session's Claude Code variables but keeps Roughdraft's and PATH", () => {
    const env = forkChildEnv({
      PATH: "/bin",
      HOME: "/home/p",
      ROUGHDRAFT_STATE_DIR: "/state",
      ROUGHDRAFT_DEV_WRAPPER_NAME: "rd-dev",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "parent",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_MESSAGING_SOCKET: "/sock",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
    });

    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/p",
      ROUGHDRAFT_STATE_DIR: "/state",
      ROUGHDRAFT_DEV_WRAPPER_NAME: "rd-dev",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
    });
  });
});

describe("findExecutable", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-fork-exe-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds an executable on PATH or by path, and reports a missing one", () => {
    const exe = path.join(dir, "claude");
    fs.writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });

    expect(findExecutable("claude", { PATH: `/nonexistent:${dir}` })).toBe(exe);
    expect(findExecutable(exe, { PATH: "" })).toBe(exe);
    expect(findExecutable("claude", { PATH: "/nonexistent" })).toBeNull();
    expect(findExecutable(path.join(dir, "nope"), {})).toBeNull();
  });
});

describe("ForkScheduler", () => {
  let statuses: Record<string, string>;
  let logs: string[];
  let forks: CommentEvent[];
  let finishFork: Map<string, (outcome: AnswerForkOutcome) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    statuses = {};
    logs = [];
    forks = [];
    finishFork = new Map();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function scheduler(
    options: {
      maxConcurrent?: number;
      outcome?: AnswerForkOutcome;
      takeOverAsks?: boolean;
    } = {},
  ) {
    return new ForkScheduler({
      afterMs: options.takeOverAsks ? 0 : 15_000,
      maxConcurrent: options.maxConcurrent ?? 2,
      ...(options.takeOverAsks
        ? { takeOverAsks: true, announceForks: false }
        : {}),
      threadStatus: async (threadRootId) => statuses[threadRootId],
      runFork: (forked, started) => {
        forks.push(forked);
        if (options.outcome?.kind !== "claude-missing") started();
        if (options.outcome) return Promise.resolve(options.outcome);
        return new Promise((resolve) => {
          finishFork.set(forked.commentId, resolve);
        });
      },
      log: (line) => logs.push(line),
      formatEventLine: (shown) => `[roughdraft] ask ${shown.threadRootId} …`,
    });
  }

  it("forks an Ask the session still has queued after the delay", async () => {
    const forker = scheduler();
    statuses.c7 = "queued";

    forker.observe(event());
    await vi.advanceTimersByTimeAsync(14_000);
    expect(forks).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(forks.map((forked) => forked.commentId)).toEqual(["c7"]);
    expect(logs).toEqual([
      "[roughdraft] forked c7 to a headless Claude (main session busy)",
    ]);
  });

  it("does nothing when the session picked the Ask up in time", async () => {
    const forker = scheduler();
    statuses.c7 = "delegated";

    forker.observe(event());
    await vi.advanceTimersByTimeAsync(20_000);

    expect(forks).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("never forks a Change or a follow-up in a Change thread", async () => {
    const forker = scheduler();
    statuses.c7 = "queued";
    statuses.c8 = "queued";

    forker.observe(event({ type: "comment.change", intent: "change" }));
    forker.observe(
      event({
        type: "comment.followup",
        intent: "change",
        threadRootId: "c8",
        commentId: "c9",
      }),
    );
    await vi.advanceTimersByTimeAsync(20_000);

    expect(forks).toEqual([]);
  });

  it("forks a follow-up in an Ask thread", async () => {
    const forker = scheduler();
    statuses.c7 = "queued";

    forker.observe(
      event({ type: "comment.followup", intent: "ask", commentId: "c9" }),
    );
    await vi.advanceTimersByTimeAsync(15_000);

    expect(forks.map((forked) => forked.commentId)).toEqual(["c9"]);
  });

  it("forks each user message once, even when the event is shown again", async () => {
    const forker = scheduler({ outcome: { kind: "answered" } });
    statuses.c7 = "queued";

    forker.observe(event());
    forker.observe(event({ sequence: 4 }));
    await vi.advanceTimersByTimeAsync(15_000);
    forker.observe(event({ sequence: 9 }));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(forks).toHaveLength(1);
  });

  it("forks only the newest message of a thread", async () => {
    const forker = scheduler();
    statuses.c7 = "queued";

    forker.observe(event());
    await vi.advanceTimersByTimeAsync(5_000);
    forker.observe(
      event({ type: "comment.followup", commentId: "c9", sequence: 2 }),
    );
    await vi.advanceTimersByTimeAsync(15_000);

    expect(forks.map((forked) => forked.commentId)).toEqual(["c9"]);
  });

  it("runs at most N forks at once and re-checks a waiting Ask before starting it", async () => {
    const forker = scheduler({ maxConcurrent: 2 });
    for (const id of ["c1", "c2", "c3", "c4"]) {
      statuses[id] = "queued";
      forker.observe(event({ commentId: id, threadRootId: id }));
    }
    await vi.advanceTimersByTimeAsync(15_000);
    expect(forks.map((forked) => forked.commentId)).toEqual(["c1", "c2"]);

    // While waiting, the session answered c3 itself.
    statuses.c3 = "answered";
    finishFork.get("c1")?.({ kind: "answered" });
    await vi.advanceTimersByTimeAsync(0);

    expect(forks.map((forked) => forked.commentId)).toEqual(["c1", "c2", "c4"]);
  });

  it("stops forking for good, with one line, when the claude CLI is missing", async () => {
    const forker = scheduler({ outcome: { kind: "claude-missing" } });
    statuses.c1 = "queued";
    statuses.c2 = "queued";

    forker.observe(event({ commentId: "c1", threadRootId: "c1" }));
    await vi.advanceTimersByTimeAsync(15_000);
    forker.observe(event({ commentId: "c2", threadRootId: "c2" }));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(forks.map((forked) => forked.commentId)).toEqual(["c1"]);
    expect(logs).toEqual([
      "[roughdraft] claude CLI not found; not forking Asks to a headless Claude",
    ]);
  });

  it("hands a failed fork's Ask back to the session with the event line", async () => {
    const forker = scheduler({
      outcome: { kind: "failed", reason: "timed out after 300s" },
    });
    statuses.c7 = "queued";

    forker.observe(event());
    await vi.advanceTimersByTimeAsync(15_000);

    expect(logs).toEqual([
      "[roughdraft] forked c7 to a headless Claude (main session busy)",
      "[roughdraft] headless fork for c7 failed (timed out after 300s); answer it yourself:",
      "[roughdraft] ask c7 …",
    ]);
  });

  describe("taking Asks over (plugin: --quiet --fork-asks-after 0)", () => {
    it("forks an Ask at once, silently, and tells the listener not to print it", async () => {
      const forker = scheduler({
        takeOverAsks: true,
        outcome: { kind: "answered" },
      });
      statuses.c7 = "queued";

      expect(forker.observe(event())).toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(forks.map((forked) => forked.commentId)).toEqual(["c7"]);
      expect(logs).toEqual([]);
      // Shown again in a later round: still not printed, not forked twice.
      expect(forker.observe(event({ sequence: 5 }))).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(forks).toHaveLength(1);
    });

    it("leaves a Change to the listener (printed, never forked)", async () => {
      const forker = scheduler({ takeOverAsks: true });
      statuses.c7 = "queued";

      expect(
        forker.observe(event({ type: "comment.change", intent: "change" })),
      ).toBe(false);
      expect(
        forker.observe(
          event({
            type: "comment.followup",
            intent: "change",
            commentId: "c9",
          }),
        ),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(forks).toEqual([]);
    });

    it("takes over a follow-up in an Ask thread", async () => {
      const forker = scheduler({
        takeOverAsks: true,
        outcome: { kind: "answered" },
      });
      statuses.c7 = "queued";

      expect(
        forker.observe(
          event({ type: "comment.followup", intent: "ask", commentId: "c9" }),
        ),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(forks.map((forked) => forked.commentId)).toEqual(["c9"]);
    });

    it("prints the Ask's line, once, when the fork fails", async () => {
      const forker = scheduler({
        takeOverAsks: true,
        outcome: { kind: "failed", reason: "claude exited with code 1" },
      });
      statuses.c7 = "queued";

      forker.observe(event());
      await vi.advanceTimersByTimeAsync(0);

      expect(logs).toEqual([
        "[roughdraft] headless fork for c7 failed (claude exited with code 1); answer it yourself:",
        "[roughdraft] ask c7 …",
      ]);
    });

    it("prints the Ask's line when the thread status cannot be read", async () => {
      const forker = scheduler({ takeOverAsks: true });

      forker.observe(event());
      await vi.advanceTimersByTimeAsync(0);

      expect(forks).toEqual([]);
      expect(logs).toEqual([
        "[roughdraft] headless fork for c7 failed (could not read the thread status); answer it yourself:",
        "[roughdraft] ask c7 …",
      ]);
    });

    it("without claude: one notice, the lines of every Ask not yet shown, then normal printing", async () => {
      const forker = scheduler({
        takeOverAsks: true,
        maxConcurrent: 1,
        outcome: { kind: "claude-missing" },
      });
      statuses.c1 = "queued";
      statuses.c2 = "queued";

      expect(
        forker.observe(event({ commentId: "c1", threadRootId: "c1" })),
      ).toBe(true);
      // Waits for the single slot.
      expect(
        forker.observe(event({ commentId: "c2", threadRootId: "c2" })),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(forks.map((forked) => forked.commentId)).toEqual(["c1"]);
      expect(logs).toEqual([
        "[roughdraft] claude CLI not found; not forking Asks to a headless Claude",
        "[roughdraft] ask c1 …",
        "[roughdraft] ask c2 …",
      ]);
      // From now on the listener prints Asks itself.
      expect(
        forker.observe(event({ commentId: "c3", threadRootId: "c3" })),
      ).toBe(false);
    });

    it("keeps an Ask waiting for a free slot without printing it", async () => {
      const forker = scheduler({ takeOverAsks: true, maxConcurrent: 1 });
      statuses.c1 = "queued";
      statuses.c2 = "queued";

      forker.observe(event({ commentId: "c1", threadRootId: "c1" }));
      forker.observe(event({ commentId: "c2", threadRootId: "c2" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(forks.map((forked) => forked.commentId)).toEqual(["c1"]);

      finishFork.get("c1")?.({ kind: "answered" });
      await vi.advanceTimersByTimeAsync(0);

      expect(forks.map((forked) => forked.commentId)).toEqual(["c1", "c2"]);
      expect(logs).toEqual([]);
    });
  });

  it("stops scheduling on close and waits for running forks", async () => {
    const forker = scheduler();
    statuses.c1 = "queued";
    statuses.c2 = "queued";
    forker.observe(event({ commentId: "c1", threadRootId: "c1" }));
    await vi.advanceTimersByTimeAsync(15_000);
    forker.observe(event({ commentId: "c2", threadRootId: "c2" }));

    let closed = false;
    const closing = forker.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(closed).toBe(false);
    finishFork.get("c1")?.({ kind: "answered" });
    await closing;

    expect(forks.map((forked) => forked.commentId)).toEqual(["c1"]);
  });
});
