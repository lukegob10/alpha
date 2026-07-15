# M5 Implementation Plan — Cost Governance and Final Acceptance

**Status:** main-repository controls and companion private admission complete; paid calibration, human review, and release freeze remain (2026-07-13)

## Objective

Enforce per-task/campaign spending limits and prove every main-plan acceptance criterion.

## Changes

1. Add campaign budget contracts: estimated, reserved, consumed, remaining, and hard cap.
2. Reserve the next task's maximum cost before scheduling it.
3. Stop scheduling when remaining budget is insufficient.
4. Terminate active tasks at model-call, token, tool-call, wall-time, or cost limits.
5. Disable silent model/reasoning fallback.
6. Store provider cost, cache use, latency, retries, tool counts, and cost per success.
7. Add cost/latency regression policies and promotion reasons.
8. Require explicit opt-in for caps above $2 and for T5.
9. Add a model-free dry-run estimator for every tier.
10. Produce a final requirement-by-requirement acceptance report.

## Primary files

- `packages/evals/src/benchmark/budgets.ts` (new)
- `packages/evals/src/benchmark/modelCampaign.ts`
- `packages/evals/src/benchmark/convergence.ts`
- `packages/evals/src/experiments/policy.ts`
- `packages/evals/src/db/schema.ts` plus migration
- `packages/evals/src/db/queries/runs.ts`
- `apps/web-evals` reporting projections
- `packages/evals/src/benchmark/__tests__/budgets.spec.ts` (new)

## Required gates

- T0 API cost is zero.
- T1 hard cap is $0.50.
- T2 hard cap is $1.00.
- T3 hard cap is $2.00.
- Holdout execution requires prior visible evidence.
- Cost per success regression above 20% or latency regression above 25% blocks/reviews promotion unless justified.
- Infrastructure and grader errors remain visible but do not distort capability scores.

## Final audit

Verify every requirement in `docs/cost-effective-frontier-benchmark-main-plan.md` against source, tests, manifests, keyless reports, and dry-run campaign output. Do not claim completion from test names alone.

## Exit evidence

- Paid model campaigns require an explicit tier and concrete model ID. T5 and caps above $2 require `--approve-high-cost`; silent model fallback is rejected.
- Runs persist tier, estimate, campaign cap, per-task live cap, approval state, and fallback policy through migration 0013.
- The scheduler reserves every selected task before execution. Governed runs disable implicit retries; active CLI tasks are cancelled and classified `budget_exhausted` when live provider cost reaches the task cap.
- Governed production scheduling is serial and reconciles actual provider cost through the campaign ledger before reserving the next task. Tasks that cannot be reserved are terminally classified `budget_exhausted` without a model call.
- Ledger tests cover concurrent/out-of-order settlement and refusal to schedule work that cannot be reserved.
- T0/T1/T2/T3 dry-run reservations are $0/$0.48/$1/$2 against hard caps of $0/$0.50/$1/$2. T1 currently estimates $0.390431 from mixed measured/seeded history.
- The eight-task targeted Luna reliability sample defaults to three iterations, estimates `$1.20`, reserves `$1.92`, and caps at `$2.00`. Five iterations require an explicitly larger approved cap. The frozen five-iteration Luna campaign currently estimates `$10.40`, reserves and caps at `$16.00`, and requires explicit approval; it is a release-only expense, not an autoresearch default.
- Promotion policy blocks an unjustified cost-per-success regression above 20% and latency regression above 25%.
- Paired reports fail closed unless immutable experiment, task-set, control-variant, and candidate-variant manifests match every observation. They reject undeclared confounders and report overall, capability, risk, family, and difficulty results.
- Luna calibration reports require one unique trial ID per claimed repetition. The suite-level reviewer manifest deterministically selects 10% of the full trial population plus every unexpected result, safety failure, unstable task, and grader disagreement; release fails until each selected trial is reviewed.
- `pnpm --filter @alpha-code/evals test:all` executes unit, database integration, contract, golden certification, and real-Docker infrastructure suites as one model-free gate.
- The first governed T1 cost $0.4147293 under its $0.50 cap and exposed timeout/completion classification defects that are now regression-tested. The final acceptance report intentionally retains paid calibration, human-review, and clean-baseline gates rather than claiming a promotion-ready release prematurely.
