# Orchestrator Review and Document Failure Analysis

## Context

The reported workflow is:

1. The user runs Alpha in Orchestrator mode.
2. Orchestrator delegates or coordinates with another model/mode, typically Code mode.
3. The user asks Orchestrator to review work and generate a document.
4. Alpha shows the "Alpha is having trouble..." / mistake-limit guidance:

    > This may indicate a failure in the model's thought process or inability to use a tool properly, which can be mitigated with some user guidance (e.g. "Try breaking down the task into smaller steps").

This document is intentionally analysis-only. It does not propose any immediate code change in this branch.

Additional user context: the same general model split worked in an unmodified or less-modified Roo-style setup when the parallel task/delegation setup was not present. That shifts the primary suspicion away from simple model incompatibility and toward this fork's multi-task orchestration changes.

## Current Implementation Signals

The error text comes from the consecutive mistake guard, not from a direct provider error. The user-visible guidance is defined at `src/i18n/locales/en/common.json:59`, and the guard trips when `Task.consecutiveMistakeCount` reaches `consecutiveMistakeLimit` in `src/core/task/Task.ts:2528`.

The Orchestrator mode is configured with no normal read/edit/command/MCP groups in `packages/types/src/mode.ts:223`, relying on always-available mode tools such as `new_task`, `switch_mode`, `attempt_completion`, and `update_todo_list` from `src/shared/tools.ts:321`.

The Orchestrator instructions require delegation via `new_task` in `packages/types/src/mode.ts:225`. The native `new_task` tool also contains a strict isolation instruction: it must be called alone and not alongside other tools in the same model turn (`src/core/prompts/tools/native-tools/new_task.ts:5`).

The shared tool-use prompt currently encourages tool batching: "Prefer calling as many tools as are reasonably needed in a single response" (`src/core/prompts/sections/tool-use.ts:6`). This conflicts with `new_task` isolation for Orchestrator-heavy workflows.

There is runtime protection for mixed `new_task` batches. `Task` truncates tools after `new_task` and injects error tool results when `new_task` appears before later tools in the same assistant message (`src/core/task/Task.ts:3519`). That helps preserve API history, but it still means the model receives tool errors and may enter a recovery loop.

Delegation also depends on parent/child persistence ordering. The parent flushes pending tool results before being disposed (`src/core/task/Task.ts:1048`, `src/core/webview/ClineProvider.ts:3424`), and the parent is later reopened with a synthetic subtask result/tool result (`src/core/webview/ClineProvider.ts:3538`, `src/core/webview/ClineProvider.ts:3600`).

This fork also contains test coverage for delegation and single-open invariants, including `src/__tests__/provider-delegation.spec.ts`, `src/__tests__/new-task-delegation.spec.ts`, `src/__tests__/removeClineFromStack-delegation.spec.ts`, and `src/__tests__/single-open-invariant.spec.ts`. That is useful context because it shows the codebase has already had to guard several edge cases introduced by the newer task/session model.

## Required Task Isolation Contract

The architectural bar should be: a task is an isolated execution lane. Starting, switching, delegating, resuming, cancelling, or completing one task must not corrupt another task's state.

Each live or resumable task should own an immutable snapshot, or a clearly versioned mutable lane, for:

- mode slug and resolved mode configuration
- API provider profile and resolved API configuration
- model/tool protocol settings, including parallel tool-call behavior
- allowed tools and mode-specific file restrictions
- custom mode prompts and task-specific instruction material used to build the system prompt
- pending assistant content, pending user tool results, and in-flight approval state
- API conversation history and UI message history
- todo state, subtask metadata, and completion summaries
- cancellation, pause, resume, and auto-approval timers
- checkpoint/worktree/session identity if those features are enabled

Global UI state can show which task is focused, but it should not be the source of truth for a task's execution lane once that task has started. A mode switch in task B must not change task A's future tool permissions or system prompt. A provider-profile switch in the UI must not change task A's model on resume unless the user explicitly edits that task's lane. Tool results from task B must never be written into task A's API history except through a deliberate, typed delegation result.

Practical invariants:

- Every command from the webview that mutates a task should include and validate `taskId`.
- Any fallback to "current task" should be treated as unsafe for concurrent or delegated flows.
- `handleModeSwitch` should distinguish foreground UI mode from task-local execution mode.
- `createTask`, `delegateParentAndOpenChild`, and `reopenParentFromDelegation` should not depend on global mode/profile state after the child lane has been created.
- Pending tool results must be keyed by task and tool-use ID, never only by the active stack item.
- Parent API history may receive a child result only through an explicit delegation contract: parent task ID, child task ID, original `new_task` tool-use ID, and result payload.
- Removing or aborting a task must only update that task and its explicit parent/child metadata.
- Background or parallel tasks must not post state that the webview interprets as the foreground task unless the event is explicitly scoped.

