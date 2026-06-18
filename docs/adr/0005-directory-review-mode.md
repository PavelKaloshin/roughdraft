# 0005: Directory Review Mode
## Context
ADR 0001 establishes a single Markdown file as Roughdraft's unit of work and explicitly excludes a multi-document workspace. In practice, reviewers often keep a set of related Markdown files in one directory (plans, specs, notes) and want to move between them without re-invoking the CLI for each file.
## Decision
Roughdraft may open a directory as a **navigation context** over the same single-file unit of work. `roughdraft open <dir>` shows a read-only tree of the directory's contents in a persistent sidebar; selecting a file opens it.

The tree lists **all** files under the directory, not only Markdown, so the directory can be browsed in full. How a selected file opens depends on its type:

- **Markdown** (`.md`) opens in the existing single-document workspace, where review, edit, comment, save, and "Done" behave exactly as in single-file mode. Markdown remains the only interactive unit of work.
- **Every other file opens read-only.** Code renders with on-demand syntax highlighting, plain text renders as monospaced text, images render as a preview, and other binaries fall back to a "preview unavailable" stub. Read-only files cannot be commented on, edited, or saved.

The directory is addressed in the app by a `dir` query parameter that scopes the sidebar tree and the server's `projectPath`. A selected file is still carried by the existing `path` parameter. Single-file mode (`?path=` with no `?dir=`) is unchanged.
## Consequences
The file tree is built on demand from the filesystem on each request. The server resolves and reads one file at a time within the directory's local-file boundary; the existing path-boundary checks continue to apply with the directory as the project root. Markdown is still served by the `.md`-gated `/api/markdown-file` endpoint; read-only files reuse the existing `/api/files` byte-serving endpoint, so no new server surface is introduced. File type is classified on the client by extension. No persistent index, database, or sync is introduced. One file is open at a time; markdown and the read-only viewer are mutually exclusive, and switching files tears down the previous file's watcher and save state.
## What This Explicitly Does Not Mean
This does not make Roughdraft a vault manager, note database, git client, desktop shell, or general multi-document editor. There is no project-wide search, cross-file operation, persistent project model, or background indexing. The directory tree is a transient, read-only listing that exists only to navigate to the next file to open. Non-Markdown files are shown for context and reference only; they are never an editable or reviewable unit of work.

This refines — it does not override — ADR 0001: the editable, reviewable unit of work is still one Markdown file. Other files are read-only context, and the directory is only the place from which a file is chosen.
