# Agent message delivery

## Reference and scope

Compared on 2026-09-28 with OpenAI Codex commit
`a9118edae8b77bf23b7182fd071a7b6251898bed` (fetched from `openai/codex` main).
Relevant upstream files are `codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs`,
`codex-rs/core/src/agent/control/api.rs`, and `codex-rs/core/src/session/input_queue.rs`.
Codex distinguishes `QueueOnly` agent messages, `TriggerTurn` follow-ups, and steering. An internal mailbox is
necessary to deliver input at an execution boundary; it is distinct from an editable human message queue.

This change aligns normal communication with that distinction. It does not establish complete CLI parity:
Alpha retains its existing authorization relationships, requires `followup_task` for stopped managed children,
and automatically resumes completed independent recipients, including parents receiving child results.

## Defects

- Independent tasks called `messageQueueService.addMessage` while running, putting agent input in the human UI queue.
- A waiting independent task called `submitUserMessage`, allowing an agent message to answer a human prompt.
- Managed messages called `steerUserMessage`, which could cancel the current provider request or tool wait, rejected
  messages during human approval, and admitted only one pending message before launch.

## Delivery contract

- Independent communication enters a bounded, durable `AgentMessageInbox`. Managed communication uses the existing
  `AgentControlStore` mailbox and its transactional claims. No second execution loop is introduced.
- `Task` drains both sources at a new logical model step, after preceding tool results are persisted. Transport retries
  keep their existing request snapshot. Messages arriving during sampling or tool execution wait for the next step.
- Human approvals remain pending until the human responds. Agent input cannot answer an approval or enter the composer
  queue. Normal delivery does not abort sampling, commands, or compaction.
- The transcript records sender attribution in an `agent_message` envelope and a host-owned `agent_message_id` receipt.
  Provider projection removes receipt metadata. The content explicitly identifies agent communication rather than human
  instructions or approval. Managed follow-up input uses the same source distinction.
- Mailbox acknowledgment follows transcript persistence. Replayed delivery checks the receipt before adding another
  message. Failed writes retain input. Managed claims acknowledge only their own messages, preserving unrelated results.
- Pending input and admissions prevent completion; the shared turn engine continues to a fresh model step.
- Explicit `steer_task` remains an interruption operation. Stopping a task still takes precedence over normal delivery.

## Regression coverage

Focused tests cover independent and managed routing, human prompts, multiple pre-launch messages, late startup arrival,
transcript persistence failure, reload, sender attribution, duplicate receipts, receipt removal from provider requests,
completion admission races, and automatic continuation after visible assistant text.

Commands:

```sh
pnpm --dir src test core/task-persistence/__tests__/AgentMessageInbox.spec.ts core/task/__tests__/Task.spec.ts core/webview/__tests__/CrossTaskOrchestration.spec.ts core/webview/__tests__/AlphaProvider.subagents.spec.ts core/tools/__tests__/attemptCompletionTool.spec.ts --maxWorkers=1
pnpm --dir src check-types
pnpm certify:managed-agents:automated
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

Validation results are reported with the change; the commands above are not evidence of a successful run.
