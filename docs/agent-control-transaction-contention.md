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
as cancelled. An attached signal can stop an uncommitted Windows replacement retry before another rename attempt.
Task-lifetime cancellation is forwarded through primary mutation reservation and root admission. Receipt settlement
after process execution remains durable and independent of acquisition cancellation.

`FileAgentControlPersistence` optionally accepts `transactionWaitTimeoutMs`, `maxPendingTransactions`, and
`onTransactionDiagnostic`. One final callback reports `operation`, `outcome`, `queueWaitMs`, `acquisitionWaitMs`, `holdMs`,
`releaseMs`, `attempts`, `ownerState`, optional `ownerPid`/`ownerOperation`, `committed`, and `releaseFailed`. Acquisition
errors carry the same snapshot. Slow acquisition, failure, and release failure log this closed shape. Callback exceptions
cannot change transaction outcomes. Timings distinguish actual body work from waiting and cleanup; they are not a model
or command-process performance measurement. NOR-35 consumes this seam for transaction-body measurements.

Lock metadata reads are capped at 1024 bytes, tokens at 128 safe filename characters, and PIDs at the positive signed
32-bit range. Operation names are allowlisted. Diagnostics exclude storage paths, tokens, task IDs, command text,
prompts, and file contents. `ELOCKED` means bounded healthy/ambiguous contention; `EQUEUEFULL` means backpressure;
`ABORT_ERR` means cancelled admission or uncommitted replacement retry; `ELOCKLEGACY`/`ELOCKOWNER` identify unverified
ownership with repair instructions.

The persistence seam exposes its configured queue deadline and capacity to the outer store queue. Rejections before
that queue admits its callback use the same diagnostic observer and error snapshot; admitted callbacks leave reporting
to persistence, so failures are not counted twice. Queue time already spent reduces the remaining acquisition budget.
Shutdown blocks new submissions and drains admitted work before releasing the runtime lease, independently of admission
deadlines. A 75 ms controlled reservation test covers deadline, cancellation, saturation, and shutdown behavior.

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
`externalTransaction` path requires atomic replacement and a per-attempt synchronous commit fence, avoiding the nested
mtime-expiring advisory lease only for externally fenced writes. The callback may await retry delays, but each ownership
fence and rename must be synchronous with respect to one another. Ordinary JSON callers retain their existing lock.

Ownerless and malformed locks are never removed automatically based on age. Close **all** Alpha extension hosts sharing
the affected global storage, confirm no owner can resume, remove only `agent_control.json.transaction.lock`, and reopen
Alpha. Preserve `agent_control.json` and all recovery tombstones. Restart all participating hosts when upgrading the
recovery protocol: an older binary still running the two-destination reaper cannot be made safe by a newer contender.

## Release notifications under sustained contention

NOR-35's original-buffer acceptance workload at `4d5ca37a83036faff20f0030e7a2537c4e47f7db` exposed three 30-second
acquisition failures among 238 transactions with 5,000 retained children and two writer processes. Successful holds were
at most 1,196 ms; only six transactions observed contention. This supports repeated acquisition by one healthy process
while another slept through brief release windows, rather than a single 30-second holder. The failed report remains
failure evidence in NOR-35's `docs/benchmarks/nor35-baseline-failed-acquisition.json`; no comparison uses it as a successful
baseline.

Fixed polling can miss every opportunity: after attempts at 0, 50, 150, 350 and 750 ms, a 400 ms interval never samples
one-millisecond release windows at each whole second. The former implementation also slept when its ownership probe
already observed that the canonical lock had disappeared. Two controlled regressions fail against the former source
with polling timers frozen: neither a release event nor a known absent lock admits the waiting transaction.

After the first failed `mkdir`, acquisition now creates one nonpersistent watcher on the lock's stable parent directory
and immediately retries. Canonical lock-name events, or events with an unavailable filename, shorten the polling wait;
notifications received during ownership probes are coalesced. Events are only retry hints: atomic `mkdir`, ownership
publication, commit fences, recovery rules, cancellation, and the absolute acquisition budget remain authoritative.
A known absent lock gets an immediate retry; consecutive absent-lock races enter a bounded, interruptible polling wait.
Uncontended transactions create no watcher. Watch errors, early closure, unsupported filesystems, and missing events
retain timer polling, and every acquisition exit closes its watcher and clears its pending timer and abort listener.