## Leading Hypotheses

### 1. Fork-specific multi-task orchestration regression

Because a similar Orchestrator plus Code model split reportedly worked before the parallel task setup, the most likely regression class is now the parent/child task lifecycle rather than the model itself.

High-risk areas:

- global mode/profile state being read after a task should have a task-local snapshot
- webview messages without strict `taskId` targeting mutating the focused task instead of the intended task
- tool filtering using the wrong task's mode or custom mode config
- parent task disposal while child task creation is in flight
- parent API history flush timing before delegation
- synthetic child result injection when reopening the parent
- task history metadata transitions between `active`, `delegated`, and `completed`
- single-open-task enforcement interacting with nested or repeated delegation
- mixed `new_task` batches creating truncated tool calls and synthetic error tool results

The mistake-limit dialog may be the final symptom after the parent resumes with confusing or incomplete context. The actual bug could happen earlier during delegation, not at the point where the dialog appears.

This hypothesis should be tested first by comparing the same prompt across:

- the current fork with parallel/delegation changes enabled
- a baseline Roo-style flow without parallel task orchestration
- the current fork with the simplest possible one-child delegation path

### 2. Prompt conflict causes invalid Orchestrator tool batches

Orchestrator is told to delegate through `new_task`, while the global tool prompt pushes models toward batching tools. A model may reasonably emit something like:

- `update_todo_list`
- `new_task`
- `attempt_completion`

or:

- `new_task`
- `switch_mode`

in one assistant turn. The runtime specifically treats `new_task` plus later tools as invalid. Even if the code prevents orphaned tool calls, the model now has to recover from an injected tool error. Repeated recovery failures increment the mistake counter.

This remains a strong model-behavior trigger, but the user report suggests it may be exposing a fork-specific orchestration bug rather than being the whole issue.

### 3. Orchestrator is asked to perform review and document generation while lacking normal read/edit tools

Built-in Orchestrator has `groups: []`, so it does not get normal read or edit tools. It can delegate, but it cannot directly inspect code or write a Markdown document unless a tool is always available or the workflow delegates to a mode that can write.

This creates an ambiguous model task:

- "Do a review" implies reading code.
- "Generate a document" implies writing Markdown.
- Orchestrator mode's intended action is delegation, not direct file work.

If the model tries to satisfy the request directly, it may call tools unavailable in the current mode. If it delegates, it must use `new_task` perfectly.

### 4. Delegation resume relies on fragile API-history repair

The code has substantial defensive handling around delegated parent/child history. That suggests previous issues existed around missing tool results and stale parent state. The current path:

1. Save the assistant message before tool execution.
2. Flush pending parent tool results before disposing the parent.
3. Open the child task.
4. On child completion, inject a synthetic result into parent API history.
5. Reopen and resume parent.

Any race, failed save, missing `new_task` tool-use ID, or malformed history can return the parent to a state where the next API call is confusing to the model or invalid for the provider.

The implementation has safeguards, but this remains a high-value validation area because the reported failure happens after a multi-step delegated workflow.

### 5. The visible message is too generic for this workflow

The same mistake-limit guidance is used for no-tool-use, unknown tools, repeated rejected tool calls, and other model/tool protocol failures. In an Orchestrator workflow, the likely recovery advice is more specific than "try breaking down the task":

- Delegate one subtask at a time.
- Call `new_task` by itself.
- Use Code or Architect mode to write Markdown.
- Ask the child task to return a concise review summary before requesting final synthesis.

The current guidance does not tell the user what actually went wrong or what prompt shape is most likely to recover.

## Suggested Investigation Plan

1. Reproduce with a minimal Orchestrator prompt:

    ```text
    Review the current changes and create a Markdown report. Delegate code inspection to Code mode, then synthesize the result.
    ```

2. Capture the assistant tool calls for the failing turn:

    - Did it call `new_task` with any other tool in the same assistant response?
    - Did it call a read/edit tool while in Orchestrator?
    - Did it produce no tool calls twice in a row?
    - Did it call an unknown/aliased tool not present in the filtered native tool list?

3. Inspect parent and child task API histories around delegation:

    - Parent assistant message contains exactly one `new_task` tool use.
    - Parent next user message contains the matching `tool_result`.
    - Child completion injects a matching `tool_result` rather than only a plain text fallback.
    - Parent resumes in the original mode with coherent context.

4. Run targeted tests around mixed tool batches:

    - `new_task` alone.
    - `update_todo_list` followed by `new_task` in one response.
    - `new_task` followed by `attempt_completion` in one response.
    - Child completion where the parent history lacks the matching `new_task` ID.

