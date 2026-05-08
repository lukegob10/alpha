# Multi-Agent Concurrency Spec

## Status

Top-level parallel task sessions are implemented.

The extension now supports the core "parallel agent" workflow:

1. Start Task A.
2. Click New Task.
3. Task A remains live in the background.
4. Submit Task B from the blank draft window.
5. Task B opens immediately in chat while Task A keeps running.
6. Repeat up to the live task limit.
7. Completed tasks release their live-task slot back to the pool.
8. Recent Tasks and Task History can reopen completed, waiting, running, and background tasks without stopping other sessions.

The current implementation is top-level multi-session concurrency, not full Orchestrator swarm fan-out. Swarm execution remains a future milestone that should reuse the same session registry and lifecycle model.

## Goal

Allow a user to start a task, leave it running in the background, and start or inspect other tasks without stopping the first task. Later, allow Orchestrator mode to decompose work into multiple child tasks and run those children concurrently, then merge their results back into the parent.

This document is now both the implementation note for completed top-level parallel sessions and the planning note for future swarm orchestration.

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

Future swarm execution should add:

1. Orchestrator decides on N independent subtasks.
2. It creates up to the configured maximum number of child tasks concurrently.
3. The user can see child tasks spin up in real time, with running indicators in task history and a swarm monitor surface.
4. Each child runs with its own lifecycle, messages, tool calls, approval state, terminal/checkpoint context, and cost accounting.
5. The user can click any running child to inspect its transcript, approvals, terminal state, todo progress, loop/stall signals, and spend.
6. Orchestrator observes child completion/failure/cancellation.
7. Orchestrator merges child summaries into its own conversation and continues.

## Recommendation

Do this in two separate milestones.

Milestone 1: multi-session top-level tasks. Completed.

This is the foundation. It introduced a live task registry and explicit active task selection while keeping task execution semantics as close to the previous model as practical.

Milestone 2: monitored parallel delegated subtasks for Orchestrator. Future.

This should be built only after multi-session top-level tasks are stable, because swarm orchestration requires the same primitives plus more complex parent-child result aggregation and clear observability.

Trying to jump directly to swarm execution would touch provider state, webview state, task routing, delegation metadata, approvals, checkpoints, terminals, and orchestration policy at the same time.

## Proposed Architecture

The Phase 1 architecture below is implemented. The Phase 2 swarm pieces remain proposed.

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

Once multiple live tasks are supported, Orchestrator can use a new parallel delegation primitive.

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

### Milestone 3: monitored parallel Orchestrator delegation - future

1. Add multi-child delegation metadata.
2. Add a swarm-capable tool schema rather than overloading single `new_task`.
3. Add settings for maximum concurrent tasks and maximum concurrent swarm children.
4. Implement child task spawning with provider-enforced concurrency and queuing.
5. Add the parent Orchestrator swarm monitor panel.
6. Add running indicators and click-through inspection for swarm children in task history.
7. Add per-child and aggregate cost visibility.
8. Add loop/stall detection signals.
9. Add result aggregation and parent resume logic.
10. Add workspace conflict policy: write lock or worktree isolation.
11. Add tests for partial child failure, cancellation, aggregation order, concurrency caps, and monitor state updates.

## Difficulty Estimate

Milestone 1 was medium-large and is now implemented. The hard part was not creating multiple `Task` objects; it was untangling places where "current task" was implicit.

Milestone 2 is partially complete for top-level sessions. The remaining work is mostly UX hardening and deeper operational safeguards.

Milestone 3 is large. Parallel Orchestrator execution changes delegation semantics, parent/child result contracts, conflict management, tool prompting, settings, and monitoring.

## Suggested Non-Goals For First Pass

- Do not run multiple agents writing to the same files without a lock or worktree isolation.
- Do not change Orchestrator behavior in the first milestone.
- Do not remove `clineStack` immediately; use compatibility wrappers first.
- Do not make background tasks auto-approve actions invisibly. If user input is needed, mark the task as waiting.
- Do not restore checkpoints while another task is live in the same workspace.
- Do not allow unbounded swarm fan-out. Every parallel path needs a provider-enforced maximum before it ships.
- Do not hide child spend inside the parent. Swarm cost must be visible per child and in aggregate.

## Open Questions

1. Should concurrent write-capable tasks share the same workspace, or should new background tasks default to isolated worktrees?
2. Should there be a visible "Close and New Task" action next to the non-destructive New Task action?
3. Is `3` the right default live-task cap, or should it become user-configurable for top-level sessions?
4. Should Orchestrator swarm be available only in Orchestrator mode, or should any mode/tool be able to request parallel children?
5. Should child tasks use the parent's provider profile by default, or can Orchestrator assign different profiles per child?
6. What should the default max concurrent swarm children be?
7. Should swarm cost limits be hard stops, warnings, or both?
8. What stall/loop heuristics are reliable enough to show as warnings without creating noise?

## Bottom Line

Top-level parallel task sessions are complete and should now be treated as product behavior, not an experiment.

The shipped foundation is a multi-session task registry with explicit active task selection. It unlocks "start one task, leave it running, start another task" without taking on full swarm orchestration complexity.

Future Orchestrator swarm work should build on the same registry to run parallel child tasks, show them running, let the user inspect each one, enforce concurrency limits, track spend, and aggregate their results.
