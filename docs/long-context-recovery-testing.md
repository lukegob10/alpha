# Long conversation recovery tests

The reported failures are loss of progress late in a conversation, `MODEL_NO_ASSISTANT_MESSAGES` warnings, and inability
to submit another question after completion. These symptoms are not yet established to share one cause.

## Coverage and hypotheses

The existing `long-thread` workflow accepts at most twelve user turns. The existing `provider-empty-recovery` scenario
injects one empty response into a fresh task; `context-compaction` manually condenses a short implementation thread.
Those checks do not exercise empty recovery or compaction after dozens of completed task lifecycles.

The opt-in `long-context-recovery` and `long-context-empty-exhaustion` scenarios use the existing real extension host, composer dispatch, guarded VS Code
LM adapter, canonical transcript/lifecycle inspections and independent repository grader. It performs:

1. Thirty-two completed probe turns in one retained task, with approximately 17 KB of unique inert synthetic data per
   user message. The first message supplies a fixed anchor; subsequent messages request that anchor and a unique receipt
   without restating its value. Completion is acknowledged before the next composer submission.
2. One deliberately empty response late in the same conversation. The fault interceptor observes and consumes real
   Copilot output before suppressing it; subsequent requests use the real provider normally. This is injected recovery
   evidence, not evidence that Copilot spontaneously returned an empty response.
3. Real-model context condensation after recovery, followed by another completed-thread question. The anchor must survive.
4. A code task in the same thread: fix the fixture's empty-array sum bug, run the required tests, and pass independent
   implementation and regression graders. Earlier probes must have preserved the fixture.

The exhaustion variant defaults to twelve probe turns so the known turn-18 compaction failure does not mask this
separate recovery test. It injects two consecutive empty responses, checks the visible warning and bounded retry count,
waits for the resumable failure boundary, and submits a new question before proceeding to condensation and the code fix.
It distinguishes recovery from one transient empty response from recovery after the automatic retry budget is spent.

Every stage checks actual same-task admission, paired tool calls/results and lifecycle receipts. Receipt checks reject
wrong or stale answers. Each completed stage writes an immutable `context-step-NNN.json` artifact with request counts,
elapsed time and heap usage, plus stored transcript size, summary count, warning count and answer correctness. The final
`reliability-observations.json` records all stages, and failures retain `reliability-failure-state.json`. Stored transcript
bytes are not active input tokens; use the canonical request-usage evidence to establish actual context pressure. The
test does not claim to reach a model's context limit merely because its transcript is large. An opt-in response probe
records part shapes, text character counts, tool-schema counts and stream EOF without retaining output text or opaque
provider payloads; this distinguishes a successful text summary from an empty or unsupported stream.

Requests, time, turn count and workspace authority remain bounded. The saturation scenario defaults to 32 probe turns and
allows 4–64 through `ALPHA_E2E_SCENARIO_TURNS`; other workflows retain their previous bounds. The stress scenario is
excluded from normal reliability matrices so it adds no routine live cost. It does not grant extra command authority.

## Run

Build the extension normally, then use an authenticated disposable test profile and an owned campaign directory outside
the source checkout. The checked-in campaign uses portable VS Code 1.136.1 with Copilot `gpt-5.6-luna`, high effort,
one sample per scenario, at most 180 requests overall and a 20-minute limit per attempt. Change the campaign ID for another run; configure an exact
available model explicitly. Do not point the portable-version configuration at an installed editor of another version.

```powershell
pnpm --dir apps/vscode-e2e test:campaign --config F:/roo-fork/Alpha-Code/apps/vscode-e2e/campaigns/long-context-recovery.json --root F:/alpha-vscode-e2e-runs/task-efficiency-20260909 --profile-dir F:/alpha-vscode-e2e-runs/20260906/profiles
```

Deterministic regression coverage lives in `longContextProbe.spec.ts`, `reliabilityDriver.spec.ts`,
`extensionWorkflowHost.spec.ts` and the existing fault-controller/contract tests. These validate bounded workload
construction, late fault placement, graded code execution, and request accounting. In particular, late recovery must
compare against the request count when the fault was armed; the old harness's `used > 1` condition could falsely treat
earlier requests as recovery. Production retry behavior is unchanged by that harness correction.

Run the exact VS Code 1.122.1 smoke gate for runtime fixes. Reproduce any live failure at a deterministic lower boundary
before changing production code. Preserve instruction authority, provider state, cancellation and complete tool receipts.

## Initial results

The first live attempt on September 9, 2026 (`long-context-recovery-11361`) failed the initial receipt after one request:
the prompt said the result should be exactly `<anchor> receipt-0`, and the model copied that placeholder literally.
This was a test-design failure, not a reproduction of the reported product bug. The prompt now explicitly asks for
the remembered value and prohibits printing a placeholder; the strict grader is unchanged. The failed evidence is retained.

