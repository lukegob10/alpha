# Stage 2: parallel reads and recent-context compaction

## Scope and baseline

This is a bounded performance-optimization pass for two Alpha Code extension tickets:

- [NOR-26: Audited, bounded parallel reads](https://linear.app/norval/issue/NOR-26)
- [NOR-24: Preserve recent working context during safe compaction](https://linear.app/norval/issue/NOR-24)

The integration branch is `codex/stage-two-core-harness`, based on completed Stage 1 commit
`678baf4440c9cad4a5f40aa6142ad12b98ca0b17`. The user-authored working-tree change to `AGENTS.md` is not part of
this implementation and must remain untouched. NOR-25 verification/progress and NOR-29 incremental persistence remain
later stages. CLI, VS Code shim, release/version changes, dependency upgrades, publishing, and unrelated refactors are out
of scope.

Success means these two ticket contracts work together with reproducible fixture evidence and regression coverage;
it does not mean the entire harness is optimized or that live-model quality has been measured.

## Parallel ownership and decision policy

Two separate app tasks/worktrees use Sol Max for planning, decisions, and difficult implementation. Bounded routine
implementation/test subtasks may use Luna Max; difficult or ambiguous work and independent reviews use Sol Max.
The orchestrator owns cross-ticket integration, combined validation, and final Linear closure.

| Workstream   | Primary ownership                                                                   | Shared integration boundary                                                              |
| ------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| NOR-26       | `ToolScheduler`, `ToolRegistry`, `TaskToolSurface`, audited read handlers and tests | Minimal `Task.ts` scheduler dispatch changes; captured policy and persistence fence      |
| NOR-24       | Condensation, context management, history projection/recovery and tests             | Minimal `Task.ts` compaction/recovery changes; environment reset and provider continuity |
| Orchestrator | This record, independent boundary audit, integration regressions and validation     | Effect completion before compaction; retained discovery evidence; retry/reload behavior  |

Worktree setup must be checked against the exact baseline before editing: a task created from the project's default
branch is not assumed to include Stage 1. Owners send an early plan and commit-based final handoff. Shared file edits
are coordinated by function and reviewed together before integration.

## Implementation contracts

### NOR-26

1. Audit real read handlers, including approval, ignored/protected paths, scope overlap, shared task/UI state, terminal
   interaction, error propagation, and cancellation. Read-only filesystem access alone does not establish independence.
2. Derive eligibility from the captured tool surface and effective policy, not a metadata relabel that bypasses approval.
   Unknown or overlapping scopes and interactive paths use the conservative serial lane.
3. Enable the existing selective-parallel scheduler with a bounded concurrency/queue policy. Keep mutations, terminal
   operations, approvals, and lifecycle barriers serialized/isolated.
4. Preserve the per-call durable before-effect check and exactly one structured terminal result per accepted call in
   model-call order. Drain or safely contain cancelled workers before later lifecycle operations.
5. Record a matched serial/parallel fixture: equal work, elapsed time, peak concurrency, cancellation behavior, result
   equality, and unchanged model-round-trip count. Do not generalize fixture timing to all tasks.

### NOR-24

1. Select a token-budgeted recent tail at complete logical-step/tool-transaction boundaries; summarize the older prefix
   while retaining the selected tail verbatim. Keep original stored history available for recovery/rewind.
2. Preserve instructions/provenance, pending constraints, result status, call IDs, canonical order, and provider-required
   opaque/reasoning state. Never condense while effects are in flight.
3. Define a deterministic bounded fallback for an oversized indivisible tail. Do not hide budget failure or continually
   retry an unchanged oversized request.
4. Apply the same contract to automatic/manual/repeated compaction, truncation fallback, reload, rewind, and cancellation.
   Preserve Stage 1's full environment baseline after a successful persisted compaction.
5. Compare matched fixtures for active tokens, exact evidence retention, repeated reads, and model/tool round trips.
   A scripted information-loss fixture demonstrates that fixture, not general model solve-rate gains.

## Shared risks to verify

- A cancelled parallel batch must settle complete terminal receipts before compaction or a new step can reuse task state.
- Manual compaction must not race an active scheduler; automatic compaction runs only at a safe step boundary.
- Retained history and discovery transactions must not widen executable permissions; catalog state stays bounded and
  reflects persisted evidence under the next captured policy.
- Compaction must retain or refresh the environment baseline, never leave deltas without their base.
- Provider retry captures and raw wire inputs remain separate from sanitized diagnostics; compaction creates an explicit
  new context boundary, not an in-place change to a retained transport attempt.
- Recovery and rewind must understand new retention metadata while continuing to read older saved histories.

## Baseline and validation plan

Baseline at `678baf4` on 2026-09-04:

```sh
pnpm --dir src exec vitest run core/condense/__tests__ core/context-management/__tests__ core/agent/__tests__/ToolScheduler.spec.ts core/agent/__tests__/AgentTurnEngine.spec.ts core/tools/__tests__/TaskToolSurface.spec.ts --maxWorkers=3
```

Result: **11 files, 234 tests passed**, 8.45 seconds. This establishes correctness coverage, not a performance baseline.
Each owner records its workload-specific performance baseline and final measurements separately.

Before closure:

- Owner-focused regression suites and production-shaped integration tests, including denied approval, timeout,
  cancellation, handler/fence failure, history reload/rewind, and retained provider-state cases.
- Affected package lint/typechecks; broaden to repository-wide checks for cross-package changes.
- Combined task/agent/tool/context/persistence/provider suites and any affected webview projection coverage.
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` on the exact supported host.
- `pnpm certify:managed-agents:automated` if managed-agent lifecycle contracts change.
- Final scope/diff inspection, no accidental lockfile/generated output or user `AGENTS.md` changes in commits.

## Closure ledger

- Fixed now: none yet; implementation in progress.
- Flagged for follow-up: NOR-25 and NOR-29 remain outside Stage 2.
- Not verified: implementation behavior, post-change measurements, combined gates, and live-model quality.
- Out of scope: CLI/shim changes, release/publish operations, broad frontend cleanup, and unrelated architecture changes.
