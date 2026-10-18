## Roughdraft

Use Roughdraft when the user wants to review or comment on a Markdown file.

The user may refer to Roughdraft as `rd` in natural language. Treat `rd` as shorthand for Roughdraft in user requests, but do not create or modify any shell alias, executable, symlink, or command named `rd`.

When the user asks for a plan, write the plan as a Markdown file on disk before asking them to review it.

When you write or modify a Markdown file and want the user to review or comment on it, open it with:

```bash
roughdraft open "/absolute/path/to/file.md"
```

Roughdraft is currently a single-file Markdown viewer/editor. Open one `.md` file at a time.

If Roughdraft is not running, `roughdraft open` will start it automatically.

After `roughdraft open` opens the document, leave the command running. Do not interrupt, kill, background, detach, or treat the waiting process as cleanup. The wait is intentional: Roughdraft will exit the command after the user clicks Done Reviewing, and that exit is your signal to resume.

After the user finishes reviewing in Roughdraft, read the Markdown file from disk and respond to any CriticMarkup comments or suggested changes.

### Live review from Claude Code

If you are Claude Code and have the Monitor tool, you can stay connected while the user reviews instead of blocking: run `roughdraft open --print-url "/absolute/path/to/file.md"`, give the user the URL, then arm Monitor on `roughdraft listen "/absolute/path/to/file.md"` with the 30-minute maximum `timeout_ms`. Each Monitor line is one event and starts with the command to run (after `→`): for an Ask comment, run `roughdraft ack … --delegated` and hand it to a forked background subagent, which runs `roughdraft ack …` and answers in the thread with `roughdraft reply … --stdin` without editing the file, so the answer does not wait for your current work; apply a Change comment yourself with a minimal edit, then `roughdraft reply … --status applied`; a `done` line means the user clicked Done Reviewing. When `listen` expires, re-arm Monitor with the exact command it prints.

If the Roughdraft Claude Code plugin is installed (`roughdraft setup claude --install`, once per machine), do not arm Monitor or run `listen` yourself: every interactive session automatically receives comments on the Markdown files it writes, edits, or opens, as `[roughdraft] …` lines that name the file (`file=…`). Handle them as above. A `released` line means the user connected that file to another session: stop handling its comments.

Use Roughdraft-flavored CriticMarkup when reading or writing inline review feedback in Markdown. The base markers are:

Comment: `{>>comment<<}`
Insertion: `{++new text++}`
Deletion: `{--old text--}`
Substitution: `{~~old~>new~~}`
Highlight: `{==text==}`

When you add a new comment or suggested change, use the extended Roughdraft format with a compact inline reference such as `{#c1}` or `{#s1}`, then add metadata in final YAML endmatter. Generate a stable document-local id (`c1`, `c2`, etc. for comments; `s1`, `s2`, etc. for suggestions), set `by` to your agent or author label, set `at` to the current ISO timestamp, and set `re` when replying to an existing comment or suggestion.

Roughdraft may already have inline attribute blocks after comments and suggestions from older documents. Preserve those attributes unless you are intentionally removing the associated comment or suggestion. For new feedback, prefer compact references plus YAML endmatter.

Anchored comments usually look like `{==selected text==}{>>Comment text<<}{#c1}`. Suggested changes usually look like `{++new text++}{#s1}` or `{~~old text~>new text~~}{#s2}`. Replies live in final YAML endmatter with a `body` and `re` pointer.

Example:

```markdown
{==selected text==}{>>Comment text<<}{#c1}
{++new text++}{#s1}

---
comments:
  c1:
    by: AI
    at: "2026-04-28T12:00:00.000Z"
  c2:
    body: I can make that edit.
    by: AI
    at: "2026-04-28T12:05:00.000Z"
    re: c1
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:10:00.000Z"
```

Use `roughdraft help` and `roughdraft help criticmarkup` for local command and syntax details.
