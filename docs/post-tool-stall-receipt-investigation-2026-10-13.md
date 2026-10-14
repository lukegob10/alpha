# Post-tool stall and investigation completion failure

Investigated on 2026-10-13 against Alpha commit `506755d1`. Evidence: the supplied screenshot and current source/tests.
The incident occurred on another computer. Its transcripts, task IDs, installed build, host version, and original
extension-host logs were unavailable. Findings below distinguish the screenshot's account from reproduced behavior.

## The two failures

The screenshot contains an investigation report about an earlier task, followed by an error from the investigation
task itself. These are two execution histories; a common root cause has not been established.

1. **Original task:** the report says a write succeeded, followed by several hours without progress, an abort marked
   `user_cancelled`, and an incomplete replacement turn with queued input. This locates the reported stall after a
   write but does not identify the awaited operation or cancellation initiator. `Task` uses `user_cancelled` as a
   fallback in termination paths, so that label alone does not prove the user pressed Stop. A running task with a
   failed earlier turn is also compatible with recovery; it is not, by itself, proof of inconsistent state.
2. **Investigation task:** the displayed error matches `common:errors.mutation_receipt_orphaned` exactly. In the
   current code, it is emitted when `waitForCompletionGateDecision()` observes `receipt_pending` for 30 seconds.
   At least one admitted workspace operation still has a reservation in the completion ledger. A reservation is
   bookkeeping for an effect's final content observation; it is different from a successful tool response or a test
   result. It does not prove a file was actually changed: primary command execution also reserves before launch and
   must release a proven no-op.

Current incident launchers create a separate primary Code task with its own root. `diagnosticSourceTaskId` is a source
reference, not shared completion authority. Therefore an investigation's pending receipt should be traced to that
investigation's operations, not assumed to be inherited from the task being investigated.

Relevant implementation:

- `src/core/webview/AlphaProvider.ts`: `startIncidentDebuggingTask()`, `startIncidentDebuggingTurnTask()`,
  `getAgentControlRootTaskId()`.
- `src/core/tools/ToolRegistry.ts`: `executeBaseTool()` reserves before edits and records/releases afterward.
- `src/core/tools/ExecuteCommandTool.ts`: primary command admission and `finalizeCommandMutationReceipt()`.
- `src/core/agent/AgentControlStore.ts`: `reservePrimaryMutation()`, `recordPrimaryMutation()`,
  `releasePrimaryMutation()`; receipt recording and matching reservation settlement share one transaction.
- `src/core/task/Task.ts`: `getCompletionGateDecision()`, `waitForCompletionGateDecision()`, and ordinary-text
  completion handling.

## Why the answer did not finish or fold

Alpha streams the assistant's report before accepting task completion. Ordinary final text must pass the same durable
completion gate as explicit completion. A pending receipt blocks `presentCompletionResult()` and the completed
transition. The text may look finished while the harness correctly keeps the task incomplete.

`webview-ui/src/components/chat/ChatView.tsx` folds expanded activity when a completed transcript boundary appears.
The rejected completion explains why the screenshot never reached the usual completed/folded presentation. It does
not establish an independent React folding bug. Automatically folding the error or declaring completion would hide
the missing effect evidence.

Retrying completion or running more checks does not settle a different operation's reservation. The existing
`ToolRegistry.mutationSettlement.spec.ts` reproduces this error after a later successful command and after reload.
The current fail-closed policy protects unknown effects, but it offers no automatic repair of an orphaned receipt.

## Confirmed diagnostics bug and fix

`SettlementDiagnostics.ts` already captures `pendingReservations`, including each token and any matching physical
command status. `projectRuntimeDiagnostics()` discarded this entire field before `generateErrorDiagnostics()` wrote
the report. Its status allowlist also omitted the valid command state `succeeded`. Thus the action recommended in
the error message removed the correlation evidence needed to investigate it.

The fix preserves bounded pending-reservation entries, hashes their tokens with the same function used for exported
command execution IDs and tool-call IDs, and preserves recognized command status including `succeeded`. Raw tokens,
command text, outputs, workspace paths, and file contents remain excluded. Truncation is explicit. Missing command
status remains missing; it is not relabeled as a proven orphan because file tools and older commands may lack a
matching entry in the bounded runtime view.

