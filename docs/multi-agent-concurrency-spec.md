# Multi-Agent Concurrency Spec

## Status

Top-level parallel task sessions and the original depth-one managed-sub-agent runtime are implemented and live-certified. Configurable orchestration guardrails, nested managed agents, layered nested-Worker ownership, and the durable live-agent tree bridge are now also implemented at the deterministic test boundary. The remaining release boundary is combined certification in a real VS Code extension host with native provider calls, process crash/reload, filesystem recovery, and host/webview convergence.

The extension now supports the core "parallel agent" workflow:

1. Start Task A.
2. Click New Task.
3. Task A remains live in the background.
4. Submit Task B from the blank draft window.
5. Task B opens immediately in chat while Task A keeps running.
6. Repeat up to the live task limit.
7. Completed tasks release their live-task slot back to the pool.
8. Recent Tasks and Task History can reopen completed, waiting, running, and background tasks without stopping other sessions.

The managed-child implementation now includes nonblocking `spawn_agent`, durable canonical paths and mailboxes, `list_agents`, `wait_agent`, downward `send_message`, immediate-parent `report_progress`, `followup_task`, `interrupt_agent`, `cancel_agent`, and `close_agent`. `report_progress` is available to every managed child without granting delegation or arbitrary routing authority; it appends a bounded durable mailbox event only for the frozen immediate parent. `fork_turns: none | all | N` captures a frozen, credential-free record of inherited conversation turns, instructions, skills, workspace, model route, runtime authority, ancestry, and effective limits. Explorer and Reviewer roles remain read-only. Workers use isolated scoped worktrees and quarantined change sets; an authorized Worker may layer a narrower nested Worker through its own private checkout, with verification owned first by the immediate Worker parent and later by the root for the outer change set. Root-wide capacity and budget contracts apply across descendants. The webview consumes a bounded, report-body-free projection of the durable registry for hierarchy, lifecycle, usage, capacity, budgets, activity, attention, and controls while transcript cards remain summaries.

## Goal

Allow a user to start a task, leave it running in the background, and start or inspect other tasks without stopping the first task. Allow a primary Code task to spawn bounded managed children, continue local work, inspect and steer those children, and receive their results without blocking the entire parent turn.

This document is both the implementation note for completed concurrency/lifecycle foundations and the planning note
for remaining real-host certification, compatibility retirement, and top-level task hardening.

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
- `managedAgentTree` is the bounded, credential- and report-body-free projection of the selected orchestration root's durable registry. It carries nested identity, frozen policy/limits, lifecycle, stop reason, usage, capacity, budgets, attention, and recent mailbox activity.
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
5. Terminal results are injected once into the parent conversation; `wait_agent` remains an explicit bounded mailbox wait rather than a polling primitive. A root with no active descendants returns immediately, while a registered managed child may wait for immediate-parent control even when it has no descendants.
6. A child can publish a bounded durable progress event only to its frozen immediate parent; `wait_agent` owns that event once.
7. Read-only roles remain read-only, while Workers use isolated worktrees, scoped writes, and parent verification.
8. User-configured provider-profile request pacing remains shared across parent and children and is reported as configured wait telemetry, not as an API failure.
9. Worker changes remain quarantined until explicit review. After Apply, parent completion is rejected until a relevant parent-owned verification command satisfies the durable obligation.

## Recommendation

Continue in dependency order. Milestones 1-3 are shipped foundations. Milestones 4-6 are implemented at the deterministic test boundary. Milestone 7's combined deterministic gate is complete; real-host acceptance is the next release boundary.

1. Multi-session top-level tasks. Completed.
2. Background-task monitoring foundation. Mostly completed; the remaining work is top-level UX and workspace-safety hardening.
3. Bounded depth-one managed agents. Completed and live-certified, including context inheritance and Worker completion enforcement.
4. Configurable orchestration guardrails. Implemented at the deterministic boundary.
5. Nested agents with root-wide budgets and descendant lifecycle semantics. Implemented at the deterministic boundary.
6. Dedicated live-agent tree and remaining monitoring UX. Durable managed-agent tree bridge implemented at the deterministic boundary; top-level session UX hardening remains separate.
7. Combined certification and `delegate_task` compatibility retirement. Deterministic gate complete; live acceptance next.

The dependency gate for nesting is satisfied: effective limits and policy are frozen per child, and root-wide capacity/budget semantics are enforced across descendants. Do not retire `delegate_task` until the replacement path passes combined provider, recovery, race, performance, native-host, and real VS Code certification.

## Proposed Architecture

The Phase 1 architecture, lifecycle control plane, explicit context inheritance, configurable child guardrails, nested authority enforcement, layered Worker completion gates, and durable agent-tree bridge are implemented. Final real-host certification and compatibility retirement remain proposed.

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

### Proposed top-level swarm settings

Top-level task concurrency currently uses a conservative provider-enforced cap of `3` live non-terminal tasks.

The shipped managed-agent settings are `maxConcurrentSubagents`, `subagentMaxDepth`,
`subagentDelegationPolicy`, role-specific timeouts, per-child input/output limits, and optional root token/cost budgets.
The names below belong only to the older, unimplemented top-level swarm proposal and are not current configuration
contracts:

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

