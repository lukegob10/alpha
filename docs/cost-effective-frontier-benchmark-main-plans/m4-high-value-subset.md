# M4 Implementation Plan — High-Value Visible Subset

**Status:** complete (2026-07-13)

## Objective

Produce an 8-10 task, capability-balanced inner-loop subset with an enforced $0.50 campaign cap.

## Changes

1. Add subset manifests with stable core and dynamically selected slots.
2. Add task history fields for discrimination, severity, grader confidence, runtime, cost, regressions, and redundancy.
3. Implement deterministic subset selection with required coverage constraints.
4. Add `--tier t1|t2|t3` and `--subset` campaign options.
5. Generate a selection explanation before model execution.
6. Reject subsets missing required capability/failure coverage or exceeding estimated cost.

## T1 coverage

- Two real-repository coding tasks.
- One Alpha context/instruction task.
- One tool/recovery task.
- Two safety/stateful tasks.
- One multi-file/long-horizon task.
- One historical regression task.

## Primary files

- `evals/subsets/frontier-t1.yaml` (new)
- `packages/evals/src/benchmark/subsets.ts` (new)
- `packages/evals/src/benchmark/modelCampaign.ts`
- `packages/evals/src/benchmark/cli.ts`
- `packages/evals/src/experiments/**`
- `packages/evals/src/benchmark/__tests__/subsets.spec.ts` (new)

## Exit evidence

- `evals/subsets/frontier-t1.yaml` freezes five stable core tasks and ranks three dynamic slots using discrimination, severity, grader confidence, regression value, redundancy, cost, and latency history.
- History now records provenance per task. Governed high-reasoning run 12 supplies measured cost and end-to-end wall latency for its eight tasks; unobserved candidates remain explicitly seeded, so the manifest is correctly labeled `mixed` rather than overstating its evidence.
- Selection is deterministic and rejects missing coverage, unknown tasks, missing history, duplicate selection, and estimates/reservations above the cap.
- The selected eight tasks cover three real-repository tasks, one Alpha instruction task, three safety/stateful tasks, four long-or-multifile tasks, four regressions, and two tool/recovery tasks.
- Current estimate: **$0.390431 expected**, **$0.48 reserved**, **$0.50 hard cap**. The dynamic slots now select tool-result integrity, resume idempotency, and transaction outbox alongside the five-task stable core.
- `benchmark:subset` explains each selection; `benchmark:estimate -- --tier t1` performs a model-free preflight.
- `benchmark:history-update -- --run-id <id> --write` accepts only a complete terminal high-reasoning governed T1 run with fallback disabled, records measured costs and wall latency atomically, and rejects duplicate run ingestion.
