# Stage 3: change-scoped verification and outcome-aware progress

## Scope and intended end state

This is a bounded **contract alignment** pass for
[NOR-25](https://linear.app/norval/issue/NOR-25/add-change-scoped-verification-and-outcome-aware-progress-detection).
The prior stage plan puts verification/progress in Stage 3 and incremental transcript persistence (NOR-29) in Stage 4.
This pass is intended to close NOR-25, not certify the entire harness or claim general live-model performance gains.

The integration branch is `codex/stage-three-core-harness`, based on completed Stage 2 commit
`1a8e38dfb971e5b5c1b693921d7d2c47a75aad93`. The existing user-authored `AGENTS.md` edit is preserved and excluded from
our commits. CLI/shim changes, dependency/lockfile upgrades, release/version changes, publishing, installation, and
unrelated cleanup are out of scope.

Success means applicable primary-agent edits cannot be presented as verified completion without current, relevant,
successful evidence; ordinary answers/reviews/plans still complete; and bounded outcome-aware recovery interrupts
demonstrably stagnant sequences without penalizing productive exploration or legitimate polling.

## Ownership and model policy

The user requested one new app task. It is `01a06c8f-c46b-74e3-96ff-e2fadb767194`, with Sol Max as planner/decider,
in its own worktree on `codex/nor-25-verification-progress`. It confirmed the exact Stage 2 baseline before editing.
Routine bounded implementation and test helpers may use Luna Max; hard or uncertain work and reviews use Sol Max.
The default when uncertain is Sol Max.

- Owner task: verification ledger/schema changes, command/mutation evidence, progress detection, localized Task wiring,
  focused tests, and `docs/nor-25-implementation.md`.
- Orchestrator: this plan, independent safety audit and integration regressions, commit integration, combined validation,
  and final Linear closure. Shared production fixes require coordination with the owner.
- Independent Sol Max auditor: read-only examination of evidence freshness, completion races, cancellation, retry,
  persistence/reload, compaction, and compatibility. Root-owned regression files are agreed after the interfaces settle.

## Existing owning boundaries

Source was rechecked at the Stage 2 baseline, not assumed from the ticket's older Alpha links:

- `AgentControlStore` and `ParentVerification` own the existing durable Worker verification-obligation ledger and
  completion decision. Extend this model instead of creating another authoritative completion engine.
- `Task.beginCommandExecution` / `completeCommandExecution` collect command evidence. Actual terminal completion,
  working directory, explicit coverage, and the relevant change/content version must agree before evidence satisfies
  an obligation. Category regexes and a successful tool invocation are insufficient proof.
- `Task` routes both visible-text and explicit-tool completion through the existing durable gate. Preserve descendant
  activity/result-consumption and Worker Apply safeguards, including the final exactly-once transition.
- `AgentTurnEngine` owns sequencing and explicit terminal outcomes. `ToolScheduler` owns effects and ordered terminal
  results; `ToolRepetitionDetector` currently checks only consecutive call arguments.
- Shared persisted schemas live in `packages/types`. New readers must remain compatible with existing saved records;
  missing legacy evidence must not be fabricated as fresh evidence.

## Implementation and integration contracts

1. Define mutation applicability from task/repository requirements, with a narrow explicit contract. No applicable
   mutation obligation means ordinary answers, reviews, and plans remain eligible for completion.
2. Bind obligations and successful checks to the relevant change set/content version, real execution identity,
   terminal status, working directory, and covered scope. Reject pre-change, wrong-scope, failed, cancelled,
   still-running, or stale evidence. `attempt_completion` itself is not verification.
3. Invalidate evidence after relevant edits, including edits during a check and external changes visible at the
   verification/completion boundary. Address async completion and persistence races without weakening mutation gates.
4. Preserve obligations/evidence through safe compaction and reload. Rewind or history replacement must not resurrect
   invalid evidence. Retry/replay must neither duplicate effects nor incorrectly reuse an execution identity.
5. Reuse explicit incomplete/awaiting-user/blocked lifecycle outcomes for unavailable validation. Report missing evidence
   and permit a bounded strategy change; do not fabricate success, require tool calls indefinitely, or hide the reason.
6. Observe a bounded window of semantic outcomes and state deltas. Catch repeated failed checks and alternating equivalent
   no-progress calls. Different-file exploration, new evidence, valid polling, and unchanged external state alone must
   not be treated as a failure to solve the task.
7. Preserve Stage 1/2 captured policy/catalog/provider state, approval revocation, bounded selective reads, exact recent
   history retention, separate environment refresh records, durable per-effect fences, and truthful ordered results.

## Baseline and validation strategy

On 2026-09-04, before Stage 3 edits, the initial root baseline passed **seven files / 136 tests** in 11.09 seconds:

```sh
pnpm --dir src exec vitest run core/agent/__tests__/AgentTurnEngine.spec.ts core/agent/__tests__/AgentControlStore.spec.ts core/agent/__tests__/AgentControlStore.nested.spec.ts core/agent/__tests__/ToolScheduler.spec.ts core/tools/__tests__/ToolRepetitionDetector.spec.ts core/task/__tests__/Task.external-mutation-runtime.spec.ts core/task/__tests__/Task.external-mutation.spec.ts --maxWorkers=2
```

This is correctness coverage, not a performance baseline. The owner records matched deterministic stagnation workloads,
thresholds, executed tools/model rounds, outcome, and before/after results in its implementation record. Successful
polling and productive exploration are controls; synthetic gains are not general live-model quality measurements.

Required completion checks:

- Focused red/green regressions at owning layers and production-shaped integration tests for text/tool completion,
  successful/stale/invalid evidence, missing validation, lifecycle races, and compaction/reload.
- Affected package tests/lint/typechecks, including shared schema readers and extension/webview consumers if changed.
- Combined core/task/tool/context/persistence/provider regressions, plus affected UI projection coverage.
- Repository lint/typecheck for cross-cutting changes.
- Exact VS Code 1.122.1 gate: `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`.
- Managed-agent gates: `pnpm certify:managed-agents:automated` when the existing verification/lifecycle contract changes.
- Final diff inspection, explicit audit exclusions and residual risks, no unrelated or user-authored files in commits.

The orchestrator runs host gates sequentially to avoid competing extension-host test instances.

## Closure ledger

- Fixed now: implementation in progress; no Stage 3 completion claim yet.
- Flagged for follow-up: NOR-29 remains Stage 4.
- Not verified: final Stage 3 behavior, combined post-change gates, live-model quality/speed, and the eight broader
  manual/live managed-agent certification scenarios already distinguished from Stage 2 automated coverage.
- Out of scope: CLI/shim, releases/publishing/installation, dependency upgrades, and unrelated architecture cleanup.