### Managed-agent task UX

Running agents must stay visible without turning the parent into a monitoring dashboard. A sub-agent is another task
that happens to run concurrently, so navigation should match normal task navigation.

The parent view should show one slim Agents strip:

- one clickable status/name chip per descendant, including nested descendants;
- concise Approval, Review, Verify, or Fix attention only when action is needed;
- no repeated root, objectives, mailbox feed, elapsed-time grid, capacity cards, or token/cost dashboard;
- exact task navigation for active and terminal agents without pausing siblings.

The transcript should use the same compact task-row idea. Contextual actions such as Review request, Steer, Stop,
Open diff, Apply, and Discard belong in an overflow menu or the opened child task. Full lifecycle detail, scope,
usage, and stop reason are available after opening the child rather than duplicated in the parent.

Task history should make running tasks look active. The compact strip, transcript rows, and history must use the same
durable task registry rather than inventing a swarm-only execution or display model.

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

Mitigation: enforce concurrency and optional cost limits in the provider, account for child spend in durable usage
metadata, expose details in the opened child, and surface actionable stalled or waiting states in compact task rows.

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

### Milestone 4: configurable orchestration guardrails - implemented at deterministic boundary

Completed:

1. Added a child/root-specific concurrency limit distinct from the total live-task limit, with atomic admission and one root-wide descendant pool.
2. Added explicit-only versus proactive delegation policy. A descendant or per-task policy may narrow proactive to explicit-only but may never widen explicit-only.
3. Replaced hard-coded role timeouts with validated Explorer, Reviewer, and Worker settings.
4. Added input/output token ceilings and optional root token/cost budgets with stable stop reasons and deterministic cancellation.
5. Persisted ancestry, effective limits, delegation policy/provenance, role-timeout map, and selected timeout in each child manifest. Reload uses the frozen record instead of current settings.
6. Added Settings controls through the local `cachedState` buffer and exposed the normalized values through the extension/webview contract.
7. Added deterministic schema, settings, persistence, reload, capacity-race, timeout, budget, and terminal-cause coverage.

Deterministic exit gate:

- Passed. A parent can run with an independently configured child cap, model route, delegation policy, timeout, input/output ceilings, and optional root budgets. Reload preserves effective configuration, and limit exhaustion yields a stable terminal result and stop reason.

Remaining release evidence:

- Exercise the same contracts through real native-provider streams and host wall-clock/billable usage in Milestone 7.

### Milestone 5: nested managed agents - implemented at deterministic boundary

Completed:

1. Authorized children may spawn descendants within frozen depth and narrowed authority; read-only parents cannot widen into mutating Workers.
2. Root-wide concurrency, token, cost, and depth ceilings cover the descendant tree; each descendant uses a role timeout from the root-frozen timeout map.
3. Canonical paths, lifecycle controls, durable mailbox claims, waits, terminal results, and recovery retain immediate-parent ownership instead of flattening to root.
4. Descendant cancellation is deepest-first with stable direct-parent/ancestor causes; close remains bottom-up; nested recovery and orphan routing preserve the tree.
5. A managed Worker may create a narrower nested Worker. The nested checkout is based on the owning Worker's live private checkout, exact-file scope rules remain frozen, and Apply lands into that parent checkout rather than root.
6. The immediate Worker parent owns and must satisfy the nested change-set verification obligation. The root separately owns and verifies the outer Worker change set.

Deterministic exit gate:

- Passed for in-process/store/provider/worktree boundaries, including capacity races, immediate-parent mailbox routing, nested recovery, layered Worker Apply, and parent/root verification ownership.

Remaining release evidence:

- Hard-kill/restart the extension host with real managed child processes at nested spawn, mailbox claim, Worker Apply, and verification boundaries in Milestone 7.

### Milestone 6: compact managed-agent task UX - implemented at deterministic boundary

Completed:

1. Added an accessible one-line Agents strip that omits the root and renders each descendant, including nested descendants, as a clickable status/name task chip.
2. Keeps the parent surface intentionally small: only status and actionable Approval/Review/Verify/Fix attention are in view; clicking opens the full child task.
3. Replaced verbose transcript summaries with compact task rows and moved Review request, Steer, Stop, Open diff, Apply, and Discard into contextual overflow menus.
4. The extension-to-webview projection is bounded and omits raw manifests, mailbox payloads, credentials, and unbounded report bodies.
5. Reloaded durable nested state renders without transcript groups; loading, empty, navigation, attention, and large-tree states are covered deterministically.

Remaining product/release work:

1. Prove host/webview convergence, exact child navigation, sibling continuity, and overflow-action timing in a real VS Code window after extension-host reload.
2. Continue the separate top-level live-session header/attention and same-workspace safety hardening from Milestone 2.

### Milestone 7: combined certification and compatibility retirement - live acceptance next

Completed:

