# Task efficiency and verification UX

Investigation date: September 9, 2026. Alpha source: `127978c916897dd532b80ddfdb789f00f5a308fb`.
Scope: extension behavior and a proposed implementation sequence. No runtime change or new performance claim.

Implementation status is recorded below; the investigation findings describe the original source revision.
Latest validation: four live candidate workflows passed on the separate VS Code 1.136.1 host, and all nine exact-host
VS Code 1.122.1 smoke tests passed; see the final section.

## Findings from current code

- [Objective instructions](../src/core/prompts/sections/objective.ts) already call for the smallest complete workflow,
  optional planning, scoped verification, evidence reuse, and an end to open-ended improvement loops. Adding another
  general instruction to be efficient would duplicate existing guidance.
- [Environment reminders](../src/core/environment/reminder.ts) still suggest creating a TODO for tasks with multiple
  steps and emphasize updating it whenever task status changes. This is broader than the optional staged-work guidance
  in the [TODO schema](../src/core/prompts/tools/native-tools/update_todo_list.ts). A small read/edit/check task qualifies
  as multiple steps. This is a concrete prompt inconsistency; its effect on model decisions needs measurement.
- [ToolRepetitionDetector](../src/core/tools/ToolRepetitionDetector.ts) recognizes repeated outcomes, but new scoped
  reads, semantic states, or admitted evidence reset stagnation. Its existing progress test deliberately allows forty
  distinct reads. This preserves legitimate investigation, but does not determine whether exploration still serves
  the requested outcome. Novelty and useful progress are different properties.
- With the default mistake limit of three, the detector's default stagnation window is six calls, followed by a stop
  at twelve stagnant calls. This is a recovery safeguard, not an efficient workflow target. Lowering the shared mistake
  setting also affects error recovery, so it is not a clean solution to excessive successful investigation.
- [AgentTurnEngine](../src/core/agent/AgentTurnEngine.ts) already allows visible assistant text to finish a turn when
  continuation is unnecessary. Alpha does not universally require a ceremonial completion tool call.
- `Task.getOpenTodoCompletionDecision` makes unfinished TODOs a completion blocker only when
  `preventCompletionWithOpenTodos` is enabled; it defaults to false. Preserve an explicit user setting. Do not assume
  this option explains the reported session without checking its configuration.
- [CompletionRecovery](../src/core/agent/CompletionRecovery.ts) already bounds repeated completion rejection and
  unsuccessful checks against unresolved verification debt. That accounting starts after completion rejection; it
  cannot by itself limit optional verification while the model still elects to continue working.

These mechanisms are plausible contributors, not a reproduced diagnosis of the user's particular task. This
investigation did not inspect that task's transcript, installed bundle, model, effort setting, or effective rules.

## Existing measurement

The [September 7 investigation](nor38-performance-investigation.md) reports 139 candidate model requests versus 135
baseline requests across eighteen live workflows, all passing. It explicitly establishes no request-efficiency gain.
The comparison used VS Code 1.136.1 with Copilot GPT-5.6 Luna at high effort, with limited samples and uncontrolled
machine contention. It is historical evidence, not a benchmark of this checkout or an exact-host acceptance result.
[NOR-36](nor36-efficiency-implementation.md) reduced local request preparation, not model-selected calls.

## What upstream sources establish

Sources below were retrieved September 9, 2026. Public guidance/source does not establish comparative speed.

| System   | Relevant observed behavior                                                                                                                                                                                      | Application to Alpha                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Codex    | The published prompting guide skips planning for straightforward tasks, groups independent reads, and permits plans to close as done, blocked, or cancelled.                                                    | Remove unnecessary planning nudges; avoid self-created obligations.                       |
| Cursor   | Documentation recommends direct Agent use for quick changes and Plan Mode for complex work. Its Agent overview explicitly allows unlimited tool calls and describes model-specific instruction/tool tuning.     | Adapt workflow to scope; do not assume a universal call cap explains Cursor's UX.         |
| oh-my-pi | Its public loop handles tool continuations, queued input, optional deadlines, bounded paused-turn continuation, and bounded forced-tool escalation. It yields when no further work/input requires continuation. | Keep continuation reasons explicit and recovery bounded; preserve terminal tool receipts. |

