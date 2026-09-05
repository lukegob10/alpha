# Proportional-scope quality and cost fixtures

These seven fixtures make conversation, lookup, edit, cross-component repair, security, audit, and escalation workloads
repeatable. `cases.json` supplies prompts, quality criteria, workspace snapshots, and focused Node test entrypoints. The
mutation fixtures deliberately start broken. They are not an admitted live-model benchmark suite.

The executable baseline is
`src/core/agent/__tests__/proportionalScope.integration.spec.ts`. It runs the real `AgentTurnEngine`, response accumulator,
`ToolScheduler`, and production `readWithSlice` against temporary copies of these workspaces. Fixture-only tool descriptors
perform real reads, edits, and Node test subprocesses. A controlled concurrent edit forces the escalation fixture to reject
a stale write, reread, and preserve the external addition on retry. Quality assertions verify test preservation, successful
validation, read-only workspace preservation, and the expected final answer or audit coverage. Setup/quality-oracle work
outside the task is excluded from task metrics.

The response stream is a fixed, public script, including calibrated repairs. Its observed call counts describe that script
on the real engine and scheduler; they do **not** measure model strategy, token savings, quality improvement, or production
approval/stale-write enforcement. The fixture host implements the stale-version check. It does not instantiate `Task`,
build production prompts, invoke an external model, exercise a real webview, or observe completion-stage gates. Run identical
fixtures and scripts when comparing revisions. Do not change scripted actions to manufacture a cost reduction. The small
fixtures complement the production scoped-read benchmark; they do not establish a timing improvement.

## Run

From the repository root with Node 20.19.2 and pnpm 10.8.1:

```sh
node --test scripts/evals/proportional-scope-report.test.mjs
pnpm --dir src test -- core/agent/__tests__/proportionalScope.integration.spec.ts
```

To save one privacy-safe report per case, set `ALPHA_SCOPE_REPORT_DIR` to an output directory before running the integration
test. Reports include the observed checkout commit/dirty status, fixture digest, and scripted configuration digest. The
test otherwise keeps its intermediate observations and reports inside its temporary directory and removes them afterward.

The first command also establishes that each mutation fixture's quality oracle fails in the initial state. The integration
test establishes that the calibrated repair passes the same oracle. These are fixture calibration assertions, not simulated
model successes. Read-only answer/audit assertions are deliberately narrower than a human review of arbitrary model output.

## Attribution contract

`scripts/evals/proportional-scope-report.mjs` consumes existing `EvalTraceEvent` records from the grading harness and the
aggregate usage names emitted by `packages/evals/src/cli/processTask.ts`. It projects an allowlist of enums, counters, and
digests. It never copies tool arguments, file contents, commands, paths, IDs, output text, or operation fingerprints.

```sh
node scripts/evals/proportional-scope-report.mjs observations.json report.json
```

An observation document contains:

- `fixtureId`, `measurementKind` (`runtime-observation`, `scripted-harness`, or `reporter-contract-test`), explicit
  `traceCoverage` (`complete`, `partial`, or `unavailable`), and `trace` in the existing normalized event shape.
- Optional `annotations`, keyed by unique trace `sequence`, with `phase` (`discovery`, `implementation`, `validation`,
  `finalization`, or `unattributed`). A phase comes from an observer; tool names never determine a phase. Unknown attribution
  remains in the `unattributed` bucket, and incomplete phase coverage is marked `observed`.
- Optional tool `category` (`read`, `search`, `mutation`, `validation`, `terminal`, `delegation`, or `other`) and orthogonal
  `purpose` (`ordinary`, `polling`, or `recovery`). Shell execution alone does not prove validation, polling, or recovery.
- Optional tool `fingerprint`: a 64-character lowercase keyed digest of the operation semantics and relevant content
  versions. Use a run-local secret key for real observations; the public integration fixture uses a public key because its
  inputs are public. Never include raw commands/paths. Missing fingerprints leave repetitions and reruns unavailable.
- Optional `usage` with existing aggregate `modelCalls`, `tokensIn`, `tokensOut`, `cacheReads`, `cacheWrites`, and `durationMs`.
  Optional `completionStage` numeric counters `candidateCount`, `rejectionCount`, `repairToolCount`, and `runtimeWaitMs` are
  reserved for an actual completion-stage observer; no values are inferred from assistant prose or tool names.
- Optional grading `graderDecision` (`passed`, `outcome_failed`, `safety_failed`, or `grader_error`) and explicit task
  `outcome` (`completed`, `blocked`, `failed`, or `cancelled`). Missing results remain `unavailable`.

`observedTotal` and all phase buckets expose model calls, terminal tool-result counts, categorized tool counts, command
counts, polling/recovery counts, tool-output bytes, committed assistant-text bytes, repetitions, validation reruns, and
completed compactions. Counts of `verification_result` are not added to tool counts because the same execution already
emits `tool_result`. Output sizes count UTF-8 bytes of the observed tool output or committed visible assistant text; raw
bytes are not retained. Repetition counts within a phase are local to that phase; total repetitions also detect matches
across phases and therefore need not equal the sum of the phase repetition counts.

Per-phase token metrics require canonical `request_usage` records covering each observed model request. Duplicate supplied
request indexes invalidate usage coverage. Aggregate usage is retained separately, never distributed across phases by
heuristic. Canonical request usage currently has no cache-write field, so phase cache writes remain unavailable. Exclusive
phase wall time also remains unavailable without an interval observer. Scripted fixture runs have no model usage records,
so their input/cache/output token costs are explicitly unavailable. A metric with `coverage: observed` is a partial
observation, not a complete task total; `coverage: unavailable` always has `value: null` and a reason.
