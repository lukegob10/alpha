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

## Tool-progress continuation

ToolRepetitionDetector issues a bounded strategy suggestion while terminal tool results continue to the model.
Fresh admitted evidence clears the advisory window; compaction retains it. The provider profile's Error & Repetition
Limit controls the mistake dialog and advisory threshold. Known failed operations retain their per-operation retry
block, and unknown effects require verification before replay. Completion obligations, cancellation, provider failures,
approval decisions, and explicit user stops retain their own lifecycle boundaries.

## Command-session ownership

A settled process remains available to its owning task until its final output receipt is consumed. Input requires the
original live process and is rechecked after approval. Terminal acquisition reserves the selected shell, releases unused
claims on cancellation or admission failure, and must not reuse a physically running shell.

Running command results and active command waits preserve the advisory window. Failed commands, unavailable sessions,
unchanged completed outcomes, and idle waits can trigger a strategy suggestion. A progress heuristic cannot establish
that the task is blocked.

## Acceptance receipts

Each passed acceptance receipt is observed using its check contract and captured input fingerprints. Execution IDs,
timestamps, receipt ordering, removals, and unchanged reruns provide no novelty. Running, failed, stale, unavailable,
and mismatched receipts provide no credit. The completion gate rechecks declared input bytes and remaining requirements.

Receipts fingerprint the command, working directory, input-file set, and reuse policy. The default working directory
(null) and a dot are equivalent. Descriptions and input-list ordering do not change the execution contract. Rewording
an otherwise unchanged plan preserves passing and failing evidence, including commands still running during the update.

Legacy receipts remain readable against their original saved definition. Updating that plan converts matching legacy
receipts to the execution-contract fingerprint without reconstructing missing evidence. Command, directory, input-set,
or reuse-policy changes invalidate evidence; changed bytes, failures, ignored inputs, and interrupted checks block completion.

## Admission ownership

Settlement requires the exact still-current admitted receipt. A missing receipt, a different execution ID, or a stale
receipt rejects a late result. Description-only and input-order edits retain the receipt; newer executions, reload,
and user-request invalidation can supersede it. Running a restored check creates a fresh admission after revocation.

## Validation

```sh
pnpm --dir src test core/agent/__tests__/TaskWorkContext.spec.ts core/task/__tests__/Task.work-context.spec.ts core/task/__tests__/stageThreeCompletion.integration.spec.ts
pnpm --dir src test core/task/__tests__/Task.spec.ts core/tools/__tests__/ToolRepetitionDetector.progress.spec.ts core/tools/__tests__/ToolRepetitionDetector.failures.spec.ts
pnpm --dir src test core/tools/__tests__/ToolRepetitionDetector.commands.spec.ts core/task/__tests__/stageThreeCompletion.integration.spec.ts
pnpm --dir src check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```
