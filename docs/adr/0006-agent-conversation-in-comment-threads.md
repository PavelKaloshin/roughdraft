# 0006: Agent Conversation In Comment Threads

## Context

Roughdraft documents are usually written by a coding agent (Claude Code) in a terminal session. During review the user wants to ask that same session "what did you mean here?" or "change this", and see the answer or the edit without switching back to the terminal. ADR 0002 says CriticMarkup is not a chat transcript format, and ADR 0004 keeps the state file free of document or collaboration state.

## Decision

A root comment may carry an `intent` in its YAML endmatter (or inline attributes): `comment` (default, no agent involvement), `ask`, or `change`. When the user submits an `ask`/`change` comment, or replies inside such a thread, the app saves the file and then explicitly posts a comment event to the local server. A listening agent receives it and answers through the CLI:

- `roughdraft listen <file>` prints one self-contained line per event, so an agent can run it under Claude Code's Monitor tool, which wakes an idle session on every line. It also prints a line when the user clicks Done Reviewing.
- `roughdraft ack | reply | resolve` write through the server with optimistic version checks. Replies are ordinary endmatter replies with `by: AI`.

The conversation is persisted only as ordinary CriticMarkup threads anchored to the text they discuss. Which agent session is listening, and whether a thread is pending, being worked on, answered or applied, is transient in-memory server state (like remote-document sessions in ADR 0004). It is not written to the file or the state file.

When no agent is listening, the app says so and shows the command to start one. It does not start an agent, call a model API, or fall back to another session.

## Consequences

- The file stays the single source of truth: a thread with an agent's answer reads the same in any editor, and stays valid for tools that ignore `intent`.
- Listener presence and thread status disappear with the server process. Queued events disappear too, but nothing is lost: the first time a listener attaches to a document, the server re-reads the file and queues every unresolved `ask`/`change` thread whose last message is not from the agent (`by: AI`). The file, not the queue, decides what is still waiting for an answer.
- Agents need instructions to arm `listen` after opening a document (see `packages/skill/` and `setup.md`). With the Claude Code plugin (ADR 0007) nobody arms anything: every interactive session listens for the documents it owns.
- "Which agent session is listening" became "which session owns the document" (ADR 0007): a document's events go only to its owner's listener, and the UI shows the owner and can reassign it. Still transient server state; the "no fallback to another session" rule holds, because only the user (or an explicit `claim --force`) moves a document between sessions.

## What This Explicitly Does Not Mean

This refines ADR 0002 rather than overriding it: Roughdraft does not store a separate transcript, chat history, or session log. Threads remain anchored review feedback that can be resolved and removed. Roughdraft does not become a chat client, an agent runtime, or a model API consumer, and the state file still holds only the managed server process (ADR 0004).

## Addendum: headless forks for a busy session

A listening session only reads `listen` lines between its steps, so an Ask can sit `queued` for minutes. `roughdraft listen --fork-asks-after <seconds>` (opt-in, agent side) answers such an Ask from a headless fork of that same session (`roughdraft answer-fork`: `claude -p --resume <session> --fork-session`, allowed to read files and run only `roughdraft ack`/`reply`, never to edit). This does not change the decision above: the server and the app still never start an agent or call a model, and never fall back to a different session. The fork is the listening session's own context, started by the agent's own listener; Changes stay with the session (one writer). Who holds a delegated thread (`delegatedTo: "fork-process"`) is more transient server state.

## Addendum: Asks go straight to a fork, fast model by default

The plugin's listener now runs `listen --session --quiet --fork-asks-after 0`: every Ask (and every follow-up in an Ask thread) goes to a headless fork at once, and its line is not printed, so an Ask no longer costs the main session two turns (one to delegate it, one when the subagent finishes). The session still gets the line when no fork can answer: the fork failed, `claude` is missing, or the thread status cannot be read. Changes are unaffected: only the session edits the document. Without `--quiet`, or with a non-zero delay, behaviour is as before.

An Ask root may carry `model` in its endmatter (`fast` default and omitted, `balanced`, `session`; RFM spec "Ask Model"). The fork runs `claude --model haiku` / `sonnet`, or the session's model for `session`; a `--model` fork that fails (for example when the forked context does not fit the smaller model's window) is retried once with the session's model before the Ask goes back to the session.

Tradeoff: a fork on the session's own model reads the session's prompt cache, so a long session forks cheaply; a different model cannot read that cache and processes the whole forked context again (fully billed, if at a lower per-token price), and its context window may be smaller than the session's. We default to `fast` because answer latency is what the user feels in the UI (Asks took ~40 s through an in-session subagent), and Asks are short questions about a document the context already explains. `session` stays one keystroke away for questions that need the strongest model, and the retry covers the context-window case. The choice is the user's, per Ask, and lives in the file like `intent`; which model actually answered is not recorded.
