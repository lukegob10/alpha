# M1 Implementation Plan — Production Model Grading

**Status:** complete (2026-07-13)

## Objective

Replace the legacy boolean unit-test completion path with full manifest-driven grading and lifecycle classification.

## Current evidence

- `processTask.ts` calls `runUnitTest()` and writes `tasks.passed` directly.
- `runUnitTest.ts` executes language commands and returns a boolean.
- Lifecycle, evidence, grader registry, persistence queries, broker, and integration tests exist but are not connected to production.
- The Drizzle schema does not export the tables used by the newer lifecycle/evidence queries.

## Changes

1. Reconcile `db/schema.ts` with migrations 0007-0012 and export trials, attempts, evidence, grader results, and experiment tables.
2. Export lifecycle, evidence, grader-result, and experiment queries from `db/index.ts`.
3. Convert `runUnitTest.ts` into a manifest-driven grader adapter returning `GraderRunResult`.
4. Resolve all task grader aliases with real visible commands, budgets, and private bundle roots.
5. Collect changed paths from a pre/post workspace snapshot rather than hard-coding them.
6. Normalize IPC/tool events into a durable trace and persist usage/environment evidence.
7. Integrate the attempt lifecycle into local CLI, VS Code, and container execution.
8. Route private commands through the trusted broker; never expose private roots to the agent process.
9. Persist grader results and map decisions to terminal statuses.
10. Revalidate evidence after grading and classify missing/corrupt evidence as infrastructure failure.
11. Derive compatibility `tasks.passed` and run totals from trials without counting infrastructure/grader errors as capability failures.
12. Preserve one-iteration research runs without calibration merge.

## Primary files

- `packages/evals/src/db/schema.ts`
- `packages/evals/src/db/index.ts`
- `packages/evals/src/db/queries/{lifecycle,evidence,graderResults,runs}.ts`
- `packages/evals/src/cli/{processTask,runUnitTest,runTaskInCli,runTaskInVscode,runEvals}.ts`
- `packages/evals/src/benchmark/{loader,graderBroker,modelCampaign}.ts`
- `packages/evals/src/grading/{catalog,registry,aggregate,types}.ts`
- `packages/evals/src/evidence/**`
- `packages/evals/src/infrastructure/**`

## Tests

- Existing lifecycle state-machine and DB integration tests.
- `runUnitTest.spec.ts` for all language adapters and all grader layers.
- `processTask.lifecycle.spec.ts` for success, safety, agent, infrastructure, grader, cancellation, retry, and evidence-integrity outcomes.
- Broker isolation tests proving no private mount or Docker socket reaches the agent.
- End-to-end scripted-agent test where visible tests pass but a hidden grader fails.
- Run aggregation test excluding non-capability terminal states from scored denominators.

## Validation

- `pnpm --filter @alpha-code/evals test:unit`
- `pnpm --filter @alpha-code/evals test:integration`
- `pnpm --filter @alpha-code/evals test:contract`
- `pnpm --filter @alpha-code/evals check-types`
- `pnpm --filter @alpha-code/evals lint`

## Exit evidence

- Production and calibration share grader resolution and aggregation.
- Every terminal task has a persisted lifecycle status and grader evidence.
- All declared graders influence model-backed outcomes.
- M1 validation is model-free and costs $0 API.

## Completion evidence

- `processTask` now drives the durable attempt state machine from setup through
  agent execution, evidence collection, grading, and an explicit terminal
  status. It no longer writes the legacy pass/fail field directly.
- Production and keyless calibration use the same
  `resolveTaskGraderSpecs()` function, grader registry, and deterministic
  aggregation rules.
- Model-backed tasks retain immutable task/variant identities, normalized agent
  events, actual changed paths, usage, environment data, all required workspace
  artifacts, per-grader results, and content-addressed grader evidence.
- Private graders execute through a trusted filesystem broker against a
  controller-owned workspace path. The agent container receives no Docker
  socket, private repository mount, grader source, solution material, or secret
  value in its Docker arguments.
- Terminal outcomes distinguish `passed`, `outcome_failed`, `safety_failed`,
  `budget_exhausted`, `agent_error`, `infrastructure_error`, `grader_error`,
  `cancelled`, and `human_handoff`. Infrastructure, grader, cancellation, and
  human-handoff results are excluded from capability calibration.
- Run aggregation counts only explicit scored pass/fail projections; nullable
  infrastructure results no longer inflate the failed denominator.
- The released `smoke-v1` fixtures all reproduce their declared initial failing
  state through the manifest-driven contract.
- Validation results:
    - TypeScript: passed.
    - ESLint with zero warnings: passed.
    - Unit: 213 tests passed across lifecycle, production adapter, grading,
      evidence, orchestration, benchmark, infrastructure, and experiment layers.
    - Database integration: 21 tests passed.
    - Contract: 17 tests passed.
    - Golden harness certification: 5 tests passed, including 20 serial and 5
      production-concurrency repetitions across 16 hostile scenarios.
    - Real Docker/Redis/Postgres infrastructure certification: 9 tests passed.
    - Production adapter proof: visible tests pass and a brokered hidden grader
      rejects the candidate as `outcome_failed`.
- API cost: `$0`.
