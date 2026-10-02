# Long-context compaction liveness review

Reviewed on October 1, 2026, against official Codex CLI commit
`cb6da58876afed3ede0ab11084f67dd5394ecb48`. The parent investigation refreshed `origin/main` at
`2026-10-02T01:34:23Z` and inspected the clean detached source checkout. This review preserves Alpha's native
TypeScript harness, existing execution protections, tickets, skills, and managed-agent behavior.

## Current reference behavior

- [Pre-sampling compaction](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/session/turn.rs#L179)
  preserves incoming user input before reporting compaction failure. The same file's mid-turn compaction boundary at
  lines 601–643 stops the turn on failure instead of sampling repeatedly with unchanged history.
- [Local compaction](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/compact.rs#L274)
  retains one client session across summary attempts. Interruption and session-budget exhaustion are terminal; a
  context-window rejection removes an older history item before another attempt, and other retries are bounded.
  Successful replacement history is persisted and token usage recomputed at lines 365–404.
- [Summary stream completion](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/compact.rs#L754)
  requires the completed response. Post-turn output is committed only after success. Task cancellation is owned by
  [task abort handling](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/tasks/mod.rs#L911),
  which cancels the task and aborts its running handle after cleanup.
- The [context-window retry regression](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/tests/suite/compact.rs#L4077)
  asserts one user request and two summary attempts, with exactly one older history item removed on the retry.

Alpha intentionally retains provider-neutral local summarization, complete tool transactions, non-destructive rewind
archives, captured provider state, and its configured API timeout. This repair does not copy Rust code or prompts, add
Codex's sandbox, or introduce an alternative loop or retry engine.

## Reproduced failure and owning boundary

`Task.attemptCapturedApiRequest` already calculated `contextManagementDeadline`, but its automatic-compaction waits used
only `options.retryDeadline`. A fresh step normally has no retry deadline. Passing the configured deadline to a provider
as metadata therefore did not bound an unresponsive summarizer or catalog preparation at the host boundary.

Manual and optional post-turn compaction also passed deadline metadata while awaiting summary/preparation promises
directly. Forced context-window recovery bounded its outer wait, but did not abort the underlying summary request when
that wait expired. These are compaction-operation ownership failures, not evidence that large prompts themselves must be
discarded or that delegation should use a separate runtime.

A controlled 100 ms fake-clock workload held the summary promise and released it after the deadline observation:

| Path      | Before the repair                                      | After the repair                                             |
| --------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| Automatic | Still pending at deadline; late summary could continue | Deadline failure; summary signal aborted; no history rewrite |
| Manual    | Still pending at deadline                              | Deadline failure; summary signal aborted; ownership released |
| Forced    | Outer deadline failed; summary signal remained active  | Deadline failure also aborts the summary signal              |

The three focused regressions failed for those exact reasons before the production edit. They make no network or live
model calls. This is a deterministic liveness measurement, not a claim about general model speed or task quality.

## Repair

Each existing Task compaction path now reuses `createLinkedAbortController` to own its configured deadline and caller
cancellation, then disposes the timer and listener in `finally`. Readonly configuration, catalog, tokenizer, and summary
waits use the existing `waitForRequestControl` with that same absolute deadline. Preparation time consumes the same budget
as the summary rather than granting the summary another full timeout.

Automatic compaction retains caller cancellation on its shared token-count context through the final dispatched-request
measurement. The tighter absolute retry budget keeps its existing failure semantics. Setting `apiRequestTimeout` to zero
continues to disable the configured timeout, while Stop still cancels the operation.

Generation-owned provider-history writes remain joined. If the deadline expires during a commit, the caller waits for
that commit before reporting timeout; it cannot detach a stale snapshot that lands after another request begins. A
timed-out optional post-turn compaction releases its ownership and preserves the already completed turn. No new provider
request is dispatched from a late summary result.

The compaction algorithm and persisted formats are unchanged. Existing safeguards already reject no-progress recovery,
recount actual provider state and refreshed environment before dispatch, retain complete recent transactions and direct
user constraints, and report exhaustion when mandatory context cannot fit. Oversized indivisible context still produces
an explicit failure; this change does not silently remove tickets or instructions to force a request through.

## Validation

- Fail-before command: `pnpm --dir src test core/task/__tests__/Task.compaction-safety.spec.ts -t "compaction by its configured deadline"`:
  3 expected failures, automatic/manual still pending and forced summary not cancelled.
- `pnpm --dir src test core/task/__tests__/Task.compaction-safety.spec.ts core/task/__tests__/Task.retry-wire.spec.ts core/context-management/__tests__ core/condense/__tests__`:
  **440 tests passed across 15 files**. The Task compaction file contributes 97, including deadline propagation,
  stalled catalogs, timeout-disabled Stop, joined commits, and optional post-turn cleanup. Retry wire contributes 57;
  its prototype fixture now initializes the existing task lifetime controller, as production construction does.
- `pnpm --dir src check-types`: passed after the repair and again after the final source/test edits.
- Focused ESLint for the three touched TypeScript files, Prettier for those files and this document, and
  `git diff --check` passed.

The parent owns builds, exact VS Code 1.125.0 gates, managed-agent certification, and the large five-ticket concurrent
child fixture. Those integration results are not claimed here. No live-model performance run was performed. Providers
must still honor cancellation to terminate their underlying network work; the host no longer waits indefinitely for a
provider or readonly preparation promise that ignores the signal.
