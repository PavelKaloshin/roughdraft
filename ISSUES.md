# Roughdraft Feedback Issues

Source: friend feedback screenshot, pasted commit-blocker text, and local testing in this branch.

## Addressed In This Branch

1. **YAML frontmatter corruption on rich-text round-trip.**

   Rich-text conversion no longer parses YAML frontmatter as Markdown body content, so frontmatter delimiters are preserved as `---` instead of being serialized back as `* * *`.

2. **Frontmatter protected as raw text in rich-text mode.**

   Markdown files with YAML frontmatter now split the frontmatter before rich-text parsing and prepend the original raw frontmatter on save. This preserves delimiters, indentation, arrays, multiline strings, and table-like YAML text unless the user edits the source in code mode.

3. **Initial frontmatter regression coverage.**

   Added tests for exact YAML frontmatter round-trip through the editor conversion layer and for rich-text autosave preserving raw frontmatter while the body changes.

## Remaining Issues To Fix

1. **Autosave can overwrite external git restores.**

   The app has version/conflict plumbing, and current document saves use `expectedVersion`, but the reported behavior still needs an end-to-end reproduction around a stale open tab, pending autosave timer, file watcher updates, and an external `git checkout HEAD -- ...` restore.

   Relevant areas:

   - `packages/app/src/App.tsx`
   - `packages/app/src/PageCard.tsx`
   - `packages/app/src/api-backend.ts`
   - `packages/server/src/index.ts`

2. **Normal Markdown table round-trip can be corrupted.**

   Local testing with `.context/frontmatter-roundtrip-test.md` showed that a normal Markdown table in the body was rewritten with an empty first row after rich-text editing:

   ```md
   |     |     |
   | --- | --- |
   | Column | Value |
   | Body table | This table should remain editable as Markdown content. |
   ```

   The frontmatter stayed intact, so this is separate from YAML preservation. It likely lives in the rich-text table parsing/serialization path.

3. **Tables immediately after frontmatter need explicit regression coverage.**

   Table-like text inside YAML frontmatter is now preserved as raw frontmatter, but Markdown tables immediately after frontmatter still need a focused reproduction and expected behavior. This should cover both a table as the first body block and a table following a heading or paragraph.

4. **Need in-app file navigation for project docs.**

   Users jump among `PLAN.md`, `PROGRESS.md`, `RESEARCH.md`, `SPEC.md`, and `STATUS.md`, but currently have to use the CLI to open each file. Backend endpoints for file listing already exist; the frontend needs a project/file sidebar or quick switcher.

5. **Need safer multi-document workflow.**

   Switching docs should handle dirty state, pending autosave timers, file watcher subscriptions, and URL state cleanly. Opening one file after another should not allow stale saves to land on the wrong content or confuse "changed on disk" state.

6. **Need commit-safety regression tests across disk changes.**

   Add tests that open a frontmatter file, round-trip through rich text, simulate an external restore/change, and verify Roughdraft does not rewrite `---` to `* * *` or overwrite a newer disk version.

7. **Need clearer conflict UX for external changes.**

   When a file changes on disk while Roughdraft has unsaved local edits, the app should make the conflict state obvious and give safe choices: reload from disk, keep editing without autosave, or intentionally overwrite.

## Commit-Blocker Text

> Commit blocker: something (Roughdraft, most likely) is re-writing unified-tasks/v1/SPEC.md over my git checkout HEAD --. Working copy starts with * * * again seconds after I restore the valid --- frontmatter from HEAD. The pre-commit hook runs the validator across the whole repo, so the bad file blocks the PR even though it's outside my staged changes. Fix needs you: close the file in Roughdraft (or accept its frontmatter-fix suggestion in-tool, then save). Once the on-disk byte 0 is --- and stays ---, I can re-run the commit.

