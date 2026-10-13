# Subagent communication and lifecycle review

The findings below describe the pre-fix implementation. The authorized implementation follow-up is recorded at the end
of this document, including the behavior changes, compatibility decisions, and validation evidence.

Alpha's continuation path has two confirmed defects: a resumed child can finish its loop without publishing a terminal
result, and a child completing during follow-up admission can cause the continuation to be rejected. Mailbox recovery
and independent-task steering have separate delivery defects. Current Codex CLI also delivers child results at normal
inbox boundaries, whereas Alpha requires an explicit `wait_agent` call to collect them.

This is a targeted contract-alignment review dated October 12, 2026. It records findings and recommended changes;
it does not implement runtime fixes. Three subagents reviewed communication, lifecycle, and upstream behavior, and the
primary reviewer independently reran the main reproductions. Existing steering, settings, and UI edits were preserved.

## Reference and scope

- Alpha base commit: `891854c1276e7013e7fe1e8868802f42052fac48`, reviewed with the existing working-tree changes.
- Current upstream: [openai/codex commit 12cca49c81c8aa6a37a5cc4e39964ee3b70f9458](https://github.com/openai/codex/commit/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458), retrieved October 12, 2026.
  The commit's author timestamp is `2026-10-12T23:36:39Z`.
- The reference source was inspected outside the Alpha checkout. No upstream implementation or prompts were imported.
- Reviewed surfaces: managed message routing, inbox admission and claims, waits, initial launch and retained follow-up,
  result publication, cancellation, blocking-delegation compatibility, independent related-task steering, tool guidance,
  and the nearest deterministic tests.
- Codex sandbox implementation is outside the convergence target. Keep Alpha's execution, workspace, approval, and
  mutation protections. Preserve skills, the HTML previewer, Alpha Tickets, scheduled tasks, and independent-task tools
  as native extension capabilities serving the shared harness.

Current upstream contains both V1 and V2 multi-agent implementations. The V1 feature defaults on; the explicit V2 feature
defaults off, but model metadata can select V2. The comparison below names the current V2 contract rather than assuming
that every current CLI model uses it. See [feature defaults](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/features/src/lib.rs#L1458-L1467)
and [version selection](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/config/mod.rs#L1631-L1657).

## Confirmed defects

### 1. P1 must fix: a resumed child can remain running after its loop has ended

Owner: `AlphaProvider.executeSubagentEnvelope` in `src/core/webview/AlphaProvider.ts:10993`.

The follow-up branch observes rejection of `resumeSubagentFollowup()` but does nothing when its promise fulfills. It
relies on `TaskCompleted` or `TaskAborted` to settle the run. A managed Task loop can instead return normally with a
failed, exhausted, or incomplete outcome (`src/core/task/Task.ts:11990–12012`). That path need not emit either event.

The run then remains active in the bounded executor. The parent receives no terminal result, `wait_agent` keeps waiting,
and parent completion stays blocked until the configured child timeout. The initial-launch branch already guards this
case by joining `waitForTermination()`, checking completion, and excluding legitimate pending asks
(`AlphaProvider.ts:11015–11037`). Retained continuation bypasses that guard.

**Reproduction:** resume a retained child with a lifecycle promise that resolves, no terminal Task event, and no pending
ask. After controlled microtasks and zero-delay work drain, the provider's run is still unsettled. The desired-contract
assertion failed independently in the primary review.

**Smallest remedy:** share the termination observer and settlement fallback between launch and resume. Preserve
intentional human-input and approval waits. Publish one terminal outcome for a genuinely ended loop and use the existing
child cancellation and cleanup boundary before finalization.

Codex V2 captures each child turn's terminal outcome and separately routes its completion; continuation is not dependent
on an initial-launch-only watcher. See [turn outcome capture](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/session/mod.rs#L2462-L2530)
and [completion routing](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/agent/control/completion.rs#L27-L153).

Regression coverage should exercise fulfilled failed/incomplete/exhausted resumes, rejected resumes, completed resumes,
pending asks, cancellation during settlement, and exactly one result per run. A separate probe showed rejected resume
skips `abortTask`; it establishes cleanup asymmetry, not a demonstrated leaked process or active workspace mutation.

### 2. P2 must fix: completion during admission rejects a valid follow-up

Owner: `AlphaProvider.followupAgentTaskAfterAdmission`, `src/core/webview/AlphaProvider.ts:9360–9375`.

Admission captures an agent record, then awaits goal binding, mode checks, and verification synchronization. If a running
child completes during those awaits, the captured record still selects the active-message branch. `sendMessageToAgent`
refreshes the record and rejects the completed target with an instruction to use `followup_task`, even though the
operation is already a `followup_task` call (`AlphaProvider.ts:9192`). The new objective is not admitted.

**Reproduction:** commit the child's completion inside the awaited verification check. The requested follow-up rejects
with the completed-target error. The primary review independently reproduced it with a controlled state transition.

**Smallest remedy:** make active delivery versus terminal relaunch one admission decision against authoritative state.
If completion wins, join predecessor finalization and enter the retained-relaunch branch. Merely adding an earlier
refresh leaves another check-then-act window. Preserve the serialized per-child admission and frozen authority checks.

Codex V2 submits follow-up through a shared [TriggerTurn operation](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs#L74-L96).
Its [continuation regression](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/tools/handlers/multi_agents_tests.rs#L1896-L2050)
expects distinct result notifications from successive turns of the same child.

### 3. P2 must fix: settlement failure can strand an accepted message

Owner: `AgentControlStore.settleMailboxClaim`, `src/core/agent/AgentControlStore.ts:3032–3052`.

The production transaction path performs a fallible address lookup before retaining the intended mailbox settlement.
If that lookup fails while releasing a claim after transcript persistence failed, the message stays claimed and
unacknowledged without a pending retry record. Subsequent delivery excludes the claim, and the synchronous pending-input
hint also excludes it (`src/core/webview/AlphaProvider.ts:9276`). Recovery skips the claim while its owner remains live
(`AgentControlStore.ts:3492`). Replacing the Task in the same host does not recover this missing retry ownership.

**Reproduction:** use real `AgentControlStore` with transactional persistence, a registered child sender, and a live owner
lease. Accept one message, claim it for automatic delivery, and fail the first settlement lookup transaction. Retrying
settlements returns zero; owner recovery returns zero; the next automatic claim contains zero entries; the pending hint
is false; the accepted entry remains unacknowledged and claimed. The primary reviewer reran this script.

**Smallest remedy:** retain claim identity and the intended ACK/release disposition before any fallible settlement work.
Keep ownership enforcement on the actual durable settlement. Test both release after transcript failure and ACK after
transcript success with the production-shaped transaction boundary. The existing retry test at
`src/core/agent/__tests__/AgentControlStore.spec.ts:741` uses nontransactional memory persistence and fails a later ACK,
so it does not cover this window.

Preserve Alpha's stronger durable delivery guarantee. Upstream's [completion router is explicitly best effort](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/agent/control/completion.rs#L1-L4)
and its [pending mailboxes are memory-backed](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/agent/control/mailbox.rs#L1-L71).
Convergence should change observable delivery semantics without weakening crash recovery.

### 4. P2 must fix: related-task steering loses provenance and acknowledges volatile input

Owners: `AlphaProvider.steerIndependentTask`, `src/core/webview/AlphaProvider.ts:5931`, and
`Task.steerUserMessage`, `src/core/task/Task.ts:9345–9382`.

The independent-task adapter invokes the human steering method with only a text argument. For a streaming child, the
Task stores the guidance in volatile `pendingSteerMessage`, infers `inputOrigin: "human"` from the missing persistence
callback, interrupts the request, and returns. The provider reports `status: "steered"` before an inbox, queue, or
transcript admission commits. Host failure before the next boundary loses the acknowledged guidance.

This contradicts the durability promise in `src/core/prompts/tools/native-tools/cross_task_orchestration.ts:85` and the
shared distinction between agent communication and human input. With an active ask, this same call can also enter the
human ask-response branch. The review does not establish a general approval bypass.

**Reproduction:** invoke the real provider steering method and real Task steering method on a streaming independent
child. Agent-origin guidance becomes human-origin input, and no durable admission occurs before success is returned.
Both desired-contract assertions failed again in the primary review. The existing
`src/core/webview/__tests__/CrossTaskOrchestration.spec.ts:686` mocks `steerUserMessage`, hiding this boundary.

**Smallest remedy:** admit agent input with explicit sender, origin, stable receipt, and interrupt intent before
interrupting. Reuse the shared admission and persistence machinery. A persistence callback must not determine authority
or provenance, and agent input must not answer a human approval or input request.

Codex distinguishes author, recipient, turn metadata, and wake intent in its [agent communication representation](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/protocol/src/protocol.rs#L908-L1019).
Alpha's additional independent-task tools can preserve their UI and ownership model while honoring that distinction.

### 5. P2 should fix: blocking delegation children have incomplete lifecycle support

Owner: extension adapters in `src/core/webview/AlphaProvider.ts:9575` and `:10180`.

Two deterministic cases fail:

- `interrupt_agent` consults only `AsyncSubagentRunManager`. A live registered child owned by the blocking
  `BoundedDelegationManager` is rejected as having no active turn. Cancellation already dispatches to both owners.
- Follow-up restoration rejects a retained child from a completed two-child `delegate_task` group because the saved
  group has more than one agent. The child retains a valid identity, history, and lifecycle target.

The primary reviewer reproduced both failures. Dispatch interruption through the actual run owner, and restore the
selected child without requiring its original group to have contained one agent. Cover the nested case where another
managed agent controls a blocking descendant while its ancestor remains active.

`delegate_task` is an Alpha compatibility capability rather than a Codex V2 tool. Retain it until the repository's
replacement certification boundary is satisfied; its extra tool surface does not justify divergent lifecycle behavior
for registered children.

## Behavioral convergence gaps

### 6. P2 should fix: child results require an explicit wait to reach the model

Owners: `src/core/task/Task.ts:8304`, `:1423`, and `src/core/webview/AlphaProvider.ts:8956`.

Alpha deliberately disables automatic final-result injection. Final result bodies are staged beside a successful
`wait_agent` receipt; ordinary agent messages arrive automatically at the next model-step boundary. Existing
`async-subagent-result-delivery.spec.ts` tests require the absence of automatic child reports.

Consequently, a parent doing useful local work does not see a child's continuation result until it calls `wait_agent`.
Its completion gate can reject with unconsumed child results instead of admitting already available agent input. This
is a confirmed implementation difference, not evidence that an acknowledged result was deleted.

Codex V2 automatically queues a final notification for each completed child turn to its actual direct parent.
`wait_agent` watches inbox activity and returns a summary; it does not own final-result delivery. See
[routing](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/agent/control/completion.rs#L95-L130)
and the [wait-content regression](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/tools/handlers/multi_agents_tests.rs#L3741).

Ordinary resumable interruption is [not a final status](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/agent/status.rs#L26-L31)
in upstream and does not produce a final-answer notification.
Alpha should preserve that distinction while ensuring every accepted tool call receives its terminal tool result.

Use Alpha's existing durable mailbox and logical step boundary to deliver result notifications as agent input. Keep one
delivery owner across automatic consumption, explicit wait, and reload. Do not revive the legacy synthetic-human-result
path. Update the tests that currently encode exclusive wait ownership.

Respect the final-answer boundary: passive results can continue a parent after reasoning or commentary, but must not
silently reopen a parent that has delivered its final answer. Retain late mail for its next authorized turn. Codex tests
this distinction in [pending input](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/tests/suite/pending_input.rs#L991-L1162).

### 7. P2 should fix: child instructions contradict permitted communication

Owners: `src/core/prompts/sections/rules.ts:90`, `src/core/prompts/sections/tool-use.ts:25`, and
`src/core/prompts/tools/native-tools/send_message.ts:10`.

The native schema advertises passive messaging to parents, root, and peers. `requireMessageRecipient` enforces same-tree
membership (`src/core/webview/AlphaProvider.ts:9809`) and permits these targets. Delegating-child instructions instead
place `send_message` under a descendants-only prohibition. The nondelegating child's authority prose also omits messaging
despite the Task capability ceiling always including it (`src/core/task/Task.ts:730`).

This is an internal contract contradiction. It can suppress valid peer updates or make the model alternate between
conflicting instructions; its impact on live-model reliability has not been measured. Existing pinned runtime hints
also promise immediate final delivery and analysis-channel message envelopes while Alpha currently supplies wait-owned
JSON notification blocks. Those hints need native descriptions matching Alpha's implemented contract.

Derive communication guidance from the same captured tool and policy surface used for execution. State passive
same-tree messaging separately from lifecycle-control authority. Adapt the behavior in Alpha's own words instead of
copying upstream role prompts. Add prompt-contract tests for delegating and nondelegating children.

Codex explicitly tests [child-to-root messaging](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/tools/handlers/multi_agents_tests.rs#L1301-L1374).

### 8. P2 should fix: retained stopped peers cannot receive passive mail

Owner: `src/core/webview/AlphaProvider.ts:9191–9196`.

Alpha rejects passive messages to completed or interrupted nonroot agents. A sibling cannot substitute `followup_task`,
because Alpha's lifecycle controls belong to the caller's retained subtree. This prevents a child from leaving useful
information for a stopped sibling's next authorized turn.

Codex V2 separates passive queue admission from starting work. Its [admission path](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/agent/control/api.rs#L122-L169)
does not reject completed or interrupted status, and [peer reload coverage](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/agent/control_tests.rs#L1782-L1897)
verifies passive messages to unloaded related agents. A dedicated send-after-completion test was not identified; the
stopped-status conclusion comes from the status-independent admission code.

Permit durable passive mail to retained communicable same-tree identities without starting a model turn or changing
lifecycle state. Continue rejecting explicitly closed, deleted, unrelated, or shutting-down-tree recipients. Runtime
unloading is distinct from deleting an agent identity.

## Differences to preserve or decide explicitly

| Concern                                                                   | Decision                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable inbox admission and transcript fencing                            | Preserve Alpha's stronger guarantee; repair the settlement gap. Upstream best-effort mail is not the durability target.                                                                                                                                                          |
| Worker worktrees, scoped mutation, Apply/Discard, and parent verification | Preserve these native execution and safety contracts.                                                                                                                                                                                                                            |
| Passive messaging versus lifecycle authority                              | Permit same-tree communication without widening child write authority or approval authority.                                                                                                                                                                                     |
| Peer follow-up and interruption                                           | Codex V2 supports broader same-tree controls. Alpha's narrower subtree ownership is defensible with nested Worker verification, but should be documented as intentional. It must not prohibit passive peer mail.                                                                 |
| Agent discovery                                                           | Codex V2 lists the whole resident tree; Alpha lists the caller's descendants. Consider a read-only whole-tree identity/status projection to discover peer targets without granting control. Preserve report-body and credential restrictions.                                    |
| Independent tasks                                                         | Preserve explicit human authorization, direct-child ownership, and the separate task UI. Apply shared provenance, delivery, cancellation, and recovery invariants. Their auto-resume message behavior is an extension-specific policy, distinct from passive managed-agent mail. |
| Native extension features                                                 | Preserve skills, HTML previews, Tickets, scheduled tasks, and additional tools through the shared kernel.                                                                                                                                                                        |

Codex's [tree listing](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/agent/control.rs#L377-L447)
is read-only. Broadening discovery need not broaden control. Upstream also attributes sibling-initiated continuation
activity to the initiating turn while routing the final text to the actual parent; see
[continuation activity tests](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/tests/suite/subagent_notifications.rs#L2854-L3209).
If Alpha later permits peer continuation, preserve that distinction in typed run/turn metadata.

## Existing strengths

Stable child task identity survives follow-up, while each new run gets a UUID-based identity and distinct terminal
events. A deterministic real-manager probe produced two distinct immediate-parent results for two turns of one child.
The suspected blanket suppression of second-run results was not reproduced.

Predecessor finalization, normal mailbox claim fencing, frozen authority, bounded capacity, budget enforcement, and
cancellation propagation already have focused coverage. A controlled concurrent-follow-up probe respected the frozen
root capacity. These mechanisms should be extended rather than replaced with another task engine or state store.

## Original review validation and closure

Existing focused suites: **14 files, 417 tests passed**, across three runs:

```text
pnpm --dir src test --maxWorkers=2 core/task/__tests__/async-subagent-result-delivery.spec.ts core/task/__tests__/Task.agent-wait-progress.spec.ts core/task/__tests__/subagent-followup.spec.ts core/prompts/tools/__tests__/build-tools-spawn-agent.spec.ts core/prompts/sections/__tests__/tool-use.spec.ts

pnpm --dir src test --maxWorkers=2 core/task-persistence/__tests__/AgentMessageInbox.spec.ts core/agent/__tests__/AgentControlStore.spec.ts core/agent/__tests__/AgentControlStore.nested.spec.ts core/agent/__tests__/AgentControlStore.transaction-isolation.spec.ts

pnpm --dir src test --maxWorkers=2 core/agent/__tests__/AsyncSubagentRunManager.spec.ts core/agent/__tests__/BoundedDelegationManager.spec.ts core/agent/__tests__/AgentControlStore.followup-admission.astra.spec.ts core/tools/__tests__/AgentLifecycleTools.spec.ts core/webview/__tests__/AlphaProvider.subagents.spec.ts
```

The primary reviewer independently ran two temporary desired-contract suites: nine tests, seven failed assertions and
two passing probes. Six failures reproduce the defects in findings 1, 2, 4, and 5; the seventh records rejected-resume
cleanup asymmetry. The passing probes cover capacity and distinct result publication across retained runs. The separate
transactional script reproduces finding 3. These expected failures expose missing coverage; the existing suites did not
fail. Temporary specs were removed from the repository after copying their evidence outside it.

Local reproduction artifacts:

- `C:/Users/Luke Goblirsch/.codex/references/alpha-communication-review-2026-10-12.ts`
- `C:/Users/Luke Goblirsch/.codex/references/Task.communication-review-only-20261012.spec.ts`
- `C:/Users/Luke Goblirsch/.codex/references/AlphaProvider.lifecycle-root-review-only-20261012.spec.ts`

The specs retain repository-relative imports and need their original test-directory placement to rerun. The mailbox
script can be run from the repository with `pnpm exec tsx` and its absolute path.

| Closure category      | Status                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed now             | Review evidence and recommendations recorded. No runtime defects were fixed in this findings pass.                                                                                                            |
| Flagged for follow-up | Findings 1–8, with the initial and resumed lifecycle settlement path first.                                                                                                                                   |
| Not verified          | Live-model impact, real host crash/reload reproduction, UI rendering, exact VS Code 1.125.0 smoke gate, full typecheck/lint, upstream Rust test execution, and actual resource leakage after rejected resume. |
| Out of scope          | Codex sandbox architecture, feature retirement, provider/model migration, performance claims, and unrelated working-tree edits.                                                                               |

Recommended implementation order:

1. Unify launch/resume termination observation and make follow-up admission safe against concurrent completion.
2. Repair mailbox settlement retry ownership and independent-task steering admission/provenance.
3. Deliver child results automatically through the existing durable mailbox; align native communication guidance and
   retained-recipient behavior. Cover the blocking-delegation compatibility paths before retirement.

Each runtime patch needs failing regression coverage, affected consumer tests, `pnpm --dir src check-types`, and the
exact `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` gate. Run
`pnpm certify:managed-agents:automated` when changing the managed-agent contract. Automatic delivery must additionally
cover running versus final-answer parents, continuation generations, wait/automatic deduplication, replay, cancellation,
and native provider ordering. This findings-only change does not claim those release gates passed.

## Implementation follow-up

The subsequent authorized implementation addresses findings 1–8 through the existing turn engine, managed store,
durable inbox, and VS Code adapters. Three subagents implemented the lifecycle, communication, and notification changes;
the primary agent integrated the patches and updated the native prompt guidance and Extension Host acceptance fixture.
No upstream implementation or new role prompts were imported, and no production dependencies or persisted schema
versions were added.

| Finding | Resolution                                                                                                                                                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Initial launch and retained resume share termination observation, pending-ask protection, and cleanup before failed settlement. Completed/blocked resumes and competing terminal events settle once.                                                           |
| 2       | Active follow-up mailbox admission checks lifecycle status in the same store transaction. If completion wins, continuation joins predecessor finalization and takes the retained relaunch path with verification and frozen authority rechecked.               |
| 3       | Mailbox ACK/release intent is retained before fallible persistence. Durable settlement still checks ownership, and retry retains the original disposition.                                                                                                     |
| 4       | Related-task steering persists sender-attributed agent input in the existing inbox before acknowledging or interrupting. Human approvals, human corrections, pause/compaction, and stop races preserve buffered guidance.                                      |
| 5       | Interruption dispatches to either run owner. A child from a blocking batch resumes in its own continuation group; original sibling cards remain intact. Rollback and the crash between durable admission and runner publication retain recoverable identities. |
| 6       | Completed, failed, blocked, and timed-out child reports reach their direct parent automatically at safe model-step boundaries. Wait, automatic delivery, and reload share event identities and validated receipts.                                             |
| 7       | Native instructions describe Alpha's actual input format and captured authority. All child roles may send passive same-tree messages; only authorized descendants may receive lifecycle control.                                                               |
| 8       | Retained completed/interrupted recipients accept passive mail without starting a model turn. Closed/deleted identities and unrelated trees remain rejected.                                                                                                    |

Receipt validation compares the complete serialized envelope, including its body, after the same private-path redaction
used for model input. Both the immediate transcript save fence and replay use this check; matching IDs or headers alone
cannot consume an altered legacy notification. Host-authored automatic receipts require agent provenance.

An explicit final answer, or an unphased visible answer that completes the turn, defers passive result notifications
until the next authorized turn. Commentary/reasoning and tool continuation can receive those reports immediately at the
next safe boundary. Required running descendants and Worker review/verification obligations still block completion.
Ordinary resumable interruption and user cancellation are not automatically presented as final child reports; their
lifecycle state and native wait receipts remain available.

Continuation-group recovery regressions cover admission before launch, advancement of the child's history, and a blocked
or failed first summary save. Admission pins the prior group in the existing runtime snapshot metadata. Fallback requires
the matching authoritative follow-up receipt and a missing current card, then validates the exact retained parent/child
summary and frozen manifest, scope, ancestry, and model route. The admitted group and receipt IDs survive recovery.

The first async, pending continuation summary commits before its lifecycle write clears the recovery receipt. Group
summaries now use the existing atomic transcript mutation queue: failed persistence leaves visible memory, UI events, and
review barriers untouched. Cancellation releases reserved resources even when that save fails. Approval response failure
retains its still-active receipt for retry without replacing a newer request or accepting duplicate actions.

Terminal usage publication cancels pending debounce work and publishes the latest values through the same event and
accounting boundary. Disposal also cancels remaining usage timers. Five real-Task regressions reproduce the orphaned
debounce timer before the fix and preserve ordinary throttling and subsequent retained-task updates afterward.

The validation fixtures use the staged group-save callback and isolate goal-owner writes only for their existing mocked
storage roots. A constructor's real file-lock retry against a directory that the mock never creates was entering a later
scheduler test's fake clock. Its elapsed-time and zero-timer assertions remain unchanged; physical goal-store and lock
coverage remains in the persistence suites.

The real-host acceptance fixture checks receipt counts, ownership, and provenance in canonical persisted history, then
checks that the same event bodies reach the model once and in order. Provider requests may merge adjacent user messages
and omit host-only receipt metadata; those projections do not redefine a wait claim's ownership. Both managed-agent
host scenarios explicitly select VS Code 1.125.0 rather than depending on an overridable runner default.

Compatibility decisions remain intentional: preserve Alpha's durable admission, worktrees, approvals, mutation gates,
verification, skills, previews, Tickets, schedules, and independent-task tools. Lifecycle control stays within retained
descendants. Broader read-only tree discovery and peer lifecycle control remain advisory follow-up work; passive peer
communication does not depend on granting either authority.

Prompt-size measurement used the same `o200k_base` encoder on the old and new managed-role fragments: root 253 → 138
tokens; child 263 → 162 tokens. This measures only those static fragments and makes no task-quality, latency, or cache
hit-rate claim. The model catalog and default collaboration template remain unchanged.

Final integrated command outcomes and any unreproduced failures are recorded in the generated
[validation log](../artifacts/certification/subagent-communication-20261012-validation.json). The managed-agent
certification also produces its standard source-bound evidence JSON. The original 417-test review baseline above is
historical evidence, separate from the post-implementation checks.

| Closure category      | Status                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fixed now             | Findings 1–8, full-body receipt matching, continuation-group crash recovery, and durable group-summary/approval/cancellation settlement.                           |
| Flagged for follow-up | Read-only whole-tree discovery and the decision on broader peer lifecycle control.                                                                                 |
| Not verified          | Live-model behavior and quantitative task-quality, latency, or cache effects. Host/type/lint/certification outcomes are recorded separately in the validation log. |
| Out of scope          | Codex sandbox architecture, retirement of extension-native features, provider/model migrations, unrelated existing edits, and release/package publication.         |
