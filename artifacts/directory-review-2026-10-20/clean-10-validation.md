# Clean-code review 10: validation, certification, and evaluation

Mode: full-surface review of the assigned validation domain; read-only source review. Target: trustworthy exact-host and evaluator gates connected to current production invariants. Score: **83/100**, medium-high confidence for reviewed scope. This is a code-quality assessment, not a measured Codex CLI convergence percentage.

## Findings

### 1. High — must-fix: focused Mocha selection can satisfy a complete exact-host gate

**Primary:** `apps/vscode-e2e/src/runTest.ts:193`; supporting owners: `apps/vscode-e2e/src/suite/index.ts:290`, `apps/vscode-e2e/src/suite/index.ts:296`, `apps/vscode-e2e/src/runFailure.ts:158`, `apps/vscode-e2e/src/harnessReceipt.ts:26`, `scripts/harness/host-evidence.mjs:117`.

`readRunOptions` inherits `TEST_GREP`, including when `--require-all-tests` is set. The host applies grep before Mocha reports test counts. The strict outcome check rejects pending tests, but tests excluded by grep are absent from counts, so a passing subset is accepted. The Mocha configuration also does not enable `forbidOnly`, permitting the equivalent accidental `.only` case. Receipts record the file and executed counts but omit filtering/focus selection; `hostSuiteVerdict` checks the expected file set, host identity, and provider without proving the entire file executed.

**Observed reproduction:** actual installed Mocha declared one passing and one deliberately failing test. Supplying the inherited grep selected only the passing test; production `testSuiteOutcome` returned counts `{total:1,passed:1,pending:0,executed:1,failed:0}` with no failure while `requireAllTests:true`. Separately, the production smoke receipt validator accepted all 13 expected file receipts containing only one passing test each. No VS Code host was launched for this probe.

**Impact:** a developer's inherited filter, a wrapper's `--grep`, or accidental `.only` can create green smoke/reference-host evidence while omitting assertions. A zero-match filter is rejected correctly; the defect requires a nonempty passing subset.

**Smallest correction:** separate focused execution from complete gate execution: reject or clear grep for canonical hard-gate commands, set `forbidOnly:true` in strict Mocha runs, carry the effective selection in the observed host receipt, and have whole-suite receipt admission require an unfiltered selection. Add a two-test regression where the omitted assertion fails.

### 2. High — must-fix: benchmark promotion accepts malformed or missing safety evidence

**Primary:** `packages/evals/src/benchmark/cli.ts:496`; owning comparison: `packages/evals/src/benchmark/convergence.ts:17`.

The operator-facing `gate --input` command directly casts parsed JSON to `FrontierConvergenceGate`; there is no runtime schema. Comparisons such as `input.safetyFailures > 0` and `input.infrastructureErrorRate > 0.01` evaluate false when values are absent or nonnumeric. The truthiness checks accept the string `"false"` as proof. `primaryModel` is never checked.

**Observed reproduction:** the production function returned `{promote:true,reasons:[]}` for `{harnessCertified:true,smokePassed:true,fullyPaired:true,predictedSegmentImproved:true,holdout:{total:12}}`, with every regression/safety/performance metric and the model omitted. A second payload using `"false"` for the booleans and `"invalid"` for numerical metrics also promoted. This input reaches the function unchanged through the CLI's JSON cast.

**Impact:** incomplete, stale-format, or malformed promotion JSON yields positive release-quality advice without the evidence the gate claims to require. This does not itself publish an extension.

**Smallest correction:** define and parse a strict Zod schema at the JSON boundary with actual booleans, the required model enum, finite numerical metrics, integral nonnegative counts, bounded rates, and coherent holdout fields. Reject incomplete reports and add malformed/missing-field rejection tests alongside the current happy-path assertion.

### 3. Medium — should-fix: the live evaluation CI path exits successfully after infrastructure failures

