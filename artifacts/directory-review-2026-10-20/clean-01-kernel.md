# Clean-code review 01: execution kernel

Review mode: full-surface review, bounded to the execution-kernel slice. Review only; no production or test files changed.

## Assessment

**Quality estimate: 88/100, moderate confidence (approximately +/- 6 points).** The staged turn engine, captured request boundary, explicit terminal statuses, durable effect fence, scheduler result taxonomy, and lifecycle reducer form a coherent implementation. The selected regression suite is materially stronger than happy-path coverage. I found no confirmed Critical/High defect or must-fix blocker in this slice.

This is a code-quality estimate, not a measured defect rate or a Codex convergence percentage. I did not inspect current upstream Codex source in this slice; the separate convergence reviewers own that comparison. No conclusion about 90% behavioral convergence follows from this score.

## Findings

### 1. Low / should-fix: successful terminal events always report zero retries

- Locations: `src/core/task/Task.ts:14598` and `src/core/task/Task.ts:14665`; event contract `src/core/agent/AgentTurnEvents.ts:128` and `:134`.
- Trigger: a provider request fails, an admitted retry succeeds, and the turn/task then completes or is aborted.
- Evidence: both `turn_completed` and `task_completed` are constructed with a literal `retryCount: 0`. Actual retry admission is active at `Task.ts:6415`, `:16868`, and `:18012`, and request events identify retries at `:19695`. Thus the terminal summary disagrees with the same run's attempt trajectory by construction.
- Impact: raw terminal summaries are misleading during operational diagnosis and comparisons of retry amplification. Retry execution itself is bounded and functional. Current `packages/evals/src/benchmark/problemSolvingDiagnosis.ts:404` counts individual retry events independently, so I found no evidence that this particular field corrupts the current benchmark diagnosis score.
- Smallest remedy: count admitted retries in the existing run/turn owner, reset at the appropriate turn boundary, and populate both terminal fields consistently; alternatively retire the unused summary field deliberately rather than storing a false value.
- Tests: `stageThreeCompletion.integration.spec.ts:1209`/`:1212` assert terminal tool-call counts but do not assert a retried turn's terminal retry count. Existing engine/retry-policy tests exercise retry admission, not the Task terminal summary contract. Add a deterministic provider-fails-once-then-succeeds integration case and assert the per-turn and per-task count semantics.
- Verification: direct active-path source trace; no custom reproduction test or behavior change was added during this review.

### 2. Low / advisory: a complete legacy sequencer survives without a production caller

- Locations: `src/core/agent/AgentTurnEngine.ts:91`, `:208`, and `:235`; active staged caller `src/core/task/Task.ts:14536`.
- Trigger: maintaining completion, cancellation, provider-outcome precedence, or completion-admission behavior requires keeping `runLegacy` and `runStaged` consistent even though production uses only the staged adapter.
- Evidence: a runtime-only repository search for `new AgentTurnEngine` / `AgentTurnHost<` across `src`, `packages`, and `apps`, excluding tests, found only the staged Task construction and the legacy type/internal implementation itself. The legacy branch is exercised by tests, including the dual-adapter matrix in `AgentTurnEngine.fault-contract.spec.ts:32`; tests alone do not establish an active runtime consumer.
- Impact: redundant lifecycle decision code enlarges the maintenance and review surface. This is **not** evidence of two active extension task engines or an observed user-facing regression.
- Smallest remedy: verify external/internal extension API compatibility, migrate any remaining test fixtures to the staged host, and remove the legacy adapter/loop if no supported caller needs it. Keep the active staged contract and fault/release coverage intact.
- Tests: `AgentTurnEngine.spec.ts` contains both legacy and staged fixtures; `AgentTurnEngine.fault-contract.spec.ts` deliberately runs both. These are useful behavioral tests, but the legacy half now appears to preserve test-only product code.

## Ownership and active-path map

