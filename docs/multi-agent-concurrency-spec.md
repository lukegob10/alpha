# Multi-Agent Concurrency Spec

## Status

Top-level parallel task sessions and the bounded depth-one managed-sub-agent runtime are implemented and live-certified. This includes the lifecycle control plane, durable tree/mailbox recovery, explicit context inheritance, authority narrowing, isolated Worker change sets, parent verification, and completion gating.

The extension now supports the core "parallel agent" workflow:

1. Start Task A.
2. Click New Task.
3. Task A remains live in the background.
4. Submit Task B from the blank draft window.
5. Task B opens immediately in chat while Task A keeps running.
6. Repeat up to the live task limit.
7. Completed tasks release their live-task slot back to the pool.
8. Recent Tasks and Task History can reopen completed, waiting, running, and background tasks without stopping other sessions.

The managed-child implementation now includes nonblocking `spawn_agent`, durable canonical paths and mailboxes, `list_agents`, `wait_agent`, `send_message`, `followup_task`, `interrupt_agent`, `cancel_agent`, and `close_agent`. `fork_turns: none | all | N` captures a frozen, credential-free record of inherited conversation turns, instructions, skills, workspace, model route, and runtime authority. Explorer and Reviewer roles remain read-only; Workers use isolated scoped worktrees and quarantined change sets. Applying a Worker change creates a durable, blocking parent-verification obligation that must be satisfied by relevant parent-owned command evidence before completion. Children remain depth-one and share the configured live-task budget. Configurable child-specific orchestration guardrails are next; nested agents, a dedicated live tree panel, and combined release certification remain future work.

## Goal

Allow a user to start a task, leave it running in the background, and start or inspect other tasks without stopping the first task. Allow a primary Code task to spawn bounded managed children, continue local work, inspect and steer those children, and receive their results without blocking the entire parent turn.

This document is both the implementation note for completed concurrency/lifecycle foundations and the planning note for the remaining orchestration work.

## Current Architecture Summary

The extension now separates task runtime from chat selection.

- `TaskSessionRegistry` is the source of truth for live task sessions.
- `ClineProvider` owns `currentView`, which is either:
    - `{ type: "newTaskDraft" }`
    - `{ type: "task", taskId }`
- `getCurrentTask()` returns the selected active task for compatibility, but task routing should prefer task-id-aware helpers.
- `clineMessages`, `currentTaskItem`, `currentTaskTodos`, and `messageQueue` describe only the selected task.
- `liveTaskIds` contains non-terminal live sessions only.
- `liveTasksById` contains lightweight runtime metadata for visible sessions:
    - lifecycle
    - streaming/waiting state
    - last activity
    - queue count
    - token and cost totals
- `clineStack` still exists for compatibility with existing delegation and legacy task flows, but it is no longer the concurrency source of truth.
- Completed tasks remain reopenable through Recent Tasks and Task History, but they do not consume the live task pool.

Current lifecycle states:

- `initializing`
- `running`
- `waiting`
- `completed`
- `failed`
- `closing`
- `closed`

Terminal lifecycle states do not count toward the max live task limit:

- `completed`
- `failed`
- `closed`

`completion_result` and `resume_completed_task` waits are treated as effectively completed for live-slot accounting, because the agent has finished work and is only waiting for review or feedback.

## Desired User Experience

Top-level background tasks are now the expected workflow:

1. User starts Task A.
2. Task A begins streaming/running.
3. User clicks New Task.
4. Task A keeps running in the background.
5. The chat opens a blank composer for Task B.
6. User starts Task B.
7. The user can return to Task A and see its latest state.
8. Cancelling, sending a response, queueing a message, checkpoint restore, condensing, and deleting operate on the selected task, not whichever task happens to be most recent globally.
9. If a task reaches completion, it gives its slot back to the live task pool.
10. Clicking a task in Recent Tasks or Task History focuses that task on the first click.

The implemented managed-child flow provides:

