# Agent settings and lifetime alignment

Reviewed October 23, 2026 against OpenAI Codex commit
[`7d592f6dd9988e349e3164feaa21d0fc14bbac8a`](https://github.com/openai/codex/commit/7d592f6dd9988e349e3164feaa21d0fc14bbac8a)
and the current [official subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents).
This supersedes the timeout findings in `subagent-codex-behavior-review-2026-10-23.md` for Alpha's current implementation.

## Reference and settings

Codex's current [`AgentsToml`](https://github.com/openai/codex/blob/7d592f6dd9988e349e3164feaa21d0fc14bbac8a/codex-rs/config/src/config_toml.rs#L766)
defines enablement, concurrent thread count, default model/effort, interruption messages, and custom agents.
`max_depth` is explicitly ignored by V2, and `job_max_runtime_seconds` is a compatibility no-op.
Experimental implementation and prompt-composition feature flags are not presented as ordinary agent settings.

| Codex agent setting                  | Alpha setting                    | Behavior                                                                                                                         |
| ------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                            | `subagentsEnabled`               | Defaults to true; disabling prevents new spawns while retaining controls for existing agents.                                    |
| `max_concurrent_threads_per_session` | `maxConcurrentSubagents`         | Positive safe integer, excludes the root. Default three spawned threads, matching V2's four threads including the root.          |
| `default_subagent_model`             | `subagentDefaultModel`           | Empty means inherit the parent model. Never selects another provider or credential set.                                          |
| `default_subagent_reasoning_effort`  | `subagentDefaultReasoningEffort` | Optional; inherits parent effort with an inherited model, or the selected model's default after a model change.                  |
| `interrupt_message`                  | `subagentInterruptMessage`       | Defaults to true; persists an attributed interruption note in child model history after owned cancellation settles.              |
| Custom agents                        | `subagentAgentTypes`             | Editable descriptions, model, reasoning effort, and developer instructions. Existing role metadata remains an authority ceiling. |

The default thread count and root exclusion follow
[`Config::effective_agent_max_threads` and V2 configuration](https://github.com/openai/codex/blob/7d592f6dd9988e349e3164feaa21d0fc14bbac8a/codex-rs/core/src/config/mod.rs#L1696).
Alpha retains its separate extension-wide task capacity and workspace protections. These are host resource and execution
policies, not per-agent lifetime settings. Custom agent definitions retain Alpha's existing size and count validation.

Model resolution applies parent inheritance, configured defaults, explicit spawn choices, then custom agent overrides.
A custom agent model alone preserves the reasoning effort resolved before the custom definition is applied. Full-history
forks, compaction, captured provider state, and existing task histories continue through the shared task runtime.

## Execution and compatibility

The current [`wait_agent` handler](https://github.com/openai/codex/blob/7d592f6dd9988e349e3164feaa21d0fc14bbac8a/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)
times out the wait without cancelling the agent. Alpha retains the 30-second default, 10-second minimum and one-hour
maximum; smaller integer requests clamp to the minimum. Explicit cancellation, interruption, parent cancellation,
provider errors, and individual tool deadlines remain independent terminal paths.

Alpha no longer starts a generic child execution timer, imposes a separate 75-second research window, or enforces
per-child cumulative input/output or root-tree token/cost ceilings. New descendants have no independent nesting-depth
ceiling. Existing captured permission and workspace restrictions still apply, including narrower historical grants.
Goal budgets and ordinary provider/tool limits retain their separate owners.

Retired global preferences are removed idempotently on initialization and ignored on settings updates and imports.
Their schemas remain available for old records. Historical manifests, their digests, usage, and stop reasons are preserved;
reloaded runs do not reinstate their old execution limits. New manifests and live projections represent retired ceilings
as null. Descendants inherit frozen capacity and permissions. Previously captured model routes continue to load by their
saved identity; new launches ignore the retired default/role/custom provider-profile preference.

An approved agent with a valid finalized manifest can receive follow-ups without a second delegation approval. Older
records that lack finalized authorization still use the existing migration approval. Ordinary tool approvals remain
enforced by the shared policy and scheduling layers.

## Validation

The regression in `SubagentRuntimeLimits.spec.ts` failed before the change because the child was aborted. It advances
fake time beyond one hour, verifies continued execution, and then verifies explicit cancellation. Additional tests cover
multi-request continuation after retired budgets, nested authority, old settings migration, cold follow-up, saved routes,
model precedence, interruption messages, and Settings Save/Discard/import behavior.

The managed-agent certification matrix now gates these contracts in place of enforcing the retired deadlines and budgets.
Its separate live-provider rows remain supplemental evidence rather than claims from scripted tests.

```sh
pnpm --filter @alpha-code/types test
pnpm --dir src check-types
pnpm --dir webview-ui check-types
pnpm certify:managed-agents:automated
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
```

`managed-agents.budget.acceptance.test.ts` now exercises retirement compatibility: a real Worker process survives both
a wait timeout and its old role deadline, then stops on explicit cancellation; synthetic output usage can complete and
root usage cannot cancel sibling agents. The suite records scripted usage as non-billing evidence.
