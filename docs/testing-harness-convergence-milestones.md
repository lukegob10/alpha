# Testing Harness Convergence Milestones

**Status:** complete  
**Parent architecture:** [`frontier-agent-eval-harness-convergence.md`](./frontier-agent-eval-harness-convergence.md)  
**Purpose:** harden Alpha's evaluation harness until its results are trustworthy enough to guide convergence toward frontier agent setups.

## How to use this document

This roadmap deliberately separates **testing the harness** from **using the harness to test agents**. Complete the milestones in order unless a milestone explicitly allows overlap.

Each milestone is a self-contained planning boundary. Before implementation begins, use its planning brief to produce a repository-specific implementation plan containing:

- the exact files and contracts to change;
- schema and migration changes;
- test cases and fixtures;
- rollout and backward-compatibility steps;
- validation commands;
- risks, decisions, and explicit non-goals.

A milestone is complete only when its exit criteria are automated and passing. Shipping the listed code without the required tests does not complete the milestone.

## Execution status

| Milestone | Status   | Evidence                                                                                                                                                                            |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0        | Complete | Final audit attempt `2026-07-12T225940199Z-ba9cf0c0`: root Turbo discovery plus eval/web tests, isolated migrations/integration, lint, and types passed.                            |
| M1        | Complete | Final audit: lifecycle/retry/orchestration coverage passed; lifecycle is 100% lines and 97.36% branches.                                                                            |
| M2        | Complete | Final audit: 25 seeded hostile-runtime tests plus orchestration fault tests passed.                                                                                                 |
| M3        | Complete | Final audit: five versioned graders, adversarial cases, 20 consecutive gold calibrations, and intended-reason broken calibration passed; grading is 100% lines and 98.83% branches. |
| M4        | Complete | Final audit: reconstructability contracts, integrity/redaction/large-output tests, runtime identity provenance, isolated persistence integration, and coverage passed.              |
| M5        | Complete | Final audit: real Docker/Redis/PostgreSQL infrastructure contracts passed; infrastructure is 100% lines and 96.07% branches.                                                        |
| M6        | Complete | Final audit: the 16-scenario golden suite passed 20 serial and 5 concurrency-four repetitions with zero drift.                                                                      |
| M7        | Complete | Final audit: experiment and append-only governance tests passed; experiments are 100% lines and 99.20% branches.                                                                    |

### Completion audit

The durable final campaign is `final-m0-m7-harness-audit`, attempt `2026-07-12T225940199Z-ba9cf0c0`. All 9 commands passed in 118.2 seconds with content digests and untruncated stdout/stderr artifacts under `.frontier-campaign/campaigns/final-m0-m7-harness-audit/`.

The campaign gates are `test:all`, real-infrastructure contracts, golden certification, experiment governance, coverage floors, eval lint/types, and web eval tests/types. A separate root `pnpm test --filter @alpha-code/evals --filter @alpha-code/web-evals` run proved Turbo discovers and executes both packages. `git diff --check` also passed. The suite is keyless and model-free; it does not authorize frontier model comparisons by itself, but it now supplies the mandatory preflight for them.

## Convergence gates

| Gate                              | Milestones | What it permits                                                   |
| --------------------------------- | ---------- | ----------------------------------------------------------------- |
| Harness testable                  | M0         | Safe iteration on harness internals.                              |
| Outcomes classifiable             | M1-M2      | Trustworthy fault injection and terminal-state testing.           |
| Grading trustworthy               | M3         | Versioned, evidence-backed deterministic grading.                 |
| Runs reconstructable              | M4         | Durable traces and artifacts that survive runner destruction.     |
| Distributed execution trustworthy | M5         | Reliable containerized and concurrent evaluation.                 |
| Harness certified                 | M6         | Construction of the larger agent capability and regression banks. |
| Comparisons trustworthy           | M7         | Controlled frontier-harness ablations and promotion decisions.    |

---

## M0 — Establish the harness test foundation

### Objective

Make all eval-harness tests discoverable, isolated, reproducible, and mandatory in the normal repository and CI workflows.

