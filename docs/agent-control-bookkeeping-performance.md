# Agent control bookkeeping benchmark (NOR-35)

Reference: Alpha 2.1.23, `530d737ec07ba6c4feac0f6745960de224496944`, inspected September 5, 2026 UTC.

## Predeclared experiment

Before changing production transaction processing, measure the actual `AgentControlStore` and
`FileAgentControlPersistence` against fixed synthetic retained-state fixtures. The primary workload is a primary
mutation reservation followed by its durable settlement, with 5,000 retained completed agents distributed across four
projects, four 512-byte mailbox payloads per agent, and one verification obligation per agent. Run both one independent
writer and two independent processes sharing storage, each owning a different active root. This is a local scaling
experiment, not an estimate of production latency or an explanation of the remote ELOCKED report.

The target is at least 25% lower p95 transaction-body hold time for the large reserve/settle workload, with no material
small-state command latency regression (greater than both 10% and 2 ms at p95). Preserve transaction count and failure
reporting; a faster successful subset with more failures does not meet the target. Use at least 60 measured iterations
per writer after five warmups. Also report 1 and 1,000 retained agents, no-op root updates, local snapshot reads, and owner
recovery scans. Each command reports total transaction and write counts, p50/p95 total/wait/hold/release and internal phase
durations, and event-loop delay. Cold process/setup and warm filesystem-cache measurement are separate; no OS cache
eviction is attempted.

Measurements must record Node/pnpm versions, OS/CPU/memory, commit, fixture sizes, sample counts, cache conditions and
whether the orchestrator granted an uncontended host window. Installs, builds, tests and other benchmark jobs must finish
before collecting a comparative baseline or candidate sample. Repeat baseline and candidate with identical options in the
same window; retain raw per-command samples so aggregates can be audited. No timing assertions belong in CI.

Production transaction work depends on NOR-34's reviewed lock contract. Its acquisition, ownership, cancellation and
release semantics remain authoritative. Any reduction in bookkeeping must retain fresh durable reads under that lock,
runtime/schema validation, owner fencing, rollback isolation, atomic receipts and publication after commit.

### Accepted acceptance matrix revision (before baseline)

On September 5, 2026, the orchestrator accepted four cases for the uncontended acceptance comparison: `reserve-settle`
with 1 and 5,000 retained children, each with one and two independent processes. Each writer still runs five warmup cycles
and 60 measured cycles, yielding 120 transaction observations in each single-process case and 240 in each two-process
case. The 25% large-state p95 body-hold target, small-state regression guard, transaction counts and failure-rate guard
are unchanged. This retains both scaling endpoints and independent-process coverage while fitting the timing window;
intermediate sizes and the additional read/no-op/recovery workloads remain supplemental measurements, clearly labelled
separately from acceptance evidence. The broader default harness matrix remains available.

```sh
pnpm exec tsx src/core/agent/benchmarks/AgentControlStore.benchmark.ts --sizes "1,5000" --writers "1,2" --samples 60 --warmups 5 --commands reserve-settle --output /absolute/path/baseline.json --label baseline --quiet-window "orchestrator-granted window"
```

The baseline must include the reviewed NOR-34 dependency with the original serialization buffer. Record the exact commit
and SHA-256 source identities in the raw report, then compare with a candidate differing only in the intended buffering
change. Frozen identities include the lock wakeup helper, transaction contracts, shared filenames, benchmark runner,
worker harness, comparator, fixture, built shared types, and dependency lockfile. Node built-ins are covered by the
recorded exact Node version. Missing a required source from both reports is rejected. The harness verifies identities
again after measurement so edits during a run cannot silently contaminate its code identity. The estimated baseline
case durations are under 10 seconds (small, one writer), under 20 seconds
(small, two writers), four minutes (large, one writer) and eight minutes (large, two writers); these are scheduling
estimates from exploratory runs, not performance claims. Reserve 15 minutes per revision.

The target uses the transaction **callback body's p95**, reported as `body.p95`, rather than NOR-34's full lock-hold
diagnostic. The 25% reduction must pass separately for both large-state process counts. The small-state guard compares
the total reserve/settle cycle p95 and fails only when the increase exceeds both 10% and 2 ms. Any command, acquisition,
release or cleanup failure invalidates acceptance; zero body times for rejected acquisitions cannot improve its score.
Both revisions include the same reviewed lock wakeups and bounded Windows replacement retries. Replacement retries
retain the closed temporary file and transaction lock, fence every rename attempt, and do not rerun the transaction
body. Their backoff is included in callback-body and full lock-hold measurements. Diagnostic `attempts` counts lock
acquisition attempts only; a successful transaction does not prove there were zero recovered OS replacement failures.