1. A primary task can start up to the available bounded child capacity without waiting for completion.
2. Every child receives a stable `task_name`, task ID, and canonical path; lifecycle controls accept any of those targets.
3. Parent-side lifecycle controls execute sequentially in provider order when batched, so spawn-plus-immediate-steer is deterministic.
4. The durable agent registry retains parent/child state, terminal results, and mailbox events across reloads.
5. Terminal results are injected once into the parent conversation; `wait_agent` remains an explicit bounded mailbox wait rather than a polling primitive.
6. Read-only roles remain read-only, while Workers use isolated worktrees, scoped writes, and parent verification.
7. User-configured provider-profile request pacing remains shared across parent and children and is reported as configured wait telemetry, not as an API failure.
8. Worker changes remain quarantined until explicit review. After Apply, parent completion is rejected until a relevant parent-owned verification command satisfies the durable obligation.

## Recommendation

Continue in dependency order. Milestones 1-3 are implemented; Milestone 4 is the next implementation boundary.

1. Multi-session top-level tasks. Completed.
2. Background-task monitoring foundation. Mostly completed; the remaining work is top-level UX and workspace-safety hardening.
3. Bounded depth-one managed agents. Completed and live-certified, including context inheritance and Worker completion enforcement.
4. Configurable orchestration guardrails. Next.
5. Nested agents with root-wide budgets and descendant lifecycle semantics. Future.
6. Dedicated live-agent tree and remaining monitoring UX. Future.
7. Combined certification and `delegate_task` compatibility retirement. Future.

Do not begin nesting until configurable limits, durable effective-policy records, and root-wide budget semantics are stable. Do not retire `delegate_task` until the replacement path passes combined provider, recovery, race, performance, and real VS Code certification.

## Proposed Architecture

The Phase 1 architecture, depth-one lifecycle control plane, explicit context inheritance, authority enforcement, and Worker completion gate are implemented. Sections describing child-specific configuration, nesting, the dedicated agent tree, and final compatibility retirement remain proposed.

### Core model

The old "current task is the top of `clineStack`" model has been replaced with two concepts:

- `TaskSessionRegistry`: all currently live task sessions and their lifecycle metadata.
- `currentView`: the chat pane state, either a selected task or a new-task draft.

Keep `clineStack` temporarily for serialized subtask compatibility if needed, but stop using it as the only live task registry. Long term, either remove it or repurpose it as a focused navigation stack only.

Provider methods and concepts:

- `getLiveTask(taskId?: string): Task | undefined`
- `getActiveTask(): Task | undefined`
- `focusTask(taskId: string): Promise<boolean>`
- `startBlankTask(): Promise<void>`
- `createTask(..., { preserveExisting: true })`: creates a top-level task without removing existing top-level tasks.
- `closeTask(taskId?: string)`: aborts/disposes one live task.
- `cancelTask(taskId?: string)`: defaults to active task for UI compatibility.
- `postStateToWebviewWithoutTaskHistory()`: posts selected-task state and live metadata without resending all history.

### Webview state

Extend `ExtensionState` from a single active snapshot to explicit task focus:

- Keep `currentTaskId` as the selected task for compatibility.
- Add `currentView`.
- Add `liveTaskIds: string[]`.
- Add lightweight live task metadata: `{ id, status, lifecycle, isActive, isStreaming, isWaitingForInput, lastUpdatedAt, waitingReason, queueCount, tokensIn, tokensOut, totalCost }`.
- Continue exposing `clineMessages` for the selected task only.

The task history list already has persistence and per-item updates. It can display running tasks by reading `status`, `currentTaskId`, and the new live metadata.

### Message routing

Every command that currently calls `getCurrentTask()` needs a task-id-aware variant.

Examples:

- `askResponse`
- `queueMessage`
- `deleteQueuedMessage`
- `terminalOperation`
- `cancelTask`
- `condenseTaskContext`
- checkpoint diff/restore
- edit/delete message
- export/share current task

Webview messages include `taskId` whenever the action is scoped to a task. Mutable task actions fail safely when a required `taskId` is missing instead of mutating whichever task happens to be selected.

### Starting a blank task while another task runs

The New Task button should no longer call `clearTask()` as its only path. Instead:

1. Set `currentView = { type: "newTaskDraft" }`.
2. Clear focus in `TaskSessionRegistry`.
3. Leave all live tasks running.
4. When the user sends the first message, call `createBackgroundTask()` and set the new task active.

The old destructive behavior can remain as an explicit "Close Task" or "Cancel Task" action.

### Task events