1. The latest recorded source-stable strict matrix passes all 26 deterministic rows: 10 tracks, 929 tests, zero
   skips, zero failures, and no baseline-debt waiver. The matrix treats 903 as a regression floor; a fresh run is
   required after source changes.
2. The canonical root workflow bundles once before package tests, avoiding competing Windows writes to `src/dist`.
   Lint, types, the broader package suite, and strict certification remain separate commands with separate evidence.
3. The eight irreducibly real-host/provider/storage cases are explicit `PENDING-INTEGRATION` rows with a single
   operator playbook in `docs/certification/managed-agent-live-acceptance.md`.

Remaining:

1. Hard-kill/restart the real VS Code extension host at every nested lifecycle, mailbox-claim, Worker Apply, and verification boundary.
2. Exercise strict native schemas, parallel tool-call streams, provider aborts, terminal ownership, and lifecycle tools through the real native-host/provider boundary.
3. Stress cancellation, duplicate events, Apply/Discard, mailbox claims, follow-up, descendant races, multi-process storage writers, and orphan cleanup.
4. Establish parent-plus-child latency, token, cost, and request-pacing benchmarks with regression thresholds and secret-safe telemetry for effective configuration and stop reasons.
5. Complete real VS Code end-to-end certification of configuration, nesting, compact task navigation/actions, crash/reload recovery, and both Worker completion gates.
6. Deprecate and retire `delegate_task` only after production callers and acceptance tests use the managed lifecycle path and the live certification is green.

## Difficulty Estimate

Milestone 1 was medium-large and is now implemented. The hard part was not creating multiple `Task` objects; it was untangling places where "current task" was implicit.

Milestone 2 is partially complete for top-level sessions. The remaining work is mostly UX hardening and deeper operational safeguards.

Milestone 3 was large and is complete at the original depth-one/live-certified boundary. Milestones 4-6 are implemented at deterministic boundaries; the remaining difficulty is integration risk rather than missing local architecture. Milestone 7 is large because it must prove process ownership, native-provider behavior, real filesystem recovery, and host/webview convergence under crash and race conditions before compatibility removal.

## Suggested Non-Goals For First Pass

- Do not run multiple agents writing to the same files without a lock or worktree isolation.
- Do not change Orchestrator behavior in the first milestone.
- Do not remove `clineStack` immediately; use compatibility wrappers first.
- Do not make background tasks auto-approve actions invisibly. If user input is needed, mark the task as waiting.
- Do not restore checkpoints while another task is live in the same workspace.
- Do not allow unbounded swarm fan-out. Every parallel path needs a provider-enforced maximum before it ships.
- Do not lose child spend accounting. Detailed per-child usage should remain available in the opened task without
  forcing an aggregate dashboard into the parent.

## Resolved Decisions

1. Worker children use isolated managed worktrees and exact write scopes; their changes remain quarantined until explicit review.
2. The total live-task cap is user-configurable and defaults conservatively to `3`.
3. Children inherit the parent provider profile by default, with configurable default and per-role saved-profile overrides.
4. Child context inheritance is explicit and frozen through `fork_turns` plus a durable manifest.
5. Applied Worker changes create a durable blocking obligation and require relevant parent-owned verification before completion.
6. Delegation defaults to explicit-only. Per-task/descendant policy may narrow proactive behavior but may not widen explicit-only policy.
7. Child concurrency defaults to `2`; nesting depth defaults to `1`; role timeouts default to 120 seconds for Explorer/Reviewer and 900 seconds for Worker. Optional root token/cost budgets are hard deterministic stops when configured.
8. Only a managed Worker can grant a nested Worker, whose write scope must be equal to or narrower than the owning Worker's frozen directory/exact-file scope.
9. Nested Worker verification is layered: the immediate Worker parent verifies the nested Apply, then root verifies the outer Worker proposal.
10. The compact managed-agent task strip consumes a bounded durable projection; raw manifests, mailbox payloads, and report bodies do not cross the webview bridge.

## Open Questions

1. Should concurrent write-capable top-level tasks share the same workspace, or should they default to isolated worktrees?
2. Should there be a visible "Close and New Task" action next to the non-destructive New Task action?
3. What stall/loop heuristics are reliable enough to show as warnings without creating noise?
4. What compatibility window and telemetry threshold should govern final `delegate_task` retirement?
5. Which real native-provider/VS Code host matrix is sufficient to promote the deterministic implementation to release-certified status?

## Bottom Line

Top-level parallel task sessions and the original bounded managed-agent foundation are complete product behavior, not experiments.

The combined implementation now includes explicit task selection, asynchronous child execution, configurable frozen guardrails, nested durable lifecycle control, root-wide budgets, narrowed authority, layered Worker isolation/verification, and a bounded durable compact-task bridge. The newer configuration, nesting, and task-surface layers have deterministic coverage but are not yet real-host certified.

The next milestone is live acceptance: real VS Code native-host/provider execution, hard crash/reload at lifecycle and mailbox boundaries, real worktree Apply/recovery, multi-process storage writes, and host/webview convergence. The deterministic combined tree is green. Only after the remaining live evidence is green should compatibility retirement begin, with `delegate_task` removed last.
