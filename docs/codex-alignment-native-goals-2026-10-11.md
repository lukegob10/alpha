# Native persistent task goals

This implementation was authorized by the human as part of the October 11, 2026 Codex alignment cleanup. It starts from
Alpha checkpoint `14fc29614911d0d3b88670135a8a5c11abb75103`, uses native TypeScript and the existing extension harness, and
was implemented in `align-native-goals-20261011` with **three collaboration subagents**: state/persistence,
kernel/accounting, and upstream/tool contract plus independent regression review. The lead owns the native command,
approval presentation, integration review, and final validation. No additional chat, parallel task runtime, Rust code,
Codex sandbox setup, copied prompt, or provider-specific goal engine is introduced.

## Verified upstream contract

The read-only official Codex source checkout was verified at
`27065a91ccbf5ba8532844be3777fcf83b77820d`, retrieved October 11, 2026, 17:43:08 UTC. The older divergence audit is design
history, not evidence for these contracts. References below use that exact commit:

- [`ext/goal/src/runtime.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/goal/src/runtime.rs):
  `continue_if_idle` holds the goal-state permit across persisted deferral checking, state reading, and host
  `start_turn_if_idle` admission. Only active goals continue. The host turn options survive continuation, and the admitted
  goal turn is identified before an immediately completing response can be handled. External changes share the permit.
- [`core/src/session/turn.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/session/turn.rs)
  and [`core/tests/suite/turn_input_submission.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/tests/suite/turn_input_submission.rs):
  normal pending input drains after sampling and tool settlement, while an authoritative host stop ends the turn. Idle
  continuation starts a separately admitted turn; stale prior-turn IDs cannot admit another one.
- [`ext/goal/src/spec.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/goal/src/spec.rs)
  and [`tool.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/goal/src/tool.rs):
  `create_goal` takes an explicit objective and an optional positive token budget and rejects an unfinished goal.
  `get_goal` returns goal state and remaining goal tokens. `update_goal` admits only complete, blocked, or explicitly
  requested paused status; resume, budget-limited, and usage-limited transitions belong to the host/system. Active
  progress is flushed before terminal status changes, and an exhausted budget takes precedence over pause. A configured
  upstream maximum token budget also supplies the default budget when the model omits one.
- [`ext/goal/src/api.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/goal/src/api.rs):
  `set_thread_goal` and `clear_thread_goal` serialize human intent, persisted mutations, and runtime effects. A failed
  intent recording does not mutate the persisted goal; clearing also removes pending goal turn options.
- [`ext/goal/src/accounting.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/goal/src/accounting.rs)
  and [`extension.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/goal/src/extension.rs):
  charge input less cached input plus output; reasoning is not added again. Plan turns are uncharged, descendant usage
  accrues to its owning root goal, and errors/usage limits stop active continuation. Three consecutive empty goal turns
  without intervening activity or objective changes block the goal.

Observable upstream regressions inspected include `goal_accounting_uses_turn_start_baseline_for_exact_deltas`,
`goal_accounting_ignores_plan_mode_turns`, `goal_accounting_preserves_concurrent_descendant_usage_across_checkpoints`,
`empty_continuations_require_three_turns_without_activity_or_goal_changes`, `installed_goal_tools_only_replace_complete_goal`,
`parallel_tool_finish_accounts_active_goal_progress_once`, `spawned_descendant_usage_exhausts_root_goal_budget_once`,
`subagent_usage_resets_when_root_goal_is_replaced`, `update_goal_can_stop_and_accounts_final_progress`,
`update_goal_rejects_resume_and_system_limit_statuses`, `thread_resume_rehydrates_active_goal_idle_accounting`, and
`goal_service_sets_gets_and_clears_thread_goal` in the upstream `ext/goal/tests` files.

## Native ownership and usable host path

`packages/types/src/task-goal.ts` owns the runtime-validated persisted state and public create/resume shapes. A goal has a
stable task and goal ID, state and control versions, explicit objective/status, optional token budget, elapsed milliseconds,
token usage, bounded continuation count, and recovery deferral. `TaskGoalStore` uses the existing task-directory safety checks,
file locking, atomic replacement, and a versioned task-local `task_goal.json` envelope. An absent file means no goal, so
existing task history needs no migration or implicit goal creation. Corrupt, foreign-task, and unsupported persisted
records fail closed and are not overwritten to hide an error.

