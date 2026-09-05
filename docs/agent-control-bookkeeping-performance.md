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

`snapshot-read` measures the local projection copy, without a durable transaction. `noop-update` calls `ensureRoot` for an
existing owned root. `reserve-settle` calls `reservePrimaryMutation` and `releasePrimaryMutation` with a fresh token, so
the full command normally requires two transactions and two writes. `owner-recovery` scans the fixture's live owners and
acknowledged mailbox entries; it measures a no-op recovery scan. Actual abandoned-owner recovery and crash/fence behavior
remain correctness-gate cases, separate from this stable-size timing workload.

Benchmark-only wrappers measure acquisition-to-body wait, transaction body, post-body fence/release, file read including
JSON parse, schema parse, structured clone and full write. JSON parse is a subset of read; do not add it twice. Unattributed
body time includes owner checks, mutation and equality. NOR-34 lock diagnostics will additionally separate queue,
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

Pending the fresh implementation-branch baseline and reviewed NOR-34 dependency. The preliminary investigation table is
context only and is not used as the baseline for this experiment.