### Why this milestone exists

`packages/evals` currently exposes `_test` rather than the root Turbo-compatible `test` script. `apps/web-evals` contains Vitest tests but does not expose a test script. The model-backed eval workflow therefore is not preceded by a complete harness test gate.

### Scope

- Add standard `test`, `test:unit`, `test:integration`, and `test:contract` scripts where applicable.
- Separate pure unit tests from PostgreSQL-, Redis-, and Docker-backed tests.
- Prevent parallel test workers from truncating or sharing mutable database state.
- Add coverage reporting for critical harness modules.
- Add a keyless, model-free harness test job to CI.
- Document local commands and test dependencies.

### Required tests

- Test discovery proves both eval packages participate in `pnpm test`.
- Database tests use an isolated database or schema per worker/run.
- Unit tests run without Docker, Redis, PostgreSQL, network access, or provider keys.
- CI fails when a harness test fails or is accidentally skipped.

### Deliverables

- Package scripts and Vitest projects/configuration.
- Test-database isolation helper.
- CI harness-test job.
- Initial critical-module coverage policy.
- Updated eval developer documentation.

### Exit criteria

- `lint`, `check-types`, unit tests, migration tests, integration tests, and contract tests have distinct commands.
- The root test command executes both eval packages.
- The unit suite passes without external services or secrets.
- CI blocks merging on harness-test failure.
- Critical lifecycle modules have an agreed branch-coverage floor; the initial target is 90% for terminal states, retry policy, manifest validation, grader result handling, and artifact integrity.

### Out of scope

- Real model calls.
- New agent capability tasks.
- Dashboard redesign.
- Broad repository-wide coverage targets.

### Planning brief

> Generate an implementation plan for M0 of `docs/testing-harness-convergence-milestones.md`. Inspect the current package scripts, Turbo configuration, Vitest configuration, database global setup, and GitHub workflows. Specify exact file changes, test-project boundaries, database isolation design, CI jobs, coverage policy, validation commands, backward-compatibility risks, and a PR-sized rollout sequence. Do not implement frontier eval features or invoke real models.

---

## M1 — Formalize trial and attempt lifecycle semantics

### Objective

Replace nullable pass/fail lifecycle behavior with a deterministic, tested state machine for trials, attempts, grading, cancellation, retries, and terminal classification.

### Dependencies

- M0 complete.

### Scope

- Define trial, attempt, execution, evidence-collection, and grading states.
- Introduce mutually exclusive terminal states:
    - `passed`
    - `outcome_failed`
    - `safety_failed`
    - `budget_exhausted`
    - `agent_error`
    - `infrastructure_error`
    - `grader_error`
    - `cancelled`
    - `human_handoff`
- Define retryable and non-retryable failure categories.
- Preserve first-attempt outcomes separately from retry-assisted outcomes.
- Define idempotency and reconciliation rules for controller restarts and late runner events.
- Keep compatibility projections for the existing `tasks.passed` and run summaries during migration.

### Required tests

- Every legal and illegal state transition.
- Duplicate, late, and out-of-order completion signals.
- Cancellation during setup, execution, evidence collection, and grading.
- Retry exhaustion and retry success.
- Controller restart and repeated reconciliation.
- Concurrent attempts racing to finalize the same trial.
- Derivation of first-attempt and retry-assisted results.

### Deliverables

- Pure lifecycle state machine and typed transition API.
- Transition/failure classification table.
- Compatibility mapping to the current run/task UI.
- Initial schema design for trials and attempts, with migration strategy.
- Lifecycle unit and property-based/table-driven tests.

### Exit criteria

- Every attempt has exactly one terminal state.
- No completed controller run can leave a task indefinitely unresolved.
- Illegal transitions fail explicitly and observably.
- Replaying the same lifecycle inputs produces the same state.
- Retries never overwrite prior attempt evidence.
- First-attempt and retry-assisted scores are independently reportable.

### Out of scope

- Full artifact storage.
- Layered grader implementation.
- Statistical candidate comparison.

