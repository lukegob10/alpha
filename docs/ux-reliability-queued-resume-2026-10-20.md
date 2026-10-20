# Fresh human queue admission after restore

## Reference and observed failure

The exact VS Code 1.138.0 two-process editor reload investigation found a second resume boundary after serializer and
queue restoration succeeded. With retained queued text, ChatView sends a fresh Enter submission as `queueMessage`.
The provider persisted that input directly, while only `Task.submitUserMessage` could lift the explicit-resume fence.
The installed resume ask also captured its queue-drain decision once. Fresh input was durable but no model request began.

Codex CLI reference inspected: commit
[`8196bcdc189ad2c189d631b321fa54b8e09b9bb0`](https://github.com/openai/codex/tree/8196bcdc189ad2c189d631b321fa54b8e09b9bb0),
`app-server/src/request_processors/thread_queue_processor.rs` and the `thread_queue.rs` tests
`idle_queue_dispatch_preserves_client_id`, `cold_thread_resume_dispatches_a_persisted_queued_submission`, and
`interrupt_preserves_queue_and_queue_start_can_resume_a_non_head_item`. Metadata reads do not resume a cold thread;
explicit queue dispatch is an operation on a resumed thread and preserves submission identity. Alpha intentionally
keeps passive panel restoration and pre-Stop entries fenced until a new human instruction or explicit Resume.

## Owning fix

- Both human webview queue routes mark their internal provider admission as human: ordinary `queueMessage` and the
  already-answered legacy ask fallback. The wire protocol is unchanged.
- Task owns fresh durable human FIFO intake. Its existing per-receipt queue mutation lane reports whether an admission
  is new or duplicate; validation callbacks still run for duplicates. Resume permission is granted only after successful
  durability and a recheck of the captured task lifetime and transcript owner. Retries, passive additions, failed writes,
  Stop, cancellation, and replacement do not grant permission.
- The existing resume ask reevaluates its drain predicate on each existing poll. It selects the oldest saved entry,
  retaining later input in FIFO order. Idle queue wake also respects the explicit-resume fence. No new queue, registry,
  polling loop, persisted field, or approval path was introduced.

## Validation

The real Task/provider regression was red before the fix: direct submit passed, while fresh queued human intake never
started the next model request. After the fix both cases pass. The queue case also stops again and retries that same
receipt, verifying that the new Stop remains fenced.

Controlled tests cover passive additions, saved receipt retries, both resume ask kinds, FIFO selection, concurrent receipt
provenance, rejection of duplicate authorization, failed persistence, and Stop/lifetime/ownership loss during a held save.
The nearest ten-file lifecycle, queue, ownership, and legacy handoff run passed **859 tests with six existing skips**.
The final three-file lower-level run, including the second-Stop assertion, passed **74 tests**. These runs overlap.
The final handler test file passed **166 tests**, including both human queue ingress routes. Targeted ESLint,
touched-file Prettier, and tracked-file diff checks passed.

The root task's unchanged two-process native editor reload assertions passed against the initial queued-resume repair:
`F:\alpha-e2e\editor-reload-closure-20261020-final\run-exu4fS\editor-chat-reload-report.json`.
Final typechecking, packaging, exact-host smoke, and broader source-bound certification are recorded by the root task.
No live-model result is claimed.

## Legacy delegated handoff admission

A subsequent audit reproduced a related routing race. Human intake captured a child during handoff preparation, then
waited for its receipt lookup or per-receipt queue lane. The handoff committed and cancelled that child before intake
resumed. The new Task ownership guard correctly rejected the retiring owner, but the provider had not selected the now
live parent. A completed handoff could also remove the child alias while that original request remained in flight.

The provider now retains its captured handoff destination, checks it after asynchronous lookup, and passes the same route
check into the existing queue admission boundary. Only the identity of an explicitly observed route-change signal permits
selecting the new destination, with the original receipt. Stop, lost Task ownership, and storage failures preserve their
own outcomes. The Task lifetime guard remains intact; no locks, stored schema, or general error retry was added.

Three controlled handoff tests failed before this repair and passed afterward: held receipt lookup, held per-receipt
admission, and alias retirement. Two adjacent cases verify Stop rejection without transferring resume intent and actual
queue persistence failure propagation without repeating admission. All **17 handoff tests** and the **74 existing
queued-resume lower-level tests** passed together (**91 tests in four files**), with parent FIFO order and duplicate receipt
handling asserted. The root task reruns native and source-bound gates against this final repair.
