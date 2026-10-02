# Codex tool cancellation review — 2026-10-01

Alpha's scheduler must preserve a tool's terminal result when Stop arrives after that result is ready. Cancellation can
stop the rest of the batch without changing a completed call's success or error into cancellation.

## Upstream reference

Reviewed Codex CLI commit `b707714ae4200db0a0385da24b3981d99139fa62`, retrieved on 2026-10-01:

- [`codex-rs/core/src/tools/parallel.rs`, lines 249–278](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/core/src/tools/parallel.rs#L249-L278)
  preserves the result when dispatch has finished or the call has reached its terminal outcome, even if cancellation wins
  while result collection or lifecycle notification is pending.
- The regression
  [`cancellation_after_handler_finishes_preserves_completed_lifecycle`, lines 733–801](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/core/src/tools/parallel.rs#L733-L801)
  holds lifecycle finalization after a handler finishes, cancels, and verifies that its successful result survives.

Alpha implements this behavior in its existing TypeScript scheduler. Codex's Rust runtime and sandbox are outside this
change.

## Failure and owning boundary

The controlled reproduction dispatches two independent reads in one bounded parallel window. The first handler returns
a success or error result; the sibling remains pending. Stop then arrives before ordered batch finalization.

`ToolScheduler.executeCall` had already produced the first terminal result. `finalizeRead` subsequently consulted the
batch's current cancellation state and replaced every read result with a cancelled receipt. This erased the earlier
truthful outcome, even though the first call had finished before Stop.

The scheduler now records `terminalResultReady` when it receives a non-cancelled call result with no prepared-read
finalizer pending. Both serial and parallel dispatch use this same completion boundary. Ordered finalization preserves
that result if a later cancellation arrives. A prepared read that still needs its finalizer has not produced its terminal
result and retains its existing cancellation behavior.

## Compatibility and ownership

- Result ordering, call IDs, output limits, and exactly-once deferred publication remain unchanged.
- Running reads that finish after cancellation and calls that were never admitted still receive cancelled receipts.
- The scheduler still joins admitted handlers. This change neither detaches ignored-signal work nor releases mutation
  ownership early.
- Committed effect outcomes retain the existing behavior. Tool schemas, persisted formats, approval authority, and
  Alpha's execution protections do not change.

Cooperative cancellation of a stalled backend is a separate adapter responsibility. This correction concerns result
fidelity rather than termination latency.

## Validation

The new sibling-read regression uses controlled promises, with no timed sleeps. Its four cases cover terminal success and
error with immediate and deferred result publication. It also verifies that Stop continues to join the pending sibling,
does not admit the queued suffix, preserves model-call order, and publishes deferred receipts once.

Before the implementation, this command produced four expected failures: the completed first result was `cancelled` in
each case.

```sh
pnpm --dir src test core/agent/__tests__/ToolScheduler.spec.ts -t 'preserves a completed .* sibling read'
```

After the implementation, those four cases passed. An additional regression confirms that cancellation suppresses a
prepared read whose terminal result still requires ordered finalization.

```sh
pnpm --dir src test core/agent/__tests__/ToolScheduler
```

Result: **5 test files passed; 169 tests passed**. This includes command batching, command-read management, deferred
results, and progress coverage alongside the main scheduler tests. Prettier was limited to the changed scheduler, test,
and this document. Integrated type checks and the exact VS Code 1.125.0 host gate are owned by the parent implementation
task and are not claimed here.