Task events carry `taskId`, and the webview applies full chat state only when it belongs to the selected task. For non-selected tasks, update lightweight live metadata and task history, but do not overwrite `clineMessages`.

The existing `clineMessagesSeq` guard protects against stale snapshots for one selected task. Multi-task support needs task-scoped sequence numbers, for example:

- `selectedTaskMessagesSeq`
- or `messageSeqByTaskId[taskId]`

Without this, a background task state push can overwrite the foreground chat.

### Settings

Top-level task concurrency currently uses a conservative provider-enforced cap of `3` live non-terminal tasks.

Before enabling swarm mode broadly, add user settings for concurrency:

- `maxConcurrentTasks`: maximum total live tasks that can run at once.
- `maxConcurrentSwarmTasks`: maximum child tasks one Orchestrator swarm may run at once.
- `swarmCostLimit`: optional cost ceiling for one swarm group.
- `swarmRequireApproval`: whether Orchestrator must ask before spawning multiple children.

Defaults should be conservative. A reasonable first default is two concurrent swarm children and a small total live task cap. The UI should show when queued swarm children are waiting for capacity.

## Orchestrator Swarm Design

The original proposal below is retained for architectural context. The shipped control plane uses one strict `spawn_agent` call per child (multiple calls may share a provider response), `AgentControlStore` for the tree/mailbox, and the lifecycle tools listed in Status; it does not use the proposed `delegateParentToChildren` API.

Add a provider API:

- `delegateParentToChildren(params): Promise<Task[]>`
- Inputs: parent task id, child specs, mode/profile per child, initial todos, concurrency limit, optional cost limit.
- Output: child task ids and initial metadata.

The provider should enforce concurrency centrally. Orchestrator may request ten subtasks, but the provider should run only up to the configured maximum and queue the rest.

Parent behavior:

- Flush parent API history before spawning children.
- Persist parent status as something richer than today's single-child `delegated`.
- Add metadata for multiple awaited children:
    - `childIds`
    - `awaitingChildIds`
    - `completedChildIds`
    - `failedChildIds`
    - `swarmId` or `delegationGroupId`
- Pause parent execution until enough child results are available.
- Emit swarm lifecycle events when children are created, started, queued, waiting for input, completed, failed, cancelled, or merged.

Child behavior:

- Each child is a live task.
- Child completion writes a result record associated with the parent tool call and delegation group.
- Child failure/cancel writes a structured failure result.
- Each child updates runtime metadata frequently enough for monitoring without flooding the webview.

Result merge:

- For a single `new_task` tool call that spawns many children, the parent needs a coherent tool result.
- If the model emitted multiple tool calls, each child can map to its own tool result.
- If one orchestrator tool call maps to a swarm, the parent should receive one aggregated tool result after all required children finish.

This likely requires a new tool or schema rather than overloading current `new_task` semantics too far. Possible names:

- `new_tasks`
- `delegate_tasks`
- `orchestrate_tasks`

### Swarm monitor UX

Swarm monitoring is a requirement for Phase 2, not a later polish item. Running multiple paid agents without visibility is too risky.

The user should be able to see:

- The parent Orchestrator task.
- Every child task in the current swarm group.
- Which children are queued, running, waiting for input, completed, failed, or cancelled.
- A running spinner or clock-style activity indicator for active children.
- Current spend per child and aggregate spend for the swarm.
- Token/request counts per child where available.
- Last activity time and elapsed runtime.
- Current tool/action, such as reading files, editing, running a command, waiting for approval, or calling the model.
- Loop/stall indicators, such as repeated tool calls, no message progress for a threshold, repeated errors, or high spend with no completed todo movement.

The task history view should make running tasks visible without requiring the user to open the swarm monitor. A running child task should look alive in history, not like a static completed item. Clicking it should focus that child task and show its normal chat transcript and controls.

The parent Orchestrator view should include a compact swarm panel:

- Child task list with status icons.
- Per-child cost and elapsed time.
- Aggregate cost and active/queued/completed counts.
- Buttons to inspect, cancel, or pause individual children.
- Button to cancel the entire swarm.
- Clear signal when children are blocked on user approval.

This monitor should use the same live task registry as normal background tasks. It should not invent a second execution model for swarm-only tasks.

## Main Pitfalls

### 1. Global `getCurrentTask()` assumptions

