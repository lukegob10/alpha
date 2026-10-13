# Agents settings and approval explanations — 2026-10-11

## Scope and ownership

This implementation addresses F1, F5, F6, and the verified unused-component portion of F8 from
[the October 10 settings review](settings-review-2026-10-10-codex-alignment.md). It uses Alpha's existing TypeScript
settings, model router, managed-agent control plane, and approval policy. Code and Plan remain user-controlled modes.
The restored `codebase_search` tool, built-in and portable skills, Tickets, scheduled tasks, HTML preview, MCP, and other
active tools remain part of the shared harness.

The implementation began from checkpoint `14fc29614911d0d3b88670135a8a5c11abb75103` in the isolated managed worktree
`settings-agents-approvals-20261011`. The human authorized implementation and concurrent work. Three collaboration
subagents actually participated: `contract_review` verified current source and implemented the bounded routing fix;
`agents_controls` implemented the Agents group and validation; `approval_review` implemented the approval explanations,
effective MCP display, and unused-component cleanup. The lead integrated SettingsView wiring and Save/Discard tests.
The separate profile lead owns profile rename and provider-edit-buffer changes.

## Current Codex source recheck

Reviewed the official source read-only at commit **`27065a91ccbf5ba8532844be3777fcf83b77820d`**, committed
**2026-10-11T17:43:08Z**. The earlier divergence audit used `a07c8ebd57feedc4cf5dfe854c8e9101de54186b`; it is design
history, not evidence for today's configuration contract. No upstream source, prompts, runtime, or sandbox architecture
was copied into Alpha.

| Current source and tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Verified contract relevant to this change                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Config defaults, `resolve_multi_agent_v2_config`, `effective_agent_max_threads`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/config/mod.rs)                                                                                                                                                                                                                                                                                                                 | V2 defaults to four concurrent threads including the root, producing three child slots. The legacy `[agents]` child-count setting is converted to total V2 threads by adding one. `max_depth` applies to V1 and is ignored by V2. V1 defaults remain six child threads and depth one. |
| [`AgentsToml`, `AgentRoleToml`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/config/src/config_toml.rs); [`load_config_resolves_agent_controls`, `agents_max_threads_alias_matches_canonical_config`, `multi_agent_v2_uses_agents_max_concurrent_threads_per_session`, `legacy_agent_job_max_runtime_seconds_is_accepted_as_noop`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/config/config_tests.rs)             | Default subagent model/effort and named roles are supported; legacy `max_threads` is accepted as an alias. `job_max_runtime_seconds` is accepted only as compatibility data and no longer provides a runtime timeout.                                                                 |
| [`prepare_agent_spawn_config`, `build_agent_spawn_config`, `apply_requested_spawn_agent_model_overrides`, `apply_spawn_agent_runtime_overrides`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/agent/child_config.rs); [`spawn_inherits_captured_settings_after_a_turn_update`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/tests/suite/step_settings/agent_spawn_tests.rs)                                    | A child starts from the invoking step's captured model/provider settings. Requested/default model choices and role configuration are layered over that route. Live approval policy and working directory are reapplied independently of model selection.                              |
| [`spawn_agent_uses_explorer_role_and_preserves_approval_policy`, `multi_agent_v2_spawn_fork_turns_all_applies_agent_type_override`, `multi_agent_v2_spawn_without_history_allows_agent_type_override`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/tools/handlers/multi_agents_tests.rs); [V2 `handle_spawn_agent`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs) | V2 supports configured named roles with full-history or fresh-history children. Selecting a role does not discard the parent's approval policy or provider. V1's full-history role restriction is not V2's contract.                                                                  |
| [`multi_agent_mode.rs` tests `catalog_proactive_mode_is_ultra_only`, `mode_hints_override_reasoning_effort`, `live_mode_change_appends_mode_without_reappending_usage_hint`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/tests/suite/multi_agent_mode.rs)                                                                                                                                                                                                        | Upstream distinguishes explicit delegation instructions from proactive delegation and supports a mode update without reappending unrelated usage guidance. Alpha retains its provider-neutral user setting rather than coupling authority to an effort/model choice.                  |
| [`maybe_request_mcp_tool_approval`, `requires_mcp_tool_approval_for_mode`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/mcp_tool_call.rs); [`approval_not_required_when_read_only_and_other_hints_are_absent`, `approval_required_when_destructive_even_if_read_only_true`, `writes_mode_requires_approval_for_non_read_only_tools`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/mcp_tool_call_tests.rs)  | Upstream has annotation-sensitive Auto and Writes MCP policy, plus Prompt and Approve overrides. Alpha intentionally retains exact configured grants and treats annotations as untrusted hints. These enums are not Alpha's Ask/Auto/Full Access UI.                                  |

