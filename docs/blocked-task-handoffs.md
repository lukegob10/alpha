# Blocked task handoffs

A primary task can end its current work with `attempt_completion({ outcome: "blocked", result })`.
This accepts the report and pauses for user guidance in the same task. It does not mark the task completed,
consume managed-child results, or satisfy verification obligations.

The model chooses between a blocked report and the existing `ask_followup_question` tool. A focused question is
appropriate when its answer can unblock progress. Otherwise, the report describes completed work and the remaining
constraint. This choice is independent of the provider, task domain, file names, and wording of the blocker.

The completion tool returns a successful acknowledgement of the handoff with `outcome: "blocked"`. Task publishes the
report as ordinary assistant text after flushing the tool transaction, then uses its existing resumable boundary.
Outstanding verification stays in the durable ledger and is checked again if a later turn requests completion.
The existing transcript and lifecycle schemas need no migration.

Runtime failures remain errors. An intentional handoff cannot replace an already pending runtime failure, and a failure
to persist the handoff still takes the error path. Existing completion rejection and recovery limits are unchanged.

Regression coverage lives in `src/core/task/__tests__/stageThreeCompletion.integration.spec.ts`: accepted handoffs with
and without verification debt, a handoff after an earlier tool error, same-task continuation, retained debt on reload,
and failed transaction persistence. Completion-tool and task-persistence tests cover the surrounding contracts.
