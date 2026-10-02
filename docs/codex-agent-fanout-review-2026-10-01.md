# Managed-agent fan-out and startup settlement review

Reference: official Codex CLI `origin/main` commit
`cb6da58876afed3ede0ab11084f67dd5394ecb48`, refreshed October 1, 2026 local
(October 2 UTC). This review uses source and deterministic extension unit tests, without live model calls.

## Applicable upstream contracts

- [Execution capacity](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/agent/control/execution.rs)
  counts active V2 child turns through an owned permit and refuses admission when the root-derived limit is exhausted.
  `execution_tests.rs::execution_guards_count_active_v2_subagent_turns` verifies both the frozen limit and release when
  the guard drops; root turns do not consume child permits.
- [Spawn ownership](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/agent/control/spawn_guard.rs)
  retains a child until its initial input is accepted. Failed or cancelled admission owns shutdown, registry removal,
  and the ordered closing of its persisted spawn edge. `spawn.rs` checks execution capacity before creating the child
  and disarms this guard only after initial delivery succeeds.
- [Residency](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/agent/control/residency.rs)
  can unload idle V2 children, but returns an agent-limit error when it cannot free capacity. The residency tests exercise
  owned reservations and idle eviction; `multi_agents_tests.rs::spawn_agent_limit_failure_emits_bounded_metric`
  verifies that a capacity failure reaches the model.
- [V2 wait](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)
  wakes on mailbox activity or new steering input and otherwise respects its bounded timeout. Waiting does not silently
  authorize more children. `multi_agents_tests.rs` covers timeout-only arguments and configured timeout bounds.
- `control_tests.rs::spawn_agent_fork_flushes_parent_rollout_before_loading_history` establishes a durable parent
  boundary before context fork. Alpha's existing context capture and frozen policy tests were retained.

## Confirmed Alpha failure

`AlphaProvider.executeSubagentEnvelope` observed new children through `TaskCompleted` and `TaskAborted` events, then
called the void `Task.start()` method. That method owns an asynchronous start promise. A preparation or early loop failure
can reject that promise before either terminal event is emitted. `Task.ownBackgroundLifecycle` reports the rejection,
but the launcher previously kept waiting. Its bounded run, child status, capacity reservation, and parent result remained
pending until cancellation or the role timeout.

The fail-before test deliberately rejected this owned lifecycle after child start. The asynchronous run remained
`running` instead of becoming `failed`. This is a demonstrated hang boundary; it does not establish that every reported
long prompt or multi-ticket stall had the same cause.

## Change and ownership

The launcher now observes the existing `Task.waitForTermination()` boundary immediately after start. A rejected start,
synchronous start exception, or unexpected lifecycle return without a terminal result enters the existing child
stop-and-join path. That path settles descendants and Task cancellation before Worker capture, terminal history, and
result publication. The failure remains a structured failed result with its startup diagnostic.

Completion events keep their existing ownership. A late lifecycle settlement cannot replace an already-selected terminal
result. Accepted retained completions use `Task.isCompleted()` and preserve a blocked outcome. An explicit pending ask or
projected resumable/interactive ask remains available to its existing consumer. Native managed approval, API-error, and
nested review asks normally keep the owned lifecycle pending; primary recovery-return paths exclude managed children.
`subagentCompletionOutcome` alone is not completion authority because the completion tool assigns it before its durable
finalizer succeeds. Cancellation and abandonment also retain their existing terminal path. The public void start API,
bounded manager, tool schemas, provider policy, and persisted formats are unchanged.

The controlled regressions cover rejected, thrown, and unterminated startup. Each holds terminal-history persistence,
proves another child cannot be admitted during that barrier, releases persistence, and then successfully starts the next
child under the same cap. They also check failed history/result publication and removal of child terminal listeners.
Three additional retained-boundary regressions preserve approval and recovery waits and publish an already-accepted blocked
completion when no completion event is available to the observer.

## Fan-out scope and intentional differences

Alpha's current preparation reserves process-wide and root-wide capacity before asynchronous preparation, counting live
and pending children. Excess fan-out is rejected with an actionable capacity error. The bounded manager also counts
descendants against the same root pool. This review did not demonstrate an admitted nested slot cycle through those
production admission checks.

Alpha retains its frozen depth, budgets, approval policy, workspace scopes, and managed Worker worktree protections.
Its durable mailbox claims and result/history barriers remain in place. Codex sandbox adoption and runtime/source ports
are outside this work; no limits or safeguards were weakened to improve apparent progress.

## Validation

- Before the fix: the focused rejected-startup regression failed for the intended reason (`running` instead of `failed`);
  134 unrelated tests were filtered out.
- After the fix: seven focused files passed, 195 tests total: `AlphaProvider.subagents`, the three
  `BoundedDelegationManager` suites, `AsyncSubagentRunManager`, `AgentLifecycleTools`, and `SpawnAgentTool`.
- `pnpm --dir src check-types` passed with the final observer guards and retained-boundary tests.
- Integrated exact VS Code 1.125.0 and managed-agent certification are owned by the parent integration run. No bundle,
  host, certification, VSIX, or live-provider command was run by this investigation.