`GoalController` serializes goal changes, usage receipts, and idle reservations. A synchronous steering generation fences
work awaiting storage. Expected goal identity protects a replacement from stale tool/host changes and late usage. The
control version changes with goal-management intent, independently of usage-only state updates, so an approved pause
can survive in-flight billing but cannot supersede a later host resume. Idle reservations also capture the continuation
count. Pending controls temporarily fence sampling; rejected stale or unauthorized actions preserve valid request
leases and reservations. Committed controls invalidate them, while Stop/Exit and human steering retain their synchronous
fences. Reads return copies. Execution remains in `AgentTurnEngine` and the existing `Task` lifecycle: the goal controller
owns neither a timer nor another model/tool loop. Automatic continuation is considered only after a completed turn's effects,
persistence, lifecycle terminal event, and cleanup have settled. Human input, approvals, cancellation, task pause,
compaction, disposal, policy, and mode boundaries take precedence over idle work.

The Task adapter considers idle continuation only after assistant completion or explicit native goal progress through
`completeGoalTurn`. An authoritative host completion preserves queued input for a later admission, even if a goal is
active or was created during the completed turn. After awaited goal admission, Task rechecks cancellation, abandonment,
durable completion, and history ownership before selecting queued input or publishing feedback. The existing terminal
journal helper records the current owner's terminal event and suppresses writes from a superseded history owner.
Reservation and consumption also recheck history ownership, so a superseded instance cannot spend the goal's continuation
allowance while storage is awaited.

The command palette exposes **Alpha: Manage Task Goal** (`alpha.manageGoal`). In the selected task the user can create,
inspect, pause, resume, or clear its goal. Creation asks for the concrete objective and optional total token budget;
resumption can change or remove the token budget. Native UI awaits retain the originating task ID and instance, and
goal-changing operations carry the captured goal ID and control version. A stopped/replaced instance must be reopened
through the existing task-history path; the command never resets a cancelled task's abort signal or silently changes Code/Plan. The Settings
view remains outside this feature's ownership.

The canonical registry exposes `create_goal`, `get_goal`, and `update_goal` through the existing tool surface, parser,
policy, scheduler, structured result, and approval paths. Creation and model-requested pause require an explicit human
approval even in Auto mode. Their approval row shows the actual objective, budget, and finite continuation bound as
escaped text. The model cannot clear, resume, increase a budget, or set a system-owned limit status. Goal completion and
normal model-turn completion are separate: a progress report can end a turn while the goal remains active, without
prematurely publishing `TaskCompleted`. A model's `update_goal(complete)` uses the existing completion gate to drain
managed children and satisfy verification obligations before committing the completed goal and reporting final usage.
Task completion reserves a single publication after asynchronous goal reads and rechecks the task steering and goal
request generations after its final verification barrier. A late host create/resume supersedes that completion and
enters the new goal through the existing drained loop, without spending an automatic continuation.

Canonical assistant history retains validated goal-usage receipts before the goal ledger is charged. Receipt identity
includes the owning task/goal and provider step/attempt, and replay reconciles the same receipt idempotently after a
crash. Goal receipt metadata is omitted from provider requests. Managed children retain their captured root goal
binding, including grandchildren created after an intermediate task unloads; late usage cannot bill a replacement
objective. Admission stops at 4,096 ledger receipts, with an 8,192 hard storage bound reserved for in-flight drain.

The bounded, immutable `task_goal_owner.json` admission record is saved before a queued child is published. Its original
goal ID and control version survive task unload and cold restoration. An explicit null owner records a child created
without a goal and prevents later adoption; goal-owned follow-up work must use an admitted child. A saved child with no
live parent can reconcile validated receipts through its recorded root controller, but cannot initiate provider work.
Legacy receipt-only recovery persists a drain-only owner across subsequent reloads. Fresh, explicit managed follow-up
admission after a human resumes the same goal may capture a new request lease; generic history restoration, an old
queued lease, and a replacement goal cannot acquire that authority. Both goal and owner stores revalidate the exact
resolved storage path after acquiring the file lock. A failed turn's terminal stop retains its original goal ID and
control version, so delayed finalization cannot block a replacement or a human-resumed goal.

