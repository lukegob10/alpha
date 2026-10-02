# Completion and follow-up review — 2026-10-01

## Reference and scope

Reviewed current Codex CLI source at commit
[`b707714ae4200db0a0385da24b3981d99139fa62`](https://github.com/openai/codex/tree/b707714ae4200db0a0385da24b3981d99139fa62),
retrieved and confirmed against upstream main on 2026-10-01. This review covers successful completion, late guidance,
completion hooks, cancellation, and same-task follow-ups. Alpha remains a native TypeScript extension on exact
VS Code 1.125.0; no Rust, prompts, or upstream implementation were copied. Its execution protections and additional
features remain outside this repair's scope.

Codex's relevant behavior is explicit in these sources:

- [`session/turn.rs:159`](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/core/src/session/turn.rs#L159):
  tool calls require continuation; an assistant message without pending continuation can finish the turn.
- [`session/turn.rs:551`](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/core/src/session/turn.rs#L551):
  pending input contributes to the continuation decision.
- [`session/turn.rs:653`](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/core/src/session/turn.rs#L653):
  stop hooks can add persisted continuation prompts before the loop returns. Successful completion does not request
  an extra user acknowledgement.
- [`tasks/mod.rs:619`](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/core/src/tasks/mod.rs#L619):
  terminal handling takes the owned active task once, records remaining input, and publishes the terminal lifecycle.
  [`tasks/mod.rs:834`](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/core/src/tasks/mod.rs#L834)
  constructs `TurnComplete` after that work.
- [`tests/suite/hooks.rs:1321`](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/core/tests/suite/hooks.rs#L1321)
  verifies multiple stop-hook continuations stay in the same turn and survive in history.
- [`tests/suite/pending_input.rs:171`](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/core/tests/suite/pending_input.rs#L171)
  verifies input submitted while idle starts the first model request and the visible user message preserves its client ID.
  [`pending_input.rs:1057`](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/core/tests/suite/pending_input.rs#L1057)
  verifies externally injected input after a final-answer item continues the active turn.

## Findings and repairs

| Gap                                                                       | Owning layer and cause                                                                                                                                                                            | Repair                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Successful visible tasks appeared to hang                                 | Both `AttemptCompletionTool` and the text completion path awaited `Task.ask("completion_result")`. The ask polled indefinitely until the user acknowledged it; the durable finalizer had not run. | Both paths now present the final answer, inspect late input and completion evidence, and run the existing finalizer directly.                                                                                            |
| Completed follow-ups briefly appeared as queued work                      | `resumeCompletedTaskFollowup` selected its durable input only after joining the prior lifecycle. UI snapshots in that interval showed an ordinary queue entry.                                    | Select the admission immediately, retain its IDs through lifecycle preparation, and preserve the previous terminal-write fence before starting another provider request.                                                 |
| Cancelling during that join could start another turn                      | The method cleared `abort` after the awaited join without checking whether cancellation had won.                                                                                                  | Check cancellation after the join and after retained preparation/selection persistence; release the selected receipt when admission fails.                                                                               |
| Optimistic follow-ups could not be matched reliably to canonical feedback | Visible feedback did not carry the request's durable queue identity.                                                                                                                              | `Task.say` accepts optional `queuedMessageIds`; completed history resume, queued completion guidance, and recovery feedback pass those exact IDs. The shared message schema and webview consume the same optional field. |

The shared `AgentTurnEngine`, completion recovery policy, completion hooks, and `Task.commitTaskCompletion` already
provide the core sequencing and durable completion guards. They were retained. Completion still fails closed for
unresolved todos, active descendants, unread managed-agent results, outstanding parent verification, transcript
persistence errors, cancellation, and unfinished tool transactions. The finalizer reserves the transition once and
checks pending human/agent input immediately before marking the task completed. A late input continues the conversation
or starts a follow-up with the same task ID; it is acknowledged only when its provider-history receipt is durable.

For the webview repair, a submitted completed-task follow-up appears immediately as a normal user message. That
presentation remains optimistic until canonical feedback with the exact `queuedMessageIds` arrives. An accepted
admission receipt alone does not remove the optimistic row, and unrelated active-task queue entries keep their existing
presentation. UI tests cover this projection and rejection/draft restoration.

## Compatibility and intentional differences

The public UX change is deliberate: a successful primary answer completes automatically, without requiring the user to
accept an extra completion prompt. The visible `say:completion_result` row is still retained, including in-place
promotion of ordinary assistant text, final-response ordering, and the normal follow-up composer.

Saved `ask:completion_result` rows and their historical response handling remain readable. No persisted lifecycle or
tool transaction format was removed. The optional feedback identity field is backward compatible with older rows that
omit it. Exact IDs are used for reconciliation; text and timestamps are not treated as message identity.

Legacy delegated subtasks keep their existing finish-subtask approval and durable parent-return protocol. Managed
children keep parent review and verification obligations. Alpha also retains its explicit `attempt_completion` tool
alongside ordinary assistant-text completion. These are extension compatibility choices, not requirements imposed by
Codex's completion loop. Alpha's sandbox, approvals, skills, previewer, Tickets, and scheduled tasks were preserved.

The affected host fixtures now wait for `TaskCompleted`/`didComplete`, capture settled completed state, and reject an
unexpected active completion ask in the dedicated completion scenarios. Historical evidence counter names such as
`requestsAtReview` remain readable for existing reports; new executions measure completed idle state.

The managed-agent Extension Host acceptance run `03e9af6c-6196-4cc8-805d-2f368fc0049c` exposed one remaining stale
fixture: it timed out after 60 seconds waiting for a root completion prompt even though the root was completed, input
was drained, and its final answer was visible. That fixture now waits for automatic root completion, joins its owned
termination boundary, and requires one completion event and final-answer row without an active ask. It retains nested
Apply, discard, child review/verification, interruption, projection, and optional rendered navigation checks. The basic
`task.test.ts` fixture had the same hard acknowledgement wait; it now asserts the same automatic completion contract
with owned listener cleanup and lifecycle settlement. Their corrected host executions are owned by the coordinating
agent. The E2E package typecheck and focused ESLint for both fixtures passed; those checks do not prove host execution
passed.

Cold history reopen now recognizes a completed task whose final row is `say:completion_result`. It reads the existing
task-history status before publishing `resume_completed_task`; a visible candidate or completed model-turn journal
alone cannot prove task completion. Active, interrupted, failed, and unknown-status final say rows remain resumable.
Old completion ask rows retain their compatibility fallback only when historical status is absent. Managed-child
history continues through its verified child finalizer and never opens a primary completion ask.

A focused recovery test also establishes that failed retained preparation can leave durably accepted input pending in
FIFO after its wake settles, without canonical feedback or a provider-history receipt. Acceptance must remain distinct
from delivery. The coordinating repair uses the existing typed host receipt to publish explicit queued recovery for
that exact request identity, rather than turning accepted input into rejection or assuming indefinite retries.

Provider-history admission can also fail after canonical feedback has already been saved. Retrying that same pending
receipt now reuses the existing complete feedback row, including edited queued text and images. The existing transcript
commit fence saves the update before publication and selects the exact receipt IDs, so unrelated rows with the same
timestamp cannot be changed. Partial, automatic, untagged, and different-ID feedback retain their existing paths.
Automatic feedback carries no human queue receipt. A consumed receipt is ignored before renewing progress or restoring
request-scoped evidence; saved user input remains immutable. A failed update preserves the original feedback and does
not admit a provider request. The released FIFO entry remains available for recovery until provider history accepts it.

Stop can occur after user history is durable but before queue acknowledgement finishes. The delayed admission callback
still settles the accepted receipt, but it now suppresses Active and Started events after cancellation or abandonment.
The same publication guard applies to completed follow-ups, idle queue delivery, edited-prompt resume, and the shared
deferred task-start callback. This preserves the terminal UI lifecycle without rejecting or replaying durable input.

## Validation

Fail-before evidence was captured with focused tests:

- Two tests covering explicit and ordinary-text completion failed because the old implementation called
  `ask("completion_result")` before finalizing (37 other focused tests passed).
- A held-lifecycle test failed because a completed follow-up remained pending instead of being selected immediately
  (12 other follow-up tests passed).
- A cancellation race test failed because admission resolved and cleared cancellation after the terminal join.
- Two reload tests failed because a new final say row reopened as interrupted work, while an explicitly interrupted
  historical completion ask reopened as completed. Task-history status now owns that distinction.
- A controlled real-resume test failed because failed provider-history admission followed by an edited retry produced
  two complete feedback rows for the same receipt. It now updates one row and admits one user API message and request.
- A held queue-acknowledgement test failed because Stop was followed by Active and Started events after the accepted
  user history had committed. It now resolves admission, preserves one consumed receipt, and emits neither event.

The focused completion suite exercises the real turn engine, canonical final-answer rows, durable finalization,
managed-agent verification, hook continuation, queued images, late input at presentation/finalization boundaries,
failed persistence/retry, held terminal writes, cancellation, immediate selection, and exact feedback identity:

```sh
pnpm --dir src test core/tools/__tests__/attemptCompletionTool.spec.ts core/task/__tests__/Task.completion-followup.spec.ts core/task/__tests__/Task.spec.ts core/task/__tests__/stageThreeCompletion.integration.spec.ts
```

The expanded focused run passed all **363 tests in four files**. Formatting was applied only to touched files, and the
completion diff passed `git diff --check`. `pnpm --dir src check-types` also passed. The coordinating agent owns
shared-package type checks, E2E runner unit tests,
the exact VS Code 1.125.0 gate, and managed-agent certification. Source inspection alone is not a claim that live
providers or all Codex capabilities have parity; this repair closes the verified completion and follow-up gaps without
claiming a general performance improvement.