5. Run fork-regression checks against the multi-task lifecycle:

    - parent delegates to one child and resumes once
    - parent delegates to child, child delegates to grandchild, then both return
    - child fails or is cancelled before `attempt_completion`
    - parent is removed from the stack while pending tool results still exist
    - two delegation requests are attempted close together
    - Code-mode child creates a Markdown file, then Orchestrator resumes and summarizes

6. Run explicit isolation tests:

    - Task A starts in Orchestrator, task B starts in Code, then task B switches mode; task A still resumes as Orchestrator.
    - Task A uses provider profile 1, task B uses provider profile 2, then task A resumes; task A still uses provider profile 1.
    - Task A has a pending tool approval, task B completes a tool call; task A's approval state and tool result IDs remain unchanged.
    - Task B writes a Markdown file; task A's API history receives only the child completion result, not B's intermediate tool calls.
    - A webview command missing `taskId` is ignored rather than applied to whichever task is focused.
    - Two tasks emit state updates close together; the webview does not overwrite `currentTaskId` or render messages under the wrong task.

## Improvement Options

### Low-risk prompt and UX changes

1. Make the global tool-use prompt conditional: when `new_task` is available, state that `new_task` is an exception to tool batching and must be called alone.

2. Strengthen Orchestrator instructions:

    - For review plus document generation, delegate the review/document work to a mode with read/edit access.
    - Do not attempt to inspect or write files directly from Orchestrator.
    - Use one child task at a time unless explicit parallel delegation is supported.

3. Improve the mistake-limit user guidance for Orchestrator mode:

    - Mention that `new_task` must be used by itself.
    - Suggest asking for "review only" first, then "write the document" as a second step.
    - Suggest switching to Architect or Code mode for direct Markdown creation.

### Medium-risk runtime changes

1. If a model emits `new_task` plus other tools, return a targeted correction before counting it as a normal mistake. The correction should explicitly say that `new_task` must be retried alone.

2. Treat tools before `new_task` differently from tools after `new_task`.

    Current comments discuss tools before `new_task` and runtime truncates tools after `new_task`. The model-facing error could be more precise:

    - Tools before `new_task`: results can be flushed, but this should still be discouraged.
    - Tools after `new_task`: never executed and should be retried after child completion if still needed.

3. Add delegation diagnostics to the downloadable error bundle:

    - current mode
    - tool names emitted in the last assistant response
    - whether `new_task` was mixed with other tools
    - parent task ID, child task ID, and whether a matching tool result was found

4. Add a temporary internal trace around delegation transitions:

    - before and after `flushPendingToolResultsToHistory`
    - before and after `removeClineFromStack`
    - before and after `handleModeSwitch`
    - before child `start`
    - before parent `resumeAfterDelegation`
    - exact API-history tail before the next parent API call

5. Add an isolation audit helper for tests that snapshots lane-critical state before and after cross-task operations:

    - task-local mode
    - task-local provider profile/config
    - allowed native tools
    - API history length and tail tool-use/tool-result IDs
    - pending approval/tool-result queues
    - parent/child task metadata

6. Replace unsafe active-task fallbacks in mutation handlers with strict task targeting where possible. Read-only UI operations can still fall back to the focused task, but mutations should fail closed when `taskId` is absent or stale.

### Higher-risk behavior changes

1. Add an Orchestrator-specific execution policy that rejects any non-delegation tool plan before it reaches the provider loop.

2. Split the Orchestrator mode into:

    - pure coordinator with only delegation tools
    - review coordinator with read access and Markdown-only edit access

3. Allow a single Orchestrator task to create a structured review artifact through a dedicated safe tool instead of general file editing.

4. Introduce a first-class `TaskLane` or equivalent object that contains all execution-scoped state, and make global state only select/focus lanes. This is larger than a bug fix, but it is the cleanest long-term model if parallel task execution is a core feature.

## Recommended Next Step

Start by proving or disproving the fork-specific delegation regression and task-lane isolation. The clearest first validation is a deterministic test or trace for one parent Orchestrator task delegating to one Code child that writes a Markdown report and returns. The parent should resume with the same task-local mode/config it started with, a valid API history tail, and no mistake-count increment.

After that, fix the prompt contradiction between the shared batching instruction and `new_task` isolation. That is still likely to reduce failures, but it should not be treated as sufficient until the multi-task lifecycle is verified.

For user guidance today, the most reliable prompt shape is:

```text
In Orchestrator mode, delegate exactly one subtask to Code mode. Call new_task by itself. Ask Code mode to inspect the current changes and create docs/review-report.md. After the child task completes, summarize the result.
```

If the goal is direct document creation without delegation, use Architect or Code mode instead of Orchestrator.