### Planning brief

> Generate an implementation plan for M1 of `docs/testing-harness-convergence-milestones.md`. Inspect task processing, container retry behavior, run completion queries, cancellation, Redis registration, and existing database tables. Design a pure lifecycle state machine, terminal taxonomy, persistence model, compatibility projection, reconciliation behavior, and exhaustive tests. Identify exact changes needed to eliminate unresolved tasks and distinguish agent, infrastructure, grader, safety, budget, and cancellation outcomes.

---

## M2 — Build a deterministic hostile runtime and fault-injection kit

### Objective

Test orchestration hardness without model cost or model nondeterminism by providing scripted fake agents, graders, processes, clocks, event streams, and infrastructure failures.

### Dependencies

- M0 complete.
- M1 lifecycle contracts stable enough to target.

### Scope

- Define injectable boundaries for process execution, time, randomness, Docker control, event publication, persistence, artifact upload, and grading.
- Create a scripted fake agent runtime.
- Create fake grader and artifact-store implementations.
- Add deterministic random seeds and reproducible failure schedules.
- Provide reusable fault scenarios for unit, integration, and container-contract suites.

### Required fault scenarios

- Successful agent completion and incorrect final workspace.
- Provider failure before and after tool use.
- Hanging process and unkillable descendant process.
- Partial stdout/stderr followed by process failure.
- Missing, duplicated, malformed, late, and out-of-order events.
- Redis disconnect/reconnect and publish failure.
- Database failure before and during terminal commit.
- Artifact upload interruption, corruption, and retry.
- Grader crash, timeout, and intentionally inconsistent result.
- Hidden-grader access and forbidden-path modification attempts.
- Container exit zero without completion and nonzero after completion.
- Secret canaries in nested and encoded event payloads.

### Deliverables

- Fake-agent scenario language or typed scenario builder.
- Fake process/Docker adapter, clock, random source, grader, event sink, and artifact store.
- Fault-injection fixture library.
- Seeded property/table-driven tests.
- Failure-reproduction output containing the scenario and seed.

### Exit criteria

- All required faults deterministically produce their expected terminal classification.
- Infrastructure and grader faults never reduce the agent outcome score.
- Safety failures cannot be averaged into a passing result.
- Evidence-collection failure invalidates the trial.
- Any randomized failure is reproducible from its logged seed.

### Out of scope

- Real provider behavior benchmarking.
- Full production Docker certification.
- Model-judge graders.

### Planning brief

> Generate an implementation plan for M2 of `docs/testing-harness-convergence-milestones.md`. Inspect where the eval CLI directly calls Execa, Docker, Redis, PostgreSQL, timers, randomness, graders, and event publishers. Propose the smallest dependency boundaries needed for a deterministic hostile runtime. Define the fake-agent scenario format, fixture organization, fault matrix, seeded test strategy, exact files to add or refactor, and validation proving failures are classified without real models or network access.

---

## M3 — Introduce a versioned, layered grader runtime

### Objective

Replace bare boolean unit-test grading with deterministic, evidence-producing, versioned graders and hard safety gates.

### Dependencies

- M1 terminal classifications complete.
- M2 fake grader and fault injection available.

### Scope

- Define a grader registry and versioned grader protocol.
- Implement initial grader types:
    1. command;
    2. filesystem/final state;
    3. Git diff/scope policy;
    4. trace assertion;
    5. schema/static analysis.
- Distinguish `failed` from `error` for every grader.
- Mark catastrophic safety and scope rules as hard gates.
- Keep hidden grader assets outside the agent-visible environment.
- Store normalized diagnostics and artifact references rather than only stdout and booleans.

### Minimum grader result

```ts
type GraderResult = {
	graderId: string
	graderVersion: string
	status: "passed" | "failed" | "error"
	hardGate: boolean
	startedAt: string
	finishedAt: string
	evidence: ArtifactReference[]
	diagnostics: Diagnostic[]
}
```

### Required tests

