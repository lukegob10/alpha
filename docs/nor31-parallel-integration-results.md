# NOR-31 parallel integration results

September 5, 2026. Six GPT-6 Astra extra-high tasks, each using GPT-6 Astra high subagents, worked from the user-selected
clean `codex/release-v2.1.23` baseline, `530d737ec07ba6c4feac0f6745960de224496944`. Reviewed changes are integrated locally
on `codex/nor31-integration-20260905`. The original dirty checkout was not edited. Nothing was pushed, merged to the release
branch, packaged for release, or published by the orchestrator.

## Delivered changes

| Ticket                                           | Owning correction and result                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [NOR-32](https://linear.app/norval/issue/NOR-32) | Stable workspace observation across repository/backend transitions, with conservative identity/content fences. Git initialization no longer creates false unknown mutation debt.                                                                                                              |
| [NOR-33](https://linear.app/norval/issue/NOR-33) | Supported Python launcher and pytest scope semantics are separate from execution policy. Execution-bound collection/outcome receipts permit justified evidence credit; unsupported, stale, failed, or unrelated evidence remains unverified.                                                  |
| [NOR-34](https://linear.app/norval/issue/NOR-34) | Bounded cancellable transaction admission, owner fencing/recovery, release notifications with fallback, complete stream closure, bounded Windows replacement/release cleanup, and redacted phase diagnostics.                                                                                 |
| [NOR-35](https://linear.app/norval/issue/NOR-35) | Control-state JSON uses a validated 65,536-character serialization threshold. Other callers retain 512. The fixed paired performance workload passed the predeclared acceptance criteria.                                                                                                     |
| [NOR-36](https://linear.app/norval/issue/NOR-36) | Representative scripted quality/cost fixtures, real-Task measurements, and removal of unnecessary whole-file indentation analysis for scoped reads. Broad model-driven exploration and token-reduction targets remain open.                                                                   |
| [NOR-37](https://linear.app/norval/issue/NOR-37) | Completion retains its candidate while owned runtime work settles, bounds actual unsuccessful repair attempts, and preserves durable completed roots. Lifecycle prerequisite waits share the configured admission budget and permit caller cancellation without cancelling the shared writer. |

Implementation details and residual behavior are in [repository transitions](command-repository-transitions.md),
[Python verification](nor-33-python-verification.md), [transaction contention](agent-control-transaction-contention.md),
[bookkeeping performance](agent-control-bookkeeping-performance.md), [proportional context](nor-36-proportional-context.md),
and [completion settlement](nor37-completion-settlement.md).

## Validation

The final production changes passed root `pnpm lint` (12/12 packages), root `pnpm check-types` (13/13), and 30 focused
integration tests covering lifecycle admission, buffering, and release cleanup/diagnostics. Earlier combined runs included
453 evidence/completion tests and the lane-specific regression suites; these overlapping totals are not added together.

An existing nested-delegation test double initially lacked the new completion methods. The test-only correction retained
its original lifecycle/event assertions and passed its focused test, formatting, and ESLint checks. No production bypass
was introduced.

On clean commit `6b4802a966de4bb59bd26a06a0c3f2349846e890`:

- `pnpm certify:managed-agents:automated` passed all 1,808 deterministic tests, all 26 deterministic rows, and the real
  VS Code 1.122.1 nested Apply/discard/verification/navigation acceptance test. Source identity stayed stable throughout
  certification (`cb3bdb19288bbf9bd3964e902d6ed251c72c3f6b87c93057bdf81835df984fe3`).
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` passed extension 2/2, modes 2/2, and VS Code LM 4/4, including
  cancellation/error recovery. The built extension SHA-256 was
  `c1b6032c90f7b61c9db8341b16ee56ac351074dc3e1d2d82f08065053d1e747f`.
- The certification matrix still lists eight live-provider, restart, multi-window, or live-UI integration rows beyond its
  automated evidence. Automated success does not mark those rows proven.

The earlier real-Task candidate at `a64816cb917fb32b0ca8baa9834e2f96a1332e1a` passed two completion scenarios with three
fresh tasks each. Every sample had one model request, zero recovery requests, one completion event, and a durable
completed root. Two context scenarios also passed three samples each: conversation used one request/no tools; known-file
lookup used two requests/one actual read. Reports retain fixture/policy/build identities and mark provider usage unavailable:
[completion](benchmarks/nor-36-completion-candidate-2026-09-05.json) and
[context](benchmarks/nor-36-context-candidate-2026-09-05.json). The release reference failed durable completion quality;
it is not an equal-quality speed or token baseline.

## Paired persistence measurement

The accepted original-buffer baseline was `55e18388a043b5976cfe65ea8e654ee04c1198c7`; the buffered candidate was
`5336b936b90bcf28f6861676cd6879d265a4cdaa`. Both used the same four cases, Node 20.19.2, pnpm 10.8.1, fixture, harness,
cache procedure, and host in separate coordinated quiet windows. There were 60 measured reserve/settle cycles per writer
after five warmups. The large fixture retained 5,000 completed children across four projects, approximately 25.65 MiB.
The benchmark used the isolated NOR-35 branch; integration also includes the other task/lifecycle fixes. This measures
the shared persistence path, not complete agent-task performance.

| Metric                                   |     Baseline |  Candidate |                     Change |
| ---------------------------------------- | -----------: | ---------: | -------------------------: |
| Large, one writer: transaction-body p95  | 1,092.983 ms | 683.483 ms |               37.47% lower |
| Large, two writers: transaction-body p95 | 1,125.929 ms | 704.488 ms |               37.43% lower |
| Large, one writer: full lock-hold p95    | 1,092.992 ms | 683.499 ms |                      Lower |
| Large, two writers: full lock-hold p95   | 1,125.942 ms | 704.501 ms |                      Lower |
| Small, one writer: complete cycle p95    |    31.145 ms |  26.717 ms |               14.22% lower |
| Small, two writers: complete cycle p95   |    53.614 ms |  55.868 ms | 4.20% higher; guard passed |

Both revisions completed all 360 measured cycles, 720 transactions, and 720 writes with no command, transaction, or
release failures, exact final state, and successful worker cleanup. The unchanged comparator accepted the raw evidence
and both >=25% large-state targets. The small-state guard rejects an increase only when it exceeds both 10% and 2 ms;
the two-writer increase of 4.20% and 2.254 ms therefore passes.

Raw evidence: [baseline](benchmarks/nor35-baseline-wakeup.json), [candidate](benchmarks/nor35-candidate-buffered.json),
and [comparison](benchmarks/nor35-buffered-comparison.json). Prior failed and contaminated reports remain separately
preserved and excluded from acceptance. Integration Git blobs match the recorded raw SHA-256 values exactly. This
checkout's `core.autocrlf=true` translates JSON line endings in working files; that changes their byte hashes, not the
committed raw evidence or parsed measurements.

These measurements establish a local workload result, not universal task speed or responsiveness. Event-loop results
were mixed: large single-writer p95 increased from 10.32 to 11.98 ms; two-writer p95 decreased, while its median increased.
The serialization threshold is in characters and permits primitive overshoot; it is not a hard byte/memory ceiling.

## Remaining limits

NOR-36's proposed broad 25% tool/command and 20% input-token reductions are not established. Scripted decisions do not
prove improved model strategy, and no new exploration cap, prompt tuning, or evidence cache was added without supporting
measurement. NOR-36 and the parent run remain open for that evidence.

The exact remote Python invocation/test outcome and original remote lock owner remain unknown. Controlled reproductions
establish the corrected defect classes; they do not prove the holder or OS handle responsible for each historical error.
Historical unknown mutation debt is preserved when current evidence cannot justify repair. Ambiguous ownership and
unsupported verification still produce explicit outcomes. Protected CLI/shim trees, release versions, and unrelated
checkout changes remain outside this integration.
