# Managed-agent return hang investigation

## Scope and reported behavior

This focused correctness investigation covers managed Worker result publication, parent wait admission, steering, and
ordinary Stop. Six investigation agents independently reviewed parent wake-up, child finalization, queued input, UI
projection, deterministic reproduction, and upstream behavior. It does not claim a repository-wide audit.

The reported task launched five workers into private worktrees. Some completed, timed out, or cancelled. Reviews appeared
complete with disabled Apply controls, and the parent displayed received agent updates but stopped making progress.
Further guidance remained “delivering to the current turn.” Pressing Stop released messages and work resumed.

The original task's private evidence has not been supplied. Findings below describe confirmed code paths and controlled
reproductions; matching the exact original task's event ordering requires its task ID or retained logs.

## Findings

### High / must-fix: settled worktree reviews can revert to pending in the parent transcript

`Task.upsertSubagentGroup` clones the retained prepared group into the transcript. Worker Apply/Discard then changes the
transcript copy and durable worktree artifact. Subsequent child progress or finalization republishes the prepared group.
If that group was not advanced with the action, it overwrites the transcript with the old `pending_review` state.

The resulting state is contradictory: capability checks correctly reject Apply against a terminal artifact, but the
parent's review barrier sees a pending transcript proposal and waits indefinitely. Stop force-releases that barrier.
This directly explains the reported combination of disabled Apply, received updates, and no further parent requests.
Equivalent publishers include spawned-child finalization, blocking groups, lifecycle events, and phase updates.

Fixed in `AlphaProvider.getWorkerChangeSetTarget`: Apply/Discard now target the matching retained group used by later
lifecycle publishers, with the transcript fallback preserved for reloaded groups. Existing artifact/verification
reconciliation runs before the review wait, including under Ask policy, so already-saved stale applied/discarded reviews
can recover without applying files again. A captured-state guard prevents an older asynchronous recovery read from
overwriting a newer Apply/Discard. Missing artifacts remain pending. The existing mutation gate and genuine pending or
conflicted reviews remain enforced.

### High / must-fix: steering can arrive before an agent wait lease exists

`waitForAgent` performs asynchronous admission work before `Task.beginAgentWait` installs its cancellation controller.
A human or agent steer arriving during that interval aborts existing controllers, but a newly registered wait can miss
that interruption and stay pending until timeout. The steer remains accepted but cannot reach the next model step.

Fixed in `Task.beginAgentWait`: a newly created lease checks already-pending steering and aborts with the existing
steering interruption error. Task cancellation retains priority, cleanup cannot clear a successor lease, and waits remain
independent of an ordinarily completed provider response's signal.

### High / must-fix: ordinary Stop can automatically submit previously queued input

After cancelling and joining a task, `AlphaProvider.cancelTask` restores it from history. The default history resume opens
a resume ask that automatically consumes queued input. Input queued before Stop can therefore start another model turn
without fresh human intent, accounting for the burst of messages and continued work after Stop.

Fixed through the host-only `requireExplicitResume` option on Stop restoration. The restored task keeps queued drafts
but does not auto-answer its resume prompt from the pre-Stop queue. Old delivery retries and agent messages cannot lift
the fence; fresh human submission or explicit resume can. Normal completed-task follow-up, ordinary history resume, and
intentional steer-and-restart retain their contracts. No persisted format or model-visible tool schema changed.

## UI interpretation

- A disabled Apply control is not proof of applied changes; it reflects the runtime action capability.
- “Received N agent updates” is the completed `wait_agent` tool receipt, not evidence that the parent started another step.
- Working counts come from agent runtime records and can coexist with already-received terminal updates.
- “Delivering” means a user queue message has been claimed and is awaiting durable settlement.

No UI-owned execution loop was found. A genuine review pause currently uses a private runtime flag and can look like
ordinary working state. Improving that presentation is separate from correcting the confirmed lifecycle defects.

## Upstream contract

Inspected current Codex CLI source and tests at commit
[`091008729d5572712ac08964a9602eb71cf31428`](https://github.com/openai/codex/commit/091008729d5572712ac08964a9602eb71cf31428),
retrieved October 19, 2026 America/New_York:

- [Agent wait](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)
  wakes for already-pending input and later human/agent messages.
- [Input queue](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/src/session/input_queue.rs)
  subscribes before checking pending input to prevent lost wakeups.
- [Completion delivery](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/src/agent/control/completion.rs)
  queues child outcomes without creating competing parent turns.
- [Stop regression tests](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/tui/src/chatwidget/tests/composer_submission.rs#L2363)
  retain queued drafts without automatically submitting them after ordinary interruption.
- [Explicit steer-and-restart](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/tui/src/chatwidget/input_restore.rs#L349)
  remains a separate intentional path.

Alpha keeps its native TypeScript runtime, worktree review gate, and existing security/approval boundaries. The changes
translate these behavioral invariants; they do not port upstream code or sandbox architecture.

## Validation and closure

Confirmed failing regressions before the fixes:

- Terminal child publication restored `pending_review` after both real Apply and Discard.
- Reloaded stale applied/discarded proposals were not reconciled before the review fence.
- A delayed recovery read overwrote a newer Apply.
- Both human and agent steering accepted before wait registration missed the new cancellation lease.
- Ordinary Stop restored a task that claimed old queued input and started another request without fresh user intent.

Focused results after fixing:

| Validation                                                         | Result                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Worker action and subagent suites                                  | 274 tests passed across two files; six new state/recovery regressions |
| Wait-admission and related steering/follow-up/wait suites          | 71 tests passed across four files                                     |
| Stop, queue, native ownership, and flicker-free restoration suites | 91 tests passed across five files                                     |
| Extension and E2E typechecks                                       | Passed                                                                |
| Changed extension files and E2E lint                               | Passed                                                                |
| Extension bundle                                                   | Passed                                                                |
| Certification configuration self-check                             | Passed                                                                |

The new `managed-agents.auto-apply.acceptance.test.ts` passed on actual Windows x64 VS Code **1.138.0** in 19 seconds.
It uses a deterministic provider, five real child tasks, a real private Worker worktree and patch, one timed-out child,
two cancelled children, and two completed children. It verifies artifact/live/persisted review agreement after final
publication, delivery of human steering exactly once, native command verification, balanced tool transactions, one
parent completion, no retained queued guidance, and zero active/queued agents. It is now included in the managed-agent
host gate. The fixture waits for the actual safe Apply boundary before asserting state, rather than assuming the first
group completion publication means automatic apply has already settled.

The first broad certification run passed all 26 deterministic contract rows, but correctly failed its source-stability
check because the new host fixture and this report changed during that run. This is not a passing overall certificate.
The completed source is frozen for the final rerun of `pnpm certify:managed-agents:automated`, which includes the
managed-agent host suites, and `pnpm --filter @alpha-code/vscode-e2e test:smoke:1380`. Final machine-readable results are
recorded in the ignored local `artifacts/certification/managed-agent-return-hang-validation.json` alongside the canonical
`managed-agent-milestone-evidence.json`; this document is not rewritten during the frozen-source check.

No live model requests were needed for these scheduling and state-publication regressions. The user's original task
evidence and paid live-model reproduction remain unverified. The initial stuck process needs the updated extension
loaded; its stale saved proposal state can then reconcile through the existing artifact reader, without deleting
worktrees or task history.