- Known-good and known-bad fixture for every grader rule.
- Timeout, crash, malformed output, and process-cleanup behavior.
- Repeated determinism runs on identical input.
- Conflicting grader outcomes and hard-gate precedence.
- Agent-visible mount and Git-history checks for hidden assets.
- Mutation testing or adversarial fixture checks proving weakened grader logic is detected.

### Deliverables

- Grader contracts and registry.
- Five deterministic grader plugins.
- Gold, broken, safety, and grader-error fixture sets.
- Hidden-state boundary enforcement.
- Migration path from `runUnitTest(): Promise<boolean>`.

### Exit criteria

- Gold solutions pass 100% over repeated executions.
- Deliberately broken solutions fail for the intended reason.
- A grader crash or timeout becomes `grader_error`, never `outcome_failed`.
- No active grader returns only a boolean without versioned evidence.
- Hidden grader assets cannot be accessed through mounts, Git history, logs, or allowed network paths.

### Out of scope

- Subjective model judges.
- Human adjudication UI.
- Aggregate statistical reporting.

### Planning brief

> Generate an implementation plan for M3 of `docs/testing-harness-convergence-milestones.md`. Inspect `runUnitTest.ts`, exercise layout, container mounts, process cleanup, logging, and task result persistence. Design the grader protocol, registry, plugin boundaries, hidden-state execution model, evidence format, hard-gate precedence, fixtures, mutation/adversarial tests, database changes, compatibility rollout, and exact validation commands. Keep subjective model judges out of scope.

---

## M4 — Make every run reconstructable and integrity checked

### Objective

Persist complete normalized traces and content-addressed artifacts so container destruction does not destroy required evaluation evidence.

### Dependencies

- M1 lifecycle identities defined.
- M3 grader evidence contracts defined.

### Scope

- Add versioned task, variant, trial, attempt, event, artifact, and grader-result contracts.
- Adapt runtime `AgentTurnEvent`, `StepContext`, tool-policy, compaction, and verification data into a stable eval event envelope.
- Collect final diff, status, tree digest, transcript, final response, test output, extension log, environment manifest, usage, and stop reason.
- Add content-addressed artifact storage with retention and access policies.
- Add event sequence, payload-digest, artifact-digest, redaction-version, and upload-completeness checks.
- Dual-write or project into the existing run/task schema while the UI migrates.

### Required tests

- Container/workspace deletion immediately after evidence collection.
- Missing required artifact invalidates a trial.
- Corrupted artifact or payload digest is detected.
- Event gaps, duplicates, and late-event rules are enforced.
- Interrupted uploads resume idempotently.
- Redaction covers nested, encoded, and key/value secret canaries.
- Large output truncation retains a protected full artifact and a bounded event representation.
- Migrations work from every supported prior schema.
- Reconstruction produces the same identities and result derivation.

### Deliverables

- Durable schema and migrations.
- Eval event adapter and schema registry.
- Artifact-store interface and initial implementation.
- Evidence collector that runs before cleanup.
- Trial integrity validator.
- Reconstruction/export CLI.
- Existing UI compatibility projection.

### Exit criteria

- An independent reviewer can reconstruct the evaluated system and diagnose the first material failure using retained evidence.
- Destroying the runner loses no required evidence.
- Missing, corrupt, or incomplete evidence cannot produce a valid pass.
- Event sequence and artifact digests are verified automatically.
- Secrets do not appear in persisted event payloads, logs, artifact metadata, or Docker command lines.

### Out of scope

- Large capability task bank.
- Baseline promotion UI.
- Model-judge calibration.

### Planning brief

> Generate an implementation plan for M4 of `docs/testing-harness-convergence-milestones.md`. Inspect the current database schema, migrations, runtime event log, StepContext metadata, task storage paths, container cleanup, logs, and web result queries. Define stable task/variant/trial/attempt/event/artifact/grader contracts, a content-addressed artifact design, evidence collection order, integrity validation, redaction, migrations, compatibility projections, reconstruction tooling, exact tests, and rollout steps.

---

## M5 — Certify container and distributed-system behavior

