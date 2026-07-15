# Frontier Benchmark — Main Repository Work

**Repository:** `F:\roo-fork\Alpha-Code`  
**Branch:** `codex/frontier-benchmark-expansion`  
**Scope:** production harness, public fixtures, campaign controls, and public release metadata  
**Status:** implementation and matching private keyless admission complete; first governed T1 measured, with model calibration, human review, and a clean frozen baseline remaining

## Purpose

This is the implementation handoff for the public Alpha-Code repository. Work in this file must not add hidden graders, holdout prompts, gold solutions, broken solutions, or reviewer-only evidence to this repository.

The companion work belongs in [`frontier-benchmark-private-repository-work.md`](./frontier-benchmark-private-repository-work.md) and is executed in the private repository.

## Repository boundary

This repository owns:

- the production eval runner and trusted grader-broker interface;
- suite, task, evidence, lifecycle, and campaign contracts;
- the 20 development and 8 regression workspaces, prompts, and manifests;
- model-free harness certification;
- visible subset selection, cost estimation, hard caps, and promotion policy;
- aggregate-only holdout reporting and public release metadata.

This repository must never contain or expose:

- hidden grader implementation or hidden inputs;
- private holdout prompts or source workspaces;
- gold or deliberately broken solutions;
- detailed holdout traces, patches, failures, or reviewer notes;
- credentials or the private repository path in an evaluated agent environment.

## Milestones

### M0 — Freeze the public/private contract

- Keep the suite identity, private bundle identity, schema version, and content digest explicit.
- Keep the two repositories in independent Git histories and branches.
- Reject a bundle whose identity, version, digest, grader references, or task identities do not match the public suite.

**Done when:** the main repository can validate an opaque private bundle without reading or copying its contents.

### M1 — Run the complete grader stack in production

- Load the exact suite and task manifest for each model-backed trial.
- Collect the final workspace, changed paths, normalized trace, usage, latency, environment identity, permissions, and network policy.
- Execute all declared visible, hidden, final-state, diff, static, trace, usage, and safety graders.
- Persist individual grader evidence and a precise terminal classification.
- Treat deterministic graders and safety gates as authoritative.
- Keep infrastructure and grader errors separate from agent capability failures.

**Done when:** keyless and model-backed trials use the same resolution and aggregation path, and missing evidence cannot produce a pass.

### M2 — Enforce the public authoring contract

- Validate immutable task identity, pinned snapshot, prompt and fixture digests, capabilities, risk, context band, edit topology, budgets, evidence, and opaque grader references.
- Reject missing assets, unknown graders, unsafe paths, duplicate identities, unsupported trace requirements, and released-version mutation.
- Produce prompt, tree, capability, context, and expected-edit similarity reports.
- Provide templates for compact, medium, long, restraint, and holdout-reference tasks.

**Done when:** malformed or duplicated public tasks fail before model execution.

### M3 — Maintain 28 genuinely distinct visible tasks

- Maintain 20 development and 8 regression tasks with different failure mechanisms and validation paths.
- Keep the visible bank balanced across real-repository, Alpha behavior, safety/stateful, and long-horizon work.
- Require every non-restraint fixture to fail initially for its declared reason.
- Do not count renamed operations, nouns, or copied repository layouts as distinct tasks.

**Done when:** authoring analysis reports no disallowed duplicate pairs and fixture checks validate all 28 initial states.

### M4 — Maintain a cost-effective T1 subset

- Keep a stable five-task core and three history-ranked slots.
- Cover real coding, Alpha behavior, tool/recovery, safety/state, multi-file work, and regression protection.
- Use one Luna High trial per task with high reasoning.
- Reserve `$0.48` and enforce a `$0.50` campaign hard cap.
- Re-rank dynamic slots using measured signal per dollar after valid runs.

**Done when:** the subset is deterministic, balanced, and cannot exceed its cap.