Sources: [Codex prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide),
[Cursor Plan Mode](https://cursor.com/docs/agent/plan-mode),
[Cursor Agent](https://cursor.com/docs/agent/overview),
[oh-my-pi agent loop, main as retrieved](https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/agent/src/agent-loop.ts).
The Codex guide is published example guidance, not proof of the exact prompt in every current Codex client.
The oh-my-pi source supports the listed controls, not a claim that it eliminates verification loops.

## Proposed implementation sequence

1. **Remove conflicting planning pressure.** Align the environment reminder with the existing objective and TODO
   schema: no absence-of-TODO warning; tracking is useful for substantial independent stages; update after meaningful
   stage transitions. Make the verification stopping instruction concrete: after affected required checks pass,
   repeat or broaden only for changed inputs, a failure, an unresolved requirement, or an explicit request.
   Preserve all repository-required validation. Measure this small candidate before expanding it.
2. **Expose the work already done.** Project existing execution/check evidence into a compact progress display:
   exploring, editing, checking, or blocked; model requests and elapsed time; completed checks and remaining checks.
   Phase labels are observational and must not become a second lifecycle engine. Do not infer success from a green
   command exit alone when the established evidence contract requires more.
3. **Make repeated verification evidence useful before completion.** Extend existing command/evidence boundaries to
   present a concise receipt for a matching successful check. Matching needs command identity, working directory,
   relevant content/configuration/dependency versions, and applicable scope. External changes invalidate affected
   evidence. Unknown dependencies or stateful/network checks require fresh execution. Initially advise reuse;
   do not silently suppress arbitrary commands or fabricate a new successful execution receipt.
4. **Separate investigation limits from failure limits.** Add a bounded advisory signal when exploration or optional
   checking continues without closing a known requirement. A new filename alone should not erase that advisory history.
   Research and audits need broader exploration, so avoid an unconditional first-edit deadline or a fixed low call cap.
   Any eventual hard budget must pause with an honest incomplete result at a safe boundary, preserving pending tools,
   cancellation, descendants, and resumption. Extend the existing detector/kernel rather than creating another runner.
5. **Provide a useful intervention.** Add a stop-and-summarize action: retain changes, settle/cancel owned operations,
   and report what is done and what remains unverified. Never label skipped required checks as passed. Keep ordinary
   interruption available. Consider optional time/request budgets only after the counters and recovery behavior work.

The default experience should need no new effort selector: small changes proceed directly; larger work has a short
plan and explicit completion evidence. A future depth preference must not weaken permissions or required checks.

## Validation and acceptance for implementation

Use the existing extension campaign infrastructure. Before editing, declare paired workloads for a one-line text
change, a small bug, a multi-file feature, a legitimate broad investigation, and a verification failure with an
external edit. Hold model, effort, fixtures, instructions, cache conditions, and grading constant.

Record model requests before first edit (editing tasks only), total requests, commands, duplicate unchanged checks,
time to first useful edit, verification time after the last edit, completed-work quality, and provider usage when
available. Keep failures in the results. Scripted tests prove policy behavior; adaptive model runs are necessary to
measure model-selected call reductions. Do not claim savings from smaller prompt bytes alone.

Targeted regressions must preserve legitimate exploration, required checks, changed-input reruns, cancellation,
completion with pending input, and durable tool transactions. Run owning tests, lint and typechecks for touched
packages; run the exact VS Code 1.122.1 smoke gate for runtime/webview changes. No tests or host gates were run for
this documentation-only investigation; local references and claims were checked against the current source.

## First implementation: direct work and bounded verification

Implemented September 9, 2026 after the investigation, following the published Codex/Cursor guidance above.
This first candidate changes the shared prompt/environment path, without a new execution engine or hard call cap:

- Empty or absent checklists produce no reminder field. Clearing a previous checklist emits the existing incremental
  retraction once; it does not ask the model to create another list.
- Existing checklist contents, statuses, and escaping remain intact. Tracking guidance groups updates at meaningful
  stages or final response instead of encouraging updates after each tool.
- The objective explicitly skips TODOs for simple read/edit/check work, directs execution once context is sufficient,
  and stops verification after affected required checks pass. Changed inputs, failures, unresolved requirements, and
  explicit requests justify further checks. Repository requirements, fresh-read safeguards, and completion gates remain.

Regression-first validation produced seven expected failures and forty-five passes before production edits. The final
environment, objective, tool-use, and existing prompt-size suites pass **76 tests across eight files**. Extension
typecheck, extension lint, and `pnpm bundle` pass. The webview build also completed while preparing the baseline host.
These checks establish the emitted instructions and context behavior, not improved model choices.

The requested exact VS Code 1.122.1 smoke command and a subsequent candidate host run were blocked before test
execution: the installed VS Code updater holds `vscode-updating`, and the host exits after its thirty-second wait.
The installer was not stopped or bypassed. The live comparison protocol selected existing `dev-git-inspect` and
`review-edit-test-commit-followup` fixtures, two samples each, Copilot GPT-5.6 Luna at high effort, at most 100 requests
and twenty minutes per campaign with a five-minute attempt timeout.

The first campaign location was rejected because disposable workspaces cannot be inside the source repository;
the runner returned missing cleanup/retention evidence, and that attempt is not a live-model measurement. The
corrected campaign uses `F:/alpha-vscode-e2e-runs/task-efficiency-20260909` and the pre-existing dedicated test profile.
It also stopped before a valid host preflight: zero passed workflows, one infrastructure-blocked attempt, complete
evidence retention, and unavailable model usage. Its run receipt confirms host exit but not successful activation.
No paired efficiency result is established. Before resuming comparison, rebuild and fingerprint both source variants:
the tentative saved baseline bundle contained candidate instructions and was rejected as comparison evidence.

The proposed progress UI, stop-and-summarize control, and additional runtime evidence policy remain separate follow-up
work. This candidate deliberately measures the smaller Codex/Cursor-style instruction change first.

### Alternate live host attempt

At the user's direction, the candidate was also tested with the installed **VS Code 1.136.1** executable and existing
`F:/alpha-vscode-e2e-runs/20260906/profiles/1.136.1` Copilot profile. Campaign `efficiency-candidate-11361` uses the same
fixtures, model, effort, samples, and budgets as the planned 1.122.1 comparison. It returned one infrastructure-blocked
attempt, no passed workflows, unavailable model usage, and complete evidence retention. The candidate extension bundle
SHA-256 remained `758ccad81db773f5b9ef54fb7b67a70a944b17f700dc996149fb176d091bd4a9` across the attempt.

The profile's `user-data/logs/20260909T201035/main.log` establishes the cause: `vscode-updating` remained held after
31,393 ms, then VS Code exited with “Code is currently being updated.” A direct diagnostic launch also exited before
host preflight; its retained run ID is `f26937fb-783f-45a2-9f5e-49370d4891fd`. The updater lock affects both tested host
versions. No Alpha/Copilot workflow or before/after efficiency comparison completed, and no speedup is claimed.

### Successful portable-host live validation

After the update completed, the installed editor was 1.137.0. A retry against the installed executable was rejected
before the sidecar receipt because its expected version was 1.136.1. The failed run's lease was cleared only after
verifying its runner and all processes using that dedicated profile had exited. The runner then downloaded a separate
1.136.1 host and reused the existing authenticated 1.136.1 profile, preserving the host-version check.

Campaign `efficiency-candidate-11361-portable` completed all four original candidate samples, with zero failures or
blocked workflows and complete retained evidence. The model was Copilot `gpt-5.6-luna`, effort `high`. The extension
bundle hash remained the candidate hash recorded above.

| Workflow                           | Sample 1 requests | Sample 2 requests | Outcome     |
| ---------------------------------- | ----------------: | ----------------: | ----------- |
| `dev-git-inspect`                  |                 6 |                 6 | Both passed |
| `review-edit-test-commit-followup` |                16 |                16 | Both passed |

Total: **44 model requests**. Workflow elapsed times were 72.3/52.0 seconds for inspection and 84.0/84.8 seconds for the
edit/test/follow-up workflow; those include host/setup and grading overhead, not just model latency. Provider token and
cost metrics were unavailable. The final raw report is
`F:/alpha-vscode-e2e-runs/task-efficiency-20260909/efficiency-candidate-11361-portable/report-00007.json`.
This establishes live correctness on these fixtures, not fewer requests relative to the old prompt: no valid paired
baseline completed. Earlier blocked infrastructure attempts remain recorded and are not passing samples.

After the live campaign finished, `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221:run` passed against the existing
fresh extension/webview builds: three extension tests, two mode tests, and four VS Code LM contract tests. All three
test hosts reported actual VS Code 1.122.1 and successful exit. This completes the previously blocked exact-host gate.

### Trace-based next experiment

Follow-up inspection of the retained first sample of each successful live workflow explains what the aggregate counts
measure. The inspection transcript has five separate model responses calling the five required Git commands, followed
by one `attempt_completion` response. The fixture explicitly requires all five commands and prohibits shell composition.
It does not prohibit emitting several separate tool calls in one response; the workflow approval adapter already
matches commands within a response batch. There are no TODO calls in that transcript.

The sixteen-request transcript covers four user turns, not a single small edit:

| User turn | Requests | Observed work                                              |
| --------- | -------: | ---------------------------------------------------------- |
| Review    |        2 | Batched reads of implementation/test; answer               |
| Fix       |        4 | Batched reads; patch; required test; completion            |
| Commit    |        5 | Diff; stage; commit; status; answer                        |
| Follow-up |        5 | Batched reads; two file patches; required test; completion |

There are no TODO calls or repeated successful tests against unchanged work in this sample. Re-reads at a new user turn
must not be suppressed without checking the existing freshness/authority contract. These fixtures establish correctness
and transaction handling, but do not reproduce the reported long verification loop.

The next bounded experiment should distinguish model-call batching from effect concurrency. Request independent,
already-known read-only command calls together, while preserving the scheduler's serial terminal execution and every
approval/result boundary. Five command calls in one response plus a final response would give an illustrative target of
two model requests for the inspection fixture; this is an unmeasured target, not an achieved reduction. Keep all five
required commands and fixture assertions unchanged. Do not batch diff-dependent edits, stage/commit dependencies, or
commands whose arguments depend on earlier output.

A second candidate is using the existing multi-file patch capability for independently known edits instead of separate
model round trips, preserving stale-content checks and partial-failure reporting. To address the original complaint,
also add outcome-oriented small-change and larger-change fixtures whose prompts do not prescribe the workflow, with
independent correctness graders and metrics for pre-edit requests and unchanged verification repeats. Preserve current
host-contract fixtures. Compare each candidate separately against the same frozen source/model/effort and include
failures; do not claim an improvement from fewer required checks or an easier grader.

### Explicit read-call batching experiment

Experimented with a shared Code/Plan prompt clarification: independent read-only calls with already-known arguments should
share a response as separate calls, including permitted inspection commands. Command execution and approvals remain
serialized by the existing host. Dependent calls wait for results; mutations and control-flow operations are excluded.
Shell composition is not a substitute for batching. No scheduler, approval, provider, fixture, or grading changes were
made. Multi-file patch guidance is deferred to keep this experiment attributable to one change.

The baseline is the successful `efficiency-candidate-11361-portable` campaign above (6 requests per inspection and 16
per four-turn edit workflow, two samples each). The candidate campaign is `efficiency-batching-11361-portable`, with the
same two scenarios, sample count, portable VS Code 1.136.1, authenticated profile, Copilot model/effort and budgets.
Candidate extension bundle SHA-256: `343a2e858157a0f48e1436332cc58f042259188636c58cb15ee6b500ae5e4c4a`.
Primary metric: model requests per passing workflow, retaining every failed/blocked attempt. Wall time is supplemental;
cache and live service variability are uncontrolled. The two-request inspection target remains a hypothesis until
the live trace demonstrates all five required calls and a passing independent grader.

Validation: the two new prompt-contract tests failed before the change and passed afterward. All 147 focused tests
passed across environment, objective, tool-use guidance and scheduler suites, including ordering, approval and
cancellation coverage. Extension typecheck, lint, touched TypeScript formatting and extension bundle passed.

The live campaign completed with four passes, no failures or blocks, and complete retention. Results:

| Workflow                          | Baseline requests (two samples) | Candidate requests (two samples) | Candidate elapsed milliseconds |
| --------------------------------- | ------------------------------- | -------------------------------- | ------------------------------ |
| Git inspection                    | 6, 6                            | 6, 6                             | 83,880; 54,892                 |
| Review/edit/test/commit/follow-up | 16, 16                          | 17, 16                           | 99,449; 91,134                 |

Total requests increased from 44 to 45. No request reduction was observed; these small live samples do not establish a
general regression or accuracy equivalence either. All original correctness graders were unchanged. Retained report:
`F:/alpha-vscode-e2e-runs/task-efficiency-20260909/efficiency-batching-11361-portable/report-00007.json`.
The first candidate inspection transcript still issued five individual command responses followed by completion.

Decision: remove the experimental clarification and its two tests; preserve the earlier checklist/verification changes.
Do not accumulate ineffective prompt instructions. No new efficiency improvement is claimed or shipped from this
experiment. The final source therefore returns to the previously validated baseline. The stronger next investigation
is a representative outcome-based workload that actually reproduces excess discovery or unchanged verification, with
per-phase request metrics. A tool-surface change should be evaluated separately and preserve command-level approvals,
cancellation and result receipts; this experiment does not justify relaxing those boundaries or changing the grader.