This corrects missed release notifications without adding persisted waiter tickets or claiming cross-process FIFO or
starvation freedom. Deterministic regressions and actual process contention coverage accompany the change; NOR-35 must
rerun its complete acceptance matrix before freezing a replacement baseline. Primary source retrieved September 5, 2026:
Node 20.19.2 [filesystem watcher contract and platform caveats](https://nodejs.org/download/release/v20.19.2/docs/api/fs.html#fswatchfilename-options-listener).

## JSON stream completion

An exploratory NOR-35 two-process reserve/settle workload reported a Windows `EPERM` during atomic JSON replacement,
with `committed: false`. Investigation exposed a separate deterministic lifecycle defect: the JSON writer resolved on
`finish` while its file descriptor could still be closing. A regression holding the real `fs.close` callback behind a
barrier reproduced the premature commit. The writer now awaits `stream/promises.pipeline` and explicitly joins the owned
destination's `close` event in `finally`. Combined validation exposed that a source serialization error can reject the
pipeline before destination destruction finishes; a second close-barrier regression prevents cleanup from racing that
descriptor on rejection. Serializer construction also precedes opening the destination because a root `toJSON` method
can throw synchronously. Error regressions cover serializer construction, streaming serialization, filesystem write, and
close failures; each preserves the prior target and prevents commit.

This closes a verified lifecycle gap; it does not establish the cause of the exploratory `EPERM`. Node 20.19.2's Windows
libuv opens ordinary files with delete sharing, so an outstanding Node file handle alone does not prove that rename must
fail. The recurrence and bounded replacement handling below are separate from stream closure. The exploratory workload
must be rerun before NOR-35 freezes its baseline; a successful rerun alone is not proof that an intermittent OS error is
resolved.

Primary sources retrieved September 5, 2026: Node 20.19.2
[pipeline completion contract](https://nodejs.org/download/release/v20.19.2/docs/api/stream.html#streampipelinesource-transforms-destination-callback),
[file stream close defaults](https://nodejs.org/download/release/v20.19.2/docs/api/fs.html#fscreatewritestreampath-options),
the [pipeline error path](https://raw.githubusercontent.com/nodejs/node/v20.19.2/lib/internal/streams/pipeline.js), and
[Windows libuv file operations](https://raw.githubusercontent.com/nodejs/node/v20.19.2/deps/uv/src/win/fs.c).
The synchronous serializer construction behavior was checked against installed `json-stream-stringify` 3.1.6 source.

## Windows replacement interference

The sustained two-process writer test reproduced `EPERM` at integrated commit `69ae789` after both close barriers and the
wakeup correction. A controlled native reproduction opened the destination through .NET with
`FileAccess.Read`/`FileShare.ReadWrite`, deliberately excluding delete sharing. Node 20.19.2 `renameSync` returned
`EPERM`; the closed source and prior destination remained intact. After disposing that external handle, the same rename
succeeded. This establishes matching Windows replacement semantics, not the identity of the original blocking handle.

The file-persistence commit now retries only a failed Windows rename reporting `EACCES`, `EBUSY`, or `EPERM`, with delays
of 10, 25, 50, 100 and 200 ms: six total attempts and at most 385 ms of scheduled backoff. The same closed temporary file
and transaction lock remain owned throughout. Before each attempt, the captured transaction must still be active,
unfinished, and present in the caller's async context; its synchronous owner fence is immediately followed by
`renameSync`. Fence failures never enter the rename retry catch. Cancellation can stop a pending retry before commit.
Success sets `committed` immediately and performs no awaited work before returning. Permanent errors and exhausted
retries retain the actual error and preserve the prior target; there is no target unlink or non-atomic fallback.
The existing diagnostic `attempts` counts acquisition attempts; replacement backoff is included in `holdMs` and is not
reported as a separate retry counter. A successful transaction therefore does not imply that its first OS rename worked.

The generic JSON helper's additive `commitTempFile` return type accepts `void | Promise<void>`. It invokes and awaits
that callback exactly once, retaining the temp file until settlement. The callback owns the per-attempt fence; neither
the serializer, transaction body, nor command is rerun. Regression coverage includes transient success, exact retry
bounds, permanent errors, fence loss, cancellation, unrelated queued writes, and escaped finished transaction contexts.

Primary Windows sources retrieved September 5, 2026:
[CreateFileW sharing rules](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) and
[MoveFileExW replacement behavior](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw).

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
