# Lookup-efficiency measurement contract

21 September 2026. Sibling of the [NOR-36 independent efficiency acceptance](nor36-efficiency-acceptance.md). This document owns measurement of production-shaped **“where does X live?”** lookups. It does not block NOR-70–74, does not change the seven proportional-scope fixtures or their scripts, and does not revive NOR-36’s unproven 25% tool / 20% token targets.

The NOR-36 scripted **narrow lookup** class remains **2 model requests / 1 tool result** on a fixture oracle. That is not a live-model budget. Lookup-efficiency scripted traces prove this reporter and contract only.

## What is measured

Each sample projects allowlisted counters from existing `EvalTraceEvent` records (see `packages/evals/src/grading/types.ts` and the normalization in `packages/evals/src/cli/processTask.ts`). Reports never copy prompts, secrets, tool arguments, file bodies, commands, paths, IDs, or output text.

| Counter                                              | Source                                                                                       | Missing value                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Provider requests                                    | `agent.turn.model_request_started`                                                           | `unavailable` when the trace is unavailable; `0` only on a complete empty trace |
| Provider retries                                     | `attempt > 0` on those starts, else `retry` events                                           | `unavailable` when starts lack attempt identity                                 |
| Tool results by name                                 | `agent.turn.tool_result` (`payload.name` or `payload.tool`)                                  | Unknown names become `other`; arguments are dropped                             |
| Distinct search tools                                | `codebase_search`, `search_files`, `list_files`, `shell` (`execute_command` maps to `shell`) | Command text is not inspected                                                   |
| First tool                                           | First terminal tool result, allowlisted                                                      | `null` on a complete empty trace                                                |
| Skill / ticket / spawn / todo / `attempt_completion` | Allowlisted tool names                                                                       | `0` only when the trace is present                                              |
| Completion rejections and reason codes               | Observer `completionStage`                                                                   | `unavailable`; unknown codes are not copied                                     |
| Reasoning tokens                                     | Adapter `usage.reasoningTokens` or complete `requestUsage` rows                              | `unavailable`, never zero-filled                                                |
| Local reasoning estimate                             | `usage.localReasoningTokenEstimate`                                                          | Separate field, labeled `local-estimator`                                       |
| Time to first grounded answer / durable completion   | Observer `timing`                                                                            | `unavailable`                                                                   |
| Backgrounded commands at first answer                | Observer `completionStage` or `timing`                                                       | `unavailable`                                                                   |

Identity on every report: git SHA, dirty flag, model id, reasoning preference, cache warm/cold, sample count declared **before** the run, `measurementKind`, and `traceCoverage`.

`measurementKind` values: `scripted-harness` (CI shape), `reporter-contract-test` (golden/failure-mode fixtures), `runtime-observation` (production Task evidence), `live-supplemental` (recorded Copilot or other live samples). Scripted and contract traces must not be labeled live.

## Frozen prompt set

Four generic prompts against tiny synthetic workspaces (`evals/lookup-efficiency/`):

1. Where is a named function defined? (positive; decoy similarly named function)
2. Which file writes a named output path? (positive; generic recorder, not this product’s logs)
3. Does this repository contain a named missing symbol? (negative)
4. What does a README-stated config key default to? (decoy unused default)

Do not retune the prompts against a candidate. Quality criteria and `expectedAnswerKey` live in `cases.json`. Status is `unadmitted`. Subset: `evals/subsets/lookup-efficiency-v1.json`.

## Predeclared acceptance

Declared before a baseline is in hand; revise rather than invent a percentage claim:

- Lookup samples finish in **≤3 provider requests** and **≤4 tool results**
- First tool is `search_files` or `read_file` or one `codebase_search`
- Zero skill, ticket, spawn, todo, and `attempt_completion` results
- First grounded answer without a completion rejection

If the measured baseline is already near this bar, tighten it. Do not treat a single live run as a general quality improvement.

## Pairing

`scripts/evals/lookup-efficiency-pair.mjs` admits reference vs candidate reports on the **same prompt ids** and predeclared sample count. It reports medians and per-sample request/tool vectors. It rejects mismatched prompt sets and a missing candidate sample. Model id, reasoning preference, and known cache state must match. Revisions may differ. Unavailable paired counts stay `unavailable`; they are not a zero delta.

## Live capture without a NOR-48 adapter

A documented wrap of existing evidence is success. Do not finish the unimplemented NOR-48 live eval adapter as a new runtime.

1. Declare sample count, model, reasoning preference, and cache state first.
2. Run the frozen prompts in the real extension. Live Copilot uses the existing campaign `--provider live-copilot` path (`docs/core-confidence.md`, `apps/vscode-e2e`). Evals VS Code execution uses `processTask`, which already reads `agent_turn_events.jsonl` and normalizes it to `EvalTraceEvent`.
3. Keep the **raw** JSONL. Campaign `*.projection.json` hashes tool names and is insufficient for this reporter.
4. Wrap each sample as `observations.json` (`fixtureId`, identity, `trace`, optional `usage` / `completionStage` / `timing`) and project with `scripts/evals/lookup-efficiency-report.mjs`.
5. Pair reference (main-equivalent source, or a recorded failure trace) against the candidate after NOR-69 children land.

Optional observer fields: `usage.reasoningTokens`, `usage.requestUsage[].reasoningTokens`, `usage.localReasoningTokenEstimate`, `completionStage.rejectionCount`, `completionStage.lastReasonCode` (allowlisted), `completionStage.backgroundedCommandsAtFirstAnswer`, `timing.firstGroundedAnswerMs`, `timing.durableCompletionMs`.

## Residual gap

There is still no admitted live Copilot adapter that schedules these four cases, records usage/completion-stage metrics automatically, and lands paired evidence in CI. Until that exists, live samples remain **supplemental**, operator-wrapped, and excluded from NOR-36’s scripted 2/1 oracle. Postgres/Redis and exact-host smoke are not part of this measurement.

## Validation

```sh
node --test scripts/evals/lookup-efficiency-report.test.mjs
```
