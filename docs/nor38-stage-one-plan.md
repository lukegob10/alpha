# NOR-38: proportionate workflows

Issue: [Stage 1 — Implement proportionate workflows for simple and comprehensive tasks](https://linear.app/norval/issue/NOR-38), retrieved September 7, 2026.
Implementation baseline: `90bb4ea` on the current checkout. The working tree was clean at discovery.
Implementation and measurement results are recorded in [the evidence report](nor38-stage-one-evidence.md).

## Scope and ownership

Keep the current selected model and execution kernel. Consolidate normal workflow guidance, preserve outcome-specific
verification, and carry actionable failure causes through the existing tool scheduler and Task recovery path. Stage 2
model levels and progressive exposure remain outside this change.

Four coordinated lanes share this checkout with disjoint ownership:

1. Measurement: capture existing NOR-36 scripted class and request baselines before production edits, declare thresholds,
   then compare the candidate and record unavailable observations accurately.
2. Prompts: consolidate objective and overlapping guidance; preserve explicit broad coverage and evidence-driven expansion,
   allow grounded ordinary answers, and align completion/todo descriptions without mandatory extra calls.
3. Tool runtime: add bounded trusted failure metadata where causes are lost; retain unchanged blocker allowances across
   unrelated activity, distinguish safe repair from uncertain effects, and test the owning tool/scheduler/progress seams.
4. Integration: wire Task observation and actionable recovery guidance; add real Task regressions, review all changes,
   and run combined validation.

Production edits follow the unchanged-code baseline. Tool-runtime contract decisions precede dependent Task edits.
All lanes preserve `apps/cli/`, `packages/vscode-shim/`, dependencies, release versions, and saved-task formats.

## Acceptance declared before implementation

- All seven existing representative scripted class oracles and their workload counts must remain intact, including
  comprehensive, security, cross-component, and stale-context escalation cases.
- Conversation-grounded completion retains zero required tool calls. Existing request/provider/policy contracts remain
  covered; absent provider usage stays unavailable.
- Consolidated workflow prompt bytes decrease by at least 10% for the declared comparable prompt workload while retaining
  requested coverage, necessary unknowns, applicable checks, fresh evidence, and authority requirements.
- Repeated unchanged capability blockers cannot obtain new allowance through unrelated reads, writes, or generic progress.
  Relevant repair, optional failure, supported alternatives, pre-launch rejection, and uncertain effects require distinct
  deterministic cases. Error, denied, and cancelled outcomes cannot become successful evidence.
- Existing waiting, cancellation, durable tool transactions, approval, and canonical completion behavior must pass the
  owning regressions and integration gates.

Scripted choices establish runtime contracts, not improved model strategy. Broad 25% call and 20% input-token reductions
require appropriate repeated provider evidence. Record useful-answer and publication latency separately when observable;
do not attribute noisy concurrent test duration to an optimization.

## Validation

Run focused prompt, BaseTool/command, scheduler/repetition, Task recovery/completion, and verification tests, followed by
lint/typecheck for affected packages and `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`. Run managed-agent
certification when shared lifecycle/delegation contracts change. One host suite runs at a time. Record actual results and
external prerequisites in the final evidence document; unavailable gates never count as passes.

## Implemented boundary

The failure metadata is internal to the extension and accepts only bounded trusted runtime fields. Provider/tool text
cannot authorize recovery. The scheduler retains original tool receipts while Task uses the cause for guidance and the
existing suspension path. Ordinary primary answers and durable child handoffs retain their distinct completion contracts.

Known blockers retain per-operation allowances across unrelated activity. Successful terminal retries can resolve them
while allowance remains; a running command cannot. Unknown effects block replay even with repetition limits disabled,
and storage exhaustion stops safely. After allowance exhaustion, renewed same-operation attempts require explicit user
guidance because the current host has no trusted automatic prerequisite-repair receipt. Independent supported alternatives
remain available. Live-model strategy, billing, and latency acceptance remains pending an available test provider.
