# Plan design handoff

A primary task's completed Plan response is saved as `HistoryItem.designHandoff` in the existing per-task
`history_item.json` metadata. The host captures the inner normalized `<proposed_plan>` markdown, optional leading
heading, source task ID, SHA-256 content digest, and update timestamp. One current handoff replaces the previous one;
streaming responses, incomplete blocks, Code responses, and subagent responses do not replace it.

Storage is limited to 100,000 JavaScript string characters, matching the existing command-output ceiling. An oversized
response stays visible in the transcript, but the host retains the previous handoff and shows a localized notice.
The transcript and metadata use the existing serialized persistence fence; the in-memory handoff is published only
after persistence succeeds. Old tasks without the optional field remain valid. Reload uses metadata, never a scan of
historical assistant text. The bounded global-state downgrade mirror is not the authoritative store.

Switching the same primary task to Code attaches its current handoff to the model's instructions. Each step rebuilds
this instruction from task metadata, so transcript compaction cannot discard it. A bounded prompt excerpt retains the
title and digest and identifies the stored handoff when the full body does not fit. User instructions, including later
changes, take precedence; the handoff cannot widen scope or grant tool authority. `taskWorkPlanSchema` and
`update_todo_list` remain the acceptance and verification checklist.

The localized **Implement plan** action switches to Code through the existing host path, then submits a localized
implementation instruction to the same task. A pending completion or reload review receives a normal message response;
an already completed task uses the durable completed-task continuation path. The action preserves the task, transcript,
and provider profile. Serialized validation rejects duplicate clicks, stale plans, and unrelated approvals; cancellation
is checked again after mode persistence. Failed completed-task admission restores Plan when the task remains idle, and
action failures are shown to the user. It adds no model-visible tool and grants no tool approval. Plan remains inspect-only;
there is no workspace export or plan editor.

Entering Plan is allowed while a task awaits a completed-result review or a reload/resume instruction. Those prompts
do not authorize tools and remain unanswered until the user continues. Tool approvals and other interactive prompts
still block entry into Plan. A rejected mode change republishes host state to undo the UI selector's optimistic value.
