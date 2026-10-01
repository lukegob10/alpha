# Codex CLI convergence: completion and continuation fixes

September 30, 2026. Implementation follow-up to the
[completion/follow-up review](F:/roo-fork/Alpha-Code/docs/completion-followup-alignment-review-2026-09-30.md) and
[CLI convergence review](F:/roo-fork/Alpha-Code/docs/early-task-ending-codex-alignment-review-2026-09-30.md).
The earlier diagnostic files remain intact. The target is current Codex CLI inside Alpha's existing kernel and
VS Code adapters. GitHub Copilot/GPT-5.6 is the reported incident context; these fixes do not establish its unseen cause
or depend on how that particular specification was supplied. Copilot Chat is not the reference harness.

## Reference and preservation

Official CLI source/tests were refreshed at **2026-10-01T00:44:30Z** to
[`875bf9209bd9aeb0a5f102888ccd90b2b59cc3c9`](https://github.com/openai/codex/tree/875bf9209bd9aeb0a5f102888ccd90b2b59cc3c9),
committed **2026-10-01T00:43:55Z**. Both times are September 30 in New York.
The [comparison with the investigation pin](https://github.com/openai/codex/compare/60947e234156ac12bdb7fba2477d3965f166bd34...875bf9209bd9aeb0a5f102888ccd90b2b59cc3c9)
contains one exec-server/file-system protocol commit; applicable turn, retry, model, hook, process and TUI contracts
are unchanged. Upstream tests were read, not run.

Root AGENTS and status were read first. The actual checkout is `main` at
`40803ed6d5f487950b35824fea30e6e2d1a325ee`, with **93 pre-existing dirty paths** at implementation start.
The communication prototype remains local, unshipped work. No switch, reset, stash, commit or dependency upgrade was
performed. Three parallel subagents owned Task lifecycle/admission, command/retry handling and provider/progress
handling, then took additional bounded scopes. The parent integrated shared types, UI projection, delivery receipts
and validation. No parallel runtime, policy engine or evidence registry was introduced.

The preservation audit still finds all 93 starting paths: 78 are byte-identical and 15 contain the scoped integration
changes or retained concurrent user work. Historical investigations, prototype-only changes, and unrelated assets
remain present. No claim is made that this dirty checkout equals shipped GitHub main.

## Implemented contracts and owning layers

| Finding                              | Repair                                                                                                                                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CF03 fast reply loss                 | Task installs the published ask identity before publication; host admission uses it instead of delayed status. Scoped replies receive correlated acceptance/rejection receipts.                                                                           |
| CF04 claimed queue/CAS race          | An occupied completion slot releases the provisional claim; the queued ID remains durable.                                                                                                                                                                |
| CF05 idle admission/wake             | Accepted input retains its queued ID through resume/reload and has one owned idle wake after completion.                                                                                                                                                  |
| CF06/CF07 late errors/settled owners | Pre-completion failures enter existing visible recovery; settled lifecycle promises release by identity. Post-completion publication failures are logged without resurrecting the task. Managed-child rejection stays observable to its parent.           |
| Recovery-prompt delivery receipts    | Mistake-limit feedback carries its exact queued IDs into the next human input. Both manual API-failure prompts durably release their selected IDs to the visible FIFO before existing recovery, preserving guidance and avoiding hidden claims or replay. |
| CF08/CF09 stale UI                   | A fresh host task-state envelope can replace a missed terminal/new-turn boundary. Counters compare only within the same turn. Older envelopes and answered historical asks cannot resurrect waiting state.                                                |
| Additional receipt race              | A stable webview listener dispatches to the latest committed handler. A receipt for A cannot clear B's pending-send guard during navigation. Controlled listener delivery reproduced duplicate B enqueue before repair.                                   |
| Composer delivery                    | A bounded per-chat pending-reply list retains optimistic submissions. Rejection restores text/images to the owning draft; duplicates are ignored and newer drafts survive. Subsequent queued instructions and new questions stay usable.                  |
| CF02 yielded timeout                 | A finalization owner outlives foreground return. Observed physical exit settles the exact/no-op receipt once; uncertain cleanup preserves unresolved debt. Persistence failure never fabricates success.                                                  |
| CF11 cleanup ownership               | Running/unconfirmed busy terminals retain the task handle. Failed synchronous interrupt delivery can be retried; accepted interrupts remain idempotent.                                                                                                   |
| Fresh draft after close              | Each affected view resets its draft mode in the synchronous close projection. Background closes and unrelated drafts retain their selection; delayed metadata repair cannot overwrite a later human mode choice.                                          |
| EE14 model identity                  | Verified Copilot host family selects instructions through an optional instruction identity captured in StepContext. Opaque execution/token-accounting IDs and conservative unknown-family fallback remain.                                                |
| EE16 malformed tool intent           | Recognized malformed LM tool parts produce nonretryable canonical failure with earlier accepted calls/correlation retained. Later semantic parts cannot convert failure into completion; matching-owner provider state is preserved.                      |
| EE04 classification                  | Polite/interrogative action requests retain the authorized implementation surface and declared verification. Real lookup questions remain narrow.                                                                                                         |
| EE05 exploration                     | Search recovery consults the existing outcome-aware progress detector's monotonic cursor. Admitted progress renews the window; raw call shape cannot pause productive work. Unchanged-outcome protection remains.                                         |
| Retry deadline                       | Retry-After stays a minimum despite the local backoff cap. One absolute deadline is captured; notification/persistence time consumes it instead of restarting or shortening it.                                                                           |
| Elapsed retry during compaction      | A consumed pacing delay resumes immediately after cancellation/deadline checks. It can no longer become an unspecified request timeout and wait almost the full retry budget. Both policy and compatibility retry paths share the repaired boundary.      |
| Stop-hook continuation               | Blocking hook prompts continue beyond the former third-continuation cutoff. Provenance, active-window state, cancellation, child budgets and hook execution/output bounds remain.                                                                         |
| EE03 mention provenance              | Shortened lines report truncation and the first clipped line. Guidance directs rereading omitted tails through the available tool surface instead of skipping past them. Budgets and access boundaries remain.                                            |

The owners are the existing
[Task integration host](F:/roo-fork/Alpha-Code/src/core/task/Task.ts),
[LM adapter](F:/roo-fork/Alpha-Code/src/api/providers/vscode-lm.ts),
[StepContext](F:/roo-fork/Alpha-Code/src/core/agent/StepContext.ts),
[request classifier](F:/roo-fork/Alpha-Code/src/core/agent/requestWorkClass.ts),
[search recovery](F:/roo-fork/Alpha-Code/src/core/agent/SearchLoopRecoveryPolicy.ts),
[progress detector](F:/roo-fork/Alpha-Code/src/core/tools/ToolRepetitionDetector.ts),
[retry policy](F:/roo-fork/Alpha-Code/src/core/agent/AgentRetryPolicy.ts),
[command tool](F:/roo-fork/Alpha-Code/src/core/tools/ExecuteCommandTool.ts),
[terminal registry](F:/roo-fork/Alpha-Code/src/integrations/terminal/TerminalRegistry.ts),
[scoped message handler](F:/roo-fork/Alpha-Code/src/core/webview/webviewMessageHandler.ts),
[UI lifecycle projection](F:/roo-fork/Alpha-Code/webview-ui/src/context/agentLifecycleState.ts),
[ChatView](F:/roo-fork/Alpha-Code/webview-ui/src/components/chat/ChatView.tsx) and
[mention reader](F:/roo-fork/Alpha-Code/src/integrations/misc/indentation-reader.ts).

## Concrete flow maps

```text
Reply: composer(requestId/taskId/ask timestamp) -> scoped handler -> published-ask validation
  -> durable Task admission -> current ask / owned queued-ID resume -> existing turn engine
  -> correlated chatCommandResult -> originating draft -> canonical transcript/lifecycle projection

Race: queued input -> provisional claim -> completion-slot compare-and-set
  -> won: same queued ID consumed/persisted once
  -> occupied: release provisional claim, retain message
  -> late accepted input after completion: one owned idle wake -> resume same chat

Recovery prompt: selected queued guidance -> host ask result with queued IDs
  -> mistake-limit feedback: bind IDs to formatted human blocks -> persist/settle with admitted input
  -> manual API failure: release only selected IDs -> flush visible FIFO -> existing recovery consumes guidance

Provider: response part -> LM intent validation -> nonretryable canonical error
  -> retain earlier calls/correlated state -> metadata-only drain
  -> failed outcome + terminal receipts -> existing visible recovery

Command: physical reservation -> background yield -> lifetime timeout -> fence ordinary callback
  -> one finalization owner -> observed exit: exact/no-op receipt
  -> uncertain stop/observation: persisted unresolved debt -> host recovery, no invented passing check

Overflow retry: select deadline -> required safe compaction -> publish retry -> remaining delay
  -> positive: cancellable bounded wait
  -> elapsed: cancellation/deadline checks -> immediate next attempt -> queued steering after safe continuation
```

Applicable CLI evidence includes
[turn continuation/Stop hooks](https://github.com/openai/codex/blob/875bf9209bd9aeb0a5f102888ccd90b2b59cc3c9/codex-rs/core/src/session/turn.rs),
[repeated-hook tests](https://github.com/openai/codex/blob/875bf9209bd9aeb0a5f102888ccd90b2b59cc3c9/codex-rs/core/tests/suite/hooks.rs#L1321),
[retry deadlines](https://github.com/openai/codex/blob/875bf9209bd9aeb0a5f102888ccd90b2b59cc3c9/codex-rs/core/src/responses_retry.rs),
and [long-running command tests](https://github.com/openai/codex/blob/875bf9209bd9aeb0a5f102888ccd90b2b59cc3c9/codex-rs/core/tests/suite/unified_exec.rs#L2847).
VS Code 1.122.1's stable LM response exposes a stream, not CLI-style end-turn/finish-reason metadata. Alpha does not
fabricate such metadata; exact-host source references are in the earlier review.

The official [steering and queuing guide](https://learn.chatgpt.com/docs/prompting#steering-and-queuing), fetched on
October 1 UTC / September 30 New York, distinguishes steering the current run from queuing a later run and documents
editable desktop queued messages. That verifies the product distinction, not undocumented app routing, persistence
or notification internals. Alpha's durable input admission and existing queue remain their native implementation;
no undocumented desktop behavior is asserted as a contract.

## Explicit boundaries and remaining convergence

- **Live services:** CLI permits turn completion with a live process. Alpha preserves finite-check and physical
  mutation obligations. The indefinite completion wait now becomes a bounded recoverable pause, never successful
  verification. Automatic healthy-service completion still needs an explicit native readiness/ownership contract;
  command-name heuristics cannot prove it. This is a remaining CLI difference.
- **Retries:** Alpha retains four total attempts and a 90-second logical-step budget. Advice beyond that budget
  exhausts safely rather than causing early replay. CLI's feature-scoped external connection retries can be unbounded;
  adoption needs native provider/error eligibility and cancellation semantics.
  Upstream preserves an absolute provider Retry-After deadline across delayed notification
  ([source](https://github.com/openai/codex/blob/875bf9209bd9aeb0a5f102888ccd90b2b59cc3c9/codex-rs/core/src/responses_retry.rs#L158),
  [test](https://github.com/openai/codex/blob/875bf9209bd9aeb0a5f102888ccd90b2b59cc3c9/codex-rs/core/src/responses_retry_tests.rs#L53)).
  CLI selects its local backoff after notification; Alpha's existing policy includes prior recovery/publication time
  in its selected local deadline. The elapsed-delay repair does not claim exact parity for that local timing choice.
- **Optional post-turn compaction:** admitted human steering skips/interrupts optional compaction, retaining the old
  transcript until a safe commit succeeds. CLI also performs post-completion work; this is an Alpha responsiveness
  choice, not evidence of an upstream stale-view defect. Required pre-step compaction is preserved.
- **Coverage:** final text and `update_plan` do not certify that a prose specification was fully implemented. No
  mandatory completion tool, hidden extra model call or inferred Goals runtime was added. Explicit Alpha acceptance
  checks, child receipts and workspace mutation policy remain enforced.
- **Next bounded work:** retrievable originals through Plan handoff/compaction; orphaned physical command debt on
  reload without invented exit evidence; explicit persistent-service readiness; separate Gemini/Anthropic terminal
  normalization repairs. Those other-provider defects are not claimed as Copilot incident causes.

### Bounded service-completion plan

The CLI test `unified_exec_keeps_long_running_session_after_turn_end` completes a turn while its process stays alive,
then shuts it down with the session. Alpha has two distinct completion fences: Task waits for the command, while
ParentVerification also blocks on its physical mutation reservation. Today the command receipt is finalized after
physical exit. Removing either fence alone cannot reproduce that CLI behavior safely.

The smallest complete native change is:

1. Add optional, validated service lifetime intent to the existing command contract. Existing calls remain finite;
   commands owning finite acceptance checks cannot opt out of those checks. Execution permission stays unchanged.
2. Bind a bounded host-observed readiness receipt to task/execution/owner generation and its specific check. Readiness
   keeps the process status `running` and cannot stand in for exit or passing finite tests.
3. Atomically capture startup mutations through that readiness barrier and transfer the physical reservation to a
   retained-service lease in the existing ledger. The lease continues protecting mutations and cleanup while ceasing
   to represent unpublished finite-operation debt. Unknown scope or failed observation remains blocking.
4. Retain one observation/stop owner independent of the completed agent status and Task object. AgentControlStore's
   agent runtime owner is released for inactive status; a retained service needs ownership for its entire physical
   lifetime. Subsequent writes invalidate captured evidence; actual exit, timeout and
   cancellation settle the lease once. Failed stop or persistence keeps unresolved recovery visible.
5. Persist the minimal lease beside AgentControlStore. CommandSessionRegistry currently uses a `WeakMap<Task>` and
   command evidence is in memory; reload must prove physical identity before reattachment, otherwise expose recovery.

This belongs in the existing command schema/ToolRegistry admission, ExecuteCommandTool, CommandSessionRegistry and
TerminalRegistry, shared persisted schemas, AgentControlStore, ParentVerification, and Task projection. It does not
require a second process runtime. Future validation must cover ready service plus finite checks, pending/failed finite
checks, spoofed or cross-execution readiness, later writes, failed durable transfer, exit during transfer, failed stop,
provider handoff, live/dead/unknown owners after reload, and stale session IDs on VS Code 1.122.1. This plan is unimplemented.

## Validation record

Normal regressions were added beside their owners. Focused failures established the admission, lifecycle, provider,
ingestion and command races before repair; the integrated Stop-hook contract tests were added after removal of the
cutoff, so no pre-repair failure is claimed for those tests. Historical investigation files remain unchanged.
Integrated checks use Node 24.14.1, pnpm 11.24.0 and the required VS Code 1.122.1 host.

Regression entry points include
[durable published-ask admission](F:/roo-fork/Alpha-Code/src/core/webview/__tests__/published-ask-response.spec.ts:109),
[completion/idle queue races](F:/roo-fork/Alpha-Code/src/core/task/__tests__/Task.completion-followup.spec.ts:50),
[optional compaction interruption](F:/roo-fork/Alpha-Code/src/core/task/__tests__/Task.post-turn-followup.spec.ts:56),
[bounded command completion](F:/roo-fork/Alpha-Code/src/core/task/__tests__/Task.command-completion-wait.spec.ts:64),
[real elapsed-retry pacing](F:/roo-fork/Alpha-Code/src/core/task/__tests__/Task.retry-progress.spec.ts:70), and
[navigation/receipt ownership](F:/roo-fork/Alpha-Code/webview-ui/src/components/chat/__tests__/ChatView.spec.tsx:4917).

The first exact-host gate run passed all five `extension.test` checks on 1.122.1, then failed evidence capture before
the remaining smoke suites. Its retained run is `dd83c5c3-a39a-4c57-9b88-703d39b11a69` under the disposable
`alpha-vscode-e2e-CPNQPb` temporary directory. The same ownership validation deterministically failed on
`fs.realpath(os.homedir())` with `EPERM` inside the filesystem sandbox, and succeeded with the required host filesystem
access. No capture-started marker or manifest was written. The runner must be rerun with that access; the failed run
remains preserved and is not counted as a passing smoke gate. No ownership check was weakened.

The next attempt encountered disappearing shared runner output. The unchanged runner was compiled into ignored
`apps/vscode-e2e/dist` at the same directory depth, preserving its fixture and source-root resolution. Seven smoke
suites passed with complete evidence before the global Windows `vscode-updating` lock blocked the eighth launch.
After the user closed VS Code, the remaining five suites passed with complete evidence on **1.122.1**. Together those
runs cover the same twelve smoke suites; neither earlier failed command is relabeled as passed. Logs are the temporary
`alpha-cli-convergence-smoke-1221-isolated.log` and `alpha-cli-convergence-smoke-1221-remaining.log` files.

Broad unit validation initially exposed stale prototype fixtures and sandbox limitations. Queue/persistence unit
fixtures now inject their virtual storage boundary while retaining the real MessageQueueService. Provider fixtures use
the real ownership registry, current history/projection adapters and controlled promises at the actual mode boundary.
Observable ownership, content, provenance and invalidation assertions were preserved; one history assertion now
compares content rather than object identity because the current adapter stages a copy. This refresh exposed the real
fresh-draft close bug above. Native packaging and Windows
process-tree assertions passed unchanged with required filesystem/process access; their sandbox failures were not
fixed by weakening expectations. The externally corrected incident-view assertion is retained.

A later standard smoke run exposed the elapsed-delay bug in the second compaction acceptance case. Recovery committed
successfully, but a 223ms backoff expired while compaction took 232ms. Passing zero remaining delay through the general
request-timeout helper selected almost the remaining 90-second budget; queued steering stayed durable while the view
waited. The retained failed run is `3d07978b-216b-4f22-b8c7-af98d86bea30` under temporary `alpha-vscode-e2e-E9KH3s`.
Two deterministic real-helper regressions failed before the guard and passed after it; the focused retry suites passed
30 tests, including positive-delay, cancellation and expired-budget controls. No host timeout or assertion was changed.

The broad test rerun uses bounded Vitest workers and Turbo's explicit `--env-mode=loose` so the worker settings reach
the package processes. Scheduled-task fixtures join the actual lease releases and storage transactions before cleanup,
and close-admission tests wait for durable failure publication. No production scheduling behavior or test timeout was
changed for those fixture repairs.

Final static QA found three host-owned ask consumers that omitted queued delivery receipts. Three normal Task
regressions failed for the missing/hidden IDs before repair, then passed. The affected six-suite run passed 354 tests
and the extension typecheck passed. Other host-owned history, primary recovery and completion-review ask consumers
already retained their IDs. This is a shared Alpha receipt invariant, not a claim about unseen Copilot internals.

Final integrated results on the frozen production/test sources:

| Check                                                  | Result                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test --env-mode=loose`                           | PASS; all 8 Turbo tasks successful. Extension: 598 files / 9,503 tests passed; 4 files / 42 tests skipped. Webview: 179 files / 1,926 passed / 2 skipped. Shared types: 367 passed; core: 169; IPC: 3; build tooling: 1. Unchanged packages reused their passing cache in the final run. |
| `pnpm check-types`                                     | PASS; 9 tasks successful.                                                                                                                                                                                                                                                                |
| `pnpm lint`                                            | PASS; 8 tasks successful.                                                                                                                                                                                                                                                                |
| `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` | PASS; all 12 suites / 34 checks passed on actual VS Code 1.122.1, including both compaction cases and all 7 LM contracts. Each run reported complete evidence capture.                                                                                                                   |
| Preservation / scope                                   | All 93 initial dirty paths remain; no missing files. The final non-document source audit covers 2,743 paths. No dependency, version, lockfile or tracked generated-output change was introduced by this convergence work.                                                                |

Temporary logs are `alpha-cli-convergence-final-unit-bounded.log`, `alpha-cli-convergence-final-types.log`,
`alpha-cli-convergence-final-lint.log`, and `alpha-cli-convergence-final-smoke-1221.log` under the Windows temporary
directory. The successful compaction run is `089b1fcc-20d2-409c-bde5-0a8b894c64dd`; the final LM run is
`a97f91b6-9a62-4eca-9675-c3dd223232b4`. Earlier failed runs remain preserved separately.

Read the [generated managed-agent evidence](F:/roo-fork/Alpha-Code/artifacts/certification/managed-agent-milestone-evidence.json)
for the deterministic certification result, counts and frozen source fingerprint. The corresponding automated host
acceptance result is recorded in temporary `alpha-cli-convergence-final-managed-certification.log`. The command is
`pnpm certify:managed-agents:automated`, with the host explicitly pinned to 1.122.1. The existing matrix separately
lists eight live/manual integration rows; deterministic or scripted-host success must not relabel those rows as passed.
This review is frozen before certification so its evidence can bind to the same complete working-tree state.

No live GitHub Copilot evaluation of the reported specification was run. These results prove the covered harness
contracts and reproduced defects, not complete implementation of an arbitrary specification or full CLI parity.