Upstream source/tests were inspected, not executed. Alpha's deterministic TypeScript tests provide the local regression
evidence below.

## Settings and effective policy

F1 was misleading consent copy: Auto described managed launches as requiring approval even though eligible bounded
launches are already approved by the captured Auto session policy. The explanation now describes that behavior while
keeping separate explicit-only/proactive delegation guidance and inherited child authority. Ask still requires a human
launch approval. Auto and Full Access do not imply a default proactive policy.

The new Agents group makes concurrency, delegation policy, and default child **Model/API profile** discoverable. Advanced
controls expose depth, role run timeouts, cumulative child token limits, root-tree budgets, role profile routing, and
named agent types. Model/API profile choices select providers/models; they do not grant file, command, network, MCP, or
delegation authority.

F6 displays MCP auto approval as effectively enabled and disabled for editing under Full Access, with an associated
effective-policy explanation. In Ask and Auto, the saved option remains editable. MCP tools require both the enabled
option and an exact configured server/tool/source grant to skip approval; MCP resource access follows the option. Full
Access overrides the option for valid MCP tool identities. Malformed identities remain fail-closed, and annotations do
not grant authority. The displayed override does not rewrite the buffered setting merely because the mode is rendered.

F8 removes the private `AutoApproveToggle` component and its dedicated tests only after production imports were checked.
Legacy persisted flags and historical readers remain, including deprecated `alwaysAllowModeSwitch`; models do not regain
a `switch_mode` tool. Active approval controls and saved permission data are preserved.

Request/cost controls use **requests between confirmations** and **reported API cost between confirmations**. They are
continuation checkpoints that can reset after user confirmation, rather than prepaid limits. Child/root budgets and
per-request output-token controls remain distinct. Profile reasoning defaults and the repetition detector's timing are
owned by their existing layers; this remit changes terminology only where it touches the owned UI.

## Native limits, units, and timing

The authoritative definitions and validation remain in
[`subagent-orchestration.ts`](../packages/types/src/subagent-orchestration.ts),
[`subagent.ts`](../packages/types/src/subagent.ts), and
[`global-settings.ts`](../packages/types/src/global-settings.ts).

| Setting                          | Default          | Accepted values and scope                                                                                                                                                                                                                                                        |
| -------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Managed children per root task   | 2                | Integer 1–16; active/reserved managed children across the root tree. This excludes the root itself and is distinct from the extension's total live-task capacity.                                                                                                                |
| Delegation policy                | Explicit only    | `explicit-only` or `proactive`; guides whether the agent waits for a delegation request. Launch approval still follows captured and live Ask/Auto/Full Access policy.                                                                                                            |
| Maximum depth                    | 1                | Integer 1–5; primary root depth is zero, direct children are depth one. Nested authority may equal or narrow the parent.                                                                                                                                                         |
| Explore / Review run timeout     | 120 seconds each | Persisted integer milliseconds 10,000–3,600,000; the UI converts to seconds without rounding away existing milliseconds.                                                                                                                                                         |
| Worker run timeout               | 900 seconds      | Same range and units. The timer starts after acquiring a run slot; a retained follow-up uses the same frozen timeout value for its new active run.                                                                                                                               |
| Cumulative child input tokens    | 250,000          | Integer 1–10,000,000; total input usage for a retained child, including follow-ups.                                                                                                                                                                                              |
| Cumulative child output tokens   | 16,000           | Integer 1–10,000,000; total output usage for a retained child, not a single-response maximum.                                                                                                                                                                                    |
| Root-tree token budget           | Unset            | `null` or integer 1–10,000,000; summed child input/output across live and closed descendants. Excludes the primary parent's own model requests.                                                                                                                                  |
| Root-tree reported cost budget   | Unset            | `null` or a finite positive USD amount; summed reported child cost across that tree. No fabricated schema maximum.                                                                                                                                                               |
| Default / role Model/API profile | Inherit          | Empty default inherits the invoking parent route; role maps may override Explore, Review, or Worker. Saved stable IDs are retained.                                                                                                                                              |
| Named types                      | Empty map        | At most 24 names matching `^[a-z][a-z0-9_-]{0,63}$`; trimmed description 1–500 characters. Optional `default`/`explore`/`review`/`worker` role, saved profile ID, model up to 256 characters, shared reasoning-effort value, and developer instructions up to 20,000 characters. |

