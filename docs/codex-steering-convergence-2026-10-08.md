# Codex steering convergence — October 8, 2026

This iteration makes ordinary composer submission interrupt an eligible active response, releases stalled provider
reads, and prevents an advisory tool-progress callback from blocking cancellation. The existing queue, turn engine,
policy snapshot, persistence receipts, and scheduler continue to own execution.

## Upstream reference and comparison

Fetched current `openai/codex` main and pinned
[`5b3c1522f85316063e43b97fa7e13751d55bccdb`](https://github.com/openai/codex/commit/5b3c1522f85316063e43b97fa7e13751d55bccdb).
The commit time is October 9 at `02:50:59Z`, October 8 locally. This adds one commit beyond the previous iteration's
`03b761dca9b04f47e166494232d70b3fe7c6738a`. The research checkout retains its original HEAD; updated remote refs supply
the current source without replacing previous evidence.

Codex [enabled instant interruption by default](https://github.com/openai/codex/commit/406b0c44460cf71e90c21c7abe6e581add3a6421)
on October 7. At the pinned revision, `core/src/session/input_queue.rs::watch_user_input` subscribes before checking the
queue and signals the current step when human input arrives. `core/src/session/turn.rs` races response reads against
that step signal separately from whole-turn cancellation. Its response transport may supply an interrupt operation;
otherwise the sampling path drops the response and requests continuation.

The October 8 [persistence test expansion](https://github.com/openai/codex/commit/19b7bffd7bd5c325a45b91111ce64c85610b90ba)
holds the original response open until a follow-up request arrives. It distinguishes human input checkpoints from
tool-output checkpoints and checks both synchronous and background persistence. This verifies interruption without
using response completion as the trigger. Alpha adopts that observable behavior with its own TypeScript and VS Code
adapters.

## Reproduced gaps and implementation

### Composer submission

Ordinary Send/Enter previously routed an active response to `queueMessage`; only the dedicated steering command used
`sendAndSteer`. The new composer regression failed because it observed the queue command.

Both ordinary Send and the host Enter command now use the existing steering path for eligible primary chats. The
composer action button shows Send when streaming with a draft and Stop when the draft is empty. Explicit queueing
retains FIFO behavior. Completed-task follow-ups, queue edits, complete question answers, and approvals retain their
own input boundaries. A waiting ask prevents steering even when live waiting metadata has not caught up. Managed-child
chats retain their parent-controlled input contract.

Admission still saves the input before interruption. A second submission while the first input awaits its transcript
receipt is durably queued without replacing the selected message. Receipt retries remain idempotent. Stopped,
abandoned, or completed tasks reject new steering. The existing webview acknowledgement reports an unclaimed retained
input as queued and remains addressed to its originating task after navigation.

### Provider request reads

`Task.attemptCapturedApiRequest` raced cancellation against the first read but delegated subsequent reads directly
with `yield*`. A provider that ignored cancellation could leave that adapter blocked. The first-read path also released
request ownership without calling the iterator's return operation.

Subsequent reads now use the existing request-control boundary, with the captured request signal and absolute deadline.
Interruption is checked before reading and before publishing a returned chunk. Every incomplete stream aborts its owned
request and initiates iterator closure without waiting for an unresponsive transport. Closure failures cannot replace
the already selected terminal result. Owned-controller identity checks protect a newer request from old cleanup.

First-chunk retry policy remains with its existing owner; a later stream error cannot become a first-chunk retry.
The regression reproduces both first and subsequent stalled reads, retains task activity during steering, observes
iterator closure, and checks request ownership and timer cleanup. Existing retry, turn, and persistence tests cover
healthy follow-ups and durable tool transaction barriers.

A further controlled race fulfilled the first read before admitting steering while request control was still resuming.
The old adapter published that obsolete chunk despite the newly aborted signal. The first chunk now checks interruption
before publication too. A separate deadline test verifies that a stalled subsequent read releases its owned request
without acquiring first-chunk retry metadata; it uses the same absolute deadline already captured in provider metadata.

### Tool cancellation during dispatch admission

A blocked progress publisher held the scheduler's admission mutex until that publisher returned. The controlled
regression failed because cancellation could not settle before the progress gate opened.

Advisory progress publication now uses the scheduler's existing cancellation race. A cancellation check immediately
afterward prevents dispatch from continuing when the old hook eventually settles. The effect fence, approved running
effects, ordered finalizers, and terminal result publication remain joined. Each accepted call still receives one
cancelled receipt, and later calls do not start. Late failures remain observed by the promise race.

This aligns one concrete case with Codex's
[dynamic-tool cancellation work](https://github.com/openai/codex/commit/18e28fe1b96db7e1d6b13584bec37c41f71b8b0e).
It does not detach workspace mutations or discard mandatory persistence to make cancellation appear faster.

## Other recent updates

| Verified upstream update                                                                                                    | Alpha decision and coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Large tool arguments](https://github.com/openai/codex/commit/515c291d875e07faa64e3fa43dc9bbffed8db31f)                     | No corresponding argument truncation was found. Added streamed freeform and JSON patch cases over 100 KiB, splitting escape sequences and Unicode code units, then saving and reloading through the real atomic transcript APIs with the terminal tool result intact. Output budgets remain separate.                                                                                                                                                                            |
| [Capabilities independent of history](https://github.com/openai/codex/commit/845345b1dd4f8e2a5d5ce91363fff666e41b07fc)      | Added a `none`/`all`/`2` matrix showing that captured skills, instruction provenance, and runtime authority survive independently of copied turns and retain their manifest serialization contract. This does not establish parity for Codex's plugin override and executor capability-root features.                                                                                                                                                                            |
| [Async questions respect enabled settings](https://github.com/openai/codex/commit/82e70121f86bc1f6fea7f2bb7bbc169d259b3c6b) | Verified Alpha's existing captured `disabledTools` contract: disabling async questions removes both their schema and executable authority while retaining blocking questions. A separate dedicated global UI toggle is not added by this iteration.                                                                                                                                                                                                                              |
| [Parallel status and catalog reads](https://github.com/openai/codex/commit/c9e0fffbbc05c36478686444f6ab1edbadfe2768)        | Alpha's scheduler already supports bounded audited reads. `AlphaProvider.listAgents` records parent verification evidence and ensures a persisted control root; its handler also publishes task presentation. These are additional effects requiring a separate pure status projection before parallel execution can be enabled safely. Alpha's `skill` action applies instructions and differs from Codex's pure skill-reading operations. Conservative scheduling is retained. |
| [Per-session gRPC routing](https://github.com/openai/codex/commit/5b3c1522f85316063e43b97fa7e13751d55bccdb)                 | Alpha has no equivalent gRPC session transport. Existing task/session routing tests and addressed background-chat receipt tests run as affected coverage. No new transport or parallel runtime is introduced.                                                                                                                                                                                                                                                                    |

The previous retry-advice implementation remains in place; see
[the previous iteration](codex-alignment-iteration-2026-10-08.md). Indexing retrieval work and other changes already
present in the shared checkout are preserved.

## Performance evidence and intentional differences

The measured workload is the same scripted request adapter with controlled provider reads and explicit human steering,
using fake timers and no live model. The metric is whether request control settles while the old response remains held.

| Boundary                               | Before                                                                                                       | After                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| First provider read                    | Interruption settled, but iterator closure was not requested                                                 | Interruption settles and requests closure                                          |
| Ready first chunk during admission     | Published an obsolete chunk after steering was admitted                                                      | Rejects the read before publishing the chunk                                       |
| Subsequent provider read               | Still blocked at interruption; the fixture released the response after advancing its fake clock by 5 seconds | Settles before the response gate opens, with no fake-clock advance                 |
| Tool progress callback before dispatch | Cancellation stayed blocked behind the callback gate                                                         | Cancellation settles before the callback gate opens; no tool execution is admitted |

The fake-clock values describe the scripted workload, not a measured network or model speedup. No general throughput,
indexing quality, live-provider latency, or rate-limit improvement is claimed.

Alpha deliberately retains synchronous durable admission and safe transcript/tool boundaries. It does not adopt
Codex's optional background user checkpoint policy or transport-specific response interrupt messages. Public extension
and IPC passive-queue operations keep their existing contracts; the default behavior change is in primary chat composer
submission. Async question cards retain their existing acknowledgement path. Uncooperative provider closure is best
effort after the owned result settles; already admitted workspace effects remain subject to joined cancellation and
verification.

## Validation and evidence

Evidence directory: `F:/alpha-e2e/artifacts/codex-steering-convergence-20261008`.

- `stream-reproduction-before.log`, `composer-reproduction-before.log`, `button-reproduction-before.log`, and
  `cancellation-reproduction-before.log` retain the failing reproductions.
- `first-ready-chunk-reproduction-before.log` retains the failed ready-chunk race reproduction.
- `steering-after.log` and `steering-benchmark.json` record the controlled request-read workload and conditions.
- `additional-contracts.log`: 91 passed across four files for queue admission, large arguments, capability capture,
  and async-question policy.
- `affected-surface-final.log`: 811 passed across 16 files covering task orchestration/recovery, retry wire inputs,
  scheduler execution/finalization, response normalization, history, and addressed session projection.
- `webview-final.log`: 260 passed across composer and textarea suites, including explicit queueing, steering,
  empty-draft Stop, repeated submission, draft retention, and navigation receipts.
- `workspace-typecheck-final.log` and `workspace-lint.log`: workspace type checks and lint passed.
- `reasoning-1250.log` and `rendered-ui-result.json`: rendered exact VS Code 1.125.0 test passed all 13 stages with
  trusted keyboard input and a scripted HTTP provider. Host assertions confirm explicit queueing retains the held
  response, ordinary Enter cancels it, and both queued and steering input reach the model before completion. The
  sidebar and editor navigation, reasoning, reload, and approval-targeting stages also passed. Twelve screenshots
  are retained in `rendered-ui/`; the queue and steering screenshots were visually inspected.
- `smoke-1250.log` and `smoke-host-runs.json`: final exact VS Code 1.125.0 smoke gate passed 13 host launches and 42
  assertions, with no failed or pending tests. The providers were scripted and the VS Code LM fixture.
- `managed-agents-automated.log` and `managed-agent-certification-evidence.json`: automated managed-agent gate passed
  3,207 tests across ten deterministic tracks and all 26 requirements. `managed-host-runs.json` records its two further
  exact 1.125.0 host launches and two passing acceptance tests, including five concurrent reviews and final idle
  settlement. Eight live-only integration requirements remain unrun. Production and test files did not change after
  certification; this document's final validation notes were recorded afterward.
- `validation-summary.json` records the final gate results and source hashes. `format-source.log` records formatting.
- `upstream-research.json` records the current reference, retrieval time, and recent commit subjects.
- `pre-existing-file-hashes.json`, `pre-existing-changes.patch`, and `status-before.txt` preserve the 71 pre-existing
  modified/untracked file baselines. `preservation-receipt.json` verifies 64 remain byte-identical and identifies the
  seven intentionally extended files.

Commands:

```sh
pnpm --dir src test core/task/__tests__/Task.spec.ts core/task/__tests__/Task.retry-wire.spec.ts core/task/__tests__/Task.queued-steering.spec.ts core/task/__tests__/Task.post-turn-followup.spec.ts core/task/__tests__/async-user-input-tool-catalog.spec.ts core/agent/__tests__/AgentTurnEngine.spec.ts core/agent/__tests__/AgentResponseFoundation.spec.ts core/agent/__tests__/ToolScheduler.spec.ts core/agent/__tests__/ToolScheduler.deferredResults.spec.ts core/agent/__tests__/ToolScheduler.command-batching.spec.ts core/agent/__tests__/SubagentContextCapture.spec.ts core/task-persistence/__tests__/canonicalAssistantHistory.spec.ts core/task-persistence/__tests__/largeToolArguments.spec.ts core/task-persistence/__tests__/apiMessages.spec.ts core/webview/__tests__/webviewMessageHandler.spec.ts core/webview/__tests__/TaskSessionRegistry.spec.ts
pnpm --dir webview-ui test src/components/chat/__tests__/ChatView.spec.tsx src/components/chat/__tests__/ChatTextArea.spec.tsx
pnpm check-types
pnpm lint
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
pnpm --filter @alpha-code/vscode-e2e test:reasoning:1250
pnpm certify:managed-agents:automated
```

All new tests use offline providers or scripted hosts; no live-model sign-in is needed for these gates. A live-provider
evaluation still requires a signed-in Alpha-owned 1.125.0 profile before it proceeds. No release, branch, push, or PR
is performed by this iteration.