The corrected workload `long-context-recovery-11361-v2` failed on turn 18, after 17 successful retained-task completions.
The canonical lifecycle moved through `compacting` to `failed` with `Failed to condense context`, then exposed
`resume_task`. This occurred before any fault injection. The diagnostic rerun `long-context-diagnostic-11361` reproduced
the failure on the same turn. Its eighteenth request had no tools, returned 664 text parts totaling 2,987 characters,
and ended normally. Copilot also logged that request as successful. The model had produced a nonempty summary.

A separate deterministic experiment reproduced rejection of a valid summary when model generation took longer than the
five-second token-counting allowance. The operation's tokenizer deadline previously continued to elapse during model
generation, so validation could fall back to a conservative byte count and reject an otherwise fitting summary.
An experimental change paused the unused tokenizer allowance during model generation. Its 481 focused condensation,
context, task and retry tests passed, but `long-context-fixed-11361` still failed on turn 18. A further diagnostic attempt
(`long-context-budget-diagnostic-11361`) also failed; its summary stream contained 3,355 text characters and ended normally.
The attempted fix and temporary runtime diagnostic were removed. No production compaction fix is claimed or retained.
The exact rejection point still requires investigation; nonempty wire text alone does not prove a usable canonical summary.

The short diagnostic `empty-exhaustion-diagnostic-11361` used four probe turns to isolate recovery from context pressure.
It passed with 13 requests: two injected empty responses reached the warning/resume boundary, a new question was
admitted in the same thread, real condensation completed, and the code fix passed independent grading. This proves that
particular short-thread recovery path, not the longer-thread or every-model case.

The default twelve-turn case ran as `empty-exhaustion-12turn-11361` on the restored production baseline. All twelve
probe turns completed, the two injected empties produced one warning and stopped at the retry budget, and a new question
completed in the same task. The subsequent manual-compaction operation rejected after approximately 17.2 seconds, using
request 16. The initial harness mislabeled this as `live_compaction_timeout`; a focused regression now distinguishes an
operation rejection (`live_compaction_failed`) from expiry of the ninety-second wait. This run did not reach the
post-compaction question or final code-fix grader and is recorded as failed, not passed. Its model observation reported
`contextWindow: 200000` and `maxTokens: -1` (the adapter's advertised value); configuration overrides were absent from
the API configuration snapshot. Effective profile defaults remain a variable to capture in further diagnosis.

All run artifacts are retained below `F:/alpha-vscode-e2e-runs/task-efficiency-20260909/<campaign-id>/host-evidence/`.
The restored extension bundle SHA-256 is `758ccad81db773f5b9ef54fb7b67a70a944b17f700dc996149fb176d091bd4a9`.
The two new scenarios are intentional live reproducers; neither is currently an all-green long-conversation release gate.

Final validation: the full harness unit run passed 357 tests with two skips; after the manual-rejection diagnostic fix,
all fourteen focused host tests passed. E2E package typecheck and lint passed. The full
`pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` gate passed all nine checks on the restored baseline.
The only retained changes from this investigation are test workloads, harness diagnostics, regression tests and this
document. The earlier task-efficiency edits remain untouched. No production fix or general model-quality improvement
is claimed. An independently unrestartable completed thread has not been reproduced; follow-up admission worked in
the measured stages, while both automatic and manual compaction supplied concrete failure points.

Live-model results are supplemental; one pass cannot establish reliability across models, naturally empty responses,
fully saturated contexts or host reloads. The production change must also pass the exact VS Code 1.122.1 gate.

## Implemented fix and repeat validation

The follow-up implementation identified the failure after summarization: Task's pre-installation checks counted the
entire saved rewind archive instead of the effective provider history. Manual, automatic and forced recovery now
validate the effective history while persisting the complete archive. Three deterministic tests reproduced the original
error before the fix. Reopen also now hydrates both histories before an instance-owned UI rewrite and rejects unreadable
existing UI history without replacing its bytes. See the
[implementation and validation report](compaction-recovery-implementation.md).

The stronger live matrix adds a real saved-task close/reopen after manual compaction, checks replacement of the Task
instance and preservation of summary count, then requires the correct anchor and independently graded code fix. A
separate two-process scenario verifies full extension-host restart. On September 9, 2026, both samples of all three
scenarios passed: long context used 41/41 requests, empty exhaustion 21/22, and full-host restart 6/5. The campaign
completed with 136 model requests and no failures or blocks. The exact VS Code 1.122.1 smoke gate also passed.

Use `apps/vscode-e2e/campaigns/compaction-recovery-validation.json` with the profile/root arguments above and a fresh
campaign ID for subsequent runs. Evidence is under
`F:/alpha-vscode-e2e-runs/task-efficiency-20260909/compaction-recovery-validation/`; its `validation-evidence.json`
summarizes actual model identity, bundle hash, every workflow result and six bounded compaction diagnostics. Earlier
failed runs remain evidence of the original bug. This is a reliability result for the covered paths, not a claim of
fewer model requests on ordinary coding tasks or proof that every naturally occurring empty response is resolved.