- `Task.initiateTaskLoop` constructs the sole production `AgentTurnEngine` and adapts sample/commit/effects/continuation/recovery/completion admission/release at `Task.ts:14024` through `:14536`.
- `AgentTurnEngine` owns sequencing and terminal outcome selection; host failure/cancellation/incomplete/exhausted/awaiting-user boundaries are explicit. The staged path joins cleanup before returning completion and supports host-admitted recovery only after the failed transaction drains.
- `Task.captureAgentStep` (`Task.ts:6043`) builds `AgentStepContextBuilder` snapshots and retains raw request data inside process-local closures. The separate raw capture at `:6165` prevents recursive diagnostic redaction from corrupting legitimate arguments or opaque provider state. Retries reuse the captured boundary; committed-history recovery derives an explicit child boundary.
- `ToolScheduler` is constructed by `Task.executeCanonicalToolCalls` at `Task.ts:4725`. Captured `TaskToolSurface` registry/policy controls executable availability; `beforeEffect` and durable effect-start receipts fence dispatch. Scheduler approvals, isolated read windows, serial mutation fences, cancelled/error/denied/success receipts, deferred commits, and command cleanup have explicit owners.
- `AgentLifecycleJournal` validates/redacts events, serializes appends, obtains the durable head under the events lock, rejects conflicting identities/sequences, and delegates transition validity to `lifecycle/reducer.ts`.
- The canonical reducer enforces accepted-call/result pairing, unique terminal receipts, effect-start ordering, terminal transition rules, and replay identities. Diagnostic `AgentTurnEventLog` is separate from the authoritative lifecycle journal; do not mistake diagnostic log failures for loss of authoritative lifecycle enforcement.

## Coverage and validation

Read/reviewed: root AGENTS.md; clean-code-review skill and its JavaScript, testing, rubric, and end-state references; `AgentTurnEngine`, `AgentStepContextBuilder`, `AgentStepRuntime`, `StepContext`, `AgentRetryPolicy`, `ToolPolicy`, main `ToolScheduler` admission/execution/commit/cleanup paths, `AgentTurnEventLog`, lifecycle journal and core reducer transitions; related Task request capture, scheduler wiring, staged-host adapter, terminal publication, and recovery paths; selected nearest tests.

Commands actually run, both with `--maxWorkers=1`:

1. `pnpm --dir src test core/agent/__tests__/AgentTurnEngine.spec.ts core/agent/__tests__/AgentTurnEngine.fault-contract.spec.ts core/agent/__tests__/AgentTurnEngine.stream-recovery.spec.ts core/agent/__tests__/AgentStepContextBuilder.spec.ts core/agent/__tests__/AgentRetryPolicy.spec.ts --maxWorkers=1`
    - **PASS: 5 files, 105 tests**, Vitest 4.1.11, reported duration 9.25 seconds.
2. `pnpm --dir src test core/agent/__tests__/ToolScheduler.deferredResults.spec.ts core/agent/__tests__/ToolScheduler.command-batching.spec.ts core/agent/__tests__/ToolScheduler.lifecycle-hooks.spec.ts core/agent/__tests__/ToolScheduler.policy-denial-status.spec.ts core/agent/lifecycle/__tests__/AgentLifecycleJournal.spec.ts core/agent/__tests__/AgentTurnEventLog.spec.ts --maxWorkers=1`
    - **PASS: 6 files, 89 tests**, reported duration 25.30 seconds.

Total selected verification: **11 files / 194 tests passed**. These checks substantiate selected contracts and do not establish full extension-host behavior.

Not run: typecheck, full unit suite, exact VS Code 1.138.0 smoke, minimum-host compatibility, live providers, and performance benchmarks. This review made no runtime changes. No speed improvement or cross-host compatibility claim is made.

## Blind spots and closure ledger

- Fixed now: none; review artifacts only.
- Flagged for follow-up: truthful terminal retry summaries; confirm/remove the test-only legacy sequencer.
- Not verified: every Task lifecycle/cancellation interleaving, every scheduler descriptor implementation, every persistence fault across operating systems, full lifecycle-journal locking implementation, provider adapter behavior, memory/latency baselines, live extension-host behavior, upstream convergence.
- Out of scope: managed-agent orchestration internals, goals internals, filesystem security implementation, provider-specific streams, UI state projection, extension activation, packaging, and CLI sandbox architecture.
- Existing user modifications were preserved, including the modified Task compaction test and provider/webview/E2E files visible at review start.

Highest-leverage next pass: retain these staged transaction tests while shrinking test-only compatibility code and moving additional Task adapter responsibilities only when an invariant has a clear existing kernel owner. A broad mechanical Task split is not justified by this review.
