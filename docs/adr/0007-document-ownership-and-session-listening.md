# 0007: Document Ownership And Session-Scoped Listening

## Context

ADR 0006 lets a Claude Code session answer Ask/Change comments, but only after it arms `roughdraft listen <file>` itself, per file, and re-arms it every 30 minutes. In practice the user has to ask for it ("connect to the doc"), and two sessions in one folder can both listen to the same file and both answer.

## Decision

**One owner per document.** The server keeps an in-memory map from document to owning session. A document's Ask, Change, follow-up and Done Reviewing events go only to listeners of its owner. Watches that are not listeners (`roughdraft open` waiting for Done Reviewing) are unaffected, and a document nobody owns behaves as before (any listener receives its events).

- **Automatic claim** — when a session writes or edits a `.md` file (plugin hook), opens it with `roughdraft open`, or runs `roughdraft listen <file>`, it becomes the owner *only if the document has no live owner*. A live owner is never displaced silently.
- **Reassignment** — only the user, from the UI's "Connect session" menu, or an explicit `roughdraft claim <file> --force`. The previous owner gets a `released` line; the new owner gets the document's unanswered events.
- **Live** means the same as for a listener in ADR 0006: a long-poll is open, or ended less than the grace period ago. A document whose owner is gone goes to the next claim.

**Session-scoped listener.** `roughdraft listen --session <id>` (`POST /api/sessions/listen`) delivers events for every document the session owns, across projects, one self-contained line each with `file=`, plus a line when a document is claimed for or released from the session. `GET /api/sessions` lists live sessions (id, name, folder, last activity, owned files); the agent status snapshot carries additive `owner` and `sessions` fields for the UI.

**Claude Code plugin.** `packages/claude-plugin` is installed once at user scope from a local marketplace (`roughdraft setup claude`). It contains:

- an always-on monitor that keeps `roughdraft listen --session <id> --quiet --no-start` running in its own restart loop and prints nothing unless there is an event (it never starts a server: Roughdraft not running means there is nothing to listen to);
- a `PostToolUse` hook (`Write|Edit`, async) that claims written `.md` files, and a `SessionStart` hook that records the session id and name and adds one line of context;
- the `roughdraft-live-review` skill without the "arm Monitor" step.

**State stays transient.** Ownership lives in the server process only (ADR 0004). To survive a server restart, the plugin keeps each session's claims in `${CLAUDE_PLUGIN_DATA}/sessions/<session>.json`; the listener re-sends them (as non-displacing claims) whenever it connects, and keeps the file in sync with `claimed`/`released` lines.

## Consequences

- No user action per document: a session that wrote a plan receives its comments, and a second session in the same folder does not.
- The UI can say who answers ("Claude · auth refactor · roughdraft") and fix a wrong assignment in one click.
- Every interactive Claude Code session with the plugin runs one lightweight process that long-polls the local server (when one runs). Environments without plugin monitors (`claude -p`, Bedrock/Vertex/Foundry, telemetry-disabled setups) fall back to ADR 0006's manual `listen`; the UI shows "No session".
- The monitor runs with the user's permissions outside Claude Code's sandbox. It only runs `roughdraft listen` and never executes comment text; comment text reaches only the owning session, as an instruction scoped to its document.
- Plugin monitors are an experimental Claude Code surface (`monitors/monitors.json`); its lifetime, restart behavior, and whether `CLAUDE_CODE_SESSION_ID` is set for it are undocumented. The wrapper restarts `listen` itself and falls back to the session id the `SessionStart` hook records for the shared Claude Code process.

## Note: listen rounds and running forks

The wrapper restarts `listen` only after it exits, so at `--max-seconds` a `listen` with headless forks still running (ADR 0006 addendum, up to their 5-minute timeout) does not stop polling: it *drains*. It starts no new forks, keeps printing Changes, follow-ups and claim notices as they arrive, and exits as soon as the last fork finishes (the open long-poll is cut then). An Ask that arrives while draining, or that was waiting for a fork slot, is neither forked nor printed: it stays `queued` on the server, and the next round (cursor from 0, unanswered events shown again) forks it. One process at a time per session, and the thread status (`delegated`/`working`/`answered`) keeps a fork from being started twice for one Ask. We chose this over overlapping rounds (the wrapper starting the next `listen` at once) because two listeners of one session would both receive every Change.

When `claude` is not on PATH, `listen` prints "claude CLI not found" once per session: once for all documents, and the plugin's claims file records it (`claudeMissingNoticeAt`) so later rounds do not wake the session again. Asks are then printed like Changes.

## What This Explicitly Does Not Mean

Roughdraft still does not start sessions or call a model (ADR 0006's headless-fork addendum is the listening session's own choice). The server does not persist ownership, sessions or claims; the plugin's claims file is the agent's own bookkeeping, not a Roughdraft database. A document is still the single file of ADR 0001; a session owning several documents does not make Roughdraft a workspace.