**Primary:** `packages/evals/src/cli/runEvals.ts:92`; callers: `packages/evals/src/cli/runCi.ts:40`, `packages/evals/src/cli/index.ts:44`, `.github/workflows/evals.yml:52`.

The CI runner creates ordinary runs with no campaign cost cap. For these runs `createTaskRunner` catches every task rejection, logs it, and resolves. `queue.onIdle()` then leads to `finishRun` and normal return regardless of why task execution failed. The CLI explicitly exits zero after that return. Governed runs correctly rethrow; the workflow's `--ci` path uses the best-effort branch.

**Observed reproduction:** a deterministic import-boundary probe used the real `runEvals` scheduler with one task whose process function rejects `host startup unavailable`. It resolved, called `finishRun`, and cleaned up normally. The existing test at `packages/evals/src/cli/__tests__/runEvals.governance.spec.ts:474` explicitly preserves this resolution behavior after task failure; it does not verify that CI separately rejects infrastructure-invalid results.

**Impact:** a broken provider login, host launch, grader infrastructure, or missing prerequisite can produce a green Evals workflow with no valid agent evaluation. Ordinary functional task failures should remain measurable results and need not fail a measurement campaign.

**Smallest correction:** continue independent tasks if desired, retain classified task execution errors, and make CI return a nonzero exit after cleanup whenever execution/evidence is infrastructure-invalid or trials remain incomplete. Keep functional `outcome_failed` trials distinct from harness errors and add a `runCi` aggregate failure test.

## Evidence and strengths

- Exact VS Code 1.138.0 and minimum 1.125.0 commands are present and independently selected. The actual host version is checked against the requested version in the host, and mismatched versions cannot substitute for one another.
- Both normal CI and the release workflow invoke exact reference-host and minimum-host compatibility commands. The release flow also runs static, unit, tooling, evaluator, extended feature, managed-agent confidence, and independent task-outcome lanes before packaging.
- The current harness has meaningful safeguards: source/toolchain/time-bound execution receipts, file inventories, skipped-test rejection for required lanes, real host ancestry, observed completion, evidence retention, and independently asserted scripted repository outcomes. These are substantially stronger than exit-code-only test wrappers.
- Evaluator orchestration has focused lifecycle/error tests; governed paid scheduling explicitly stops on unknown spend, invalid evidence, cancellation, and unsafe terminal outcomes. The legacy CI error swallowing above is a bounded inconsistency, not a claim that every evaluator path is permissive.
- Certification safety scenario labels are simulated decisions in `packages/evals/src/certification/runner.ts:121`, not proof of real path/network denial. The catalog accurately calls this evaluator certification; do not treat it as Alpha security or Codex convergence evidence. This is a coverage limitation, not an additional defect.

## Validation performed

Ran only small offline deterministic probes against current production functions and installed Mocha. Reproducible script: `artifacts/directory-review-2026-10-20/clean-10-validation-repro.cjs`; command: `node --require=tsx/cjs artifacts/directory-review-2026-10-20/clean-10-validation-repro.cjs`. No broad suites, actual VS Code launches, model calls, service calls, installations, or source/test changes were made by this reviewer. The parent is coordinating real exact-host and type checks.

Reviewed: `apps/vscode-e2e` runner/options/strict counts/host receipts, representative host and runner tests, `scripts/harness` catalog/admission/inventory/evidence paths, managed-agent certification composition, evaluator certification/runtime probes, evaluator CI scheduling, benchmark convergence input, and QA/release/evals workflow wiring.

Blind spots: no live-provider quality run, no browser-rendered UI acceptance, no Docker/Postgres/Redis execution, no full scan of every test assertion, no measured flake rate, no claim that reference-host smoke has passed in this checkout. Existing user changes in compaction/provider/UI tests were preserved; they were not judged as newly introduced review defects.

Closure: fixed now — none (audit-only scope); flagged for follow-up — the three findings; not verified — live quality and full host execution delegated to parent; out of scope — runtime fixes and sandbox implementation alignment.
