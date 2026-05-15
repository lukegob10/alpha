# Orchestration Regression Review

Date: 2026-05-15
Branch: `codex/orchestration-feature-bug`

## Baseline

The earliest local Alpha commit is `8d66b37 Initial Alpha codebase`. That is the closest in-repository baseline for the "Roo worked flawlessly" behavior. The review compared the current task/orchestration surface against that baseline and against the later concurrency and scheduled-task commits that changed task lifecycle assumptions.

High-risk commits in the local history:

- `6e75b38 feat: implement multi-agent concurrency support and clipboard utility enhancements`
- `504b580 Add scheduled task agents`

The main regression pattern is not one isolated provider bug. The current system has stricter provider-native tool history requirements, an Orchestrator mode that depends on delegation for most useful work, and newer parallel task lifecycle paths that changed previously single-task assumptions.

## Findings

### 1. Mixed `new_task` tool turns could corrupt provider history

The observed recovery message points at the task lane rejecting an invalid or unproductive sequence. The highest-confidence cause was a mismatch between the prompt rule and the implementation rule for `new_task`.

Before this branch, the task loop tried to repair a model response where `new_task` appeared with other tools by truncating only tools after `new_task`. If another tool appeared before `new_task`, the saved assistant message could still contain multiple `tool_use` blocks while the next user message only supplied one or partial `tool_result` blocks. Provider APIs treat that as invalid history.

The shared tool-use prompt also said multiple tool calls are encouraged, while `new_task` is a special case that must be used alone. That exception was easy for orchestration models to miss.

Status: fixed on this branch.

Changes:

- `src/core/task/Task.ts` now rejects any mixed `new_task` turn before any tool executes.
- Every tool call in the rejected turn receives a matching error result, keeping provider history balanced.
- The assistant execution queue is cleared so no partial delegation can dispose the parent task.
- `src/core/assistant-message/presentAssistantMessage.ts` applies the same all-or-nothing guard in the presenter path.
- `src/core/prompts/sections/__tests__/tool-use.spec.ts` now covers the prompt exception.
- `src/core/task/__tests__/new-task-isolation.spec.ts` now expects complete turn rejection instead of partial truncation.

### 2. Child tasks could start before parent delegation metadata was persisted

`delegateParentAndOpenChild()` intentionally creates child tasks with `startTask: false` so the parent can first persist its delegated state. The comments in `ClineProvider` are correct: starting the child too early can let the child write or complete while the parent still appears active or lacks delegation metadata.

Before this branch, `createTask()` ignored that option and always called `task.start()`.

That made delegation timing depend on event loop ordering and provider speed. With fast failures or quick subtask startup, the parent/child resume flow could become inconsistent.

Status: fixed on this branch.

Changes:

- `src/core/webview/ClineProvider.ts` now respects `options.startTask === false`.
- `src/__tests__/provider-create-task-start.spec.ts` covers both delayed-start and default-start behavior.

### 3. Orchestrator mode is structurally fragile for document-producing reviews

The Orchestrator mode has no normal file read or edit groups. It must delegate nearly all repository inspection and markdown creation to child tasks. That design can work, but only if delegation is deterministic and provider history stays valid.

For user requests like "review this directory and generate a markdown file", the current Orchestrator UX is high risk because the primary mode cannot directly inspect or write the requested artifact. The model is pushed toward delegation immediately, and any invalid `new_task` sequence can trigger the recovery loop the user saw.

Status: partially mitigated by the `new_task` fix. Product decision still needed.

Options:

- Keep Orchestrator delegation-only, but make the prompt more explicit that every child task must be launched in a single-tool turn.
- Use Code mode as the primary mode for repository review tasks and let it coordinate subtasks only when needed.
- Create a safer review/coordinator mode with limited read and markdown-write capability, instead of relying on delegation for all useful work.

### 4. Multi-session concurrency changed single-task assumptions

The concurrency work introduced multiple live tasks, per-task message routing, background task stacks, and parent/child task switching. That is the right direction for parallel work, but it also means old single-active-task assumptions can become race conditions.

Reviewed surfaces included task message handling, delegation/resume flow, task stack creation, presenter tool handling, and existing delegation tests. The code has several task-id routing protections, but the highest-risk remaining areas still need end-to-end tests:

- parent delegates child, child completes, parent resumes with valid API history
- checkpoint restore while multiple tasks exist
- terminal ownership when multiple task lanes request shell execution
- task-scoped mode/profile/config snapshots across resume and scheduled task execution

Status: partly tested, not fully closed.

### 5. Parent resume still relies on synthetic history repair

`reopenParentFromDelegation()` finds the last `new_task` tool use and injects a synthetic matching tool result if the parent history tail needs repair. That is necessary for provider validity, but it is a critical lifecycle seam and should have a dedicated regression test.

Status: existing behavior reviewed, no code change made here.

Recommended next test:

- Start an Orchestrator parent with a provider-native tool-call response.
- Delegate one Code child.
- Complete the child.
- Reopen the parent.
- Assert the final API-history tail has every `tool_use` matched by exactly one `tool_result` and the parent mode/profile did not drift.

## What Was Fixed Now

This branch fixes two concrete bugs that can plausibly explain repeated recovery loops during orchestration:

1. Mixed `new_task` batches are now rejected as a complete turn with balanced tool results.
2. `createTask(..., { startTask: false })` now actually delays child task start until the caller starts it.

These fixes preserve the intended delegation contract instead of allowing partial execution and race-prone startup.

## Remaining Risks

The following areas are still worth treating as release blockers before considering orchestration stable:

- Full VS Code end-to-end orchestration test with real parent/child task switching.
- Provider-specific validation against Anthropic/Claude and Gemini tool-call history shapes.
- Checkpoint restore with more than one active task.
- Terminal command ownership across concurrent task lanes.
- Clear product guidance on whether Orchestrator should be delegation-only or allowed to directly inspect/write review artifacts.

## Validation

Focused tests added or updated on this branch:

- `src/core/task/__tests__/new-task-isolation.spec.ts`
- `src/core/task/__tests__/mistake-limit-auto-recovery.spec.ts`
- `src/core/prompts/sections/__tests__/tool-use.spec.ts`
- `src/__tests__/provider-create-task-start.spec.ts`
- `src/__tests__/provider-delegation.spec.ts`

The focused regression suite passed after the code changes. Typecheck and final diff whitespace checks should be run before merging this branch.
