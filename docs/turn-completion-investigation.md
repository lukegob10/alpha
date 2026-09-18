# Turn completion investigation: 2.1.47

Reviewed 2026-09-17 against release commit `cc0d11680b224debb93c74686205f8bc9b920d57`.
The pending local compaction changes do not modify the completion paths described here.
No affected user-task trace was available; these findings reproduce possible causes, not the identity of a particular incident.

## Final text and a completed activity trace are separate boundaries

`AgentTurnEngine` accepts an ordinary visible assistant response without tool calls as a completion candidate.
`Task.initiateTaskLoop` then checks the durable completion gate, promotes the existing text row through
`presentCompletionResult`, opens the completion review boundary, and durably finalizes the task.
Explicit `attempt_completion` calls reach the same completion gate and finalizer through `AttemptCompletionTool`.

The webview's `getCompletedActivity` requires a non-partial `completion_result` row and an accepted host/review boundary.
Ordinary `say:text` does not qualify, even if its wording says the work is finished. This prevents failed or unverified
work from being presented as successfully completed. The collapse is a presentation of the existing transcript, not
model context compaction or another generated summary.

## Confirmed: background services can hold completion indefinitely

The `execute_command` schema explicitly permits timeouts that return while a dev server or watcher keeps running.
The runtime records this with `markCommandExecutionBackgrounded` and `returnedInBackground`.
However, `hasActiveCommandExecutions` checks only `status === "running"`; the completion gate waits on every such record.
`waitForCompletionGateDecision` bounds individual evidence reads but does not impose an overall timeout on a running
command. A persistent server can therefore prevent the final text from ever being promoted to `completion_result`.

Reproduction used the real completion integration harness: register `pnpm dev`, mark its physical execution backgrounded,
and provide one successful text-only final response. After 60 seconds of simulated time, there was still one provider
request, no completion presentation, no error row, and no Continue boundary. Ending that process allowed the same
candidate to complete exactly once. The loop's condition continues to hold for as long as the process remains running.

The repair should distinguish intentionally persistent services from commands whose exit and verification evidence are
required. Simply ignoring every backgrounded command would incorrectly waive unfinished tests and mutations.
The UI should also expose the reason for a completion wait instead of making an inactive model stream look unexplained.

## Confirmed: late completion exceptions bypass ordinary recovery

The engine catches errors from `runStep`, but lifecycle finalization and the ordinary-text completion flow contain
awaits outside that boundary. Exceptions from `finishCanonicalLifecycleTurn`, `presentCompletionResult`, or
`finalizeTaskCompletion` can reject `initiateTaskLoop` without reaching `waitForPrimaryTurnRecovery`.
For the background start/resume path, `ownBackgroundLifecycle` logs the rejection; it does not itself publish recovery.

Three separate fault-injection probes rejected those operations after a single successful model response. Each rejected
the task loop without a TaskCompleted event, a recovery ask, or a visible error row from the loop. Presentation or journal
failure can leave ordinary final-looking text in the open trace. Finalizer failure happens later and can leave different
presentation depending on which completion events were already published.

The repair should route post-stream completion failures through the existing failure/recovery boundary, preserving
the transcript and cancellation semantics. It must retract any rejected completion candidate and must not label a
failed persistence or lifecycle write as a successful completion. Errors occurring after an already committed terminal
transition need separate idempotent handling.

## Validation and scope

The normal runtime suites passed 267 tests across `AgentTurnEngine`, `Task`, completion diagnostics, and the durable
completion integration. The webview suites passed 165 tests with one existing skip across `completedActivity`,
`ChatView`, and `ExtensionStateContext`. The final integration probe run passed 49 tests: 45 existing cases and the four
temporary reproductions above. The diagnostic probes were removed after the investigation to avoid treating the
undesired behavior as an acceptance contract. This investigation adds no production behavior change.

Useful existing checks:

```sh
pnpm --dir src test -- core/agent/__tests__/AgentTurnEngine.spec.ts core/task/__tests__/stageThreeCompletion.integration.spec.ts core/task/__tests__/completionDiagnostics.spec.ts core/task/__tests__/Task.spec.ts
pnpm --dir webview-ui test -- src/components/chat/__tests__/completedActivity.spec.ts src/components/chat/__tests__/ChatView.spec.tsx src/context/__tests__/ExtensionStateContext.spec.tsx
```

The earlier 2.1.47 receipt-identity repair remains valid: descriptive work-plan updates retain command evidence.
It does not address background-service completion waits or exceptions after the model stream. A visible Continue or
incomplete/unverified warning points to the normal rejection path; silence with an open trace is also consistent with
the two paths identified here. Identifying the cause of an individual user task still requires its runtime state.