An ordinary human task follow-up after a paused or completed goal can still run under Alpha's existing task policy. New
children of that ordinary work have no goal owner. The fallback capture binds only a current active goal admission;
historical goals do not silently become the owner of unrelated work. The invoking model step's captured binding takes
priority even if that response just exhausted the goal, preventing queued launches from escaping its limit.
Goal-generated replies to a native resume prompt retain a text-bound admission through consumption. A subsequent pause
can revoke that pending input without turning it into ordinary human input or granting a new request lease.

## Intentional Alpha differences and limits

- Alpha restricts goal tools to primary root tasks; upstream hides them specifically for review subagents. This narrows
  authority while managed descendants still charge the captured owning root goal. Explicitly requested independent
  primary tasks created by `AlphaProvider.createIndependentTask` do not inherit the parent's goal accounting;
  `orchestrationParentTaskId` identifies their relationship without granting goal-tool or host goal-management authority.
  Saved parent/root-linked delegated tasks retain their original accounting owner for recovery. Historical `new_task`
  calls remain readable but gain no executable descriptor in the current catalog. This feature does not remove or replace
  any existing child, orchestration, codebase-search, Tickets, scheduling, skills, preview, browser, command, or MCP tool.
- Goal creation and pause use Alpha's enforced human approval contract. Upstream tool descriptions also instruct the
  model to honor explicit human intent; model text alone is not Alpha's authority boundary.
- Plan exposes `get_goal` and admits no automatic goal execution or goal usage charge. Host state management remains
  available without changing the mode or execution policy.
- Each explicit run defaults to at most 20 automatic continuations; the typed host contract allows a bounded limit up to
  1,000. No maximum token-budget setting is added. Omitting a token budget therefore leaves tokens unbudgeted while
  continuation and existing task/provider/delegation limits still apply. A host resume starts a fresh continuation run
  while keeping lifetime usage and the existing goal identity.
- Empty provider responses use the existing shared no-response retry/exhaustion guard and then stop the goal. Alpha does
  not add upstream's separate persisted three-empty-goal-continuation counter in this change.
- Recovered active goals remain visible but require explicit host resume before automatic admission. Reload does not
  authorize an unattended restart or revive user-paused/cancelled work. A completed goal requires clear/new creation
  rather than host reactivation. Elapsed time is root model-step wall time through tool settlement, including approval
  waits within a step; it excludes closed or suspended time and does not double count descendant elapsed time.
