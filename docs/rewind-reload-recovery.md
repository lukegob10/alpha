# Deliberate rewind and crash recovery

Reference: Codex CLI commit `8c076942cb70fba8e5c4732c23f1faabc4aed484`, inspected on 2026-10-17.
Its [rollout reconstruction](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/session/rollout_reconstruction.rs)
uses explicit `ThreadRolledBack` events when reconstructing retained user turns. Its
[paginated revert implementation](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/thread-store/src/local/revert_thread.rs)
persists a replacement rollout before switching the active pointer, and
[revert tests](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/thread-store/src/local/revert_thread_tests.rs)
cover repeated reverts retaining thread identity and hiding removed suffixes.

Alpha retains its existing TypeScript task owner, lifecycle journal and transcript writers. The corresponding invariant
is that intentional history removal must be durable before crash repair decides which missing tool transactions to
restore. Previously MessageManager wrote shortened UI history first, then provider history, without recording deliberate
removal. False persistence receipts were ignored. Canonical recovery could then recreate removed calls and results.

`Task.commitConversationRewind` now writes `task_rewind.json` atomically before either transcript changes. This receipt
contains the exact pending UI and provider projections plus removed canonical call IDs scoped to lifecycle run and turn.
Accepted calls still receive terminal lifecycle receipts, including removed unresolved calls; exclusions suppress only
provider transcript repair. Both existing projection writers must acknowledge success before the pending projections are removed. Failure leaves
the receipt available for retry and fails the caller instead of reporting a completed rewind. Resume finishes pending
projections before reading either history or repairing canonical transactions. Repeating recovery after success is a
no-op.

Completed receipts retain cumulative exclusions. Rewinding again must not forget an earlier intentional removal from
the same lifecycle; a successor turn can reuse a provider call ID without inheriting an old exclusion. Calls retained in
the provider history remain eligible for normal missing-result repair. When a historical rewind retains a tool call
but deliberately removes its previously stored result, the target records a host-authored error receipt in place of
the removed output. This preserves transaction pairing without restoring deleted contents. A result already missing
before the rewind remains eligible for crash repair. This deliberately tightens historical result-only rewind behavior. Older tasks without a receipt retain their prior
recovery behavior. Retained historical UI fields and retired variants are preserved, and malformed receipts fail closed
without replacing their bytes. This change does not retroactively identify deletions made before these receipts existed.

Rewind is a host operation. Callers must join task cancellation before replacing history or restoring workspace files;
an abort flag alone is not a termination receipt. Checkpoint restoration and prompt restart already join
`awaitTaskCancellationBoundary`. The shared task operation serializes its rewind commits and recovery, and applies
equally to foreground and background task instances. Artifact cleanup runs only after both transcript receipts commit,
with the existing idle and current-reference checks.

Focused validation:

```sh
pnpm --dir src test core/message-manager/index.spec.ts core/message-manager/index.artifacts.spec.ts core/task-persistence/__tests__/TaskRewindStore.spec.ts core/task/__tests__/Task.rewind-recovery.spec.ts --maxWorkers=2
pnpm --dir src test core/task/__tests__/Task.persistence.spec.ts core/task-persistence/__tests__/ThreadHistory.spec.ts core/task/__tests__/Task.post-eof-cancellation.spec.ts --maxWorkers=2
```

The focused cases cover false UI/provider receipts, a crash between projection writes, repeated recovery, removed-tool
suppression, retained-tool repair, successor call-ID reuse, cumulative exclusions and stale receipt completion. These
tests use deterministic failures and real temporary receipt files rather than timed process termination. Exact
VS Code 1.125.0 smoke remains the integration gate.
