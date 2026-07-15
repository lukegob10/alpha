# Cost-Effective Frontier Benchmark — Main Repository Plan

**Repository:** `F:\roo-fork\Alpha-Code`  
**Working branch:** `codex/frontier-benchmark-expansion`  
**Status:** main implementation and companion keyless admission complete; first governed T1 measured, with model calibration, human review, and a clean frozen baseline pending  
**Date:** 2026-07-13  
**Primary evaluation model:** Luna High (`gpt-5.6-luna`)  
**Companion private plan:** `F:\roo-fork\Alpha-Code-private-evals\docs\private-frontier-benchmark-expansion-plan.md`

## Split implementation handoffs

- [`frontier-benchmark-main-repository-work.md`](./frontier-benchmark-main-repository-work.md) — changes made in `Alpha-Code`.
- [`frontier-benchmark-private-repository-work.md`](./frontier-benchmark-private-repository-work.md) — changes made in the separate private eval repository.

Use one handoff per Codex project. The files intentionally keep production-harness work and hidden benchmark assets in different repositories.

## Responsibility boundary

This repository owns:

- production harness and runner code;
- suite and task contracts;
- visible development and regression fixtures;
- public task manifests and prompts;
- grader interfaces and the trusted grader broker;
- trace, usage, environment, and changed-path evidence collection;
- model-free certification and campaign orchestration;
- cost controls, reporting, and promotion policy.

This repository must not contain private holdout prompts, hidden grader source, gold solutions, adversarial broken solutions, or detailed holdout results.

## Purpose

Turn the current model campaign into a promotion-capable benchmark while keeping routine research runs inexpensive.

The main-repository priorities are:

1. Connect every deterministic and hidden grader declared by a task to production model-backed runs.
2. Build the public authoring and admission system needed to reject shallow or duplicated tasks.
3. Replace the duplicated visible fixtures with genuinely different repositories and problems.
4. Enforce campaign-level API budgets and capability-balanced subsets.

## Baseline evidence and budget

The historical pre-convergence one-iteration Luna High run measured:

| Segment         | Tasks | Passed | Not passed |    Cost |
| --------------- | ----: | -----: | ---------: | ------: |
| Visible         |    28 |     22 |          6 | $0.9467 |
| Private holdout |    12 |     10 |          2 | $0.4143 |
| Total           |    40 |     32 |          8 | $1.3611 |

The historical average was approximately **$0.034 per task**. That 80% result is not release evidence because the campaign executed ordinary workspace tests rather than the full manifest-declared grader stack, and the generated bank repeated one reducer pattern.

The first governed post-convergence T1 run measured eight high-value visible tasks once with Luna High at high reasoning. It cost **$0.4147293** under the **$0.50** hard cap. Three trials passed; three were classified budget-exhausted; one had an agent-execution error; and one failed a safety gate. The run exercised the full grader path and exposed two runner-policy defects that are now fixed, so it is retained as measurement evidence rather than frozen as the baseline.

### Run tiers

| Tier | Purpose                        |                                        Scope |                             Expected cost |               Hard cap |
| ---- | ------------------------------ | -------------------------------------------: | ----------------------------------------: | ---------------------: |
| T0   | Harness and task certification |                                   Model-free |                                        $0 |                     $0 |
| T1   | Inner research loop            |               8 visible tasks, one iteration |           $0.390 measured/seeded estimate |                  $0.50 |
| T2   | Candidate validation           |              20 visible tasks, one iteration |                               $0.68-$0.90 |                  $1.00 |
| T3   | Full confirmation              |                      40 tasks, one iteration |                               $1.36-$1.60 |                  $2.00 |
| T4   | Promotion reliability          | Affected and unstable tasks only, 3-5 trials |                                  Variable |  Approved per campaign |
| T5   | Frozen release calibration     |                   Full bank, five iterations | About $10.40 from the first governed rate | $16, explicit approval |

T5 is a one-time release expense, not part of normal autoresearch.

`frontier-v1` is Luna-only. T4 is a targeted three-to-five-iteration Luna reliability tier, not a cross-model transfer campaign.

## M0 — Put work on the correct branch

### Actions

- Leave the eval-generated `runs/*` branch unchanged as historical run state.
- Create or switch the main repository to `codex/frontier-benchmark-expansion` without discarding unrelated user changes.
- Record the public suite version and private bundle identity expected by the branch.
- Keep main and private commits independently reviewable; do not combine repositories through nested Git state.

### Exit criteria

- Main work is no longer performed on an eval-generated branch.
- The expected private bundle ID and version are explicit in public manifests.

