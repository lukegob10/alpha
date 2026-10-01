# Message queue and steering contract review

Retrieved on **2026-09-30 (America/New_York)** from current `openai/codex` main commit
[`b44ca872b1059c65f0eb6a7534e9e8ae55df54a8`](https://github.com/openai/codex/commit/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8).
This review examines public CLI/core/app-server source and tests. It does not assert knowledge of proprietary Codex app
implementation details. Source tests were inspected; the upstream Rust suite was not executed in this workspace.

## Verified upstream behavior

| Contract                                                                                                                                                                                                                                                          | Current source and tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queueing and steering express different delivery intent. CLI defaults use Enter to submit and Tab to queue. Submitted input can steer a running turn; queued input waits until the current turn settles.                                                          | [Composer bindings](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/tui/src/bottom_pane/chat_composer.rs#L812-L813), [input dispatch](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/tui/src/chatwidget/input_flow.rs#L49-L94), [idle queue drain](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/tui/src/chatwidget/input_flow.rs#L235-L269)                                                          |
| Waiting input remains visible across delivery phases. The pending-input preview includes queued messages, pending steers, and rejected steers.                                                                                                                    | [Queue preview](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/tui/src/chatwidget/input_queue.rs#L84-L116)                                                                                                                                                                                                                                                                                                                                                                            |
| Steering carries a client submission identity. A steer remains pending until a committed user-message receipt matches it; the committed row replaces the preview and duplicate receipts are suppressed. Identity matching takes priority over textual comparison. | [Pending submission UUID](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/tui/src/chatwidget/input_submission.rs#L426-L440), [pending preview publication](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/tui/src/chatwidget/input_submission.rs#L533-L536), [committed receipt handling](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/tui/src/chatwidget.rs#L1324-L1366)                            |
| Admission validates the current turn while holding its ownership lock. Absent turns, mismatched expected turn IDs, review/compaction turns, and empty input are rejected before adding the input. Accepted input receives an acceptance order.                    | [Core steering admission](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/core/src/session/turn_input.rs#L705-L791), [app-server steering errors](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/app-server/src/request_processors/turn_processor.rs#L1025-L1102), [active turn test](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/app-server/tests/suite/v2/turn_steer.rs#L40-L99)                  |
| A rejected steer for a non-steerable turn returns to the visible follow-up queue, retaining content, source, and history information.                                                                                                                             | [Rejected steer recovery](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/tui/src/chatwidget/input_restore.rs#L288-L305), [error dispatch](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/tui/src/chatwidget/turn_runtime.rs#L301-L308)                                                                                                                                                                                                        |
| Steering while a tool drains must preserve every accepted input and exactly one real terminal result for the tool. A held-tool regression supplies two steers and checks their order, the actual tool output, and successful completion.                          | [Tool-drain regression](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/core/tests/suite/pending_input.rs#L1290-L1388)                                                                                                                                                                                                                                                                                                                                                                 |
| A steer can yield a waiting code-execution cell without stopping the cell. Immediate interruption and ordinary delivery have separate tests; their existence does not promise arbitrary tools can safely stop immediately.                                        | [Execution/wait regression](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/core/tests/suite/pending_input.rs#L1394-L1593)                                                                                                                                                                                                                                                                                                                                                             |
| Compaction preserves pending steers and applies them after the appropriate continuation boundary.                                                                                                                                                                 | [Steer during compaction](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/core/tests/suite/pending_input.rs#L1599-L1679), [post-compaction continuation](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/core/tests/suite/pending_input.rs#L2233-L2319)                                                                                                                                                                                         |
| The experimental app-server durable queue preserves submission identity, order, and change notifications. Starting its queue while a turn is active reports busy and preserves the queue; explicit interruption and resume preserve queued items.                 | [Queue identity/order regression](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/app-server/tests/suite/v2/thread_queue.rs#L117-L251), [busy start regression](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/app-server/tests/suite/v2/thread_queue.rs#L701-L773), [interrupt/resume regression](https://github.com/openai/codex/blob/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8/codex-rs/app-server/tests/suite/v2/thread_queue.rs#L560-L697) |

## Alpha ownership and intended alignment

Alpha's `MessageQueueService` owns durable queued messages and selection/claiming. `Task` owns delivery into the canonical
turn and persisted transcript receipts. `webviewMessageHandler` owns task-scoped command acknowledgements; `ChatView` and
`useTaskComposer` project this state and keep pending submissions scoped to their originating task. These existing layers
are sufficient; another queue engine or phrase classifier would add conflicting ownership.

Alpha intentionally uses **Enter to queue during a running turn, then an explicit Steer action**. This follows the requested
extension UX while differing from the CLI's default keyboard bindings. Preserve the common behavioral contract:

1. Pressing Enter yields a visible pending submission and then a durable queue acknowledgement or a visible recoverable
   rejection. Acceptance cannot be inferred from the disappearance of the composer draft.
2. Selection changes a queued message to a visible delivering phase. It does not remove the user's only visible copy or
   make the same item eligible for a second delivery. The committed transcript receipt ends this phase.
3. Recheck steer eligibility at the owning Task boundary after asynchronous persistence; an earlier webview-side check
   cannot authorize delivery into an unrelated ask or a turn that has already changed state.
4. A declined/busy/stale steering attempt preserves the already accepted queue item. Persistence failures also preserve
   a recoverable message; they must not produce success acknowledgements.
5. Delivery preserves submission identity and attachments. Identical text is allowed to represent distinct user messages.
   Replayed acknowledgements may not create duplicates or consume another message.
6. Command execution can delay steering until a safe boundary. The queue/delivering preview supplies immediate feedback
   while the canonical tool call/result transaction remains complete and correctly ordered.
7. Queueing, retry, cancellation, task navigation, reload, and background sessions follow the same task-scoped ownership
   and receipt rules. No matching against particular natural-language phrases is necessary.

## Regression scenarios for the local change

Use controlled promises around durable queue saves, transcript commits, provider streaming, and command completion.
Verify visible queued → delivering → committed transitions, rollback to queued on failure, and no duplicate eligibility
while delivering. Change active asks/turn state while a save is held and verify admission cannot answer the replacement
ask or delete the original queue item. Exercise same-text messages with different IDs, image-only input, failed queue
admission, rejected steering, task switching before command receipts, and delayed/out-of-order state projections.

## Implemented fixes

Five focused reviews covered UI submission, runtime delivery, upstream semantics, queue durability, and cross-layer
integration. The environment permitted three child-agent slots, so the final two reviews reused those agents. Existing
workspace changes were preserved.

- `ChatView` routes Enter and host submission consistently during streaming and approvals. Running-turn input and queued
  edits reach their normal input boundary before idle composer operations are considered. Pending admission receives a
  visible preview keyed by request identity; rejected admission preserves both the submitted input and newer drafts.
- `MessageQueueService.visibleMessages` projects claimed input as `deliveryState: "delivering"` until its containing
  transcript commits. The selectable FIFO remains separate. Delivery controls and reordering cannot apply to a claimed
  or not-yet-admitted row. This optional wire field accepts old messages unchanged and needs no persisted-format migration.
- `Task` rechecks steering eligibility after asynchronous claim persistence, retains admitted input after a failed
  handoff, and releases ask-owned input when command waits are superseded or cancelled. Ask supersession timestamps advance
  even within one millisecond; an accepted reply cannot be overwritten by another steer.
- Durable edits and admissions reserve each message identity before yielding. Ownership and selection barriers last
  through the final reserved operation, preserving rollback correctness and allowing a retry after an earlier failure.
- Queue acceptance follows queue publication. When consumption beats acknowledgement, the same patch includes the
  containing transcript and captured navigation sequence. The webview also rejects a transcript addressed to another
  task. Queue broadcasts reserve and dispatch every registered view before awaiting transports, preventing an older
  broadcast from reviving delivered input with a newer sequence in another view.
- Managed steering distinguishes failure before admission from delivery deferral after durable acceptance. A retained
  receipt is acknowledged, including legacy callers assigned a host-generated identity, so a retry cannot introduce a
  second queued instruction. Async-question annotation failure likewise cannot invalidate durable queue acceptance.

These changes use state, identities, and persistence receipts. They add no natural-language matching rules or alternate
task runtime. Tests use held promises and fake timers for timing-sensitive boundaries; the new regressions were observed
failing before their corresponding fixes.

## Local validation

Validation ran with Node.js `24.14.1` and pnpm `11.24.0` on Windows, finishing on 2026-10-01 (America/New_York).

- Fourteen focused extension files: **615 tests passed**, covering queue storage, steering, ask draining, command waits,
  post-turn continuation, task routing, managed steering, cross-view broadcasts, and API submission.
- Five focused webview files: **229 tests passed**, covering composer interactions, queue controls, task-scoped drafts,
  state merging, and refresh behavior.
- Shared types package: **39 files / 368 tests passed**; package typecheck passed.
- Extension and webview typechecks passed after dependency builds. Scoped extension/webview ESLint and shared-type lint
  passed. Touched-file formatting and whitespace checks passed.
- The exact-host smoke command was attempted. Its bundle prerequisite failed because the repository-root `LICENSE` file
  is absent, while `src/LICENSE` exists. This build limitation prevents claiming the full smoke gate passed. The compiled
  extension contains the final queue fixes; `test:smoke:1221:run` is the closest existing host-only validation command.
- Managed-agent automated certification was attempted: all **26 deterministic matrix entries** passed; **8 integration
  obligations** remained explicitly pending. Its final source-stability check rejected the run because this review document
  was edited during certification. A final certification run uses a frozen working tree; its generated evidence in
  `artifacts/certification/managed-agent-milestone-evidence.json` records the result without editing source files.

An earlier concurrent typecheck encountered temporarily missing generated declarations while a dependency build cleaned
its output; the subsequent complete extension and webview typechecks passed. No declaration workaround was added.