### Objective

Prove that real Docker, Redis, PostgreSQL, concurrency, retries, and cleanup preserve the lifecycle and evidence contracts under failure.

### Dependencies

- M2 hostile runtime available.
- M4 durable lifecycle and evidence contracts complete.

### Scope

- Run real infrastructure with the fake agent runtime.
- Pin and record container image digest, resource profile, network mode, runtime versions, and concurrency.
- Replace shell-composed Docker commands with structured arguments or a Docker API adapter.
- Implement controller/runner restart reconciliation.
- Verify process-tree termination and resource cleanup.
- Verify run-scoped resource ownership and isolation.

### Required tests

- Fresh workspace and cross-task contamination.
- CPU, memory, timeout, and network policy enforcement.
- Controller death and restart at every lifecycle stage.
- Runner death and orphan reconciliation.
- Redis and PostgreSQL outages during execution and finalization.
- Concurrent attempts racing to finalize a trial.
- Timeout kills all descendant processes.
- Cleanup affects only the selected run.
- Artifact collection completes before container removal.
- Hidden grader assets remain invisible in the actual task container.
- Secret values never appear in process listings or logged command lines.

### Deliverables

- Docker/infrastructure contract suite.
- Structured container invocation adapter.
- Restart and orphan-reconciliation worker.
- Resource and isolation manifest collector.
- Leak/orphan detector for test teardown.

### Exit criteria

- The contract suite passes repeatedly under serial and production-like concurrency.
- No test leaves orphaned containers, unresolved trials, or cross-run mutations.
- Failure injection produces zero misclassified outcomes.
- Infrastructure retries are visible and do not silently increase an agent's first-attempt score.
- Resource, network, permission, and image identities are present in every valid trial.

### Out of scope

- Real-model quality comparisons.
- Statistical promotion policy.
- Full 50-task capability bank.

### Planning brief

> Generate an implementation plan for M5 of `docs/testing-harness-convergence-milestones.md`. Inspect Docker Compose, runner image construction, `processTaskInContainer`, Redis registration/heartbeat, database finalization, process termination, cleanup actions, and CI infrastructure. Specify the real-infrastructure contract topology, structured Docker invocation, restart reconciliation, resource provenance, test scenarios, leak detection, CI scheduling, exact file changes, and validation commands. Use the fake runtime; do not rely on real model calls.

---

## M6 — Create the golden harness certification suite

### Objective

Create a small deterministic suite that continuously proves the harness reports known truths correctly before the harness is used to judge changing agents.

### Dependencies

- M0-M5 complete.

### Scope

Create 12-16 certification tasks whose expected lifecycle, evidence, grading, retry, and classification results are completely specified.

### Minimum certification scenarios

- Known pass.
- Known functional failure.
- Forbidden-path modification.
- Hidden-grader access attempt.
- Agent timeout.
- Grader timeout.
- Setup/infrastructure failure.
- Artifact corruption.
- Missing and duplicate event.
- Infrastructure retry succeeds.
- Agent retry succeeds while first-attempt score remains failed.
- Cancellation.
- Network-policy violation.
- Secret-redaction canary.
- Nondeterministic-grader canary.

Each scenario must declare its expected:

- trial terminal state;
- attempt terminal states;
- grader results and hard gates;
- required artifacts;
- event-integrity result;
- retry count;
- inclusion in outcome, reliability, infrastructure, and safety metrics.

### Deliverables

- Versioned certification manifests and fixtures.
- Machine-readable expected-result files.
- Certification runner and result comparator.
- Serial and concurrent repeatability jobs.
- Failure bundle suitable for local reproduction.

### Exit criteria

- The suite passes 20 consecutive serial runs.
- The suite passes 5 consecutive runs at production-like concurrency.
- There is zero result drift, misclassification, or missing required evidence.
- Every intentionally invalid trial is rejected.
- Certification is required before model-backed eval jobs and baseline promotion.

### Out of scope

- Measuring agent capability.
- Ranking models.
- Subjective quality grading.

### Planning brief

