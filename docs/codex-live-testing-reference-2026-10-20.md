# Codex reference for full and live reliability testing

Retrieved October 20, 2026, at approximately 05:01 UTC. This is a source comparison for the current testing and
performance pass. It records intended behavior and useful regression boundaries; it is not a test result or a claim of
whole-product equivalence.

## Reproducible reference

`git ls-remote https://github.com/openai/codex.git HEAD` returned
[`18795fc12571a3530d3e4ac18366e41cd2f57448`](https://github.com/openai/codex/commit/18795fc12571a3530d3e4ac18366e41cd2f57448).
The commit timestamp is `2026-10-20T04:49:25+00:00`. A separate ignored sparse checkout at
`artifacts/ux-reliability-hunt/upstream/codex-18795fc1` is detached at that commit and has a clean Git status. The previous
`8196bcdc` and `09100872` checkouts and their reports remain intact. This revision is the reference for new findings in
this pass; it does not retroactively change the provenance of prior tests.

The OpenAI Docs skill was applied. The fetched official
[app-server lifecycle documentation](https://learn.chatgpt.com/docs/app-server#lifecycle-overview) distinguishes starting
or resuming a thread, starting a turn, steering that active turn, streaming notifications, and receiving terminal turn
status. The source and tests below provide the more specific contracts. No upstream Rust code, prompts, or runtime was
copied into Alpha, and no upstream Rust tests were run by this research task.

## Behavior to preserve while fixing findings

| Surface                  | Verified upstream contract                                                                                                                                                                                   | Alpha test or measurement implication                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human steering           | `turn/steer` requires an expected active turn ID and reports a mismatch, no active turn, or a non-steerable turn.                                                                                            | Race navigation, Stop, late delivery, and replacement against the captured task/turn owner. A successful UI enqueue must not mean input was silently redirected.                                          |
| Input wakeup             | `InputQueue` subscribes before inspecting pending input. Active-turn checks and queue mutations remain atomic. Already queued mail and human input are observable immediately.                               | Use controlled arrival barriers around subscription and queue admission. Avoid a timing-dependent sleep as the only regression.                                                                           |
| Worker wait              | Both handler generations can return before every Worker has finished. The v1 handler returns the first final status and any immediately ready statuses; v2 wakes for mailbox activity, steering, or timeout. | A test needing all replies must accumulate identified results until every required reply is present. A Worker UI completion event is not a result-publication barrier.                                    |
| Child completion         | The controller routes a captured terminal outcome through queue-only communication (`trigger_turn: false`) and measures queued versus failed delivery.                                                       | Preserve pending child mail without manufacturing an extra provider request after a final answer. Do not treat receipt acceptance as proof the parent consumed the result.                                |
| Durable queue            | Queue start requires a resumed thread, rejects active or pending turns, and preserves queued items through interruption. Explicit queue start can select a non-head item.                                    | Verify persistence, ordering, per-chat identity, and failed writes separately. Alpha's ordinary FIFO queue remains its own UI contract; do not infer Codex requires every start to use the head.          |
| Cancellation             | Consumer disposal cancels the response mapper. A full downstream channel still records cancellation and partial completed items when its consumer disappears.                                                | Test cancellation before request admission, during streaming, while downstream publication is held, and after a successor owns the surface. Preserve partial canonical history and terminal distinctions. |
| Terminal notification    | Abort signals before waiting for task shutdown. The abort lifecycle callback and interrupted-history flush precede terminal notification.                                                                    | Measure Stop admission and final settlement separately; never improve displayed latency by publishing completion before required cleanup or persistence.                                                  |
| File-change replay       | A completed patch can render with no preceding start notification; a start plus completion renders once. Empty success and failed patches retain different outcomes.                                         | Optimize completed-only transcripts without making old approval previews a prerequisite. Preserve distinct repeated edits and failure/cancellation filters.                                               |
| Incremental presentation | Stable completed Markdown blocks are retained while the last block changes. Source-wide dependencies and display changes deliberately invalidate retained output.                                            | Reduce work on stable content while testing the incremental result against a complete projection. Correct invalidation matters as much as avoiding repeated work.                                         |
| Per-chat status          | The app server separates a single-thread status lookup from a requested set of threads, backed by a map keyed by thread ID.                                                                                  | A single incremental message should not require deriving every open chat's unrelated presentation state. Preserve the existing lifecycle projection and identity checks.                                  |

Sources for the table:

- Steering: [turn_processor.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/app-server/src/request_processors/turn_processor.rs#L1063),
  [codex_thread.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/core/src/codex_thread.rs#L565).
- Wakeups and atomic ownership: [input_queue.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/core/src/session/input_queue.rs#L150).
- Wait handlers: [v1 wait.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/core/src/tools/handlers/multi_agents/wait.rs),
  [v2 wait.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L69).
- Queue-only results: [control/completion.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/core/src/agent/control/completion.rs#L113).
- Queue start: [thread_queue_processor.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/app-server/src/request_processors/thread_queue_processor.rs#L185).
- Stream ownership: [client_common.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/core/src/client_common.rs#L123),
  [client.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/core/src/client.rs#L2532).
- Abort ordering: [tasks/mod.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/core/src/tasks/mod.rs#L943).
- File-change projection: [history_projection.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/tui/src/chatwidget/tests/history_projection.rs#L268).
- Incremental rendering: [streaming/render.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/tui/src/streaming/render.rs),
  [markdown_render_cache.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/tui/src/history_cell/markdown_render_cache.rs).
- Per-thread status: [thread_status.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/app-server/src/thread_status.rs#L113).

## Concrete regression references

These current upstream tests are useful behavioral examples, not code to port:

- `core/src/session/input_queue.rs`: `input_queue_notifies_steer_subscribers`,
  `input_queue_reports_already_pending_steer`, `input_queue_drains_mailbox_in_delivery_order`, and
  `input_queue_uses_latest_followup_choice_and_ignores_queue_only_mail`.
- [pending_input.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/core/tests/suite/pending_input.rs):
  `steer_interrupts_wait_agent_and_is_sent_in_follow_up_request`, `steer_during_stream_retry_skips_backoff`,
  `steers_during_tool_drain_preserve_tool_output_and_each_input`,
  `queued_inter_agent_mail_does_not_restart_after_final_answer`, and
  `steer_during_compaction_is_sent_after_compaction`. The retry test holds a provider's nominal 60-second retry delay
  and verifies fresh input avoids that delay; it still checks both original and fresh input in the follow-up request.
- [thread_queue.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/app-server/tests/suite/v2/thread_queue.rs):
  `queue_crud_preserves_identity_order_and_notifications`, `queue_rejects_messages_after_reaching_its_capacity`,
  `cold_thread_resume_dispatches_a_persisted_queued_submission`,
  `interrupt_preserves_queue_and_queue_start_can_resume_a_non_head_item`, and
  `queue_start_while_active_returns_busy_and_preserves_the_queue`.
- [model_request_tests.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/core/src/model_request_tests.rs#L26):
  `interceptors_forward_before_completion_in_order_and_cancel_upstream` verifies transformed ordered deltas before
  provider completion and cancellation after consumer disposal.
- [client_tests.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/core/src/client_tests.rs#L1889):
  `dropped_backpressured_response_stream_traces_cancelled_partial_output` fills the mapper channel, holds an output
  publication, drops the consumer, and verifies cancelled execution with the completed partial item retained.
- [abort_lifecycle.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/core/tests/suite/abort_lifecycle.rs#L57):
  `abort_lifecycle_finishes_before_terminal_event` holds a lifecycle contributor behind a controlled barrier. Interrupt,
  conditional interrupt, and shutdown cannot emit the terminal event before it completes.
- [history_projection.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/tui/src/chatwidget/tests/history_projection.rs#L268):
  `snapshot_formatter_completed_patch_needs_no_started_notification`,
  `snapshot_formatter_live_and_buffered_patch_notifications_render_once`, and
  `snapshot_formatter_empty_success_and_failed_patch_keep_their_outcomes` cover complete-only and mixed replay paths.
- [streaming/render_tests.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/tui/src/streaming/render_tests.rs):
  `incremental_render_keeps_final_block_mutable_and_matches_full_render`,
  `growing_single_top_level_blocks_render_and_scan_in_one_pass`,
  `reference_link_definition_recomputes_earlier_and_later_blocks`, and
  `inline_visualizations_use_canonical_full_render` check equivalence and deliberate invalidation.
- [chatwidget/tests/app_server.rs](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/tui/src/chatwidget/tests/app_server.rs#L1684):
  `live_app_server_turn_completion_repairs_dropped_message_deltas` checks that the final canonical item repairs a
  transport's missing delta without duplicating a terminal answer.

## Measured optimization boundaries

Two candidates in the current Alpha pass are presentation work, with no intended agent-policy change:

1. `webview-ui/src/components/chat/utils/fileChangesFromMessages.ts` scans earlier candidates for every completed edit.
   Modern completed-only transcripts have no legacy approval preview to match. Restricting compatibility matching to
   prior unmatched previews is consistent with completed-only upstream replay. Preserve nearest preceding matching
   preview selection, normalized paths, command-execution identity, original-content checks, output order, and distinct
   repeated edits. Include mixed same-path and legacy-preview workloads; report their limits separately from the modern
   transcript result. The upstream's own `app/thread_events.rs::file_change_changes` performs a newest-first scan for a
   requested turn/item. This comparison does not establish a matching upstream indexing algorithm.
2. Alpha's incremental message publication should derive the affected chat's existing live projection without building
   all unrelated chats' projections. Current Codex's separate single-thread and multi-thread status reads support that
   ownership boundary. Keep the canonical reducer, observer-specific permissions, session identity, and full snapshot
   paths unchanged. Measure multiple loaded-chat counts and check identical selected projection output.

Neither candidate establishes a provider latency or general rendering-speed improvement until measured with the same
workload. Record warm-up, sample count, message/chat sizes, elapsed CPU or wall time, memory assumptions, and assertion
counts. Synthetic projection benchmarks supplement exact-host and live tests; they do not replace them.

For stream latency, use distinct metrics. Current Codex's `client.rs` starts `ttft_ms` in the mapper and ends it at the
first `ResponseEvent::OutputItemAdded`; this can precede visible text. Alpha's provider first item, first text delta,
extension-to-webview publication, and actual browser paint must not be reported as the same measurement. Current v2
wait also measures duration by `mailbox`, `steered`, or `timed_out` outcome. Total wait duration alone cannot distinguish
an intentional idle wait from a blocked delivery.

The TUI [frame scheduler](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/tui/src/tui/frame_requester.rs)
coalesces draw requests and limits notifications to 120 FPS, with fake-time tests for coalescing, late frames, and
future deadlines. This is a terminal-specific implementation detail. It justifies testing bounded duplicate work; it
does not prescribe a 120 FPS React/webview throttle. Its scheduler request channel is unbounded, so this source must not
be cited as evidence that every upstream queue is bounded or that Alpha may weaken its own bounds.

## Deliberate distinctions and evidence limits

| Distinction                   | Decision for Alpha                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox                       | Codex sandbox architecture remains outside the convergence target. Preserve Alpha's existing path scope, approval, mutation, execution, and security enforcement.                                                                                                                                                             |
| Additional tools              | Skills, HTML preview, Tickets, scheduled tasks, and other retained tools stay on the shared TypeScript harness. Apply the same cancellation, transaction, persistence, and terminal contracts.                                                                                                                                |
| Worker changes                | Alpha's staged worktree Apply/Discard review is a native extension capability. A pending review can fence completion, but accepted human steering must remain usable and already settled artifacts must not become pending again. Upstream patch approval is a related authority boundary, not an identical Worker review UI. |
| UI and reload                 | Native VS Code panel restoration, draft storage, theme/focus handling, and host 1.138.0 compatibility are Alpha adapter contracts. Public Codex TUI source does not prove the private Codex IDE implementation behaves identically.                                                                                           |
| User message queue            | Durable queue identities and explicit interruption behavior align; Alpha's ordinary FIFO admission and native restore fence retain their own documented semantics. Do not introduce an extra queue engine to mimic protocol names.                                                                                            |
| Retry and cancellation timing | Signal propagation, correct ownership, and terminal ordering are targets. Upstream's 100 ms task grace period is not a universal timeout requirement for Alpha providers or subprocess adapters.                                                                                                                              |
| Live evidence                 | Record exact host, provider/model, signed-in profile, fixture/task, request count, retries/rate limits, sample count, and run conditions. A single live success does not establish reliability or speed across users/models.                                                                                                  |

This research inspected source and tests and fetched official documentation. It did not execute Alpha unit tests,
extension hosts, live providers, Codex tests, benchmarks, or package checks. Integrating agents own those results. No
universal no-crash claim, installed-user failure frequency, complete historical upgrade coverage, or proprietary
frontend equivalence follows from this comparison.
