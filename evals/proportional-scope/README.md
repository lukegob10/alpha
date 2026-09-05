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
- To attribute request usage, every `model_request_started` row needs an observer-supplied annotation `requestIndex`
  matching the corresponding usage row's `payload.requestIndex`. Both identities must be nonnegative safe integers, unique
  within the reported group, and match one-to-one. The canonical start event lacks this identity; never invent it from
  sequence numbers, row counts, or delivery order. Missing or invalid identities leave usage unavailable.
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
emits `tool_result`. Command counts depend only on canonical `execute_command` identity (`payload.name`, falling back to
`payload.tool`), independently of phase, category, and purpose. A discovery command categorized as a read still counts as a
command; a noncommand validation tool does not. Output sizes count UTF-8 bytes of the observed tool output or committed
visible assistant text; raw bytes are not retained. Repetition counts within a phase are local to that phase; total repetitions also detect matches
across phases and therefore need not equal the sum of the phase repetition counts.

Per-phase token metrics require canonical `request_usage` records matched by explicit request identity to each observed
model request in that phase. Missing, invalid, duplicate, or mismatched request/usage indexes invalidate usage coverage.
Complete empty groups retain zero input/output/cache-read usage. Aggregate usage is retained separately, never distributed
across phases by heuristic. Canonical request usage currently has no cache-write field, so phase cache writes remain unavailable. Exclusive
phase wall time also remains unavailable without an interval observer. Scripted fixture runs have no model usage records,
so their input/cache/output token costs are explicitly unavailable. A metric with `coverage: observed` is a partial
observation, not a complete task total; `coverage: unavailable` always has `value: null` and a reason.

## Real Task request capture provenance

The separate `apps/vscode-e2e/src/suite/proportional-context.test.ts` fixture requires the runner to supply
`ALPHA_SCOPE_RUN_METADATA` as JSON before launching the host. It contains `sourceRevision` (40-character Git commit),
`sourceTreeState` (`clean` or `modified`), `buildSha256` (SHA-256 of the **loaded extension's `dist/extension.js`**),
`configurationId` (a nonsecret label identifying the recorded initial profile and fixture overrides), and
`hostAtSuiteStart` (`fresh` or `reused`). For a modified source tree it additionally requires `sourceDiffSha256` covering
the full source delta, including untracked files. Prefer committing every measured source file and using a clean tree.
Do not mistake the current checkout commit for proof that it produced the loaded bundle: these fields are explicitly
runner declarations, and the runner must associate the build artifact with its source revision.

After building and compiling from the clean integration checkout, an example PowerShell setup is:

```powershell
if (git status --porcelain) { throw 'Use a clean measured checkout or supply a complete source delta digest.' }
$env:ALPHA_SCOPE_RUN_METADATA = @{
    sourceRevision = (git rev-parse HEAD).Trim()
    sourceTreeState = 'clean'
    buildSha256 = (Get-FileHash -LiteralPath src/dist/extension.js -Algorithm SHA256).Hash.ToLowerInvariant()
    configurationId = 'isolated-defaults-v1'
    hostAtSuiteStart = 'fresh'
} | ConvertTo-Json -Compress
```

Use the same configuration label only while the externally recorded profile/overrides are unchanged. Never pass the
credential-bearing settings object as provenance. The report allowlists the declared fields and rejects missing or
invalid identities. Run the targeted host fixture centrally with `--file proportional-context.test`; no host run is
performed by the support tests below.

Three new Tasks per scenario share one host across both scenarios. Reports include scenario and host sample ordinals and
state that provider prompt caching is disabled. They do not describe three cold-host runs. `emittedToolCalls` records
provider-emitted calls; observed terminal tool results and actual read evidence are checked separately. A successful
measurement is printed only after task disposal, cache eviction, configuration restoration, and fixture unlink complete.

```sh
pnpm exec tsx --test scripts/evals/proportional-context-support.test.ts
```