`AlphaProvider.getSubagentAncestryAndLimits` captures depth and resource ceilings at the root's first child preparation.
`findFrozenRootOrchestration` recovers those ceilings from retained agents, history, or pending descriptors. Descendants
and reloaded children keep those limits, including the root role-timeout map. Save does not widen a running tree.
The extension's current total live-task capacity can restrict admission further than the frozen root ceilings.

Delegation settings have a separate narrowing rule: a saved explicit-only setting can narrow an open proactive task;
proactive cannot widen a task already frozen as explicit-only. Ask at either captured or live boundary still requires
review. The explicit-only guidance therefore does not promise a new approval dialog for each Auto-eligible launch.

Budget enforcement uses observed usage. An in-flight request can cross a reported-cost or token ceiling before the host
cancels the child/tree or denies a later launch/follow-up. Unset root budgets mean no additional root-budget limit, not
unbounded child authority, task capacity, or child token/run limits.

## Routing integration and persisted compatibility

The checkpoint's owning model router already implemented role/default/parent precedence, but
`AlphaProvider.prepareSubagentGroup` omitted the configured route arguments. Existing integration tests even asserted
that saved routes were ignored. Named types applied role/instructions but dropped their profile/model/effort defaults.
Exposing controls without fixing that integration would have made F5's UI deceptive.

The bounded host fix uses the existing `SubagentModelRouter`:

1. Profile route: named type profile ID, then role profile ID, then default child profile ID, then invoking parent route.
2. Model and reasoning effort independently: explicit per-spawn value, then named type value, then resolved profile.
3. Empty settings retain parent inheritance. Missing or unconfigured selected profiles produce the existing visible
   fallback metadata and use the parent route rather than silently trying another saved profile.
4. Routing preferences are captured before asynchronous Worker scope validation; actual resolved configurations are
   cloned at preparation and used at launch. Later settings or profile edits do not alter a prepared launch.
5. A retained child resumes its manifest route, or historical route metadata, by stable profile ID. Captured model/effort
   overrides are reapplied; incompatible provider/model drift is rejected. Manifest-less legacy children retain their
   own historical sticky profile when known. If that known profile is unavailable/unconfigured, resume fails explicitly
   rather than silently switching to today's defaults. Only records with no historical route/profile inherit the parent.

Named type profile selection uses the existing `role` route provenance; no public or persisted schema migration is
introduced. Profile IDs/routes are credential-free durable metadata, while provider credentials remain in the existing
profile/runtime configuration path. Authority is still derived and intersected independently from those configurations.

One deliberate Alpha precedence choice remains: explicit per-spawn model/effort wins over named type defaults. Current
upstream layers role configuration after requested/default model overrides, allowing the role layer to win. Alpha's
choice makes the caller's explicit override consistent with its existing router and required controls. User-configured
defaults still preserve parent authority.

Full-history, recent-turn, and fresh-history selections remain supported. The checkpoint already accepts V2 per-spawn
overrides when `fork_turns` is omitted (default `all`) or explicit. No V1-only restriction was introduced. Existing
`SubagentContextCapture.isCompatibleHistoryRoute` detects provider/model/profile changes, strips incompatible context
annotations and all parent-local opaque/response-chain state, and requires context rebuilding while retaining portable
conversation and media. The integration regressions verify this guard with saved routes across providers/models.

## Save path and validation

