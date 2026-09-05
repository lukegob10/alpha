# Agent-control transaction contention (NOR-34)

Investigated against Alpha 2.1.23, commit `530d737ec07ba6c4feac0f6745960de224496944`, on September 5, 2026.
The reported Python-package incident has no retained command, owner metadata, process-start evidence, or editor-window
count. It cannot establish whether Python ran. The known error originates in shared agent-control bookkeeping before
terminal launch.

## Reproduction and root causes

The former acquisition loop exhausted `[50, 100, 200, 400, 800, 1000]` millisecond delays and rejected a still-healthy
holder after exactly 2550 ms of scheduled wait. A deterministic reproduction executing the original acquisition body
observed seven failed acquisition attempts and `ELOCKED`, with the holder still alive. An ownerless legacy directory
followed the same path. This is a correctness reproduction, not a comparative throughput benchmark.

Independent race review also found distinct `.reap.T` and `.released.T` recovery destinations. A released owner can die;
a contender delayed on one recovery path could move the next live owner after the other path had recovered the old
owner. Three regression cases reproduced successor quarantine before the fix. Candidate-directory promotion also had a
POSIX empty-directory replacement window when a legacy holder appeared after the existence check.

## Admission and diagnostics

Each store and persistence instance uses a FIFO with at most 64 pending entries. Cancelled waiters are removed, including
their timers and listeners. The default queue-plus-file-acquisition budget is 30 seconds, with retry delays increasing
to a 400 ms cap. The deadline uses a monotonic clock; it never expires ownership or steals a live lock. Contention is
expected to complete when the holder and preceding admitted work release within that budget. This is bounded waiting,
not a cross-process fairness guarantee. Filesystem operations already submitted to the OS cannot themselves be aborted.

`withTransaction(operation, options?)` is additive. Options contain an `AbortSignal`, a closed operation label, and the
store queue time already spent. Cancellation stops queued acquisition and is checked before invoking the transaction
body. Once the body begins, it settles and releases normally; no timer races it, retries it, or reports a committed write
as cancelled. Task-lifetime cancellation is forwarded through primary mutation reservation and root admission. Receipt
settlement after process execution remains durable and independent of acquisition cancellation.

`FileAgentControlPersistence` optionally accepts `transactionWaitTimeoutMs`, `maxPendingTransactions`, and
`onTransactionDiagnostic`. One final callback reports `operation`, `outcome`, `queueWaitMs`, `acquisitionWaitMs`, `holdMs`,
`releaseMs`, `attempts`, `ownerState`, optional `ownerPid`/`ownerOperation`, `committed`, and `releaseFailed`. Acquisition
errors carry the same snapshot. Slow acquisition, failure, and release failure log this closed shape. Callback exceptions
cannot change transaction outcomes. Timings distinguish actual body work from waiting and cleanup; they are not a model
or command-process performance measurement. NOR-35 consumes this seam for transaction-body measurements.

Lock metadata reads are capped at 1024 bytes, tokens at 128 safe filename characters, and PIDs at the positive signed
32-bit range. Operation names are allowlisted. Diagnostics exclude storage paths, tokens, task IDs, command text,
prompts, and file contents. `ELOCKED` means bounded healthy/ambiguous contention; `EQUEUEFULL` means backpressure;
`ABORT_ERR` means cancelled admission; `ELOCKLEGACY`/`ELOCKOWNER` identify unverified ownership with repair instructions.

## Ownership and recovery

Acquisition uses atomic `mkdir` at the canonical lock path followed by bounded owner publication. Contenders tolerate
the publication window within their wait budget. A failed publication is cleaned up best effort by its creator. A crash
before metadata publication leaves an explicit ownerless lock requiring offline repair.

Live PIDs, reused PIDs, and permission-denied process probes remain protected. Only a definitive `ESRCH` permits dead
owner recovery. A release marker proves the old body has finished even if its process remains alive. Both recovery paths
use the same permanent nonempty `.reap.T` destination, and existing older `.released.T` tombstones remain respected.
Permanent tombstones prevent a delayed contender from moving a successor; they must not be pruned while hosts can run.
This protocol assumes machine-local global storage, not shared storage spanning PID namespaces or machines.

Windows release renames retain bounded transient retries. If exhausted, a durable release marker enables another instance
to recover. If marker publication also fails, the original instance retains one inactive token after cleanup settles and
can recover it through the same quarantine boundary. Another instance needs a durable marker or definitive process death.
Committed data remains successful even when cleanup fails; diagnostics explicitly preserve both outcomes.

An async transaction context prevents an unrelated standalone write from borrowing another caller's lock. The context
is fenced as finished as soon as its body settles, so escaped callbacks cannot write during cleanup or after replacement.
Every file write has a synchronous owner check plus atomic replacement. The generic JSON writer's optional
`externalTransaction` path requires atomic replacement and a synchronous commit callback, avoiding the nested
mtime-expiring advisory lease only for externally fenced writes. Ordinary JSON callers retain their existing lock.

Ownerless and malformed locks are never removed automatically based on age. Close **all** Alpha extension hosts sharing
the affected global storage, confirm no owner can resume, remove only `agent_control.json.transaction.lock`, and reopen
Alpha. Preserve `agent_control.json` and all recovery tombstones. Restart all participating hosts when upgrading the
recovery protocol: an older binary still running the two-destination reaper cannot be made safe by a newer contender.

## Command outcomes and validation

Mutation reservation now belongs to the protected pre-launch admission block. A reservation failure explicitly reports
that the command was not started, never releases an unacquired reservation, and cannot enter shell-integration fallback.
Cancelled admission similarly avoids process launch. This change adds no automatic command retry. The existing broader
shell-integration fallback after ambiguous adapter dispatch remains a separate issue reported to NOR-31.

Regression coverage includes healthy wait beyond the old budget, queue cancellation/backpressure, multi-instance and
actual child-process read-modify-write, process crash recovery, Windows transient release, mixed reaper races, legacy
tombstones, malformed/oversized metadata, local recovery after marker failure, caller context, and command admission with
foreground/background timeout settings. Independent subagents authored and ran the contention and recovery/fence tests;
the implementation owner reviewed them and ran the combined affected-surface suite.

Primary source checked during review: Node 20.19.2
[process.kill documentation](https://nodejs.org/download/release/v20.19.2/docs/api/process.html#processkillpid-signal),
retrieved September 5, 2026; installed `proper-lockfile` 4.1.2 acquisition/update source. Validation results and any blocked
exact-host checks are recorded in the ticket handoff; no wall-clock speedup is claimed.
