# Stop and disposal audit — 2026-10-19

## Confirmed defect: cached failed Stop finalization

Severity: P2. A transient transcript persistence failure after the abort phase completed left every later native Stop awaiting the same rejected termination promise. The provider could not finish rehydrating the stopped chat even after storage became available. Reloading was the only way to replace that cached Task boundary.

`Task.beginTaskCancellation()` invalidated its cache when `abortPromise` rejected, but did not permit another finalization when `finalizeTerminationAfterAbort()` failed after a successful abort. The finalizer owns the remaining canonical lifecycle and transcript persistence barrier, so treating successful process abort as successful termination would lose data integrity.

The fix retains the fulfilled abort and captured cancellation boundary. A subsequent explicit Stop republishes only the failed finalization promise. Original receipts retain their rejection; concurrent retries coalesce; process cancellation, resource disposal, and `TaskAborted` are not repeated. A failed originating producer remains observable, and an old boundary cannot retry after losing turn ownership. No timeout, automatic retry, or approval bypass was introduced.

Changed source: `src/core/task/Task.ts` (`beginTaskCancellation`, new `publishTaskCancellationReceipt`, retained-lifecycle reset).

Regression: `src/core/webview/__tests__/AlphaProvider.stop-finalization-retry.spec.ts`.

## Evidence

The first focused regression failed before the fix because a second Stop returned the identical failed receipt. The final fixture runs the actual Task request loop and provider with scripted transport, extends the captured producer using a controlled promise, awaits successful abort, then injects one failure into the public transcript flush. It asserts eventual success, an immutable original failure, concurrent retry coalescing, and exactly one canonical `turn_terminal`, abort event, and disposal.

Final validation (one worker):

```text
pnpm --dir src test core/webview/__tests__/AlphaProvider.stop-finalization-retry.spec.ts core/webview/__tests__/AlphaProvider.native-stop-ownership.spec.ts core/webview/__tests__/AlphaProvider.stop-queued-input.spec.ts core/webview/__tests__/TaskCancellationBoundary.spec.ts --maxWorkers=1
4 files / 26 tests passed
```

The new regression file passed ESLint and was formatted with repository Prettier. `Task.ts` formatting and scoped `git diff --check` passed. Root owns the combined typecheck and exact VS Code host validation.

## Current Codex reference

Read the current official source cached at commit `091008729d5572712ac08964a9602eb71cf31428`, retrieved October 19, 2026:

- [Core abort sequencing](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/src/tasks/mod.rs): cancellation first, bounded graceful unwind, task abort, lifecycle cleanup, and rollout flush before the terminal event. Rust task abort cannot be copied literally into JavaScript; Alpha retains its native cancellation and exact producer ownership.
- [Abort lifecycle tests](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/tests/suite/abort_lifecycle.rs): callbacks finish exactly once before the terminal event across Interrupt, conditional Interrupt, and Shutdown.
- [Abort task tests](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/tests/suite/abort_tasks.rs): suspended roots retain unfinished history and separately observe child writer cleanup failure.

Intentional Alpha divergence: Alpha rejects an incomplete durable transcript barrier rather than logging it and continuing. This patch preserves that stronger existing contract while allowing an explicit retry of the captured finalization.

## Limits

The audit used scripted transport and injected deterministic persistence failure. It does not establish the frequency of this failure in user installations, and no paid model or live signed-in chat was exercised. No additional production issue was confirmed in the inspected native cancellation/owned disposal paths.
