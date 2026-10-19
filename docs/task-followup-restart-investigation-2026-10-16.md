# Task follow-up restart investigation — 2026-10-16

## Scope and expected behavior

Five agents traced composer submission, retained-task lifecycle ownership, cold history restoration, cancellation and
provider continuation. This is a correctness cleanup of reproducible restart failures, not a claim that every possible
restart failure has been eliminated. A specific failing user task or provider log was not supplied.

An accepted follow-up must retain its task identity and durable input receipt, reach an eligible input consumer exactly
once, and leave its draft or queue recoverable if admission fails. Follow-up handling must preserve cancellation,
approval, workspace policy and terminal persistence barriers. Existing uncommitted performance work was preserved.

Current Codex CLI HEAD was reverified on 2026-10-16 as
[`221e4e7c05386d06aa7b91da2a9b04f7f2bd921f`](https://github.com/openai/codex/tree/221e4e7c05386d06aa7b91da2a9b04f7f2bd921f).
The relevant source and tests were inspected before implementation:

- [`session/turn_input.rs`](https://github.com/openai/codex/blob/221e4e7c05386d06aa7b91da2a9b04f7f2bd921f/codex-rs/core/src/session/turn_input.rs)
  and its tests distinguish explicit new user input from steer-only input. Explicit input starts a turn when no active
  turn owns the session; steer-only input can reject that state.
- [`stream_error_allows_next_turn.rs`](https://github.com/openai/codex/blob/221e4e7c05386d06aa7b91da2a9b04f7f2bd921f/codex-rs/core/tests/suite/stream_error_allows_next_turn.rs)
  requires a failed provider request to release its turn so the next user input can run.
- [`client.rs`](https://github.com/openai/codex/blob/221e4e7c05386d06aa7b91da2a9b04f7f2bd921f/codex-rs/core/tests/suite/client.rs)
  verifies that response-item IDs survive shutdown/resume and that another prompt issues a request in the same thread.

Alpha keeps its own TypeScript runtime, durable FIFO, VS Code task registry and approval boundaries. No upstream runtime
or prompt was copied.

## Confirmed failures and fixes

### High / should-fix: failed lifecycle settlement left accepted input without a consumer

In [Task.ts](../src/core/task/Task.ts), `ownBackgroundLifecycle` woke queued input after successful settlement, but only
cleared ownership after rejection. A follow-up accepted while the old lifecycle was draining could remain in the durable
FIFO indefinitely after that lifecycle failed.

The matching owner now releases and invokes the existing idle-input consumer after either settlement. A replaced older
owner cannot wake or clear its successor. Existing joiners still receive the original rejection. The queue admission
guards still prevent cancelled or busy tasks from restarting, and a failed consumer is attempted once rather than
repeatedly retried.

[Task.followup-wake-ownership.spec.ts](../src/core/task/__tests__/Task.followup-wake-ownership.spec.ts) reproduced the
rejected-owner failure before the fix and covers successful/failing settlement, replacement ownership, cancellation,
active-engine guards, original error propagation, failed-consumer recovery and an empty queue.

### High / should-fix: typed recovery guidance waited behind the prompt it needed to answer

In [ChatView.tsx](../webview-ui/src/components/chat/ChatView.tsx), active-turn routing queued typed responses to
`mistake_limit_reached` and `api_req_failed`. `Task.ask` deliberately drains passive queued input only at completion and
resume boundaries, so these recovery prompts could remain blocked while the new instruction sat in the queue.

The current complete, unanswered recovery prompt now receives a correlated `askResponse`, including its task ID, ask
timestamp and durable request ID. Ordinary future input, approvals, command-output prompts and stale/partial/answered
recovery prompts retain their existing queue behavior. An API-error text response exits the retry prompt through the
existing recovery path, which retains its receipt for the next human-input consumer.

A task-owned claim in the existing composer draft also spans accepted acknowledgement before transcript publication.
That prevents a fast second prompt from answering the old recovery prompt again. A matching rejection clears only its
owning claim and restores only its owning draft, including when another task is selected.

The ChatView regressions reproduce both blocked recovery variants and distinguish them from the already-working
follow-up/completion/resume paths. Task-level fake-timer coverage checks the passive-queue versus explicit-reply boundary.

### High / should-fix: cold-restored completion was visible before runtime completion admission

The restored transcript and task-registry projection can show a completed task before its new runtime publishes
`resume_completed_task`. That runtime has `didComplete === false`: it owns history restoration and an upcoming resume
ask. The correlated `resumeCompletedTask` handler previously rejected every such command based on `isCompleted()`.

A narrow read-only Task predicate now identifies this existing restoration boundary. The
[host handler](../src/core/webview/webviewMessageHandler.ts) can admit the explicit prompt into the existing durable FIFO;
the owned resume ask then consumes it. It rechecks runtime identity and eligibility after image resolution. Active turns,
stopped/disposed tasks, managed children, approvals and closed/failed sessions cannot gain admission through this path.
Request receipts remain idempotent and a rejection remains tied to its owning draft.

[webviewMessageHandler.history-followup.spec.ts](../src/core/webview/__tests__/webviewMessageHandler.history-followup.spec.ts)
reproduced both the pre-ask and published-resume-ask failures before the fix. It exercises actual Task submission/ask and
TaskSessionRegistry projection, plus duplicate requests and controlled image-resolution races.

## Reviewed paths and limits

Provider/turn-engine inspection did not reproduce an additional restart blocker. The engine releases its active guard in
`finally`; provider request cleanup checks ownership so a late predecessor cannot cancel a successor. Existing focused
engine, retained-history, post-EOF cancellation and VS Code LM tests passed: 276 tests across seven suites.

Cancellation inspection verified the current native Stop behavior: dispose the old runtime, wait for its natural
termination and persistence, then restore a fresh runtime with the same task ID. Another 45 tests across three suites
passed, overlapping the provider review's cancellation coverage. Clearing an aborted object's flags would be unsafe
because its lifetime signal and services are already disposed.

An existing intentional Alpha divergence remains: composer input on Failed/Closed sessions starts a new task. Native
Stop normally replaces that state with a same-ID resumable runtime after cleanup. If cancellation cleanup fails, or the
user submits during that Closed interval, same-task continuation needs a separately designed host-owned restore and
durable-submit transition. Reopening a retained disposed entry currently focuses it rather than rebuilding it. This pass
does not widen terminal-session authority or weaken a failed cleanup barrier.

## Validation

The focused reproductions use controlled promises or fake timers; they do not depend on live models, network timing or
arbitrary sleeps. Development uses Node 24.21.0 and pnpm 11.24.0; the release-gating host remains exact VS Code 1.125.0.
The following runs overlap existing suites and must not be summed into a unique-test total:

| Check                                                      | Result                                                |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| Lifecycle owner / completed / post-turn follow-ups         | 39 passed / 3 files                                   |
| Host routing / published asks / registry / queued asks     | 226 passed / 5 files                                  |
| Final combined new lifecycle, history and queued-ask tests | 67 passed / 3 files                                   |
| ChatView and task-composer hook                            | 225 passed / 2 files, including 18 new UI cases       |
| Queued-ask boundaries                                      | 38 passed / 1 file, including 2 new recovery cases    |
| Selected core API-error / mistake-limit receipt handling   | 3 passed; remaining tests excluded by the name filter |
| Provider / turn-engine / retained-history review           | 276 passed / 7 files                                  |
| Cancellation / same-ID replacement review                  | 45 passed / 3 files                                   |

The final combined reproduction command was:

```sh
pnpm --dir src test core/task/__tests__/ask-queued-message-drain.spec.ts core/task/__tests__/Task.followup-wake-ownership.spec.ts core/webview/__tests__/webviewMessageHandler.history-followup.spec.ts --maxWorkers=2
```

`pnpm --dir src check-types` and `pnpm --dir webview-ui check-types` passed after integration. Touched-file extension and
webview ESLint checks, Prettier checks and `git diff --check` passed. The webview typecheck caught a conditional test row's
widened string literal; the fixture was corrected without changing its assertion, and the final check passed.

`pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` rebuilt the extension and webview and passed **42 tests across
13 suites** on exact VS Code 1.125.0, with zero failures or pending tests. Every suite verified profile ownership,
complete evidence capture and observed host exit. This includes cold reload/compaction, same-task VS Code LM follow-up,
provider-error recovery, cancellation and background-command completion. These runs use deterministic scripted providers
and the VS Code LM fixture, not a live provider account.

The retained gate log is
`C:/Users/LUKEGO~1/AppData/Local/Temp/alpha-followup-smoke-99e906d82a6048c5a15b9e6f9a81a274.log`.

## Closure ledger

- **Fixed now:** the three reproduced lifecycle, recovery-prompt and cold-history failure paths above.
- **Flagged for follow-up:** explicit same-task recovery for disposed Failed/Closed primary sessions, with ownership,
  cancellation cleanup and durable admission preserved.
- **Not verified:** attribution of a particular user incident without its task conditions or logs; every live provider
  and platform combination.
- **Out of scope:** provider/model changes, new lifecycle engines, dependency upgrades, persisted-format migrations,
  release publication and the prior performance pass's unrelated follow-ups.
