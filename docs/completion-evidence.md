# Completion evidence and plan updates

Both an ordinary final answer and `attempt_completion` use `Task.getCompletionGateDecision()`. Declared work-plan
checks require an observed successful command, matching working directory, and unchanged declared input bytes.
Missing evidence produces the `Declared acceptance checks need attention` diagnostic. Three model completion
attempts against the same unresolved obligation reach the bounded recovery stop and expose Continue. A visible
assistant answer by itself does not establish that this gate accepted completion.

Repairable text-answer rejections return feedback to the model without displaying a terminal error, matching
`attempt_completion`. The task remains active and cannot complete until verification succeeds. A non-repairable
rejection or exhausted repair allowance still displays an error and offers recovery.

An `unavailable` receipt means input evidence could not be captured, even if the command exited successfully.
Declared inputs must be individual workspace files, not directories or glob patterns, and remain subject to ignore,
path-containment, and content-size limits. Receipts now retain an optional, bounded host diagnostic in the working
record and completion feedback so the agent can address the cause before trying to finish again. Native filesystem
error text is not retained. Older receipts without a diagnostic remain readable; no missing evidence is inferred.

## Current tool-progress continuation policy (2026-09-28)

The older screenshot and several deterministic reproductions exposed a broader loop mismatch. At the default provider
profile setting of three, Alpha used to suggest a new strategy after six tool outcomes with no recognized state or
verification delta and then suspend the task after twelve. This counted successful `update_todo_list`, MCP, repeated
reads, and other tool results even when the model had more work to do. The detector's knowledge of progress is partial:
absence of a recognized delta does not establish that the requested task is blocked.

`ToolRepetitionDetector` now issues one bounded strategy suggestion and continues passing terminal tool results to the
model. Fresh admitted evidence clears the advisory window, and compaction retains it. `Task` no longer turns a
no-progress or unchanged opaque-result guess into a blocked task. The provider profile's Error & Repetition Limit still
controls the mistake dialog and the advisory threshold. Its UI description now distinguishes those behaviors. Known
failed operations retain their per-operation retry block; a rejected retry returns corrective feedback without pausing
independent repair or inspection. Unknown effects still require verification before replay.
Completion obligations, cancellation, provider failures, approval decisions, and explicit user stops retain their own
lifecycle boundaries.

