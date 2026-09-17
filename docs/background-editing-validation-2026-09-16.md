# Background editing validation — 2026-09-16

Mode: correctness cleanup. Scope: the `preventFocusDisruption` setting and the shared file-save boundary.
The intended behavior is that approved edits preserve editor focus, tabs, selections, and unrelated unsaved typing;
changed or dirty targets are rejected; cancellation stops a save before it starts writing.

## Fixed now

- **High, must-fix:** `DiffViewProvider.saveDirectly` did not check task cancellation or edit invalidation before writing.
  It now captures the edit generation and the task's current cancellation signal, checks them before filesystem
  preparation and after awaited preflight work, and preserves the existing approved-preview validation.
  A newer request signal cannot revive an interrupted save. The shared boundary serves all file-edit tools.
- **Medium, should-fix:** new files created by `apply_patch` and `edit_file` requested editor tabs even with background
  editing enabled. Both now use the same closed-tab behavior as the other edit tools.
- **Medium, should-fix:** background saves loaded documents even when diagnostics were disabled. They now leave closed
  documents closed when neither presentation nor diagnostics is requested.

No public setting, persisted format, approval rule, provider selection, or default experiment value changed.

## Coverage

Reviewed the setting's cached-state binding, all six file-edit tool save paths, the shared preview/direct-save boundary,
task cancellation signals, workspace mutation serialization, and existing dirty-buffer/content-conflict coverage.

Regression cases reproduced the defects before the fixes. Tests cover:

- New-file creation without showing editor tabs, including a tool-to-real-save-boundary test for `apply_patch`.
- Cancellation before saving, task abandonment, cancellation/reset during baseline validation, and an interrupted
  captured signal followed by a new healthy signal.
- Keeping documents closed with diagnostics disabled, and reporting committed bytes when diagnostic document loading fails.
- Existing coverage for dirty buffers, saved editor revisions, stale/deleted targets, exclusive creation, denied approval,
  CRLF/BOM preservation, multi-file outcomes, preview ownership, and workspace mutation serialization.

The added VS Code host fixture exercises closed-file creation/modification, unchanged tabs/focus/selection, preservation
of unrelated unsaved typing, refresh of an open clean target, and rejection of an open dirty target. It uses the real
bundled save provider and real VS Code documents; tool selection is covered separately by the tool regression tests.

Validation completed:

```text
Focused extension tests: 247 passed, 5 pre-existing Windows-skipped cases, 9 files
pnpm --dir src check-types: passed
pnpm --dir src lint: passed
pnpm --filter @alpha-code/vscode-e2e check-types: passed
pnpm --filter @alpha-code/vscode-e2e lint: passed
Touched-file Prettier check: passed
```

Host validation commands:

```sh
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
pnpm --filter @alpha-code/vscode-e2e exec node ./out/runTest.js --vscode-version 1.122.1 --provider scripted --file diff-preview-ownership.test
```

The exact VS Code 1.122.1 smoke gate passed (10 tests). The focused host suite passed both the new background-editing
test and the existing preview ownership test on Windows. The initial focused run failed in fixture cleanup because
closing one editor group invalidated a later tab handle; batching the test-owned tab close fixed the cleanup and the
bounded rerun passed. The fixture assertions were retained.

## Limits and follow-up

- **Flagged for follow-up:** existing-file writes still use content validation followed by filesystem writing, not an
  atomic compare-and-swap with unrelated external processes. Workspace mutation serialization protects cooperating
  Alpha tasks sharing the provider's mutation gate, but does not lock arbitrary editors or filesystem writers.
- **Flagged for follow-up:** the default-preview host scenario logged a VS Code local-history `ENOENT` while cleaning
  up a temporary preview. Its source-buffer assertions passed; preview-history cleanup was not changed in this pass.
- **Not verified:** macOS/Linux host runs, extended manual typing sessions, remote filesystem providers, or live-model
  behavior. This is deterministic correctness evidence, not a claim of perfect behavior under every environment.
- **Out of scope:** background task selection/routing, managed-agent lifecycle certification, CLI/shim changes, and
  installing or publishing an extension release.

Once a filesystem write has started, cancellation cannot safely undo its bytes. This change checks cancellation before
that effect boundary; it does not turn post-write diagnostic problems into a failed write or roll back committed edits.
