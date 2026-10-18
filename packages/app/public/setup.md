# Roughdraft Agent Setup

You are setting yourself up to use Roughdraft, a local Markdown review tool.

Roughdraft lets you open one Markdown file from disk in a local browser editor so the user can read, edit, comment, and suggest changes. It is currently a single-file Markdown viewer/editor.

## Check Installation

Check whether Roughdraft is available:

```bash
roughdraft help
```

If Roughdraft is missing and the user has asked you to install it, install it with:

```bash
npm i -g roughdraft
```

If the user did not explicitly ask you to install software, ask before installing a global npm package.

## Update Your Persistent Instructions

Add Roughdraft guidance to the persistent instruction file this agent will actually load. Prefer global or user-level instructions, because Roughdraft is a cross-project workflow.

First inspect the user's existing setup. Do not create a new instruction file when an appropriate one already exists.

Common current locations:

```text
OpenAI Codex:        ${CODEX_HOME:-$HOME/.codex}/AGENTS.md
Claude Code:         $HOME/.claude/CLAUDE.md
Gemini CLI:          $HOME/.gemini/GEMINI.md
opencode:            ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/AGENTS.md
Cursor:              Cursor Settings > Rules for global user rules; project AGENTS.md or .cursor/rules/*
VS Code Copilot:     GitHub/VS Code settings for personal instructions; project .github/copilot-instructions.md, .github/instructions/*.instructions.md, or AGENTS.md
```

Check for existing files before editing:

```bash
find \
  "${CODEX_HOME:-$HOME/.codex}" \
  "$HOME/.claude" \
  "$HOME/.gemini" \
  "${XDG_CONFIG_HOME:-$HOME/.config}/opencode" \
  "$PWD" \
  -maxdepth 3 \
  \( -name "AGENTS.md" -o -name "CLAUDE.md" -o -name "GEMINI.md" -o -name "copilot-instructions.md" -o -name "*.instructions.md" \) \
  2>/dev/null
```

If one or more files exist, choose the one for the current agent and merge in any missing Roughdraft guidance. If the current agent cannot determine which file it loads, use its built-in memory or settings command when available, such as Claude Code's `/memory`.

If no persistent instruction file exists and the user has not specified a tool, create a portable canonical file at `${XDG_CONFIG_HOME:-$HOME/.config}/agents/AGENTS.md`, then connect vendor-specific global files to it. Do not overwrite existing files.

```bash
canonical_agents_file="${XDG_CONFIG_HOME:-$HOME/.config}/agents/AGENTS.md"
mkdir -p "$(dirname "$canonical_agents_file")"
touch "$canonical_agents_file"

mkdir -p "${CODEX_HOME:-$HOME/.codex}"
[ -e "${CODEX_HOME:-$HOME/.codex}/AGENTS.md" ] || [ -L "${CODEX_HOME:-$HOME/.codex}/AGENTS.md" ] || ln -s "$canonical_agents_file" "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"

mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
[ -e "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/AGENTS.md" ] || [ -L "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/AGENTS.md" ] || ln -s "$canonical_agents_file" "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/AGENTS.md"

mkdir -p "$HOME/.gemini"
[ -e "$HOME/.gemini/GEMINI.md" ] || [ -L "$HOME/.gemini/GEMINI.md" ] || ln -s "$canonical_agents_file" "$HOME/.gemini/GEMINI.md"

mkdir -p "$HOME/.claude"
[ -e "$HOME/.claude/CLAUDE.md" ] || [ -L "$HOME/.claude/CLAUDE.md" ] || printf "@%s\n" "$canonical_agents_file" > "$HOME/.claude/CLAUDE.md"
```

Use imports or symlinks only when the target agent supports normal Markdown files at that path. For UI-only settings such as Cursor User Rules or GitHub Copilot personal instructions, tell the user what text to add rather than editing an unknown file.

The canonical Roughdraft instruction block is hosted at https://roughdraft.md/prompt.md. After you identify or create the right instruction file, prefer appending or merging that exact block:

```bash
agent_instructions_file="/absolute/path/to/AGENTS.md"
printf "\n\n" >> "$agent_instructions_file"
curl -fsSL https://roughdraft.md/prompt.md >> "$agent_instructions_file"
```

If the instruction file already has Roughdraft guidance, merge in any missing guidance from https://roughdraft.md/prompt.md instead of duplicating the section.

If you cannot use `curl`, add guidance like this:

````markdown
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

Roughdraft may already have inline attribute blocks after comments and suggestions from older documents. Preserve these attributes unless you are intentionally removing the associated comment or suggestion. For new feedback, prefer compact references plus YAML endmatter.

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
````

After updating your instructions, briefly tell the user which file you changed.

## Claude Code Plugin (automatic live review)

If you are Claude Code, offer to install the Roughdraft plugin once at user scope. It makes every interactive session receive the user's Ask/Change comments on the Markdown files it writes or opens, without arming anything, and lets the user see and switch the connected session in Roughdraft:

```bash
roughdraft setup claude            # prints the two commands
roughdraft setup claude --install  # runs them
```

Ask before installing it. New sessions pick it up; running sessions need a restart.

## Roughdraft-flavored CriticMarkup Reference

Roughdraft uses CriticMarkup for inline comments and suggested changes while keeping all review state in the Markdown file.

For exact syntax, metadata, and round-trip behavior, read the official Roughdraft Flavored Markdown spec at https://roughdraft.md/spec/roughdraft-flavored-markdown.md. The review-index JSON Schema is available at https://roughdraft.md/spec/roughdraft-flavored-markdown.schema.json.

Base markers:

```text
Comment: `{>>comment<<}`
Insertion: `{++new text++}`
Deletion: `{--old text--}`
Substitution: `{~~old~>new~~}`
Highlight: `{==text==}`
```

When adding review feedback, prefer the extended Roughdraft format so comments and suggested changes keep ids, authors, timestamps, and thread relationships.

Roughdraft extensions:

```markdown
{==selected text==}{>>Comment text<<}{#c1}
{++new text++}{#s1}
{--old text--}{#s2}
{~~old text~>new text~~}{#s3}

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
  c2:
    body: I can make that edit.
    by: AI
    at: "2026-04-28T12:05:00.000Z"
    re: c1
  c3:
    body: Use the customer example here.
    by: user
    at: "2026-04-28T12:13:00.000Z"
    re: s1
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:10:00.000Z"
  s2:
    by: user
    at: "2026-04-28T12:11:00.000Z"
  s3:
    by: AI
    at: "2026-04-28T12:12:00.000Z"
```

Metadata is written in final YAML endmatter:

```text
id  Stable document-local id for a comment or suggested change
by  Author or agent label
at  ISO timestamp
re  Parent comment or suggestion id for replies
```

CriticMarkup inside fenced code blocks is literal example text. Do not treat it as review feedback.

User comments may appear inline in the Markdown file. Suggested insertions, deletions, and substitutions should be interpreted as review feedback unless the user asks you to accept them directly.

Use `roughdraft help criticmarkup` for local syntax examples.
