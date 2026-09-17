# Completion evidence and plan updates

Both an ordinary final answer and `attempt_completion` use `Task.getCompletionGateDecision()`. Declared work-plan
checks require an observed successful command, matching working directory, and unchanged declared input bytes.
Missing evidence produces the `Declared acceptance checks need attention` diagnostic. Three model completion
attempts against the same unresolved obligation reach the bounded recovery stop and expose Continue. A visible
assistant answer by itself does not establish that this gate accepted completion.

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
pnpm --dir src check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

The completion integration regressions exercise both final-answer paths through the real task loop, completion
gate, scheduler, and finalizer. Each preserves the passing receipt, completes exactly once, and never reaches
the Continue boundary after a descriptive plan update. Provider, UI, and message-persistence I/O are fixture adapters.
