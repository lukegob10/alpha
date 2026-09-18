# Completion evidence and plan updates

Both an ordinary final answer and `attempt_completion` use `Task.getCompletionGateDecision()`. Declared work-plan
checks require an observed successful command, matching working directory, and unchanged declared input bytes.
Missing evidence produces the `Declared acceptance checks need attention` diagnostic. Three model completion
attempts against the same unresolved obligation reach the bounded recovery stop and expose Continue. A visible
assistant answer by itself does not establish that this gate accepted completion.

## Resuming after a no-progress stop

The tool-progress detector stops an attempt after repeated outcomes provide no new state or evidence. Its stopped
state remains latched for that attempt, including across compaction. Continue or a typed response to the recovery
prompt starts a fresh progress window, without removing declared acceptance checks or their recorded evidence.
Automatic tool-result feedback does not renew this window, so another unchanged attempt remains bounded.

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

## Validation

```sh
pnpm --dir src test -- core/agent/__tests__/TaskWorkContext.spec.ts core/task/__tests__/Task.work-context.spec.ts core/task/__tests__/stageThreeCompletion.integration.spec.ts
pnpm --dir src test -- core/task/__tests__/Task.spec.ts core/tools/__tests__/ToolRepetitionDetector.progress.spec.ts core/tools/__tests__/ToolRepetitionDetector.failures.spec.ts
pnpm --dir src check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

The completion integration regressions exercise both final-answer paths through the real task loop, completion
gate, scheduler, and finalizer. Each preserves the passing receipt, completes exactly once, and never reaches
the Continue boundary after a descriptive plan update. Provider, UI, and message-persistence I/O are fixture adapters.
