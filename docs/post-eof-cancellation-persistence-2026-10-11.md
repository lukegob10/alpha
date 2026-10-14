# Cancellation persistence after provider EOF

Reviewed on 2026-10-11 against Alpha baseline `3a67501a2c92b9747d0598274ef3826121456151` and the
read-only Codex checkout at `27065a91ccbf5ba8532844be3777fcf83b77820d`. Alpha remains a native TypeScript
VS Code extension with VS Code **1.125.0** as its host contract. The accepted assistant phase and message
boundary changes remain intact; a `final_answer` phase does not independently complete a turn.

## Verified upstream behavior

- Codex [tool dispatch](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/tools/parallel.rs#L258)
  observes cancellation, joins handlers that must finish, or produces an aborted output with the original
  call ID. Its terminal-outcome flag prevents duplicate abort callbacks. The
  [dynamic handler](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/tools/handlers/dynamic.rs#L235)
  resolves a cancelled wait into a failed completed item instead of a successful reply.
- The [sampling loop](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/session/turn.rs#L2462)
  drains ordered in-flight tool outputs into conversation history after streaming. It publishes recorded
  token counts before its final cancellation check at lines 3170–3179.
- [Task interruption](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/tasks/mod.rs#L925)
  first cancels the task and allows a bounded graceful join. It flushes the interruption marker before
  `TurnAborted`, then flushes again after the terminal event. These abort-path flush failures are logged;
  they are not proof that every cancellation became durable.
- The [rollout writer](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/rollout/src/recorder.rs#L1785)
  retains its unwritten suffix after I/O failure. Explicit `persist`/`flush` barriers acknowledge the
  writer or return an error. `persist_reports_filesystem_error_and_retries_buffered_items` and
  `writer_state_retries_write_error_before_reporting_flush_success` cover recovery.

Upstream regressions inspected: `interrupt_tool_records_history_entries` replays the original call and
its aborted output on the next request; `interrupt_completes_cancelled_dynamic_call` requires the
completed failed item and one aborted callback before `TurnAborted`;
`terminated_cell_persists_failure_and_excludes_late_reply_from_context` checks one persisted completion
and excludes a late successful reply. These are in
[abort_tasks.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/tests/suite/abort_tasks.rs)
and [dynamic_tool_cancellation.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/tests/suite/dynamic_tool_cancellation.rs).
The separate `root_turn_suspension_preserves_unfinished_turn_history` contract preserves an unfinished
turn during handoff; suspension must not be conflated with user cancellation.

## Alpha failure and ownership

At the reviewed baseline, [Task.runAgentRequests](../src/core/task/Task.ts) adds each chunk to the
canonical accumulator before observing abort. Its abort check around line 13090 skips graceful stream
cleanup when `abandoned` is true, then breaks. The inner catch around line 13317 also skips abandoned
instances. The post-stream abort/abandoned throw around line 13602 lies outside that catch and reaches
the outer failure return without finishing or persisting the accumulator. A clean EOF therefore can
leave only the user input on disk even after a complete assistant call and usage were captured.

Equivalent asynchronous boundaries before the assistant save include preview draining, the early-read
dispatch tail, accumulator finalization, canonical projection, reasoning-message updates, UI transcript
saving, and grounding presentation. Cancellation during those awaits needs the same terminal repair.
`drainStreamingPreviews` returns when cancelled, so checking only rejected promises is insufficient.
`AgentResponseAccumulator.finish` caches its promise: a later call with a cancelled outcome does not
replace an already finalized completed outcome.

[AlphaProvider.cancelTask](../src/core/webview/AlphaProvider.ts) marks the original instance abandoned
before joining its [cancellation boundary](../src/core/webview/TaskCancellationBoundary.ts). Replacement
and history rehydration await that boundary before constructing a new `Task`. `waitForTermination`
joins the owned producer, persists staged results, closes the canonical lifecycle, and flushes history.
It cannot recover a missing assistant boundary from an unfinished accumulator on its own.
The legacy `TaskAborted` notification may precede those joins; provider replacement relies on
`waitForTermination` as the authoritative persistence boundary.

Abandonment prevents further work; it does not itself revoke transcript ownership. The constructor
assigns a per-task writer generation, queued transcript saves verify that generation, and all instances
share one bounded serial save queue. Terminal repair may run for the abandoned **current owner** while
its joined producer settles. It must not enable obsolete instances to write or publish new canonical
state. The existing generation and commit-receipt/content-digest fences remain mandatory.

Resource disposal cancels requests and removes presentation listeners, but does not clear captured
response data or revoke the writer generation. Repair uses that captured data without reopening tools
or provider work. Background usage draining intentionally rejects aborted/abandoned owners; already
normalized usage must be projected from the local request totals instead.

## Correction contract and verification

The correction uses `persistTerminalCanonicalResponse` through one memoized per-step cancellation
repair before the normal assistant commit. Current-owner checks surround its await boundaries and
fence the cancellation producer's Engine callbacks, elapsed goal billing, and terminal publication.
The repair joins accepted early reads, finalizes the authoritative accumulator, preserves ordered
items and provider metadata, and assigns a cancelled outcome even when normal finalization already
occurred. It saves the assistant boundary before emitting one cancelled/error receipt per unresolved
accepted call. Recovery is cleared before either normal or terminal persistence begins, including
failed saves, so a late error cannot append another assistant boundary or repeat response accounting.

An early-read scheduler that settled while approval was pending does not prove the read ran. Its
receipt remains cancelled and never executed; withheld-read error receipts are reserved for completed
reads. An interrupted read with a recorded effect start carries an unknown-outcome warning so replay
cannot claim the read never ran. Existing completed results remain authoritative. The producer keeps
external termination joins separate from its own repair and stops before further approvals, effects,
retries, or completion. These fences cover cancellation/transaction follow-through; normal replacement
already waits for the old producer to settle.

Failed assistant/result persistence must retain retryable in-memory data and make the external
termination boundary reject, preventing replacement. Alpha intentionally retains its stronger
fail-closed legacy-transcript plus sidecar receipt boundary instead of copying Codex's rollout runtime
or abort-path warning policy. Stable goal usage receipt IDs, goal stop coalescing, and usage-update
ownership must preserve exactly-once accounting through cancellation and reload.

Required controlled-barrier regressions cover a complete call with a held provider tail; EOF followed
by cancellation during finalization; accepted calls with pending approval; abandonment while the
original writer still owns the task; refusal of obsolete-generation writes; failed save retention and
replacement refusal; exactly one durable assistant call and terminal result after JSON/sidecar reload;
and one goal/usage charge with no tool effect or false completion.

Existing adjacent coverage is in [Task.persistence.spec.ts](../src/core/task/__tests__/Task.persistence.spec.ts)
(delayed acceptance joins, replacement write ordering, failed result-buffer retention),
[Task.spec.ts](../src/core/task/__tests__/Task.spec.ts) (stream failure salvage and pending approval
cancellation), [Task.goals.spec.ts](../src/core/task/__tests__/Task.goals.spec.ts), and
[checkpointRestoreHandler.spec.ts](../src/core/webview/__tests__/checkpointRestoreHandler.spec.ts).
The new [Task.post-eof-cancellation.spec.ts](../src/core/task/__tests__/Task.post-eof-cancellation.spec.ts)
reproduced the baseline failure with real native history, lifecycle journal, sidecar, and goal storage:
both ordinary and abandoned cancellation reloaded only the user message, with no captured response or
goal usage receipt, and termination rejected because recovery tool-result receipts could not be saved.
The exact command was:

```sh
pnpm --dir src test core/task/__tests__/Task.post-eof-cancellation.spec.ts --maxWorkers=2
```

Baseline result: one file, two failed cases, exit 1. The same command against the correction passed all
22 cases in one file, including the final rerun after fixture type repairs (exit 0; 12.65 seconds
overall, 4.17 seconds in tests). Coverage includes nine controlled boundaries under both ordinary abort
and abandonment, a held authoritative receipt save,
an approved read interrupted after effect start, failed write retention and repeated cleanup rejection,
and obsolete-owner refusal both directly and through the real `AgentTurnEngine`. Reload assertions
preserve phases and opaque provider state, one terminal receipt, and one goal/usage charge.

Six adjacent files passed 218 tests (exit 0; 15.58 seconds) with:

```sh
pnpm --dir src test core/task/__tests__/Task.persistence.spec.ts core/task/__tests__/Task.goals.spec.ts core/task/__tests__/Task.retry-wire.spec.ts core/agent/__tests__/GoalStepAccounting.spec.ts core/agent/__tests__/ToolScheduler.deferredResults.spec.ts core/task-persistence/__tests__/assistantMessagePhaseReplay.spec.ts --maxWorkers=2 --reporter=verbose
```

A preceding seven-file run that also included all of `Task.spec.ts` reported failures and blocked a
worker; that runner was interrupted (exit 1). A serial first-failure run retained the concrete result:

```sh
pnpm --dir src test core/task/__tests__/Task.spec.ts --maxWorkers=1 --bail=1
```

It stopped after 21 passed and one failed case (exit 1; 10.05 seconds). The failure was
`Alpha > getEnvironmentDetails > API conversation handling > processUserContentMentions > should process mentions in user_message tags`:
the storage mock lacks `resolveExistingTaskDirectoryPathReadOnly`, called by `TaskGoalStore.filePath`.
Read-only baseline inspection confirmed that the storage mock already omitted the export and that
`TaskGoalStore`, `GoalController`, and this fixture are unchanged in the correction. The parent owns
that baseline fixture repair in the separate goals work. No `Task.spec.ts` fixture or assertion was
changed here, and the broad file is not claimed to pass.

The scoped terminal-persistence, approval-cancellation, and streaming-preview cases from
[Task.spec.ts](../src/core/task/__tests__/Task.spec.ts) passed 16 cases with 299 skipped (exit 0;
10.57 seconds). Scoped lint passed with:

```sh
pnpm --dir src exec eslint core/task/Task.ts core/task/__tests__/Task.post-eof-cancellation.spec.ts
```

The extension typecheck passed (exit 0) after fixing two regression-fixture types: the test capabilities
declare `supportsPromptCache: false`, and approved scheduler callbacks retain the complete native
`ToolCallbacks` shape. The exact command was:

```sh
pnpm --dir src check-types
```

Final new-test lint passed (exit 0) after the fixture repairs with:

```sh
pnpm --dir src exec eslint core/task/__tests__/Task.post-eof-cancellation.spec.ts --max-warnings=0
```

No production changes followed the successful scoped lint run above. Normal commit hooks and broader
lint belong to the lead.

This follow-up chat owns focused regression, typechecking, and lint validation. The parent chat owns
the integrated full suite and serial exact-host retest using
`pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`; those gates have not run in this follow-up
worktree.
