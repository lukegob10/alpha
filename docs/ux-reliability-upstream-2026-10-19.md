# Reliability reference for the UX bug hunt

Research date: October 19, 2026, America/New_York. This is a source comparison, not a reliability benchmark or a claim
that another product never hangs. The target is ordinary operation that finishes, delivers input and results, and keeps
the right chat visible. Recovery is a necessary fallback, not the intended successful path.

## Provenance and public scope

| Reference                                                                                          | Revision or retrieval                                                                                             | Material inspected                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Codex](https://github.com/openai/codex/commit/091008729d5572712ac08964a9602eb71cf31428)           | `091008729d5572712ac08964a9602eb71cf31428`; current HEAD confirmed with `git ls-remote` during this investigation | Core input queue, task lifecycle, child completion routing, app-server status and terminal-event handling, transport, and related tests                                                                   |
| [Cline](https://github.com/cline/cline/commit/ca7402c5abced42da9c7c50500b7a9bae82cb6fa)            | `ca7402c5abced42da9c7c50500b7a9bae82cb6fa`; current HEAD confirmed during this investigation                      | VS Code SDK task-control coordinator and tests; storage migrations                                                                                                                                        |
| [Roo Code](https://github.com/RooCodeInc/Roo-Code/commit/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16) | `b867ec9145750d0ae1ff7f02d35406e9bf2a0b16`; current HEAD confirmed during this investigation                      | Task cancellation/disposal and pending tool-result persistence                                                                                                                                            |
| Official OpenAI documentation                                                                      | Retrieved October 19, 2026                                                                                        | [App-server](https://learn.chatgpt.com/docs/app-server), [open-source scope](https://learn.chatgpt.com/docs/open-source), and [troubleshooting](https://learn.chatgpt.com/docs/reference/troubleshooting) |
| VS Code documentation                                                                              | Retrieved October 19, 2026                                                                                        | [Webview lifecycle/persistence](https://code.visualstudio.com/api/extension-guides/webview#persistence) and [extension host](https://code.visualstudio.com/api/advanced-topics/extension-host)            |

The Codex IDE extension frontend is not open source. Official documentation identifies app-server as the public engine
behind rich clients including that extension. The implementation conclusions below concern that public engine and CLI,
not an inferred proprietary extension UI. Alpha should implement the verified behavior in its existing TypeScript
kernel and VS Code adapters; this does not propose importing the Rust runtime or replacing Alpha's security model.

An ignored, task-owned reference cache is available at
`artifacts/ux-reliability-hunt/upstream/codex`. It is a sparse checkout at the pinned Codex revision, not an update to a
preexisting research checkout. Exact-revision Cline and Roo files are beside it. The cache is investigative material,
not a runtime dependency.

## What current Codex actually enforces

### Status belongs to the running thread

The app-server's `ThreadWatchState` keys runtime facts and watchers by thread ID. Running state, pending permission
requests, pending user-input requests, and system errors determine the projected status. Dropping permission/input
guards removes their waiting flags; completing a turn returns the thread to idle. An observed in-progress turn wins
over a temporarily stale idle/not-loaded watch value. Tests cover the transitions and non-interactive threads.

Source and tests: [thread_status.rs](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/app-server/src/thread_status.rs).

For Alpha, a chat's buttons and working label should be projections of its own canonical lifecycle, not deductions from
the last visible message, another chat's request, or the presence of a partial transcript row. A real waiting condition
must identify its owner and release when that condition ends.

### A terminal event carries an outcome

The app-server maps completed work with a recorded error to `failed`, successful work to `completed`, and interruption
to `interrupted`. Pending interrupt RPCs are answered through their own request IDs. The protocol therefore does not
equate the receipt of a completion notification with successful execution.

Source and tests: [bespoke_event_handling.rs](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/app-server/src/bespoke_event_handling.rs).

The official [event contract](https://learn.chatgpt.com/docs/app-server#events) separates thread status, turn outcomes,
item start/completion, and streaming deltas. Clients must keep consuming the event stream. Final item data is
authoritative; a spinner or accumulated text alone is insufficient evidence that a tool or turn finished.

For Alpha, errors, cancellation, and completion should all clear the corresponding activity and settle accepted tool
calls once, while retaining their distinct outcomes. A generic success-shaped text result should not conceal a failed
or cancelled tool.

### Subscribe before checking for pending work

`InputQueue.subscribe_activity` creates its receiver first and then checks turn-local input and mailbox contents. Its
tests cover later steering/mail and already-pending steering. This closes the gap in which an event arrives between a
pending check and listener installation.

Source and tests: [input_queue.rs](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/src/session/input_queue.rs).

For Alpha, every asynchronous admission boundary matters: an accepted message cannot become dependent on one specific
instantaneous abort signal. Its durable pending state and its wake-up registration must agree. The same principle
applies to child returns, human steering, approval responses, and completion of background commands.

### Child completion queues data; it does not race a second parent turn

Core captures a terminal child outcome and routes it through agent control without retaining the child's live turn
context. Its completion communication uses `trigger_turn: false`. Delivery metrics explicitly distinguish queue
acceptance from delivery failure; the module documents delivery as best effort.

Source: [completion.rs](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/src/agent/control/completion.rs).

For Alpha, `received updates` should mean that particular transaction settled, not that the parent necessarily sampled
or integrated every result. Accepted, incorporated, and terminal outcomes need observable ownership. Independent
callbacks must not start competing parent loops or overwrite newer applied/review state.

### Persistence and finalization share the lifecycle owner

The task spawn site invokes the task, attempts a rollout flush, reports a flush failure as a warning, calls the shared
finalizer when not cancelled, and notifies task waiters. Cancellation follows a separate explicit lifecycle path. This
is stronger ownership than requiring each individual task implementation to remember its own final notification.
It is not a claim that disk writes always succeed: the source explicitly handles that failure.

Source: [tasks/mod.rs](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/src/tasks/mod.rs).

For Alpha, the existing turn engine, lifecycle journal, and transcript store should own settlement. Presentation code
must not become a second task runtime. A save error should remain visible and preserve unsaved data, without making an
unrelated chat depend indefinitely on that write.

### Backpressure has an explicit failure behavior

The app-server outbound transport uses a bounded channel. For a disconnectable connection, a full outbound queue
disconnects the slow connection rather than waiting forever on that client. Other transport types retain their
specified send behavior. This is a transport-specific design, not a universal recommendation to disconnect Alpha's
webview or discard its events.

Source: [transport.rs](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/app-server/src/transport.rs).

For Alpha, delayed webview rendering or delivery must not own the progress of canonical execution. State snapshots,
bounded queues, cancellation, and an explicit reattachment path should avoid both unbounded retention and permanently
blocked finalization. Any dropped transient delta must remain reconstructible from authoritative final state.

## Useful evidence from other extension harnesses

Cline's current SDK task-control coordinator raises its cancellation epoch synchronously before awaiting SDK abort.
It claims a task-view generation before the first asynchronous history read, so a slower old selection cannot replace
a newer selection. Clearing a task also clears its task-scoped settings overlay. The comments describe real stale
button/setting failure modes, and the tests verify cancellation ordering, transition serialization, and settlement of a
question whose state post is still in flight.

Sources: [coordinator](https://github.com/cline/cline/blob/ca7402c5abced42da9c7c50500b7a9bae82cb6fa/apps/vscode/src/sdk/sdk-task-control-coordinator.ts),
[tests](https://github.com/cline/cline/blob/ca7402c5abced42da9c7c50500b7a9bae82cb6fa/apps/vscode/src/sdk/sdk-task-control-coordinator.test.ts).

These patterns support Alpha's existing navigation generations and session ownership. They also show why fixing only
the visual disabled state is insufficient: stale asynchronous producers must lose mutation authority at the owning
boundary. They do not establish that Cline's complete runtime is race-free.

Roo's current `Task` abort path cancels the active HTTP request and centralizes cleanup of profile listeners, queue
listeners, task listeners, terminals, ignore controllers, and file-context tracking. Its pending tool-result flush
waits for assistant history before writing results, retains pending content when saving fails, and exposes bounded
save retries. The inspected implementation also includes timeout/log-and-proceed behavior; that should not be copied
as a substitute for Alpha's stricter tool-transaction and persistence contracts.

Source: [Task.ts](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/task/Task.ts).

## What skipped updates can explain, and what they cannot prove

Older installations can carry saved configuration, model identifiers, task history, partially completed migrations,
and credentials into a later release. A fresh profile passing tests does not validate those inputs. A service-side
model or credential change can also occur while the extension version stays fixed. These are hypotheses to test;
this research contains no user population telemetry that identifies the most common cause of Alpha complaints.

Current Codex has explicit tests that cold-resume/fork legacy protected-model settings under current requirements,
rather than trusting the stored settings as current authority:
[model_auto_review.rs](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/app-server/tests/suite/v2/model_auto_review.rs).
Cline's [storage migrations](https://github.com/cline/cline/blob/ca7402c5abced42da9c7c50500b7a9bae82cb6fa/apps/vscode/src/core/storage/state-migrations.ts)
similarly show that legacy state is a real compatibility surface. For example, the inspected code moves legacy
workspace settings only if a global setting is absent and removes legacy custom instructions only after writing them.
Neither example proves all upgrade sequences safe.

VS Code's [webview contract](https://code.visualstudio.com/api/extension-guides/webview#persistence) explains a separate
source of apparent crashes: hidden webview content may be destroyed; `getState`/`setState` preserve a serializable UI
snapshot, and panel serialization handles restart restoration. Retaining hidden content has memory costs. Alpha's
task/history ownership must survive independently of whether React currently exists.

To distinguish these causes, a useful incident record needs the actual loaded Alpha version, exact VS Code version,
profile/storage identity, selected provider/model, current lifecycle and pending-input receipts, migration status, and
the last bounded error. Keep prompts and credentials out of that record. Record whether the failure reproduces in an
existing profile, a fresh profile, or both. Installing a VSIX without reloading an existing extension host is a distinct
condition from running the new build.

## Mapping to Alpha's existing owners and tests

This table is an audit/test map, not a list of newly confirmed Alpha defects. The parallel bug-hunt findings determine
which rows need implementation changes.

| User-visible failure                              | Owning Alpha boundary                                                 | Stable regression to require                                                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Working forever after success/error/Stop          | `AgentTurnEngine`, lifecycle journal, `Task` adapter                  | Every terminal outcome settles once; no leftover active request/tool/approval ownership                                                 |
| Input stays delivering or appears in another chat | Task input receipts, agent waits, session routing                     | Submit before/during wait admission; change selected chat while delivery is delayed; prove exactly-once incorporation                   |
| Old chat replaces the newly selected one          | `AlphaProvider`, `TaskSessionRegistry`, webview navigation projection | Controlled out-of-order history loads; latest selection owns the view throughout every await                                            |
| Blank or disabled view after hide/reopen          | Host snapshot publication and webview hydration                       | Destroy/remount the view while execution continues; the initial refreshed snapshot contains the current task and controls               |
| Lost tool result after reload/delegation          | `ProviderTranscriptStore`, task persistence and compaction            | Inject a write failure/restart between transaction stages; accepted calls have terminal results and saved external edits survive        |
| Stop hangs or late work reactivates it            | Task cancellation, provider abort, tool/process disposal              | Slow provider and delayed tool teardown; old callbacks cannot revive a stopped generation; fresh explicit user intent still works       |
| Existing users fail while fresh profiles work     | Activation, `ContextProxy`, settings and provider migrations          | Old saved fixtures, skipped releases, interrupted migration, replay, and custom settings; run migrations twice and preserve user intent |

The strongest prevention is to test these ownership boundaries under deliberately reordered events, not to add
unconditional retries or an idle timer that resets the UI. Use controlled barriers and deterministic providers first,
then the exact VS Code 1.138.0 extension-host gates. Live-model runs supplement those checks but cannot make a race
deterministic or demonstrate universal reliability.

## Evidence limits

No upstream Rust tests or third-party extension tests were executed for this document. Their source and assertions
were inspected. No proprietary Codex frontend internals, fleet incident rates, or telemetry were available. This
document therefore supports behavioral comparisons and a concrete Alpha test strategy, not a ranking of products or
an assertion about what most infrequently updating users experience.