Agents form inputs bind to SettingsView's typed `cachedState`, not live `useExtensionState()` values. The existing
`updateSettings` Save path sends typed values through `webviewMessageHandler` and `ContextProxy`. Numeric/type editors
validate before Save; invalid drafts remain visible and cannot be silently clamped into an accepted payload. Default
initialization/resync, dirty-state, cancel/discard/reset, and Save remain explicit. Untouched saved named-type and profile
maps are preserved rather than replaced with fabricated empty role entries.

Accessibility follows existing settings controls: associated labels and validation descriptions, keyboard-operable
Advanced disclosure, and the disabled Full Access MCP control's effective-policy description. No new VS Code API or
contribution point is required; the host contract remains **VS Code 1.125.0**.

## Validation ledger

All local commands use pnpm **11.24.0**, Node **24.21.0**, the workspace TypeScript configuration, and at most two Vitest
workers. The source regressions were run before changing production code.

| Command                                                                                                                                                                                                                                                                                                                                                                                                  | Actual result                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --dir src test core/webview/__tests__/AlphaProvider.subagents.spec.ts -t 'named agent type\|named type route\|spawn .* override\|saved role profile\|configured default profile\|role profile fallback\|historical child profile\|captured route by stable\|captured profile drift\|configured Worker routing\|configured route change\|captured saved role routes' --maxWorkers=2 --minWorkers=1` | Before the host fix: 20 failed, 2 passed, 156 skipped. Failures demonstrated ignored routes/type defaults, changed history-route metadata, and historical-profile replacement. After the fix: 22 passed, 156 skipped.                                                                                             |
| `pnpm --dir src test core/webview/__tests__/AlphaProvider.subagents.spec.ts core/agent/__tests__/SubagentModelRouter.spec.ts core/agent/__tests__/SubagentContextCapture.spec.ts core/agent/__tests__/SubagentDelegation.spec.ts --maxWorkers=2 --minWorkers=1`                                                                                                                                          | 4 files, 303 passed. Includes additional legacy history-route recovery coverage, all/none/recent forks, Ask authority, default/role/type selection, independent spawn overrides, fallback metadata, stable-ID reload/drift rejection, controlled asynchronous scope-check capture, and concurrent child launches. |
| `pnpm --dir src test core/webview/__tests__/AlphaProvider.subagents.spec.ts -t 'configured route change' --maxWorkers=2 --minWorkers=1`                                                                                                                                                                                                                                                                  | 3 passed, 177 skipped after adding the same-provider/same-model/different-profile boundary alongside provider and model changes. All three discard incompatible inherited annotations and rebuild context.                                                                                                        |
| `pnpm --dir src exec eslint core/webview/AlphaProvider.ts core/webview/__tests__/AlphaProvider.subagents.spec.ts --max-warnings=0`                                                                                                                                                                                                                                                                       | Passed after scoped formatting.                                                                                                                                                                                                                                                                                   |
| `git diff --check -- src/core/webview/AlphaProvider.ts src/core/webview/__tests__/AlphaProvider.subagents.spec.ts docs/settings-agents-approvals-fixes-2026-10-11.md`                                                                                                                                                                                                                                    | Passed.                                                                                                                                                                                                                                                                                                           |

The integrating lead completed these additional checks:

- `pnpm install --frozen-lockfile` passed in this isolated worktree, without lockfile or manifest changes.
  `pnpm --filter @alpha-code/types build` passed to supply the normal typecheck's internal dependency declarations.
- The nine-file focused settings command below passed **123 tests**. This includes component/schema validation, untouched
  route/type preservation, optional clearing, Save, dirty refresh, Cancel/Discard, imported-settings reset, and Advanced
  search with controlled animation frames.
- `pnpm --dir src test core/auto-approval/__tests__/mcpApprovalPolicy.spec.ts core/auto-approval/__tests__/AutoApprovalHandler.spec.ts --maxWorkers=2`
  passed **29 tests** across two files, covering effective MCP policy and confirmation checkpoints.
- Both normal gates, `pnpm --dir src check-types` and `pnpm --dir webview-ui check-types`, passed. These were the ordinary
  package commands, not source-alias substitutes.
- Scoped ESLint passed for all touched TypeScript files. Prettier checks passed for touched source, tests, and locales.
  The normal commit hook's scoped Prettier write normalized five already-owned legacy CRLF input/test files to LF; this
  accounts for additional line-ending changes in their diffs. The design note was formatted and its source links, units,
  commands, and claims were reviewed against the current files.
- The normal pre-commit hook passed `pnpm exec lint-staged` and `pnpm lint`: all eight runnable lint tasks succeeded
  across the extension-focused workspace, including the webview and E2E runner. No hook was bypassed.
- `git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --check` passed. No generated files,
  package manifests, lockfiles, release versions, or unrelated files are included.

```sh
pnpm --dir webview-ui test src/components/settings/__tests__/AgentsSettings.spec.tsx src/components/settings/__tests__/agents-settings-validation.spec.ts src/components/settings/__tests__/AutoApproveSettings.spec.tsx src/components/settings/__tests__/MaxCostInput.spec.tsx src/components/settings/__tests__/MaxRequestsInput.spec.tsx src/components/settings/__tests__/managed-agent-settings.spec.ts src/components/settings/__tests__/SettingsView.spec.tsx src/components/settings/__tests__/SettingsView.unsaved-changes.spec.tsx src/components/settings/__tests__/SettingsView.change-detection.spec.tsx --maxWorkers=2 --minWorkers=1
```

Intermediate validation exposed a nullable MCP event target and an unsupported test matcher; both were corrected before
the passing ordinary typecheck. The first combined UI run overlapped a helper export edit and used a wall-clock wait for
search indexing, producing two failures. The export is present in the final snapshot, and the search regression now uses
fake timers and controlled frames. The final nine-file run above passed. An unused test import discovered by final scoped
ESLint was removed, and scoped ESLint was rerun successfully. The approval component/input regressions were also run
before their fixes: **7 failed and 19 passed**, then **26 passed** after the fixes.

The final parent integration owns the serial exact-host gate
`pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`, automated managed-agent certification, repository gates, and any
manual/live Copilot validation. They are **deferred to integration**, not claimed to have run in this remit. Known
baseline lookup-catalog assertions about the restored `codebase_search` remain parent-owned; the tool was not removed
to hide them. The human clarified that normal Git hooks are allowed in this isolated checkout, including the hook's
repository-wide `pnpm lint`. The commit follows that normal hook path, and the hook passed as recorded above. The
parent still owns the integrated repository checks after collecting sibling commits. No benchmark or general
quality/latency claim is made.

## Changed files

The isolated implementation changes these 21 files:

```text
src/core/webview/AlphaProvider.ts
src/core/webview/__tests__/AlphaProvider.subagents.spec.ts
webview-ui/src/components/settings/AgentsSettings.tsx (added)
webview-ui/src/components/settings/agents-settings-validation.ts (added)
webview-ui/src/components/settings/AutoApproveSettings.tsx
webview-ui/src/components/settings/AutoApproveToggle.tsx (deleted)
webview-ui/src/components/settings/MaxCostInput.tsx
webview-ui/src/components/settings/MaxLimitInputs.tsx
webview-ui/src/components/settings/MaxRequestsInput.tsx
webview-ui/src/components/settings/SettingsView.tsx
webview-ui/src/components/settings/__tests__/AgentsSettings.spec.tsx (added)
webview-ui/src/components/settings/__tests__/agents-settings-validation.spec.ts (added)
webview-ui/src/components/settings/__tests__/AutoApproveSettings.spec.tsx
webview-ui/src/components/settings/__tests__/AutoApproveToggle.spec.tsx (deleted)
webview-ui/src/components/settings/__tests__/MaxCostInput.spec.tsx
webview-ui/src/components/settings/__tests__/MaxRequestsInput.spec.tsx
webview-ui/src/components/settings/__tests__/SettingsView.spec.tsx
webview-ui/src/components/settings/__tests__/SettingsView.unsaved-changes.spec.tsx
webview-ui/src/i18n/locales/en/agents.json (added)
webview-ui/src/i18n/locales/en/settings.json
docs/settings-agents-approvals-fixes-2026-10-11.md (added)
```
