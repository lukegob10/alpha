# Diff review investigation

Investigated October 21, 2026, with three parallel agents covering the webview, extension dispatch, and actual VS Code
editor behavior. Validation uses Windows Node 24.21.0 and pnpm 11.24.0.

## Findings

- Multi-file **Review** only expanded the inline file list. Its tests explicitly required that no native diff request was
  sent. Single-file Review already requested a native diff.
- Per-file `+/-` counts belonged to the filename's inline disclosure button. Only the separate hover icon requested a
  native diff. The unchanged hover action passed the baseline rendered test on exact VS Code 1.138.0; a general failure
  of that action was not reproduced.
- Captured diff requests shared the global webview operation queue with compaction. A controlled pending compaction
  prevented a later diff request from dispatching. This is a reproduced conditional failure, not proof that compaction
  caused the reported incident.
- A long filename could produce a title exceeding the host schema's 256-character limit. Invalid requests were silently
  discarded. Editor command failures reached the generic output logger without visible feedback.
- Review was disabled for historical changes without complete before/after snapshots even though their persisted patch
  could still be displayed inline.

## Resulting contract

`FileChangesPanel` sends a native diff request for captured files when Review is selected, up to the existing 128-file
limit. The per-file counts and diff icon form one visible native-diff button; the filename retains its inline disclosure
behavior. Multi-file Review preserves existing inline expansion and manual disclosure choices. Historical changes without
complete snapshots remain reviewable inline without reconstructing contents from the current workspace.

The existing payload limits remain unchanged. Titles fall back to **Alpha Diff** when necessary, and reviews larger
than 128 captured files remain completely available inline with working individual native-diff actions. Multiple native
groups would replace one another's preview editors, and the stable `vscode.changes` contract supplies no preview option.
The existing host schema continues to validate every native request.

`AlphaProvider` dispatches captured diff requests through its existing immediate-operation path. These requests contain
all required snapshots and do not depend on task, settings, or compaction transitions. `webviewMessageHandler` retains
runtime validation and reports invalid requests or editor-opening failures visibly. Its logs omit raw editor errors
because virtual document URIs contain base64-encoded file contents.

There is no persisted-format migration, workspace mutation, new production editor API, or change to task authority.
Both native diff sides continue to use the existing read-only virtual document provider.

## Source references

Current Codex CLI HEAD was verified with `git ls-remote` on October 21, 2026:
[`342ed69a174c206c1de52a59491b131e0753cfa5`](https://github.com/openai/codex/commit/342ed69a174c206c1de52a59491b131e0753cfa5).
Its [history projection tests](https://github.com/openai/codex/blob/342ed69a174c206c1de52a59491b131e0753cfa5/codex-rs/tui/src/chatwidget/tests/history_projection.rs)
verify that completed file changes remain displayable after replay without a preceding start notification. Its
[diff renderer](https://github.com/openai/codex/blob/342ed69a174c206c1de52a59491b131e0753cfa5/codex-rs/tui/src/diff_render.rs)
renders recorded additions, deletions, and updates. Alpha preserves this replay behavior; opening a native editor is the
intentional VS Code presentation adapter rather than a separate execution engine.

VS Code 1.138.0's installed commit is
[`7debcd0e2acdea1c52de81bf9ee1620444407dda`](https://github.com/microsoft/vscode/commit/7debcd0e2acdea1c52de81bf9ee1620444407dda).
The [extension-host command adapters](https://github.com/microsoft/vscode/blob/7debcd0e2acdea1c52de81bf9ee1620444407dda/src/vs/workbench/api/common/extHostApiCommands.ts#L446)
and [editor command implementation](https://github.com/microsoft/vscode/blob/7debcd0e2acdea1c52de81bf9ee1620444407dda/src/vs/workbench/browser/parts/editor/editorCommands.ts#L529)
confirm the existing `vscode.diff` and `vscode.changes` argument shapes. Their signatures did not need changing.

## Regression coverage and validation

New focused regressions were run before their fixes and failed for the intended reasons: native Review routing, legacy
Review, overlong titles, count-button routing, compaction blocking, and silent error handling. Coverage also preserves
complete inline review above the native file limit.

- Webview: 40 panel tests and 41 adjacent projection, chat-action, parser, and renderer tests passed; webview typecheck,
  touched-file ESLint, and Prettier passed.
- Extension: 175 handler/editor tests passed. Listener coverage passed 18 tests with one existing optional benchmark
  skipped. Extension typecheck and touched-file ESLint/Prettier passed.
- Baseline rendered host test passed on exact VS Code 1.138.0 using the scripted provider and an isolated profile. It
  proved that the original hover icon worked, while its Review assertions covered only inline expansion.
- The strengthened rendered test failed against the old UI because Review did not open a native multi-file editor. It
  passed against the rebuilt extension on exact VS Code 1.138.0 using the scripted `file-review-ui-host` model and an
  isolated profile. It verifies all captured before/after contents after reload and subsequent external edits, closes
  only fixture-owned tabs, and then independently checks the requested middle-file diff. Its four driver unit tests,
  E2E typecheck/compile, and touched-file lint/format checks passed. Native editor and narrow-sidebar screenshots were
  visually inspected. Result: `ui-probe-7fbfb2d4-2160-4141-b8f4-fcd871127e4e` in `artifacts/file-review-ui/`.

- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1380` passed all 47 tests across 13 suites, with actual host version
  1.138.0 and verified process ownership in every receipt. This includes activation, modes, approvals, command changes,
  compaction, VS Code LM fixtures, and background application completion. The complete invocation used pinned Windows
  Node 24.21.0 and pnpm 11.24.0 with a TTY and exited zero.
- `pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250` built successfully but was blocked before any tests
  started. The selected exact 1.125.0 host waited 31 seconds for the global `vscode-updating` Windows mutex, then exited
  with "Code is currently being updated." No minimum-host preflight was produced; this is not a passing compatibility
  result. Extension compilation against the existing 1.125.0 API types, focused lower-level coverage, and the full
  exact-reference-host gate are the available checks. No host files or update locks were modified.

An initial smoke invocation through the pnpm shell wrapper ended with exit 143 after 45 passing tests, during the last
suite, without a terminal runner receipt or a failed assertion. No orphaned test process remained. Its signal source
was not established. The complete pinned-executable rerun above passed the entire gate, including that last suite.

Logs are `/tmp/alpha-diff-ui-final-tests.log`, `/tmp/alpha-diff-handler-tests.log`,
`/tmp/alpha-file-review-native-final.log`, `/tmp/alpha-diff-smoke-1380-final.log`, and
`/tmp/alpha-diff-compatibility-1250.log`.