This is the largest implementation risk. Many provider and webview handlers assume one current task. Background execution will be incorrect until task actions are explicitly routed by `taskId`.

Impact: high.

Mitigation: introduce task-id-aware provider helpers and migrate handlers incrementally behind compatibility fallbacks.

### 2. Webview state overwrite races

Today, `clineMessages` is a single array. If multiple tasks emit updates, a background task can replace the selected task's chat transcript.

Impact: high.

Mitigation: only post full message snapshots for the active task, and include `taskId` on task event messages. Use task-scoped message sequence guards.

### 3. Tool and approval prompts from background tasks

If Task A asks for approval while Task B is active, the UI must show that Task A needs attention without injecting the approval prompt into Task B.

Impact: high.

Mitigation: live task metadata should include `waitingForInput`, `askType`, and `lastAskTs`. The task list/header can show attention state. Selecting the task displays the prompt.

### 4. File system conflicts

Two agents editing the same workspace can conflict. This is especially risky for write tools, terminal commands, checkpoint restore, and generated files.

Impact: high.

Mitigation options:

- Start with read-only or user-approved parallelism.
- Add a per-workspace write lock for write tools.
- Prefer isolated worktrees per concurrent task.
- For swarm mode, require Orchestrator to assign non-overlapping file ownership.

The existing `packages/core/src/worktree` code suggests worktree isolation may already be a useful foundation.

### 5. Terminal and process ownership

Terminal operations must belong to one task. Background tasks may start terminals or wait for command output while another task is selected.

Impact: medium-high.

Mitigation: tag terminal sessions by task id and route terminal operation messages with `taskId`.

### 6. Checkpoint semantics

Checkpoint restore is workspace-global by nature. Restoring one task while another live task is modifying files could corrupt assumptions.

Impact: high.

Mitigation: disable checkpoint restore while multiple live tasks exist in the same workspace, or require per-task worktrees before enabling concurrent write tasks.

### 7. API configuration and mode are provider-global

Task creation currently reads mode/profile from provider state. Running tasks can have their own initialized API configuration, but switching mode/profile while creating or restoring another task may still affect global UI state and future task construction.

Impact: medium.

Mitigation: capture mode/profile into each task at creation; avoid global mode/profile mutation when merely selecting an existing live task. Restoration from history needs special care.

### 8. Delegation metadata is single-child oriented

Current fields support a parent awaiting one child: `delegatedToId`, `awaitingChildId`, `completedByChildId`.

Impact: medium-high for swarm.

Mitigation: keep those fields for serial compatibility and add multi-child fields for swarm groups instead of changing semantics in place.

### 9. IPC clients assume one active task

The IPC protocol has commands such as `SendMessage`, `CancelTask`, and `DeleteQueuedMessage` without task ids.

Impact: medium.

Mitigation: extend command data with optional `taskId`; keep active-task fallback for old clients.

### 10. Swarm observability and runaway spend

Parallel agents can burn tokens quickly and can fail silently if the UI only shows the parent task. Users need to know what is running, what is stuck, and what it costs.

Impact: high.

Mitigation: enforce concurrency and optional cost limits in the provider, emit per-child runtime metadata, show aggregate swarm spend, and surface stalled or waiting children in both history and the swarm monitor.

## Implementation Plan

### Milestone 1: task registry and non-destructive New Task - completed

Completed implementation items:

1. Introduced `TaskSessionRegistry` and `currentView` in `ClineProvider`.
2. Kept `getCurrentTask()` as a compatibility wrapper over the selected active task.
3. Added task-id-aware accessors and lifecycle methods.
4. Changed top-level task creation so it can preserve existing sessions.
5. Changed New Task UI flow to clear focus rather than close the running task.
6. Added `liveTaskIds`, `liveTasksById`, and `currentView` to `ExtensionState`.
7. Ensured only selected-task messages are posted as `clineMessages`.
8. Routed mutable task actions by `taskId`.
9. Updated Recent Tasks and Task History rows to show live session status.
10. Added close/delete paths that release live sessions even when they are in the background.
11. Added live-slot accounting so terminal/completed sessions return capacity to the pool.
12. Fixed background/native tool-call parsing so concurrent tasks do not share parser buffers.
13. Fixed draft/history navigation so clicking a task reopens it on the first click after switching views.
14. Added focused regression tests for registry accounting, message routing, draft creation, history click-through, and task UI state.

