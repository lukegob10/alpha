# Sub-agent timeout, context and Worker integration review

Reviewed on October 23, 2026 against current Alpha source and OpenAI Codex commit
[`4610b573e59b211bf9430cf6ffb97cfb84623090`](https://github.com/openai/codex/commit/4610b573e59b211bf9430cf6ffb97cfb84623090).
Existing working-tree changes were included in the review and preserved.

## Timeouts

Codex's ordinary spawned agents are separate child threads. The V2
[`wait_agent` handler](https://github.com/openai/codex/blob/4610b573e59b211bf9430cf6ffb97cfb84623090/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)
times out waiting for mailbox activity; it does not terminate the child. The default wait is 30 seconds, and the
configured upper bound defaults to one hour. The current
[`agents.job_max_runtime_seconds` field](https://github.com/openai/codex/blob/4610b573e59b211bf9430cf6ffb97cfb84623090/codex-rs/config/src/config_toml.rs#L777)
is explicitly retained as a compatibility no-op. No ordinary child-runtime deadline was found in the reviewed spawn path.
Provider, network and individual tool deadlines remain separate concerns.

Alpha has both a wait timeout and additional execution limits:

- `AgentLifecycleTool.ts`: default wait 30 seconds; allowed range 10 seconds to one hour. Expiring the wait does not
  cancel the child.
- `BoundedDelegationManager.ts`: a hard `budget.timeoutMs` timer aborts the child after execution admission. It covers
  the whole run rather than resetting when the child makes progress.
- `subagent-orchestration.ts`: default Explore/Review runtime 120 seconds; Worker runtime 900 seconds; configurable
  range 10 seconds to one hour.
- `AlphaProvider.ts` / `Task.ts`: an additional, fixed 75-second research window denies subsequent tools for
  Explore/Review roles and requests a final answer, independently of the configured role timeout. This is not itself
  a terminal timeout, but can make a larger configured timeout ineffective for further research.
- The orchestration root freezes role timeouts and budgets. Changing settings does not change the existing root's
  captured map or its descendants. Input/output and optional root token/cost budgets can terminate a child separately.

These timeout settings were reviewed, not changed by this work. Diagnosing an individual reported timeout still requires
its actual stop reason; the research-window denial alone does not prove a hard runtime timeout.

## Threads and compaction

Codex's
[`spawn_child_thread` path](https://github.com/openai/codex/blob/4610b573e59b211bf9430cf6ffb97cfb84623090/codex-rs/core/src/agent/control/spawn.rs)
creates a separate runtime and history. V2 defaults `fork_turns` to `all`; `none` starts without inherited conversation
history. Full-history forks preserve the applicable compacted history; the upstream
[`subagent_notifications.rs` tests](https://github.com/openai/codex/blob/4610b573e59b211bf9430cf6ffb97cfb84623090/codex-rs/core/tests/suite/subagent_notifications.rs#L1983)
explicitly check an inherited compaction checkpoint. Children subsequently use the normal compaction machinery on their
own history. They do not share a mutable transcript or inherit the parent's cumulative usage counters. Some feature
configurations reset child context-window/compaction limit overrides to model defaults in
[`child_config.rs`](https://github.com/openai/codex/blob/4610b573e59b211bf9430cf6ffb97cfb84623090/codex-rs/core/src/agent/child_config.rs#L132).

Alpha also creates an actual background `Task` with its own persisted transcript and the shared turn/compaction pipeline.
The current V2 capture supports native conversation inheritance from effective parent history with provider compatibility
checks. Legacy captures can use a bounded text projection instead. Normal child compaction is available, but it does not
reset or override the independent execution and cumulative token budgets above.

## Worker Review/Apply handoff

The reviewed Codex child configuration inherits the parent's working directory and execution policy. Its ordinary worker
spawn/result path has no mandatory private-worktree proposal followed by a second human Review/Apply step. Ordinary
tool approvals still follow the session's approval policy. The official
[subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
also describes inherited parent permissions.

Previously, Alpha captured Worker effects as `pending_review`, published that state, and attempted automatic application
later through a parent-idle UI mutation lease. This could expose Review/Apply state even with automatic write approval;
Ask required a second disposition after the child's original action approvals.

Completed Workers now integrate already-approved, in-scope effects before publishing their terminal result. Integration
uses the existing workspace mutation gate, baseline-content conflict detection, durable artifact state and parent ledger.
The child's inherited action approvals remain authoritative. Current parent mode and any reduction of captured approval
authority are checked under the mutation gate. Integration errors propagate instead of reporting an unapplied change as
success.

Alpha deliberately retains isolated execution and capture-time scope validation as workspace protections. Conflicts,
partial/cancelled work, reduced permissions and older pending proposals retain the recoverable Review/Apply path.
Existing persisted change-set schemas remain readable. Automatic application excludes partial and unsuccessful runs.

The deterministic regression uses actual Tasks, captured workspaces, artifact integration and persistence with a scripted
provider; approved child file effects are supplied by the fixture. It covers Ask/Auto/Full Access completion without an
intermediate review publication, concurrent edits, permission reduction, Plan mode and cancellation:

```sh
pnpm --dir src test core/webview/__tests__/AlphaProvider.worker-integration.spec.ts
```

The extension-host recovery scenario deliberately changes each owning parent's file before the child's final response.
It asserts a real conflict before exercising Apply/Discard. This preserves coverage of the recovery UI without treating
manual review as a requirement for ordinary successful Workers.