## M1 — Connect complete grading to model-backed runs

### Objective

Make production model outcomes use the same grader specifications and aggregation rules as keyless calibration.

### Required changes

- Load the exact suite and task manifest for every model-backed trial.
- Collect the final workspace, actual changed paths, normalized trace, usage, latency, permissions, network policy, runner image, and environment identity.
- Resolve and execute every declared grader:
    - visible tests;
    - private hidden tests through the trusted broker;
    - final-state assertions;
    - diff and forbidden-path policies;
    - static analysis;
    - trace assertions;
    - validation-after-edit assertions;
    - usage and safety limits.
- Submit private-grader requests by opaque bundle and grader identity. Never mount the private repository into the evaluated agent environment.
- Persist each grader result, evidence digest, diagnostics, and failure class.
- Replace nullable pass/fail outcomes with:
    - `passed`;
    - `outcome_failed`;
    - `safety_failed`;
    - `budget_exhausted`;
    - `agent_error`;
    - `infrastructure_error`;
    - `grader_error`;
    - `cancelled`.
- Exclude infrastructure and grader errors from capability scores while reporting them as reliability failures.
- Preserve first-attempt and retry-assisted outcomes separately.
- Allow one-iteration research campaigns to finish without invoking five-trial admission logic.

### Tests

- A brokered hidden grader can reject a solution that passes visible tests.
- A safety hard gate overrides functional passes.
- Missing trace, usage, environment, changed-path, or final-state evidence invalidates the trial.
- Agent containers cannot access the private benchmark root, grader source, or solutions.
- Broker and infrastructure errors are not scored as agent failures.
- All declared grader layers affect the stored decision.

### Exit criteria

- Production model campaigns and keyless calibration share grader resolution and aggregation.
- Every terminal trial has an explicit classification and durable evidence.
- Model-free integration tests certify the complete path.

### API cost

**$0.** Use scripted agents and deterministic fixtures.

## M2 — Establish the public task-authoring contract

### Required public task package

Every scored task must publicly declare:

- immutable task identity and version;
- pinned repository snapshot and runtime identity;
- issue-shaped prompt without solution leakage;
- family, capability, risk, difficulty, partition, and context band;
- visible commands and public validation policy;
- hidden grader bundle identity and opaque grader references;
- expected evidence requirements;
- model, tool, time, token, and cost budgets;
- fixture, prompt, repository, grader-reference, and environment digests.

Private solution and grader material is supplied by the companion private repository and is not copied here.

### Duplication controls

Admission must flag or reject:

- prompts differing only by nouns, task IDs, or difficulty labels;
- substantially identical source and test structures;
- gold-diff fingerprints reported by the private admission process as duplicates;
- tasks solvable by copying another task's patch;
- families that do not exercise different tools, files, reasoning paths, or validation methods.

The public authoring report should include normalized prompt similarity, source-tree similarity, capability overlap, context size, and expected edit topology.

### Exit criteria

- A task template and validation command exist.
- Missing assets, unsupported graders, duplicate identities, unsafe paths, and mutable released versions are rejected.
- Public validation can verify private references without reading private contents.

### API cost

**$0.**

## M3 — Replace the duplicated visible fixtures

### Bank target

Across both repositories, retain no more than five current reducer fixtures as foundation or smoke tasks. The 35 replacements are divided as follows:

| Family                             | Final total | Retained maximum | New tasks required |
| ---------------------------------- | ----------: | ---------------: | -----------------: |
| Real-repository engineering        |          16 |                2 |                 14 |
| Alpha agent and extension behavior |           8 |                1 |                  7 |
| Safety and stateful behavior       |           8 |                1 |                  7 |
| Long-horizon and recovery          |           8 |                1 |                  7 |
| Total                              |          40 |                5 |                 35 |

The public repository owns the 20 development and 8 regression fixtures. The private repository owns the 12 holdouts.

### Required problem diversity

Visible tasks should cover different root causes and workflows:

- race conditions, cache invalidation, pagination, cancellation, and cleanup;
- bounded feature additions across multiple modules;
- compatibility-preserving refactors and dependency changes;
- build, packaging, migration, and test-infrastructure repair;
- repository instructions and protected-file behavior;
- context, plan, compaction, resume, and verification behavior;
- tool failure interpretation and recovery;
- secrets, injection, path boundaries, permissions, and side effects;
- idempotency, rollback, retry, and partial failure;
- browser or UI validation;
- constrained correctness, latency, and cost optimization.

Changing operation names or domain nouns is not sufficient. A replacement must change the failure mechanism, reasoning path, edit topology, or validation method.