This is the same continuation principle as the current Codex CLI turn loop: when a sampled response needs tool
follow-up or pending input exists, the turn continues; [stop hooks run only after that continuation is clear](https://github.com/openai/codex/blob/f5430515a8acf9251f60cacae6c86ae43686c960/codex-rs/core/src/session/turn.rs#L3178-L3230).
Codex also [returns a non-fatal tool-dispatch error to the model for follow-up](https://github.com/openai/codex/blob/f5430515a8acf9251f60cacae6c86ae43686c960/codex-rs/core/src/stream_events_utils.rs#L2101-L2147).
The [pinned source](https://github.com/openai/codex/blob/f5430515a8acf9251f60cacae6c86ae43686c960/codex-rs/core/src/session/turn.rs#L3383-L3398)
was retrieved 2026-09-28. This comparison concerns turn continuation, not a claim that every Codex CLI policy matches
Alpha's retry and verification rules. The screenshot's exact task transcript remains unavailable, so the historical
failure is reproduced at the shared Task boundary rather than attributed to an unobserved individual command.

The stopping policies are **partially aligned, not fully converged**. Alpha still has a default three-mistake dialog,
one advisory based on recognized progress, scoped retry blocks, and completion-evidence obligations. Those are Alpha
policies with no claimed Codex CLI equivalent. Safety and durability failures can still stop a task. Further convergence
requires auditing each policy's reason to interrupt the turn; removing the old twelve-outcome stop alone does not prove
parity for primary tasks, launched tasks, or managed children.

## Successful commands incorrectly treated as a stalled loop

Investigated 2026-09-18 against the 2.1.48 working tree. The screenshot's exact message,
`Task remains incomplete: repeated tool outcomes produced no new state or verification evidence`, is emitted by
`Task.recordToolCallForStopping()` after `ToolRepetitionDetector.recordOutcome()` returns `stop`. This is a host-imposed
pause, not a provider termination or a model's final answer. The task loop persists pending results, reports an
incomplete outcome, and offers recovery without claiming successful completion. That is why work and file edits can
be present while the activity never reaches the successful completion boundary.

With the default consecutive-mistake setting of three, the detector asks the model to change strategy after six
unrecognized outcomes and stops after twelve. These are tool-result counts, not API-request counts. Before this fix,
different successful commands could consume this entire allowance. `CommandExploration` deliberately recognizes
only a bounded grammar of Git and ripgrep inspections; PowerShell reads, pipelines, multiline commands, Python/Node
scripts, and ordinary project commands can fall outside it. In the absence of fresh independently admitted state or
verification evidence, that absence of instrumentation was incorrectly treated as evidence of stagnation.

Earlier fixes renewed progress on user follow-ups and admitted passed acceptance receipts. They did not address this
case within a single user turn. Extending a shell parser for every legitimate command would preserve the underlying
mistake: an unrecognized successful operation is not necessarily repeated or unproductive.

The detector now remembers bounded operation identities for successful, finished commands without semantic metadata.
A previously unseen operation permits continuation without clearing existing strikes or granting verification credit.
Repeating those commands still consumes the allowance; timeouts, verification associations, execution IDs, and changing
stdout cannot manufacture a new operation. Supported inspections retain their semantic identities. Known failures,
uncertain effects, running commands, cancellation, approvals, and declared acceptance requirements retain their existing
boundaries. This is a continuation heuristic, not an assertion that arbitrary shell work advanced the task.

The deterministic regression runs the real task loop, scheduler, command-evidence recording, completion gate, and
finalizer with scripted successful command receipts. Before the change, both ordinary-text and `attempt_completion`
variants stopped at request 12. Afterward, both deliver 16 command results and complete exactly once at request 17.
Additional detector tests cover history rollover, repeated commands, preserved strikes, and unsuccessful or unfinished
execution. The affected screenshot's saved task trace was not located in the inspected local task stores, so these are
reproduced causes of this exact message, not a reconstructed command history for that individual screenshot.

### Codex CLI comparison

Inspected upstream commit `7498521d288b9b3b96ffba4eedf089d8d6e06a84`, retrieved 2026-09-18.
Codex's [tool dispatch](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/core/src/stream_events_utils.rs#L308)
marks a tool call as requiring a follow-up model step. Its
[turn loop](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/core/src/session/turn.rs#L541)
continues while tool follow-up or pending input exists, handles context rollover, and checks stop hooks when no ordinary
continuation is pending. That loop has no corresponding requirement for every few tool results to produce a recognized
file-state or verification delta. OpenAI's
[documented tool-calling flow](https://developers.openai.com/api/docs/guides/function-calling#the-tool-calling-flow)
also returns tool results to the model for a final response or further tool calls.

Alpha retains bounded repetition and completion-evidence policies. The correction narrows the additional stop rule to
avoid treating a gap in command instrumentation as sufficient reason to interrupt distinct successful work.

## Active command sessions (2026-09-28)

The older screenshot also shows `Command session is unavailable for this task` before the no-progress pause. The
session registry used to require the returned process to remain the terminal's current process. A command that
finished between `exec_command` and `write_stdin` lost that binding, so the final poll became an error instead of
delivering its exit code and remaining output. The settled process is now available to its owning task until the
final output receipt is consumed. Input still requires the original live process and is rechecked after approval.

On a slower host, command admission can overlap another task's terminal acquisition. Terminal acquisition now
reserves the selected shell before returning, releases unused claims on cancellation or admission failure, and
never reuses a physically running shell. Execa completion clears the terminal's running state through the same
terminal completion path as the VS Code provider.

The progress detector also counted every backgrounded `exec_command` result and active `write_stdin` wait as a
stagnant tool outcome. A batch of legitimate slow commands could therefore exhaust the former no-progress allowance
without any completed operation to evaluate. Running command results and active command waits preserve the advisory
window; failed commands, unavailable sessions, unchanged completed outcomes, and idle waits can trigger one strategy
suggestion. They no longer suspend the task based on that heuristic. This applies to primary, launched, and managed
child tasks through their shared Task and tool paths.

The comparison target remains Codex CLI's pinned source commit
[`e0ef5a1`](https://github.com/openai/codex/blob/e0ef5a1a0f6421601baaa679fb37eddaa4e9c8c1/codex-rs/core/src/session/turn.rs),
retrieved 2026-09-28. Its turn loop follows pending tool input and evaluates stop hooks after ordinary
continuation is finished. That change preserved Alpha's former no-progress stop while preventing unfinished commands
from being treated as demonstrated stagnation; the current policy above supersedes that stop. The screenshot alone does not establish which command process
or workspace path changed on the other computer.

## Historical recovery after a no-progress stop

The following describes the pre-2026-09-28 policy and its recovery behavior. The tool-progress detector stopped an
attempt after repeated outcomes provided no new state or evidence. Its stopped state remained latched for that attempt,
including across compaction. Continue or a typed response to the recovery prompt started a fresh progress window,
without removing declared acceptance checks or their recorded evidence. Automatic tool-result feedback did not renew
this window, so another unchanged attempt remained bounded.

Previously, recovery resumed inside the existing task loop and bypassed the detector reset at loop entry. Every
subsequent tool result inherited the old stop, even when it read a new file. The task-loop regressions reproduce
this for both Continue and typed guidance and verify that fresh work can complete, while repeated work eventually
pauses again. Recovery also renews known-failure allowances; operations with unknown effects retain their replay
blocks because user resumption does not establish what happened.

Long conversations also reuse that loop for normal follow-ups and steering. Consuming a new user-feedback message
renews the progress window for all of those paths, including queued messages. A deterministic regression performs
200 useful reads before eight follow-ups revisit the same files. Previously, both typed and queued follow-ups
hit the no-progress stop at step 216; they now reach the final answer at step 233. Automatic mistake recovery uses
the same feedback presentation but is explicitly marked automatic: it neither renews the user attempt nor
invalidates non-reusable acceptance receipts. Compaction alone retains the progress window.

## Acceptance checks as progress

Declared acceptance checks used to participate in completion gating without contributing to tool-progress evidence.
After a long investigation, a sequence of distinct passing checks could therefore trigger the no-progress stop.
The regression reproduces this after 200 reads followed by 16 declared checks, without any user follow-up.

The detector now observes each passed acceptance receipt independently, using its check contract and captured
input fingerprints. Execution IDs, timestamps, receipt ordering, removals, and unchanged reruns provide no novelty.
Running, failed, stale, unavailable, and mismatched receipts provide no credit. This progress observation does not
grant completion: the completion gate still rechecks the declared input bytes and remaining requirements.

## Receipt identity

Acceptance receipts identify the check by ID and fingerprint its command, working directory, input-file set, and
reuse policy. The default working directory (`null`) and `.` are equivalent. Descriptions and input-list ordering
do not change the execution contract. Rewording an otherwise unchanged plan must retain both passing and failing
evidence, including results from commands that were still running during the update.

Previously, the fingerprint covered the entire check object. Editing a description, reordering paths, or replacing
the default directory with `.` discarded successful evidence and could produce `not run` followed by repeated
completion rejection. The regression tests reproduce this without a model or network dependency.

Legacy receipts that fingerprinted the complete check remain readable against their original saved definition.
When that plan is updated, matching legacy receipts are converted to the execution-contract fingerprint. No
missing or mismatched receipt is reconstructed. Changes to the command, directory, input set, or reuse policy
invalidate evidence; changed file bytes, failures, ignored inputs, and interrupted checks still block completion.

## Revoked command admissions

Investigated 2026-09-21 against the 3.0.0 working tree. A running acceptance command could regain verification
credit after its check was removed or changed and then restored before the process settled. Plan replacement
correctly removed the running receipt, but `settleAcceptanceChecks()` treated an absent current receipt as
permission to publish the captured result. Restoring the original definition therefore let the late result
reconstruct evidence whose admission had already been revoked.

Settlement now consumes the exact still-current admitted receipt. A missing receipt, a different execution ID,
or a stale receipt rejects the late result. Description-only and input-order plan edits retain the same receipt;
newer executions and reload or user-request invalidation still supersede it. After revocation, running the restored
check again creates a fresh admission and can satisfy completion normally.

This is an in-memory settlement correction with no persisted-schema, command-policy, approval, sandbox, mode, or
VS Code API change. Existing saved passed and failed receipts keep their compatibility behavior. The regression
uses controlled work-plan transitions and the real `Task` admission/publication caller; it does not infer live-model
quality or efficiency. This cycle does not change the separate workspace/cwd identity contract or make external
effects observable beyond the declared input snapshot.

## Validation

```sh
pnpm --dir src test core/agent/__tests__/TaskWorkContext.spec.ts core/task/__tests__/Task.work-context.spec.ts core/task/__tests__/stageThreeCompletion.integration.spec.ts
pnpm --dir src test core/task/__tests__/Task.spec.ts core/tools/__tests__/ToolRepetitionDetector.progress.spec.ts core/tools/__tests__/ToolRepetitionDetector.failures.spec.ts
pnpm --dir src test core/tools/__tests__/ToolRepetitionDetector.commands.spec.ts core/task/__tests__/stageThreeCompletion.integration.spec.ts
pnpm --dir src check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

The completion integration regressions exercise both final-answer paths through the real task loop, completion
gate, scheduler, and finalizer. Each preserves the passing receipt, completes exactly once, and never reaches
the Continue boundary after a descriptive plan update. Provider, UI, and message-persistence I/O are fixture adapters.

For the 2026-09-28 continuation correction, the new Task regression first failed in all six primary, launched,
and child combinations across serial and selective-parallel scheduling: each was suspended by the old twelfth-result
stop. After the change, seven focused suites passed 194/194 tests; the full Task suite passed 256/256, the scheduler
progress suite 45/45, the completion integration suite 28/28, and the command-outcome integration suite 36/36.
Extension and webview typechecks, repository lint, and the exact VS Code 1.122.1 smoke gate passed. The automated
managed-agent certification and its nested-worker host E2E also passed. These are deterministic checks; they do not
measure a live model's solve rate or guarantee that a model will choose an effective next action after advisory text.

For the 2026-09-18 command-progress correction, 453 tests passed across 13 affected detector, scheduler, task,
recovery, and completion suites. Extension typechecking, focused ESLint, formatting, and diff checks passed.
`test:smoke:1221` rebuilt the extension and webview and passed all ten host tests on the exact VS Code 1.122.1:
three activation/command tests, two mode tests, and five language-model contract tests. The deterministic command
regressions use scripted process receipts; these results do not claim a live-model quality or latency improvement.

For the 2026-09-21 admission-revocation correction, the focused regression first failed in both intended variants
(28 passed, 2 failed) and then passed 30/30 after the fix. The combined work-context and completion run passed
85/85; the persistence/reload suite passed 60/60. Extension typechecking, focused ESLint, and Prettier checks passed.
The exact-host gate rebuilt the extension and webview and passed 17/17 tests on VS Code 1.122.1: four extension,
two mode, five approval-mode, and six language-model contract tests. These deterministic results establish the
corrected lifecycle behavior only; they do not claim a live solve-rate or efficiency improvement.
