# Scheduled Task Agents

## Purpose

Scheduled task agents let a user define work that Alpha should run later or repeatedly without needing an active chat session.

This should feel like a controlled automation feature, not hidden agent memory. The user should always be able to see what exists, when it will run, what it is allowed to do, and what happened last time.

## Primary Use Cases

- Run a recurring repository health check.
- Revisit an issue, investigation, or TODO at a specific time.
- Watch for CI, dependency, release, or documentation changes.
- Generate a periodic project status summary.
- Continue a long-running task after a cooling-off period.
- Run a bounded research or maintenance loop on a known schedule.

## Non-Goals

- Do not make scheduled agents secretly modify the project.
- Do not use scheduling as a replacement for specs, docs, tests, or indexed code.
- Do not run ambiguous prompts forever.
- Do not create background behavior that is invisible to the user.
- Do not make the first version depend on a complex memory system.

## User Model

A scheduled task contains:

- Name.
- Prompt.
- Schedule.
- Scope.
- Permissions.
- Status.
- Last run result.
- Next run time.

The schedule answers when it runs.

The scope answers where it runs.

The permissions answer what it may do.

The result answers what happened.

## UI

Scheduled tasks should be visible from a dedicated view, likely under Alpha automation or tasks.

The list view should show:

- Task name.
- Enabled or paused state.
- Next run time.
- Last run status.
- Last run summary.
- Workspace or repository scope.

The detail view should show:

- Full prompt.
- Schedule definition in human-readable form.
- Allowed actions.
- Files or workspaces in scope.
- Run history.
- Logs or summaries for each run.
- Manual run button.
- Pause, resume, edit, duplicate, and delete actions.

Creating a task should require the user to confirm:

- What the agent will do.
- When it will run.
- Whether it may edit files.
- Whether it may create commits or pull requests.
- Whether it should notify the user before or after running.

## Scheduling Model

Support two scheduling types first:

- One-time scheduled run.
- Recurring scheduled run.

Recurring schedules should use simple human-facing controls before exposing advanced rules:

- Hourly.
- Daily.
- Weekly.
- Monthly.
- Custom interval.

Internally, schedules should be stored in a normalized format that can represent recurrence, time zone, start date, and optional end date.

Every scheduled task should store the user's intended time zone. Background execution must not silently reinterpret local times if the system clock or environment changes.

## Orchestration

The scheduler should not directly perform agent work. It should enqueue a run request.

Recommended flow:

1. Scheduler detects a due task.
2. Scheduler creates a task run record.
3. Run is placed into a durable queue.
4. Worker claims the run.
5. Worker prepares the execution context.
6. Agent executes within the task's scope and permissions.
7. Worker records status, summary, artifacts, and next run time.
8. UI updates from persisted run state.

This keeps timing, execution, and UI state separate.

## Background Execution

Scheduled agents need a background process that can run when the main chat is not active.

The background process should:

- Wake on a timer.
- Check for due tasks.
- Enqueue eligible runs.
- Avoid duplicate runs.
- Respect paused tasks.
- Respect workspace availability.
- Persist run state before execution starts.
- Recover cleanly after restart.

If the application is fully closed and no background host exists, missed runs should be detected on next startup. The UI should clearly show that the run was delayed.

## Execution Context

Each run should receive explicit context:

- Task prompt.
- Workspace path.
- Current repository state.
- Relevant docs or specs.
- Prior run summary, if useful.
- User-approved permissions.
- Time and schedule metadata.

Prior run summaries may help continuity, but they should be visible and editable. They should not become hidden memory.

## Permissions

Scheduled tasks should default to read-only.

Escalated permissions should be explicit:

- Read files.
- Run commands.
- Edit files.
- Stage changes.
- Commit changes.
- Push branches.
- Open pull requests.
- Send notifications.

Risky actions should require either per-run approval or a task-level permission that is obvious in the UI.

## Run States

Task runs should have clear states:

- Pending.
- Queued.
- Running.
- Waiting for approval.
- Succeeded.
- Failed.
- Skipped.
- Canceled.

Skipped should be used when the scheduler intentionally does not run a task, such as when the workspace is unavailable or a prior run is still active.

## Concurrency

A task should not start a second run while one of its runs is still active unless the user explicitly enables overlapping runs.

Default behavior:

- If a task is due while already running, record a skipped run or defer until the active run completes.
- If the app restarts during a run, mark the old run as interrupted unless it can be safely resumed.

## Notifications

Notifications should be configurable per task:

- Notify before running.
- Notify only on completion.
- Notify only on failure.
- Notify when approval is needed.
- Do not notify.

The notification should link directly to the task run detail.

## Auditability

Every run should leave a durable record:

- Trigger time.
- Actual start time.
- Finish time.
- Agent/model used.
- Prompt used.
- Workspace used.
- Permissions granted.
- Commands run, if any.
- Files changed, if any.
- Final summary.
- Error details, if failed.

The user should be able to understand why a task ran and what it did without reading raw logs first.

## Storage

The first version should use a simple local persisted store owned by Alpha.

The store should contain:

- Task definitions.
- Run records.
- Run summaries.
- Schedule metadata.
- Notification preferences.

Repository-specific scheduled tasks may live in project-local Alpha metadata if they are intended to travel with the repo. Personal scheduled tasks should live in user-local storage.

The UI must make this distinction clear.

## Failure Handling

Failures should not silently retry forever.

Recommended default:

- Record the failure.
- Notify if configured.
- Retry only if the task has retry policy enabled.
- Pause automatically after repeated failures.

Failure messages should distinguish:

- Scheduling failure.
- Workspace unavailable.
- Permission denied.
- Agent execution failure.
- Command failure.
- User approval timeout.

## MVP

The first version should support:

- Create scheduled task.
- Pause and resume task.
- One-time and recurring schedules.
- Read-only runs.
- Manual run.
- Run history.
- Last run summary.
- Missed-run detection on app startup.

Editing files, committing, pushing, and opening pull requests can come later.

## Open Questions

- Should scheduled tasks run when VS Code is closed?
- Should project-local schedules be committed to the repository?
- Should personal schedules be synced across machines?
- Should a missed recurring task run immediately, skip, or ask the user?
- What is the approval model for tasks that want to modify files?
- How much run context should be retained before summaries become noisy?