> Generate an implementation plan for M6 of `docs/testing-harness-convergence-milestones.md`. Use the completed lifecycle, grader, artifact, and distributed-system contracts to design 12-16 golden certification tasks. Define manifest layout, expected-result schema, fixture reuse, deterministic runner behavior, repetition/concurrency policy, result comparator, CI integration, reproduction bundles, exact files, and validation commands. These tasks certify the harness and must not depend on model quality.

---

## M7 — Add trustworthy experiment and promotion testing

### Objective

Prove that the certified harness can make controlled, statistically defensible comparisons between agent or harness variants.

### Dependencies

- M6 certification gate consistently green.

### Scope

- Add immutable task-set and variant identities.
- Pair control and candidate by task, seed, resource profile, time window, and repetition.
- Machine-diff every material variant dimension.
- Report success uncertainty, consistency, paired outcomes, cost per success, tail latency, and infrastructure error rate.
- Separate harness-only from model-only experiment templates.
- Add immutable baseline promotion and rollback records.
- Prevent aggregate scores from hiding safety or high-risk regressions.

### Required tests

- Statistical functions against fixed reference datasets.
- Pairing rejects mismatched tasks, seeds, resources, permissions, or retry policies.
- Variant diff detects prompt, tool, policy, skill, build, image, model, and working-tree changes.
- Infrastructure/grader errors are excluded from agent outcome denominators and separately reported.
- Hard safety failure blocks promotion regardless of aggregate score.
- Baseline promotion is immutable, reviewed, and reversible through a new promotion record.

### Deliverables

- Experiment manifest and pairing engine.
- Statistics library with reference-vector tests.
- Variant diff and confounder report.
- Baseline/promotion schema and audit trail.
- Initial PR, nightly, and release-candidate policies.

### Exit criteria

- A candidate cannot be promoted from aggregate pass rate alone.
- Changed dimensions and confounders are machine-visible.
- First-attempt reliability and retry-assisted capability are both reported.
- Safety hard gates and high-risk regressions cannot be averaged away.
- The approved baseline is immutable, reviewable, and has an explicit rollback target.

### Out of scope

- Automated model-judge grading.
- Automated production-failure clustering.
- Generated eval tasks.

### Planning brief

> Generate an implementation plan for M7 of `docs/testing-harness-convergence-milestones.md`. Inspect the certified trial schema, metrics queries, run-copy behavior, web reporting, and CI workflows. Design immutable experiment/task-set/variant identities, paired execution, variant diffing, statistical calculations with reference tests, failure-denominator rules, baseline governance, promotion gates, schema/UI changes, exact files, rollout steps, and validation commands. Do not introduce subjective model judges.

---

## Frontier setup work unlocked after M7

After M7, Alpha can responsibly begin the frontier convergence work described in the parent document:

1. Build the balanced capability and production-regression task banks.
2. Run one-variable harness ablations.
3. Compare model variants while holding the harness fixed.
4. Add calibrated subjective graders only where deterministic graders are insufficient.
5. Feed sanitized production failures into the regression suite.
6. Establish PR, nightly, and release-candidate quality gates.

The following work should not begin earlier merely to create more measurements:

- the full 50-task capability bank;
- model-versus-harness bundle comparisons;
- automated judge scoring;
- baseline promotion based on aggregate pass rate;
- generated evals or automated failure clustering.

## Definition of testing-harness convergence

The testing harness is ready to guide frontier-agent convergence only when all of the following are continuously true:

- Every trial and attempt terminates deterministically.
- Fault classification is verified through injection.
- Gold and broken grader fixtures are stable and mutation-resistant.
- Hidden truth is demonstrably unavailable to the evaluated agent.
- Required evidence survives runner destruction.
- Event and artifact integrity failures invalidate results.
- First-attempt reliability cannot be overwritten by retries.
- Resource, network, permission, retry, and policy changes are part of variant identity.
- The golden certification suite is stable under production-like concurrency.
- Candidate comparisons are paired, uncertainty-aware, and governed by hard safety gates.