Compare frozen reports with:

```sh
pnpm exec tsx src/core/agent/benchmarks/AgentControlStore.benchmark.ts --compare-baseline /absolute/path/baseline.json --compare-candidate /absolute/path/candidate.json --output /absolute/path/comparison.json
```

The comparator derives nearest-rank p95 from raw per-worker samples. It requires the four expected cases, 60 distinct
iterations per writer, 120/240 transactions and writes, successful diagnostics, matching fixture/runtime/frozen sources,
and finite nonnegative measurements. Summaries are not trusted as evidence. Missing event-loop observations are `null`
(unavailable), not zero delay. Per-worker samples remain in both source reports and the comparison artifact.

## Reproduce

Use Node 20.19.2 and pnpm 10.8.1. Install with `pnpm install --frozen-lockfile` and build the schema package with
`pnpm --filter @alpha-code/types build` before the timing window. From the repository root:

```sh
pnpm exec tsx src/core/agent/benchmarks/AgentControlStore.benchmark.ts --output /absolute/path/baseline.json --label baseline --quiet-window "orchestrator-granted window"
```

The default matrix uses sizes `1,1000,5000`, process counts `1,2`, 60 measured iterations and five warmups. Each iteration
runs `snapshot-read`, `noop-update`, `reserve-settle` and `owner-recovery`. Quote comma-separated CLI values in PowerShell.
Use `--sizes 1 --samples 2 --warmups 1` for a harness smoke check, which is not performance evidence. Raw reports include
every measured command, including failures; failed warmups stop the run. Output is saved after each size/process case.
Independent processes synchronize before initialization and measurement and retain live leases until all siblings finish.
Successful cases compare the complete retained state after reload, allowing only the top-level update timestamp to differ.

`--harness-timeout-ms` defaults to 1,800,000 (30 minutes) per worker group, covering its initialization, warmups, barriers,
measurement and shutdown. This generous harness deadline does not change production transaction timeouts. Deadline,
interruption, spawn, IPC or worker failure terminates every child and awaits process closure before fixture deletion.
Termination escalates after five seconds; if closure cannot be confirmed within ten seconds, the fixture is retained and
cleanup failure is reported with the original failure as its cause. Worker barriers reject lost IPC. Tests use controlled
events/fake timers, and a real two-process deadline smoke check verifies the fixture cleanup path.

Processes synchronize at initialization and the start of measurement, then run independently. Start synchronization does
not imply continuous contention; reported attempts and acquisition waits describe observed contention. Periodic background
recovery is explicitly disabled in this controlled workload; the `owner-recovery` command remains available.

`snapshot-read` measures the local projection copy, without a durable transaction. `noop-update` calls `ensureRoot` for an
existing owned root. `reserve-settle` calls `reservePrimaryMutation` and `releasePrimaryMutation` with a fresh token, so
the full command normally requires two transactions and two writes. `owner-recovery` scans the fixture's live owners and
acknowledged mailbox entries; it measures a no-op recovery scan. Actual abandoned-owner recovery and crash/fence behavior
remain correctness-gate cases, separate from this stable-size timing workload.

Benchmark-only wrappers measure acquisition-to-body wait, transaction body, post-body fence/release, file read including
JSON parse, schema parse, structured clone and full write. JSON parse is a subset of read; do not add it twice. Unattributed
body time includes owner checks, mutation and equality. NOR-34 lock diagnostics additionally separate queue,
acquisition, hold and release, and report attempts, contention, outcome and cleanup failure. No benchmark observer is
installed in normal extension operation.

## Exploratory phase investigation

A September 5 pilot used three measured iterations and one warmup while other tasks were active. Its 5,000-agent fixture
occupied 25,650,417 bytes. It is **not a comparative baseline**. It identified full streamed writes as the largest phase;
snapshot copying alone was too small to plausibly reach the whole-body target. Installed `json-stream-stringify` 3.1.6
documents a fifth constructor argument for its bounded output buffer, defaulting to 512 characters. A deterministic
535,439-byte nested/Unicode serialization check emitted 501 chunks with that default, 28 with 16,384 characters and seven
with 65,536; output bytes matched. Dates, undefined values, sparse arrays and surrogate cases also matched. This motivates
testing bounded buffering before changing transaction state semantics. It does not establish a latency improvement.

## Results

The first approved [failed original-buffer baseline](benchmarks/nor35-baseline-failed-acquisition.json) ran at
`4d5ca37a83036faff20f0030e7a2537c4e47f7db`, including the reviewed NOR-34 stream-close correction, under granted quiet-window
`nor31-baseline-20260905-0509utc`. It is **invalid for acceptance**: the final large two-process case recorded three
acquisition timeouts. The entire report is retained; no samples were retried or discarded and no buffering optimization
has been applied. The quiet window was released when the final case returned its failure status. Workers report samples
at case completion, so failures in that case became visible then.