### Context bands

| Context band | Total target | Character                                                                      |
| ------------ | -----------: | ------------------------------------------------------------------------------ |
| Compact      |           16 | Focused repository slice with fast validation                                  |
| Medium       |           16 | Multiple related files or packages and coordinated edits                       |
| Long         |            8 | Broad discovery, dependent changes, recovery, UI/browser work, or optimization |

Compact tasks should remain discriminating while limiting unnecessary model context and cost.

### Seven coordinated waves

Each wave contains five new tasks across the main and private repositories. Public fixtures and contracts are implemented here; corresponding hidden assets are completed in the private plan.

| Wave | Focus                                            | Paid gate after keyless admission          |
| ---- | ------------------------------------------------ | ------------------------------------------ |
| W1   | Compact real-repository tasks                    | Two targeted Luna trials, maximum $0.15    |
| W2   | Alpha instructions, context, and tool behavior   | T1 subset                                  |
| W3   | Safety and stateful archetypes                   | One trial per new archetype, maximum $0.25 |
| W4   | Build, dependency, migration, and refactor tasks | T1 subset                                  |
| W5   | Medium multi-file tasks                          | T1 subset and signal-per-dollar review     |
| W6   | Recovery, cancellation, resume, and side effects | T2 only if T1 separates candidates         |
| W7   | Long-horizon, browser, and optimization tasks    | Targeted trials, then one T3 baseline      |

No wave receives model trials until its public and private assets pass keyless admission.

## M4 — Build the high-value visible subset

### Objective

Select 8-10 visible tasks that provide broad signal for no more than $0.50 per candidate.

### Required coverage

- Two real-repository coding tasks.
- One Alpha context or instruction-following task.
- One tool-use or recovery task.
- Two safety or stateful tasks.
- One multi-file or long-horizon task.
- One regression task protecting a previously fixed defect.

Maintain a stable core of approximately five tasks. Select the remaining tasks according to the candidate's predicted impact, historical discrimination, severity, cost, and redundancy.

### Escalation

```text
Model-free certification
→ T1 high-value visible subset
→ stop on no predicted improvement or any safety regression
→ T2 visible expansion
→ stop if the improvement disappears or a critical regression appears
→ request private holdout confirmation
→ T3 only for a credible promotion candidate
```

## M5 — Enforce cost governance

### Controls

- Estimate campaign cost before scheduling work.
- Require per-task and campaign hard caps.
- Stop scheduling when the remaining budget cannot cover the next task cap.
- Terminate tasks crossing model-call, token, time, tool-call, or cost budgets.
- Prevent automatic fallback to a more expensive model or reasoning level.
- Record actual provider cost, cache usage, latency, retries, and cost per success.
- Keep prompts concise and retrieve repository context through tools.
- Require explicit approval for T5 or any campaign capped above $2.

### Promotion cost gates

Reject or review a candidate when:

- cost per successful task increases more than 20% without a capability gain;
- median latency increases more than 25% without justification;
- unnecessary reads, retries, or tool calls materially increase;
- tasks repeatedly exhaust their cap without valid evidence;
- the campaign exceeds its hard cap.

## Implementation order

1. M0: move development off the eval-generated branch.
2. M1: connect the complete grader path and terminal taxonomy.
3. M2: implement public authoring, validation, similarity, and bundle-reference contracts.
4. M3: author W1-W7 with private assets completed in lockstep.
5. M4: construct and freeze the initial high-value subset.
6. M5: enforce campaign and task cost caps.
7. Run T1, then T2 only if useful, then one complete T3 rebaseline.
8. Defer T5 until an actual release decision.

## Main-repository acceptance criteria

- Model-backed trials execute every declared grader through trusted interfaces.
- Private assets are never mounted into or readable by the evaluated agent.
- Terminal results distinguish capability, safety, budget, agent, infrastructure, grader, and cancellation outcomes.
- The 28 visible tasks exercise distinct root causes and workflows.
- Public task contracts and private bundle references are immutable and digest-verified.
- A capability-balanced T1 subset costs no more than $0.50.
- A one-iteration full campaign has a $2 hard cap.
- Reports segment capability, difficulty, safety, reliability, latency, and cost.

## Non-goals

- Storing hidden graders or solutions in this repository.
- Running Luna before public and private keyless admission succeeds.
- Using model judges for deterministic coding correctness.
- Running five repetitions of all 40 tasks during routine autoresearch.
- Counting renamed copies as new tasks.
- Exposing private holdout details to autonomous optimization.
