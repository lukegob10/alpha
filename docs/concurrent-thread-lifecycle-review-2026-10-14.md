# Concurrent thread lifecycle and communication review

Reviewed on 2026-10-14 against Codex CLI commit
[`1ffa95ee8a02ec68f6ccd758998bcb7d4b32bcdb`](https://github.com/openai/codex/commit/1ffa95ee8a02ec68f6ccd758998bcb7d4b32bcdb).
This review covers Alpha's command/API root creation, model-created independent chats, provider ownership,
execution snapshots, capacity admission, message consumption, completion receipts, and recovery. It does not claim
an audit of the Codex desktop application or the separately assigned project bulk-deletion fix.

## Reference behavior and Alpha contracts

The current upstream sources inspected were `codex-rs/core/src/thread_manager.rs`,
`agent/control/{spawn,execution,execution_tests,delivery,mailbox,user_authorization,completion}.rs`, and
`tools/handlers/{multi_agents_tests,multi_agents_v2/{spawn,send_message,followup_task,message_tool}}.rs`.
These are review references, not implementation dependencies; Alpha continues to use its native TypeScript kernel.

- Upstream's thread manager retains execution by thread identity. Selecting a view does not replace its registry.
  Spawn admission commits the child relationship and input before publishing the new thread.
- `spawn_agent_uses_explorer_role_and_preserves_approval_policy` verifies inherited approval authority.
  Alpha independent chats must likewise inherit the launching task's approval mode rather than mutable global defaults.
- `execution_guards_count_active_v2_subagent_turns` and `execution_guards_ignore_root_and_v1_turns` distinguish
  upstream's V2 child execution admission from root turns. Alpha intentionally retains its configurable host-wide
  live-task cap to bound extension resources; it does not adopt an unlimited root-task policy.
- Upstream V2 `send_message` uses `QueueOnly`; `followup_task` uses `TriggerTurn`. Tests verify child-to-root mail
  does not trigger a turn and explicit follow-up does. Completion notifications are also passive upstream.
  Alpha's managed-agent mail remains passive. Its separate, explicitly requested independent-chat tools retain their
  existing contract: messages and completion reports may resume a completed primary recipient. That intentional
  extension feature requires a durable inbox consumer and serialized continuation admission.
- Upstream tests verify one completion notification for each child turn. Alpha retains its stronger persisted
  completion outbox, stable message identities, transcript consumption proof, and retry/reload reconciliation.

The 2026-10-12 communication review describes already completed managed-agent changes. This change extends those
existing ownership and persistence abstractions; it does not introduce another task engine or message store.

## Reproduced findings and fixes

| Finding                                                                                                                                           | Owning boundary                                            | Fix and regression evidence                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command/API launches cancelled the previously selected task. The API's new-tab path also reverted files and closed all editors.                   | `AlphaProvider.createTaskUnderCreationLock`, extension API | Root creation preserves existing tasks by default; explicit `preserveExisting: false` retains replacement compatibility. API launches preserve editors and execution. Ten-launch/capacity unit and exact-host fixtures cover the path.                                                         |
| An independent child launched from an editor was disposed when that editor closed.                                                                | Host provider ownership                                    | The existing sidebar provider in the same host owns independent background roots. Editor-disposal regression verifies the child survives with its runtime owner.                                                                                                                               |
| Independent children could inherit a broader global approval mode than their parent.                                                              | Creation snapshot                                          | Capture the parent's approval mode before asynchronous preparation and pass it with the existing workspace, model, mode, reasoning, and delegation snapshot. Child-creation regression asserts the inherited value.                                                                            |
| Simultaneous messages to a completed coordinator raced continuation admission and some deliveries failed.                                         | Shared session ownership fence                             | Serialize inbox admission and wake by stable recipient ID; coalesce the Task's continuation admission. A controlled barrier verifies all ten child messages are accepted while one continuation is admitted.                                                                                   |
| A message arriving just before lifecycle completion could remain queued without a consumer.                                                       | Task-owned lifecycle settlement                            | Independent input marks a pending wake request. The existing idle-input consumer resumes pending independent mail after the previous loop settles, without waking passive managed-agent mail. A controlled lifecycle regression reproduces completion winning after delivery.                  |
| Completion delivery held the receipt-write fence while resuming the recipient, which could re-enter that fence to finalize an older wait receipt. | Completion outbox delivery                                 | Deduplicate whole deliveries separately through the existing session registry. Reserve receipts under a short write fence, release it before mailbox append/resume, then record delivery under the write fence. A deterministic re-entry regression verifies both old and new receipts settle. |

All six failures were reproduced before their corresponding fixes. Existing duplicate delivery, failed wake,
failed receipt write, transcript proof, reload, cancellation, lineage, and authorization coverage remains relevant.
Completion receipt fields and mailbox/transcript formats are unchanged. Persisted historical tasks remain readable.

## Concurrency workload and acceptance

`maxConcurrentTasks` remains bounded from 1 through 50 and defaults to 3. It counts active roots and children across
providers in the host. Ten independently running roots need a cap of 10; ten running children alongside an active
coordinator need 11. Capacity exhaustion must reject a new launch without cancelling accepted work. This change does
not silently modify users' configured limits or serialize workspace writes outside the existing mutation gate.

The scripted exact-host fixture `cross-task-orchestration.acceptance.test.ts` now verifies:

1. Ten API launches enter ten simultaneously held provider requests; an eleventh launch rejects and all ten survive.
2. One coordinator creates ten children through model-facing `create_task`; all remain running after the coordinator
   completes, then all ten completion reports reach the resumed coordinator and acquire durable delivery receipts.
3. The existing create/list/stop/wait/persistence workflow and single-child completion resume still work.

Barriers control provider release and cancellation; polling observes state with deadlines. No live model, network
provider, arbitrary race sleep, or real user-history deletion is used. This is correctness evidence, not a latency
benchmark. The fixture is included in the existing extended VS Code 1.125.0 gate and canonical host-evidence inventory,
so QA and release checks require its actual execution rather than merely discovering the test file.

## Validation ledger

Validation is recorded after execution. Required commands include the focused lifecycle/mailbox/provider/API tests,
`pnpm check-types`, `pnpm lint`, `pnpm test:tooling`, `pnpm knip`, `pnpm test`,
`pnpm certify:managed-agents:automated`, `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`, and
`pnpm --filter @alpha-code/vscode-e2e test:cross-task:1250`.

Local checks completed:

- `pnpm check-types`, `pnpm lint`, and `pnpm knip` pass.
- Focused lifecycle, mailbox, persistence, provider ownership, and API suite: 266 tests pass.
- Final Task wake coalescing/guards, cross-task host and tool, and managed-agent policy suite: 283 tests pass.
- Repository tooling: 222 tests pass, including exact-host inventory consistency.
- The cross-task host command bundled and compiled successfully, downloaded and selected exact VS Code 1.125.0,
  then was blocked before test execution by Windows' `vscode-updating` mutex. Its retained receipt is blocked,
  not passed. No updater was stopped and no alternative host version was substituted.

Full-suite, automated managed-agent certification, smoke, and clean-runner exact-host results will be recorded
before this change is marked ready for review.
