# 0005: Directory Review Mode

## Context

ADR 0001 establishes a single Markdown file as Roughdraft's unit of work and
explicitly excludes a multi-document workspace. In practice, reviewers often
keep a set of related Markdown files in one directory (plans, specs, notes) and
want to move between them without re-invoking the CLI for each file.

## Decision

Roughdraft may open a directory as a **navigation context** over the same
single-file unit of work. `roughdraft open <dir>` shows a read-only tree of the
Markdown files under that directory in a persistent sidebar; selecting a file
opens it in the existing single-document workspace, where review, edit, save,
and "Done" behave exactly as in single-file mode.

The directory is addressed in the app by a `dir` query parameter that scopes the
sidebar tree and the server's `projectPath`. A selected file is still carried by
the existing `path` parameter. Single-file mode (`?path=` with no `?dir=`) is
unchanged.

## Consequences

The file tree is built on demand from the filesystem on each request. The server
resolves and reads one Markdown file at a time within the directory's local-file
boundary; the existing path-boundary checks continue to apply with the directory
as the project root. No persistent index, database, or sync is introduced. One
file is open at a time; switching files tears down the previous file's watcher
and save state.

## What This Explicitly Does Not Mean

This does not make Roughdraft a vault manager, note database, git client, desktop
shell, or general multi-document editor. There is no project-wide search,
cross-file operation, persistent project model, or background indexing. The
directory tree is a transient, read-only listing that exists only to navigate to
the next single file to review.

This refines — it does not override — ADR 0001: the unit of work is still one
Markdown file. The directory is only the context from which that one file is
chosen.
