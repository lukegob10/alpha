# Harness implementation reliability notes

This note records the bounded reliability audit at the current Alpha revision. It separates observations that have a
deterministic reproducer from observations that remain environmental or integration evidence.

## Ticket progress timeout

The historical source-suite report recorded an unrestricted run timing out in
`src/core/task/__tests__/Task.ticket-progress.spec.ts`, around the selective-parallel deletion case. The same report
also recorded a later focused run and a worker-limited suite passing. Those results do not identify whether the original
timeout came from filesystem contention, worker scheduling, fixture cleanup, or the task implementation.

At the current Node 24.14.1 / pnpm 11.24.0 baseline, the focused file was rerun with two workers:

```text
pnpm --dir src test core/task/__tests__/Task.ticket-progress.spec.ts --reporter=verbose --maxWorkers=2
```

All 7 tests passed. The two history-window cases took about 4.09 s and 3.96 s; the test-reported duration was about
12.52 s and Vitest's total duration was about 23.61 s. The test still uses real temporary profile/workspace files and
20-ticket workloads against an eight-entry repetition history, so it retains useful pressure. No timeout or invariant
failure was reproduced in this focused run. The original unrestricted timeout remains evidence and is intentionally
unresolved; do not treat this green rerun as a root-cause fix. If it recurs, capture worker count, active handles,
profile cleanup, and pending filesystem operations before changing runtime code or weakening the workload.

## Separate 75 ms persistence fixture

`src/core/agent/__tests__/AgentControlStore.queue-diagnostics.spec.ts` uses `maxPendingTransactions: 1`, then uses
barriers and fake timers to exercise transaction admission, cancellation, queue-full diagnostics, and lock errors. The
fixture uses a test-only `QueueDiagnosticsPersistence` subclass. Its inherited timeout starts at the production 30 s
default while initialization and root creation perform real filesystem I/O; the test then changes the subclass field to
75 ms and asserts that value before entering the barrier-driven admission cases. No production timeout or unchecked cast
is involved. This prevents slow Windows setup I/O from being mistaken for the timed admission behavior while preserving
the intended checks. The 75 ms value is not the production default and not the timeout recorded for ticket progress. The
migration investigation that mentions a 75 ms real-filesystem admission failure applies to this queue-diagnostics
fixture; it does not explain the separate ticket-progress timeout.

## Managed-agent UI acceptance

`webview-ui/src/components/agents/__tests__/ManagedAgentTree.spec.tsx` and
`webview-ui/src/components/agents/__tests__/managedAgentTreeAdapter.spec.ts` provide deterministic jsdom coverage for
compact task strips, exact nested navigation, attention/error/loading states, overflow, status text, fallback paths,
cycles, and durable projections. The certification matrix's `live-tree-ui` track selects these tests and the related
chat/history tests. The current matrix deliberately keeps `INT-LIVE-TREE-001` pending because jsdom cannot prove the
real VS Code extension/webview message loop, timing, reload convergence, or Settings refresh behavior.

The legacy `apps/vscode-e2e/src/suite/subtasks.test.ts` remains a broad `suite.skip` around live-provider subtask
cancellation/resumption. It is not the managed-agent live-tree acceptance row and uses long, provider-dependent waits;
enabling it would not be a deterministic regression. The pending integration classification is therefore preserved
rather than converted into a misleading pass.

## Representative grader controls

The contract suite now audits small control sets using the existing calibration gold fixture, the admitted
`smoke-read-edit` task fixture, and disposable copies. The task-bank manifest is
[`evals/grader-controls/smoke-v1.json`](../evals/grader-controls/smoke-v1.json):

| Control             | Setup                                                                                         | Expected decision |
| ------------------- | --------------------------------------------------------------------------------------------- | ----------------- |
| reference           | Corrected `smoke-read-edit` implementation and the existing calibration gold implementation   | `passed`          |
| alternative-correct | Independent `smoke-read-edit` implementation; calibration uses `Number(left) + Number(right)` | `passed`          |
| broken              | Lowercase `smoke-read-edit` implementation; calibration uses subtraction                      | `outcome_failed`  |
| negative            | Empty/no-op change against each deliberately broken copy                                      | `outcome_failed`  |

`auditGraderControls` requires exactly one of each control kind, executes them serially, and reports the actual decision
without turning a failed control into a grader error. The same contract test still checks that all eight admitted smoke
fixtures begin with failing visible tests and that representative task families (`read-edit`, `test-repair`,
`multi-file`, and `safety`) are present. Hidden-grader boundary behavior remains covered by the existing grading tests;
the disposable controls never alter the checked-in fixture.

Focused validation for this slice:

```text
pnpm --dir packages/evals exec dotenvx run -f .env.test -- vitest run --config vitest.unit.config.ts src/grading/__tests__/controls.spec.ts
pnpm --dir packages/evals exec dotenvx run -f .env.test -- vitest run --config vitest.contract.config.ts src/grading/__contracts__/localFixtures.spec.ts
pnpm --dir src test core/task/__tests__/Task.ticket-progress.spec.ts --reporter=verbose --maxWorkers=2
pnpm --dir webview-ui exec vitest run src/components/agents/__tests__/ManagedAgentTree.spec.tsx src/components/agents/__tests__/managedAgentTreeAdapter.spec.ts
```

The focused managed-agent UI command passed 17 tests across both files. A separate full webview run observed 1,829
passing tests and 3 intentional skips; the exact skipped test identities were not changed by this slice. The exact-host
VS Code gate and managed-agent certification remain parent-level checks because they require the host and full workspace
bundle.
