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

Primary-source comparison was checked on 2026-09-04 against
[Pi agent-loop.ts at `6aedd1066e540642165aa30fa7b4a1b863778aa7`](https://github.com/earendil-works/pi/blob/6aedd1066e540642165aa30fa7b4a1b863778aa7/packages/agent/src/agent-loop.ts).
Its shared loop gathers completed tool results before a turn-level stopping hook and prepares the next turn from an
explicit completed-turn snapshot. This supports keeping progress/stop decisions at the canonical settled-turn boundary;
it is not a verification policy to copy, nor proof that Alpha's primary changes have been tested.

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

### Independent regressions established before integration

- Completion fixture: real Task loop/gate/finalizer, engine, scheduler, completion tool and file-backed ledger. The
  original ten cases reproduced four failures (unbounded text/tool completion claims and obligations arriving during
  final persistence) with six no-debt/guidance/cancellation controls passing. Primary-obligation and running-command
  variants extend this to sixteen cases; baseline has ten expected failures and six passing controls.
- Recovery fixture: real transcript compaction/atomic persistence and file-backed ledger. The no-debt control passes;
  three primary revision/evidence cases require the owner's new API before integration. The fixture retains the exact
  recent complete transaction and verifies archived edit records remain available in saved history.
- Legacy handoff review found a separate completion route after parent staging. Its final child gate and removal must
  share the existing workspace mutation reservation; rejection must restore the staged parent. The child-owned handoff
  awaits abort/persistence but cannot join its own calling loop. External cancellation/replacement keeps the full join.
- Command-result regressions exercise the real scheduler/registry/command tool against controlled terminal callbacks,
  distinguishing process exit, denial, background execution, and late completion after cancellation.

The orchestrator's legacy handoff fix passed **four files / 147 tests, six skipped** in 14.49 seconds:

```sh
pnpm --dir src exec vitest run core/webview/__tests__/stageThreeLegacyHandoff.integration.spec.ts __tests__/history-resume-delegation.spec.ts __tests__/nested-delegation-resume.spec.ts core/webview/__tests__/ClineProvider.spec.ts --maxWorkers=2
```

New handoffs now require the live child; matching already-committed historical retries remain repairable without it.
The self-join exception is limited to primary children with a committing handoff buffer and delegation repair disabled.
Existing background-child fixtures now supply an explicit live child/gate rather than silently accepting a missing child.

### Integrated implementation and independent review

The owner's clean implementation commit `b80f29336ccff32fa36163cda84a100797fb7e18` was cherry-picked as
`39a4366` after the orchestrator's legacy handoff fix `b20d77e`. Its independent affected run passed 530 tests
across 23 files. Supported command/configuration forms, observation bounds, recovery limits, and the matched
before/after stagnation workloads are recorded in [the implementation record](nor-25-implementation.md).

The final integration audit reproduced two further text-only loops using real persisted descendant/mailbox state:
completion was rejected with no file-verification obligations, so the verification-only retry counter never advanced.
Both regressions hit a deterministic twenty-step guard before the correction. The shared completion decision now
bounds every unchanged rejection, including active descendants and unconsumed results, without changing polling rules.
All eighteen independent completion cases pass after the fix. The four compaction/recovery cases and six real
command-outcome cases also pass. Command fixtures use bounded temporary workspaces and actual Task receipt state.

The legacy live-child requirement and narrow self-join exception remain protected by twelve independent regressions.
Ordinary no-debt text completion, terminal outcome truthfulness, cancellation, late exit callbacks, persistence races,
current evidence after reload, and stale evidence after history/content rewind are covered explicitly.

Important limits: arbitrary shell writes to previously unknown ignored files or outside the workspace are not audited.
Explicit file tools cover their named targets, and tracked assume-unchanged/skip-worktree files are observed. Imported,
dynamic, or unsupported verifier configuration (including Alpha's current Vitest configuration) receives no durable
verification credit; the agent must report explicit incomplete/unverified status. There is no automatic repair for an
unresolved write-ahead mutation reservation. These limits are intentional conservative boundaries, not proof of broad
live-model quality or complete filesystem mutation tracking.

The final integration correction is committed as `3afaa13`. Managed host acceptance first exposed a Windows
short/long workspace-path mismatch at command admission, hidden behind an old generic shell-integration error.
Canonical cwd and persisted workspace identity now agree; only the trusted root spelling is normalized, and real
containment still rejects escaping junctions and traversal. Unknown-scope debt survives a removed workspace.
Non-shell-integration admission errors now retain their actual cause and cannot trigger a fallback execution.
Real junction/short-name, primary/Worker evidence, disappearing-root, and command-admission regressions cover these fixes.

The managed host fixture now uses real Vitest assertions over the edited ESM modules, with inert configurations and
separate nested/root verification scopes. Its former arbitrary `node verify.mjs` command is intentionally unsupported
by the evidence resolver. Existing Apply/discard, completion rejection, ownership, terminal, and navigation assertions
are retained. The test uses the installed repository Vitest binary and restores its temporary host PATH change.
The rebuilt host reached successful root completion but exposed a final fixture assertion comparing Windows CRLF
against LF. Commit `df4df9f` makes the module-content assertions line-ending-neutral while retaining exact body checks.

Certification also reproduced one outdated primary-tool assertion: NOR-25 intentionally exposes the optional blocked
completion outcome. The assertion now requires that field, while catalog-stability checks remain intact; all six
focused catalog tests pass. The final bounded clean-code review found no additional must-fix issue.

Combined post-integration validation on 2026-09-04:

- Shared types: 21 files / 272 tests passed.
- Provider/transform: 87 files / 1,575 tests passed, two skipped.
- Webview chat/agent consumers: 44 files / 507 tests passed.
- Root lint: 12 tasks passed; root typecheck: 13 tasks passed on the final production changes. The later catalog-only
  assertion correction also passed extension typecheck. Touched-file Prettier and `git diff --check` passed.
- Broader core: 162 files / 2,354 tests passed, eleven skipped. Four older fixture failures were reproduced and fixed
  by supplying actual Task receipt/detector state or the explicit provider progress seam; original persistence,
  parallel-read, and compaction assertions remain, and compaction now also asserts successful scheduler completion.
- Exact VS Code 1.122.1 smoke: the full command passed all eight checks again after the Windows correction
  (activation/commands, modes, LM transactions, cancellation/recovery).
- Strict managed-agent deterministic certification: all ten tracks / 1,395 tests passed with no skipped/todo tests;
  all 26 automated matrix rows passed. The final source remained stable for the run at commit `df4df9f`, with only
  the preserved user guide and these integration documents dirty.
- The complete `pnpm certify:managed-agents:automated` command exited zero after that deterministic run and a rebuilt
  exact VS Code 1.122.1 managed host acceptance test. The host scenario passed in 22.36 seconds, covering nested Apply,
  discard, actual verification commands, completion rejection/success, projection, and exact-child navigation.
  This does not satisfy the eight separately listed broader manual/live certification scenarios.

Representative combined commands:

```sh
pnpm --dir src exec vitest run core/agent core/task core/task-persistence core/tools core/context-management core/condense core/environment core/webview __tests__/history-resume-delegation.spec.ts __tests__/nested-delegation-resume.spec.ts --maxWorkers=2
pnpm --dir src exec vitest run api/providers api/transform --maxWorkers=2
pnpm --dir packages/types exec vitest run
pnpm --dir webview-ui exec vitest run src/components/chat src/components/agents --maxWorkers=2
pnpm check-types
pnpm lint
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
pnpm certify:managed-agents:automated
```

## Closure ledger

- Fixed now: Stage 3 / NOR-25 is complete on `codex/stage-three-core-harness`: primary verification debt, current scoped
  evidence, bounded progress, completion/handoff races, and Windows workspace identity. Required automated gates pass.
- Flagged for follow-up: NOR-29 remains Stage 4.
- Not verified: live-model quality/speed and the eight broader manual/live managed-agent certification scenarios
  already distinguished from Stage 2 automated coverage.
- Out of scope: CLI/shim, releases/publishing/installation, dependency upgrades, and unrelated architecture cleanup.