| Retained children | Processes | Cycles | Transactions | Writes | Failed cycles |
| ----------------- | --------- | ------ | ------------ | ------ | ------------- |
| 1                 | 1         | 60     | 120          | 120    | 0             |
| 1                 | 2         | 120    | 240          | 240    | 0             |
| 5,000             | 1         | 60     | 120          | 120    | 0             |
| 5,000             | 2         | 120    | 238          | 235    | 3             |

In the final case, worker 0's iteration 33 reservation waited 30,009.0 ms over 76 attempts while observing live holder
PID 76548. Worker 1's iteration 0 reservation waited 30,002.5 ms over 75 attempts while observing live holder PID 36376;
its iteration 22 release waited 30,006.9 ms over 76 attempts against that same live process after its reservation had
committed. All three failed diagnostics reported `committed: false` and `releaseFailed: false`. Successful full lock-hold
maxima were 1,117.2 ms for worker 0 and 1,196.2 ms for worker 1, consistent with missed admission opportunities during
repeated peer transactions rather than one measured 30-second hold. This is admission evidence for NOR-34 review, not
permission to increase the wait budget or weaken persistence.

There was no atomic-rename `EPERM` in this run. The comparator rejected the report's errors, incomplete transaction/write
counts and unsuccessful diagnostics before evaluating performance thresholds. The successful large single-process body
p95 was 984.1 ms, but the failed matrix cannot substantiate a before/after improvement. Root-cause disposition and a new
explicit measurement grant are required before another baseline or candidate. The preliminary investigation table is
context only and is not substituted for a valid baseline. The failed report has an explicit failure filename and must not
be overwritten by a later measurement.

### Corrected dependency baseline: rejected release diagnostics

After the reviewed lock wakeup and bounded Windows replacement fixes, the first new window was
[rejected for overlapping orchestrator lint](benchmarks/nor35-contaminated-baseline-20260905055146.md). Its three-case
partial report remains intact and is excluded entirely from acceptance.

The fresh [failed-release baseline](benchmarks/nor35-baseline-failed-release.json) ran at
`e04f34d80f69b98baed002747121151ac87f2846` under separately granted window
`nor31-corrected-baseline-restart-20260905055552`. All four cases collected their full samples: 360 measured cycles,
720 transactions, and 720 writes, with no command errors. The final fixture comparison and worker cleanup succeeded.
However, the 5,000-child, two-writer case had three `releaseFailed: true` diagnostics, each with `outcome: success` and
`committed: true`. The harness exited with code 1 and the comparator rejected the raw diagnostics before calculating
performance thresholds. The complete matrix is invalid for acceptance despite its durable writes succeeding.

| Worker | Iteration | Operation                | Full hold (ms) | Release (ms) |
| ------ | --------- | ------------------------ | -------------- | ------------ |
| 0      | 40        | reserve-primary-mutation | 1,050.51       | 2.75         |
| 1      | 36        | mutation                 | 1,047.25       | 2.65         |
| 1      | 44        | mutation                 | 1,040.89       | 2.85         |

These diagnostics do not contain the underlying release error code or phase, so the timings alone cannot establish a
root cause. The quiet window was released immediately when the runner returned; a Windows process inventory confirmed
that no runner or worker remained. No failed sample was discarded, no command was rerun, and no buffering edit or
candidate run has started. A reviewed dependency correction and fresh explicit grant are required before measuring
again. This report was renamed without changing its contents and must not be overwritten.

### Failed dependency smoke (not acceptance evidence)

The [preserved smoke report](benchmarks/nor35-exploratory-rename-failure.json) ran at
`9b702f7dcfc425f425c18534e8afe3b310e781b9`, including NOR-34's core lock and outer-queue diagnostic changes with the original
serialization buffer. It used one retained child, one and two independent processes, one warmup and two measured
reserve/settle cycles per writer. Other local checks were active. The single-process case passed; the two-process case
recorded one atomic-file replacement `EPERM` during `releasePrimaryMutation`, with `outcome: error`, `committed: false`
and `releaseFailed: false`. The harness exited with failure and did not retry the command.

This report is retained as a correctness failure and cannot satisfy the acceptance matrix. NOR-34 is investigating the
writer's completion/close boundary; the observed OS error alone does not establish that boundary as its cause or prove a
transaction-lock exclusion failure. The later original-buffer run described above includes the reviewed stream-close
correction and encountered acquisition timeouts instead. No candidate measurement has started.
