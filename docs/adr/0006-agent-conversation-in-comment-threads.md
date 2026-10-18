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
- Listener presence and thread status disappear with the server process. Events posted while no server is running are not delivered; the user re-submits.
- Agents need instructions to arm `listen` after opening a document (see `packages/skill/` and `setup.md`).

## What This Explicitly Does Not Mean

This refines ADR 0002 rather than overriding it: Roughdraft does not store a separate transcript, chat history, or session log. Threads remain anchored review feedback that can be resolved and removed. Roughdraft does not become a chat client, an agent runtime, or a model API consumer, and the state file still holds only the managed server process (ADR 0004).