This is an additive diagnostic export change. It does not clear receipts, replay effects, change approval authority,
alter task lifecycle, or claim to repair the other computer's task. Existing reports remain readable.

## Upstream comparison and scope

Current Codex source was retrieved on 2026-10-13 at `2f05c0a71f59fb2f05800846351f3e9926c3e52b`:

- [Task lifecycle and abort handling](https://github.com/openai/codex/blob/2f05c0a71f59fb2f05800846351f3e9926c3e52b/codex-rs/core/src/tasks/mod.rs)
  centralizes task finish handling, distinguishes replacement from interruption, and flushes interrupted history
  before emitting the abort event.
- [Pending-input persistence tests](https://github.com/openai/codex/blob/2f05c0a71f59fb2f05800846351f3e9926c3e52b/codex-rs/core/tests/suite/pending_input_persistence.rs)
  exercise input durability and restart boundaries.

Alpha intentionally retains its own workspace mutation receipt gate and security model. No upstream runtime or
prompts were ported. The screenshot's broad watchdog/checkpoint proposal is not an established root-cause fix.
Alpha already has durable lifecycle/transcript recovery and bounded provider/completion waits; the exact unresolved
post-tool await must be identified before adding another watchdog or recovery mechanism.

## Evidence needed from the affected computer

First capture **Get detailed error info for both tasks**, the Alpha version/build, VS Code version, and each task ID.
An old report will lack the reservation fields fixed here. For a definitive trace, preserve the relevant task
directories and the matching task's verification obligation from `agent_control.json`, together with extension-host
errors around the last successful tool and first receipt failure. Relevant task files are:

- `history_item.json`, `ui_messages.json`, and `provider_transcript.json` (or `api_conversation_history.json`).
- `agent_lifecycle_events.jsonl`, `agent_turn_events.jsonl`, and `agent_lifecycle_snapshot.json` when present.
- `pending_queue.json` and relevant `command-output/` records.

Review raw records before sharing: unlike the bounded diagnostic export, they can contain prompts, file contents,
and command output. Do not clear the reservation or re-run the original write merely to make completion succeed.
Join the pending token to the tool/physical execution, inspect its terminal outcome and first persistence error,
then reproduce that specific cancellation, finalization, or reload boundary with controlled promises.

## Validation

The pre-existing receipt, command-lifecycle, turn-engine, and queued-input suites passed: 4 files, 71 tests. The new
export regressions first failed on the missing reservation projection and missing `succeeded` status (7 failing
cases, 1 existing passing case). After the fix, the settlement/export and diagnostics handler suites passed: 2 files,
18 tests. Extension type checking and focused ESLint also passed. These checks used Windows Node 24.21.0 and
pnpm 11.24.0; the initial Linux test attempt could not start because the existing dependency tree lacked Linux
Rollup's native optional package. No dependency or lockfile changes were needed to run with the installed Windows
dependencies.

Commands:

```sh
pnpm --dir src test core/tools/__tests__/ToolRegistry.mutationSettlement.spec.ts core/tools/__tests__/ExecuteCommand.lifecycle.spec.ts core/agent/__tests__/AgentTurnEngine.spec.ts core/task/__tests__/Task.pending-queue-receipts.spec.ts
pnpm --dir src test core/agent/__tests__/SettlementDiagnostics.spec.ts core/webview/__tests__/diagnosticsHandler.spec.ts
pnpm --dir src check-types
pnpm --dir src exec eslint core/webview/diagnosticsEvidence.ts core/agent/__tests__/SettlementDiagnostics.spec.ts --max-warnings=0
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```

The extension bundle and webview production build passed. The exact-host gate could not run its tests. The first
launch inherited `ELECTRON_RUN_AS_NODE=1` from the Windows environment. Retrying with that variable removed from the
test process reached the installed VS Code **1.125.0**, which waited 30 seconds for the Windows `vscode-updating`
mutex and exited with `Code is currently being updated`. The runner classified this as `host-preflight-missing`
(run `05a72d48-666d-4055-80ce-9c0d635ca8d9`). No different host version was substituted. Full host validation remains
outstanding until the update lock clears. No live model or remote-incident reproduction is claimed.