### Milestone 2: background task UX polish and monitoring foundation - mostly completed for top-level sessions

Completed:

1. Recent Tasks and Task History act as the task switcher.
2. Runtime metadata includes lifecycle, waiting state, queue count, token totals, cost, and last activity.
3. History rows show static status dots for running, waiting, completed, failed, closing, and closed sessions.
4. Completed tasks show as complete without consuming live capacity.
5. Background task updates refresh live metadata without replacing the selected chat transcript.

Still needed before calling this fully complete:

1. Add an explicit compact live-task list or header affordance for all running/waiting sessions.
2. Add clearer waiting-for-approval attention indicators outside history.
3. Add stronger safeguards around checkpoint restore while more than one same-workspace task is live.
4. Add terminal ownership hardening for simultaneous command-running tasks.
5. Add elapsed runtime and current tool/action metadata if users need deeper monitoring.

### Milestone 3: bounded depth-one managed agents - completed and live-certified

Completed:

1. Durable multi-child metadata, canonical paths, nonblocking spawn, provider-enforced bounded capacity, lifecycle controls, mailbox delivery, exactly-once result injection, and retained agents for follow-up.
2. Explicit `fork_turns: none | all | N` inheritance with durable context references and a credential-free manifest of effective instructions, skills, workspace, model route, and runtime authority.
3. Default and per-role saved provider-profile routing with safe parent-profile fallback and frozen route metadata.
4. Read-only Explorer/Reviewer enforcement and parent-authority narrowing.
5. Isolated, exact-scope Worker worktrees with quarantined change sets, explicit review/apply/discard controls, conflict protection, and crash-safe/idempotent Apply recovery.
6. Durable parent-verification obligations: `required`, `pending`, `satisfied`, `failed`, `superseded`, and `not_applicable`.
7. Completion enforcement before completion UI and immediately before the terminal transition. Applied `pending` or `failed` obligations block completion; missing or unreadable durable decisions fail closed.
8. Verification evidence restricted to relevant, post-Apply, parent-owned command execution. Pre-Apply, unrelated, and child commands do not satisfy the obligation.
9. Worker-card verification states, authoritative Apply/Discard capability checks, visible confirmation/error handling, duplicate-submission protection, and lifecycle/list projections.
10. Live VS Code acceptance proved the complete transition `pending_review/required -> applied/pending -> completion rejected -> verified/satisfied -> completed`, including durable reload-safe evidence and no duplicate pending/satisfied events.

Non-blocking observation:

- After terminal children leave the retained live projection, `list_agents` can return an empty `agents` array while still reporting the durable verification summary correctly. Track this with the dedicated tree/observability milestone; it does not weaken Apply or completion enforcement.

### Milestone 4: configurable orchestration guardrails - next

Already available:

1. A user-configurable total live-task limit with a conservative default.
2. Default and per-role saved provider profiles.
3. Global sub-agent enablement and auto-approval policy.
4. A shared capacity pool across top-level tasks, `spawn_agent`, and `delegate_task`.

Implement next:

1. Add a child-specific/root-specific concurrency limit distinct from the total live-task limit.
2. Define explicit-request-only versus proactive delegation policy and where it may be overridden per task.
3. Replace hard-coded role timeouts with validated configurable limits.
4. Add output/token limits and optional root cost budgets with deterministic cancellation and terminal reporting.
5. Persist the effective limits and delegation policy applied to every child so reload and audit do not depend on current settings.
6. Surface queued/capacity-limited children and the effective stop reason without encouraging polling.
7. Add schema, settings, persistence, reload, cancellation, and live VS Code acceptance coverage.

Exit gate:

- A parent can run with an independently configured child cap, model route, delegation policy, timeout, output/token ceiling, and optional cost ceiling. Reload preserves the effective configuration, limit exhaustion produces one deterministic terminal result, and no path can exceed the root-wide limits.

### Milestone 5: nested managed agents - future

1. Allow explicitly authorized children to spawn descendants while preserving authority narrowing and frozen context inheritance.
2. Enforce root-wide concurrency, token, cost, timeout, and depth budgets across every descendant.
3. Extend canonical paths, lifecycle controls, mailbox routing, visibility, and result ownership to the full tree.
4. Define descendant cancellation, parent interruption, close, crash recovery, cycle prevention, and orphan cleanup.
5. Prove nested Worker scope isolation and parent/root verification ownership.

