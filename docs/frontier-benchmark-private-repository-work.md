# Frontier Benchmark — Private Repository Work

**Target repository:** `F:\roo-fork\Alpha-Code-private-evals`  
**Target branch:** `codex/frontier-v1-private-expansion`  
**Scope:** private graders, solutions, holdouts, calibration, review, and bundle release  
**Status:** private migration and keyless admission complete; model calibration, human review, and release freeze remain

## Purpose

This is the handoff for a separate Codex project opened on the private eval repository. It describes the private work without placing private benchmark contents in the public repository.

Production runner or campaign changes belong in [`frontier-benchmark-main-repository-work.md`](./frontier-benchmark-main-repository-work.md), not in the private project.

## Repository boundary

The private repository owns:

- task-specific hidden deterministic graders for all scored tasks;
- verified gold solutions and at least three plausible broken solutions per task;
- the 12 isolated holdout workspaces and prompts;
- detailed calibration results, traces, patches, reviewer notes, and disagreements;
- private bundle manifests, content digests, admission reports, and release evidence;
- reviewer-only access and aggregate-safe publication.

The private repository does not own:

- production runner, database, UI, or campaign-orchestration code;
- public visible-task fixtures or manifests;
- provider credentials committed to Git;
- autonomous changes to the public suite contract.

The evaluated agent must never receive the private repository as a workspace, mount, searchable path, tool root, environment value, or prompt context.

## Milestones

### P0 — Establish safe repository and branch state

- Keep the repository private and its Git history independent of Alpha-Code.
- Work on `codex/frontier-v1-private-expansion` from an intentional baseline.
- Ignore credentials, `.env` files, transient run output, caches, and local machine state.
- Record the matching public suite version and commit identity in release metadata.

**Done when:** intended assets are versioned without secrets or transient evidence.

### P1 — Align all 40 private task packages

For every public task identity, provide:

- the exact task ID/version and public contract digests;
- a private grader entrypoint and runtime declaration;
- one gold solution;
- at least three plausible broken solutions with distinct expected failure codes;
- expected initial-state failure codes;
- reviewer notes and content digests.

The private assets have been migrated from the retired shared reducer/`workflow.js` layout to task-specific overlays matching the current visible workspaces and source modules.

**Result:** complete. All 40 private packages match the current public manifests and no visible-task package relies on the retired fixture contract.

### P2 — Build task-specific hidden graders

- Test each task's real failure mechanism and meaningful edge cases.
- Use stable decision codes and bounded, non-leaking diagnostics.
- Cover concurrency, ordering, state, rollback, idempotency, compatibility, paths, secrets, permissions, side effects, build artifacts, trace ordering, cancellation, or resume as appropriate.
- Run graders read-only against a copied final workspace with network disabled by default.
- Reject shared graders whose only differences are renamed values.

**Done when:** every grader catches the intended realistic mistakes and does not reveal hidden assertions or solution structure.

### P3 — Validate gold and broken solutions

- Gold solutions fix the root cause, preserve required behavior, and pass every deterministic and safety gate.
- Each task has at least three realistic broken solutions representing different agent mistakes.
- Broken solutions fail for their declared codes; trivial syntax errors do not count unless syntax recovery is the task.
- Add mutation checks that fail if a critical grader is weakened.

**Done when:** gold and broken assets independently demonstrate grader sensitivity and specificity.

### P4 — Complete and isolate 12 holdouts

- Keep holdouts distributed across all four capability families and all context bands.
- Give every holdout a distinct repository problem and deterministic grading path.
- Copy only one disposable task workspace into an evaluated run.
- Expose no private root, metadata, solutions, grader sources, or detailed evidence.
- Delete run-scoped copies after evidence finalization under the retention policy.

**Done when:** filesystem, symlink, environment, tool-output, process, network, and diagnostic leakage tests all pass.

### P5 — Run zero-dollar keyless admission

For every scored task:

- the initial fixture fails for the intended code, except declared restraint tasks;
- gold passes all graders 20 consecutive times;
- each of at least three broken solutions fails for its intended code 20 consecutive times;
- evidence remains deterministic across 50 repetitions;
- mutation and leakage checks pass;
- all public/private identities and digests agree.

**Result:** complete. All 40 tasks are keylessly admitted with zero rejected tasks; companion-loader, mutation, determinism, and isolation checks pass.

### P6 — Calibrate models and conduct human review

- Run Luna High only after keyless admission.
- Use one-pass holdout confirmation for credible candidates; do not expose per-task holdout feedback to autoresearch.
- Human-review every unexpected pass, safety failure, model/grader disagreement, and unstable task, plus a random 10% sample.
- Resolve all suspected false-positive passes.

**Done when:** required model evidence and signed review decisions are bound to the exact candidate digest.

### P7 — Freeze and publish the private bundle

- Freeze immutable bundle and task content digests.
- Retain detailed release evidence privately.
- Publish only the approved bundle identity, version, schema, digest, admitted task identities, and aggregate-safe status to the public project.
- Require a new bundle version and recalibration for any content change.

**Done when:** the main repository can validate and use the bundle without gaining access to its contents.

## Cost policy

- P0-P5 should use `$0` of model API budget.
- Ordinary autoresearch does not run holdouts.
- Run visible T1/T2 gates in the public project before private model confirmation.
- Initially cap a one-pass 12-task holdout campaign at `$0.60` until current task costs are measured.
- Require explicit approval for full five-repetition release calibration.
- Do not spend model budget to diagnose broken graders, fixtures, contracts, or isolation.

## Cross-repository return contract

Return these public-safe outputs to Alpha-Code:

1. private bundle ID and version;
2. bundle schema and content digest;
3. admitted task IDs/versions and their opaque grader-reference digests;
4. aggregate admission and model-calibration status;
5. aggregate holdout family/difficulty results and promotion reasons;
6. confirmation that required human review and release approval are complete.

Never return hidden prompts, grader source, solutions, detailed traces, patches, hidden assertions, reviewer-only notes, or per-task holdout failures to the autonomous loop.

## Acceptance criteria

- All 40 task packages match the current public suite.
- Every task has a task-specific hidden grader, gold solution, and at least three realistic broken solutions.
- All 12 holdouts are distinct, balanced, admitted, and isolated.
- Initial, gold, broken, determinism, mutation, and leakage gates pass keylessly.
- Required Luna and human-review evidence is complete with zero unresolved false-positive passes.
- The released bundle is immutable and exposes only approved aggregate/public-safe metadata.