- Goal remaining tokens are independent from context-window capacity. Usage is normalized by the captured existing API
  protocol contract before charging; cached reads and reasoning are never counted twice.
  Vertex Gemini's adapter now includes `thoughtsTokenCount` in canonical output tokens while retaining reasoning as a
  subset and calculating cost from the raw provider counts once. Its streaming and nonstreaming regression fixtures
  preserve the same cost. The current official
  [Vertex UsageMetadata contract](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/GenerateContentResponse#UsageMetadata)
  was retrieved October 11, 2026; prompt, candidate, and thought counts are disjoint there.

## Validation and integration handoff

Validation uses Node `24.21.0`, pnpm `11.24.0`, and TypeScript `5.8.3`. Dependencies were installed with
`pnpm install --frozen-lockfile`; only the types package's standard build prepares its runtime/declaration exports for
focused tests. No lockfile upgrade, generated artifact commit, extension bundle, VSIX, manually launched full repository
gate, or live Copilot run belongs to this worktree's handoff. The normal commit runs the repository's required pre-commit
formatting and default lint hook.

Final focused validation includes:

| Surface                                                                      | Result                           |
| ---------------------------------------------------------------------------- | -------------------------------- |
| Kernel, accounting, child-owner store, task lifecycle, cancellation baseline | 381 tests passed across 13 files |
| Final task recovery, completion follow-up, and transcript persistence        | 150 tests passed across 3 files  |
| Goal controller, state store, receipts, history validation, atomic writer    | 116 tests passed across 5 files  |
| Goal tools, completion tool, registry, dispatch, parser, Vertex adapter      | 196 tests passed across 7 files  |
| Managed-child preparation, retained follow-up, and provider lifecycle        | 166 tests passed                 |
| Native goal command and command registration                                 | 24 tests passed across 2 files   |
| Goal approval presentation                                                   | 5 tests passed                   |
| Shared goal schemas                                                          | 15 tests passed                  |
| Extension, shared types, and webview normal typechecks                       | Passed                           |
| Scoped ESLint across touched source, shared-type, and webview files          | Passed                           |

The 381-test baseline preceded the final four resume-prompt admission regressions; the affected three task files were
then rerun against the final source with all 150 tests passing. The final goal/completion tool rerun also passed all 95
tests in those two files. Extension typechecking and the affected-file lint checks passed after the final fixture edit.

Exact focused commands (Vitest filters have no standalone `--`):

```sh
pnpm --dir src test core/agent/__tests__/AgentTurnEngine.goals.spec.ts core/agent/__tests__/AgentTurnEngine.spec.ts core/agent/__tests__/GoalStepAccounting.spec.ts core/agent/goals/__tests__/GoalAccountingBindingStore.spec.ts core/task/__tests__/Task.goals.spec.ts core/task/__tests__/Task.goal-request.spec.ts core/task/__tests__/Task.completion-followup.spec.ts core/task/__tests__/Task.compaction-safety.spec.ts core/task/__tests__/Task.retry-wire.spec.ts core/task/__tests__/Task.retry-progress.spec.ts core/task/__tests__/Task.post-turn-followup.spec.ts core/task/__tests__/Task.persistence.spec.ts core/task/__tests__/Task.dispose.test.ts --maxWorkers=2
pnpm --dir src test core/task/__tests__/Task.goals.spec.ts core/task/__tests__/Task.completion-followup.spec.ts core/task/__tests__/Task.persistence.spec.ts --maxWorkers=2
pnpm --dir src test core/agent/goals/__tests__/GoalController.spec.ts core/task-persistence/__tests__/TaskGoalStore.spec.ts core/task-persistence/__tests__/goalUsageReceipts.spec.ts core/task-persistence/__tests__/validatePersistedApiMessages.spec.ts core/task-persistence/__tests__/atomicWrite.spec.ts --maxWorkers=2
pnpm --dir src test core/tools/__tests__/GoalTools.spec.ts core/tools/__tests__/attemptCompletionTool.spec.ts core/tools/__tests__/ToolRegistry.spec.ts core/tools/__tests__/nativeToolDispatchContract.spec.ts core/assistant-message/__tests__/NativeToolCallParser.registry.spec.ts api/providers/__tests__/vertex.spec.ts api/providers/__tests__/vertex-provider-outcomes.spec.ts --maxWorkers=2
pnpm --dir src test core/tools/__tests__/GoalTools.spec.ts core/tools/__tests__/attemptCompletionTool.spec.ts --maxWorkers=2
pnpm --dir src test core/webview/__tests__/AlphaProvider.subagents.spec.ts --maxWorkers=2
pnpm --dir src test activate/__tests__/goalCommands.spec.ts activate/__tests__/registerCommands.spec.ts --maxWorkers=2
pnpm --dir webview-ui test src/components/chat/__tests__/GoalApproval.spec.tsx --maxWorkers=2
pnpm --filter @alpha-code/types test src/__tests__/task-goal.test.ts --maxWorkers=2
pnpm --dir src check-types
pnpm --filter @alpha-code/types check-types
pnpm --dir webview-ui check-types
```

The parent integration chat owns the serial exact-host gate
`pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`, managed-agent certification when required, release/content gates,
and the exclusive signed-in VS Code 1.125.0 live profile. Those checks are explicitly deferred to integration; no other
VS Code host is substituted. Known checkpoint lookup assertions still classifying restored `codebase_search` as retired
are owned by the parent and must not be hidden by removing that tool or weakening policy.

## Changed-file inventory

The isolated worktree is
`C:/Users/Luke Goblirsch/.codex/worktrees/align-native-goals-20261011/Alpha-Code` on
`codex/native-goals-20261011`. The implementation touches these 50 repository-relative files:

```text
docs/codex-alignment-native-goals-2026-10-11.md
packages/types/src/__tests__/task-goal.test.ts
packages/types/src/goal-tool-approval.ts
packages/types/src/index.ts
packages/types/src/task-goal.ts
packages/types/src/tool.ts
packages/types/src/vscode-extension-host.ts
packages/types/src/vscode.ts
src/activate/__tests__/goalCommands.spec.ts
src/activate/goalCommands.ts
src/activate/registerCommands.ts
src/api/providers/__tests__/vertex-provider-outcomes.spec.ts
src/api/providers/__tests__/vertex.spec.ts
src/api/providers/gemini.ts
src/core/agent/__tests__/AgentTurnEngine.goals.spec.ts
src/core/agent/__tests__/GoalStepAccounting.spec.ts
src/core/agent/AgentTurnEngine.ts
src/core/agent/goals/__tests__/GoalAccountingBindingStore.spec.ts
src/core/agent/goals/__tests__/GoalController.spec.ts
src/core/agent/goals/GoalAccountingBindingStore.ts
src/core/agent/goals/GoalController.ts
src/core/agent/GoalStepAccounting.ts
src/core/assistant-message/NativeToolCallParser.ts
src/core/prompts/tools/native-tools/goals.ts
src/core/prompts/tools/native-tools/index.ts
src/core/task-persistence/__tests__/goalUsageReceipts.spec.ts
src/core/task-persistence/__tests__/TaskGoalStore.spec.ts
src/core/task-persistence/apiMessages.ts
src/core/task-persistence/TaskGoalStore.ts
src/core/task-persistence/validatePersistedApiMessages.ts
src/core/task/__tests__/Task.goal-request.spec.ts
src/core/task/__tests__/Task.goals.spec.ts
src/core/task/__tests__/Task.persistence.spec.ts
src/core/task/Task.ts
src/core/tools/__tests__/attemptCompletionTool.spec.ts
src/core/tools/__tests__/GoalTools.spec.ts
src/core/tools/AttemptCompletionTool.ts
src/core/tools/GoalTools.ts
src/core/tools/ToolRegistry.ts
src/core/tools/validateToolUse.ts
src/core/webview/__tests__/AlphaProvider.subagents.spec.ts
src/core/webview/AlphaProvider.ts
src/i18n/locales/en/common.json
src/package.json
src/package.nls.json
src/shared/tools.ts
webview-ui/src/components/chat/__tests__/GoalApproval.spec.tsx
webview-ui/src/components/chat/ChatRow.tsx
webview-ui/src/components/chat/GoalApproval.tsx
webview-ui/src/i18n/locales/en/chat.json
```

## Host completion follow-up validation

The separate host-completion fix starts from fixture commit `241cc05734bfd5196d47bcab1ceeb20526c9fc6d`. Its initial
controlled baseline failed 11 of 13 cases; two subsequent owner-only reproductions exposed queued-input claims and
continuation allowance consumption after history ownership changed. The final 15 boundary cases passed, including
canonical and legacy native goal progress, authoritative host completion, human guidance during admission, and terminal
or ownership changes while goal storage was awaited.

The two original queue regressions remained unchanged and passed. The complete `Task.spec.ts` passed all 315 tests on
the final source. The adjacent engine, goal-request, completion, follow-up, disposal, and native completion-tool set passed
165 tests across eight files. Final extension typechecking, scoped ESLint, and diff checks passed. These were bounded unit
checks; this follow-up did not run extension-host, live-provider, bundle, or repository-wide test gates.

```sh
pnpm --dir src test core/task/__tests__/Task.spec.ts --maxWorkers=2
pnpm --dir src test core/task/__tests__/Task.goals.spec.ts --maxWorkers=2 --testNamePattern 'Task idle continuation completion authority|continues (legacy|canonical) goal completion progress'
pnpm --dir src test core/agent/__tests__/AgentTurnEngine.goals.spec.ts core/agent/__tests__/AgentTurnEngine.spec.ts core/task/__tests__/Task.goals.spec.ts core/task/__tests__/Task.goal-request.spec.ts core/task/__tests__/Task.completion-followup.spec.ts core/task/__tests__/Task.post-turn-followup.spec.ts core/task/__tests__/Task.dispose.test.ts core/tools/__tests__/attemptCompletionTool.spec.ts --maxWorkers=2
```