### Milestone 6: dedicated live-agent tree and monitoring UX - future

1. Add a compact live tree with follow-up, interrupt, cancel, close, and inspection controls.
2. Show per-agent and aggregate usage, cost, elapsed runtime, current activity, queue state, and waiting-for-approval attention.
3. Keep transcript group cards as durable summaries while the tree consumes the agent registry/mailbox as its source of truth.
4. Integrate Worker change-set review and verification state without duplicating provider authority decisions.
5. Resolve the empty post-terminal `list_agents` projection and remaining top-level live-task header/attention affordances.

### Milestone 7: combined certification and compatibility retirement - future

1. Crash/restart recovery at every lifecycle and Worker verification boundary.
2. Strict-schema and multi-provider coverage for parallel calls and lifecycle tools.
3. Cancellation, duplicate-event, Apply/Discard, mailbox, follow-up, and descendant race stress.
4. Parent-plus-child latency, token, cost, and request-pacing benchmarks with regression thresholds.
5. Telemetry for effective configuration, stop reason, stalled work, and discarded or failed change sets without persisting secrets.
6. Real VS Code end-to-end certification of configuration, nesting, tree controls, recovery, and completion enforcement.
7. Deprecate and retire `delegate_task` only after production callers and acceptance tests use the managed lifecycle path.

## Difficulty Estimate

Milestone 1 was medium-large and is now implemented. The hard part was not creating multiple `Task` objects; it was untangling places where "current task" was implicit.

Milestone 2 is partially complete for top-level sessions. The remaining work is mostly UX hardening and deeper operational safeguards.

Milestone 3 was large and is now complete at depth one. Milestone 4 should remain bounded to configuration and enforcement contracts; nesting and the dedicated tree must not expand its scope.

## Suggested Non-Goals For First Pass

- Do not run multiple agents writing to the same files without a lock or worktree isolation.
- Do not change Orchestrator behavior in the first milestone.
- Do not remove `clineStack` immediately; use compatibility wrappers first.
- Do not make background tasks auto-approve actions invisibly. If user input is needed, mark the task as waiting.
- Do not restore checkpoints while another task is live in the same workspace.
- Do not allow unbounded swarm fan-out. Every parallel path needs a provider-enforced maximum before it ships.
- Do not hide child spend inside the parent. Swarm cost must be visible per child and in aggregate.

## Resolved Decisions

1. Worker children use isolated managed worktrees and exact write scopes; their changes remain quarantined until explicit review.
2. The total live-task cap is user-configurable and defaults conservatively to `3`.
3. Children inherit the parent provider profile by default, with configurable default and per-role saved-profile overrides.
4. Child context inheritance is explicit and frozen through `fork_turns` plus a durable manifest.
5. Applied Worker changes create a durable blocking obligation and require relevant parent-owned verification before completion.

## Open Questions

1. Should concurrent write-capable top-level tasks share the same workspace, or should they default to isolated worktrees?
2. Should there be a visible "Close and New Task" action next to the non-destructive New Task action?
3. Which modes may delegate proactively, and which require an explicit user request or per-task opt-in?
4. What should the default child-specific concurrency cap be within the total live-task cap?
5. Should root cost limits be hard stops, warnings, or both?
6. What default timeout and output/token ceilings should apply to Explorer, Reviewer, and Worker roles?
7. What maximum nesting depth should ship first?
8. What stall/loop heuristics are reliable enough to show as warnings without creating noise?

## Bottom Line

Top-level parallel task sessions and bounded depth-one managed agents are complete and should now be treated as product behavior, not experiments.

The shipped foundation includes explicit task selection, asynchronous child execution, durable lifecycle control, frozen context inheritance, model routing, authority narrowing, isolated Worker changes, and a live-certified parent completion gate.

The next implementation milestone is configurable orchestration guardrails. Freeze and persist the effective child limits and delegation policy before adding nesting or building a dedicated tree UI. After configuration, nesting and monitoring can reuse the same registry, mailbox, authority, verification, and budget contracts. Final combined certification comes last, followed by `delegate_task` retirement.