**First governed measurement:** run 12 evaluated eight Luna High tasks once for `$0.4147293`. Three trials passed, three exhausted the per-task budget, one ended in an agent-execution error, and one failed a safety hard gate. Seven tasks reached all seven grader layers without grader errors; the execution-error task correctly did not receive a capability grade. Do not treat this run as a frozen baseline. The exposed timeout misclassification and completed-task budget overwrite are fixed and regression-tested; require a fresh paired T1 before promotion.

### M5 — Govern escalation and promotion

- Run model-free certification before every paid campaign.
- Require a concrete provider model ID and disable model fallback.
- Use T1 for the inner loop, T2 for credible candidates, T3 for one-pass full confirmation, and T5 only for an explicitly approved release calibration.
- Reserve all scheduled work before execution and terminate a task at its live task cap.
- Require exact baseline/candidate pairing.
- Block promotion on safety failures, critical regressions, private-holdout failure, or unjustified cost/latency regression.

**Done when:** a paid campaign cannot silently add repetitions, retries, tasks, a more expensive model, or a larger budget.

## Cross-repository handshake

The private project returns only:

- bundle ID, version, schema version, and content digest;
- the admitted public task identities and grader-reference digests;
- aggregate admission/calibration status;
- aggregate holdout segment metrics and promotion reasons approved for publication.

After receiving a newly admitted bundle, this repository must:

1. update and validate the public bundle reference;
2. rerun model-free certification and public fixture checks;
3. run one governed Luna High T1 baseline;
4. run T2 only if T1 provides useful separation;
5. run one T3 baseline only when both visible and private gates are ready;
6. freeze release metadata only after all admission and review requirements pass.

## Validation

Run the main-repository checks without paid model calls:

```powershell
pnpm --filter @alpha-code/evals exec tsc --noEmit
pnpm --filter @alpha-code/evals lint
pnpm --filter @alpha-code/evals test:all
pnpm --filter @alpha-code/evals benchmark:validate
pnpm --filter @alpha-code/evals benchmark:author-check
pnpm --filter @alpha-code/evals benchmark:fixture-check
pnpm --filter @alpha-code/evals benchmark:sync-keyless
pnpm --filter @alpha-code/evals benchmark:release-audit
```

Do not run Luna merely to compensate for failed fixture, grader, isolation, or admission checks.

After paired model campaigns, compile the immutable observations into a digest-bound report:

```powershell
pnpm --filter @alpha-code/evals benchmark:paired-report -- --control <control-observations.json> --candidate <candidate-observations.json> --experiment <experiment.json> --task-set <task-set.json> --control-variant <control-variant.json> --candidate-variant <candidate-variant.json> --output <paired-report.json>
```

The observation contract requires exact task/repetition, resource, permission, network, retry, and time-window pairing. Immutable variant manifests additionally prove that model, model settings, prompts, tool schemas, runner image, and infrastructure controls stayed fixed outside the explicitly declared candidate fields. Reports include overall, capability, risk, family, and difficulty segments.

After the five-trial Luna calibration exists, create the reviewer-only manifest in the private repository:

```powershell
pnpm --filter @alpha-code/evals benchmark:review-sample
```

It deterministically selects 10% of all Luna trials and additionally includes every unexpected result, safety failure, unstable task, and supplied grader disagreement. It does not approve any trial or expose holdout details publicly.

## Acceptance criteria

- Every model-backed trial executes every declared grader with durable evidence.
- The evaluated agent cannot read private material.
- The 28 visible tasks remain distinct and start in their declared state.
- T1 is capped at `$0.50`; one-pass T3 is capped at `$2.00`.
- Results separate capability, safety, reliability, grader/infrastructure errors, latency, and cost.
- A release cannot be frozen without the exact admitted private bundle and required model/human calibration.

The release audit is aggregate-only. It currently proves 40/40 keyless-complete tasks and reports the remaining Luna, review, and admission counts without exposing holdout identities or evidence. `frontier-v1` calibration is Luna-only.
