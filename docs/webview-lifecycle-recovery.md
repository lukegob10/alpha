# Webview lifecycle and recovery

The extension owns task lifecycle, persistence, and policy. Sidebar/editor webviews consume projected state and retain
only presentation drafts. A replacement view must hydrate independently of long-running commands and cannot become a
second task owner.

## View ownership

- `webviewDidLaunch` uses the existing immediate tracked-operation lane so compaction or another global command cannot
  block initial state.
- Register disposal before awaiting HTML. Subscriptions, listeners, initialization callbacks, and readiness remain bound
  to the originating view; a replaced or disposed view cannot mutate its successor.
- Resolve cross-view task operations through the shared session registry within the same storage host. Execute compaction
  on the original task and acknowledge the requesting view in `finally`, including missing-task and failure paths.
- Cancellation, persistence barriers, and task ownership remain authoritative when a view hides, reloads, or closes.

## Incremental lifecycle projection

`LiveTaskMetadata` carries compact task state, optional `turnId`, and `hasPendingToolCalls`. Canonical journals, response
items, replay, and public lifecycle readers remain in the runtime; they are not resent in full on every UI update.

Compact metadata supersedes delayed legacy snapshots. Slow tree/full-refresh work captures fresh metadata and preserves
the original transcript, queue, and todo fences. Navigation suppresses follow-up publication to a replacement task.
Lifecycle publication must not await unrelated managed-agent startup.

History indicators use canonical lifecycle rather than late streaming flags. Waiting/completed/failed tasks cannot resume
a spinner because an old input flag arrives. Removing live metadata restores a saved task's age. Labels and accessible
names use the English locale and VS Code theme tokens; reduced motion suppresses activity animation.

## Bounded rendering

When following output, the transcript hook renders the newest 80 rows. Explicit older-history loading, browsing, and
checkpoint navigation preserve their anchors; returning to the bottom restores the bound. Full history and stable row
identities remain available.

Code fences over 100,000 characters or 1,000 lines render complete plain text instead of syntax highlighting, including
after streaming ends. Copy retains the original source. These are renderer resource bounds, not transcript truncation.

## Native question drafts

The synchronous `request_user_input` form retains its draft by task, ask timestamp, and question payload. Navigation is
local until the complete answer map is submitted once. Rejected admission preserves editable answers; historical cards
cannot answer a newer request or restart a failed/closed task.

Optional `userInputResponse` metadata is a presentation receipt carried with its owning feedback message. Older messages
remain readable as plain text. The webview renders a receipt only when its validated full question/answer text matches
the persisted feedback. It does not create another authoritative answer store or overwrite the composer's separate draft.

## Local diagnostics

The existing `[webviewError]` path accepts bounded fixed categories, numeric locations, visibility, hashed task identity,
message counts, and validated activity phase. It excludes exception text, stacks, resource URLs, prompts, and raw task IDs.
Both sides deduplicate and cap reports at ten per attached document/view, and renderer listeners are disposed.

A killed renderer or failed initial entry bundle cannot report through JavaScript. Missing local diagnostic output does
not establish that the renderer stayed healthy. Do not infer a renderer-crash fix from a passing lifecycle fixture.

## Validation

```sh
pnpm --dir webview-ui test src/components/chat/hooks/useProgressiveTranscript.spec.ts
pnpm --dir src check-types
pnpm --dir webview-ui check-types
pnpm --filter @alpha-code/vscode-e2e test:transcript-lifecycle-ui:1380
pnpm --filter @alpha-code/vscode-e2e test:request-user-input-ui:1380
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250
```

The rendered fixtures exercise real chat rows and question controls with scripted providers. Use controlled promises,
retained old callbacks, or fake clocks for replacement, delayed projection, cancellation, and compaction regressions.
