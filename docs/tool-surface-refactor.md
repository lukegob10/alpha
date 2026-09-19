# Agent prompt: native tool-surface refactor

Copy this entire document as the implementing agent's instructions. Do not re-open Pi vs Codex research. Do not invent a different catalog. The target is the locked surface below, taken from the harness toolkit comparison and the 2026-09-19 pressure test.

This is a behavior-and-contract change. Follow `AGENTS.md`. Preserve unrelated dirty-tree work (provider reduction, retired `github_api` / `gh` via command). Make the smallest complete change at the owning layer. Add or update tests in the same change.

## Mission

Reduce Alpha's model-visible native catalog so it is **more than Pi and less than today's overlap**. Keep host policy, Plan allow-listing, command lifecycle, tickets, skills, MCP discovery, and managed agents. Remove duplicate editors and duplicate agent lifecycle names. Thin the command **schema**, not the command **host**.

Success is a smaller, vendor-neutral advertised set that still works on GitHub Copilot (`vscode-lm`), GCP Vertex, and Stellar, with OpenAI, Claude, Grok, and Gemini underneath.

## Authority. Do not relitigate

These decisions are closed:

1. **Host-eager, not `discover_tools`.** Native tickets, `apply_patch`, `shell`, agents, and browser tools must not go through `discover_tools`. That path already exists for large MCP catalogs (`mcp--*` when count ≥ 8 and schema bytes ≥ 16 KB). NOR-28 measured +1 model round. Extending it to product tools will hide tickets and patch.
2. **Tickets stay eager** whenever the read group is available. Do not gate them on discovery or a fragile mention detector. The system prompt already tells the model to call `list_tickets` / `read_ticket` before planning.
3. **`apply_patch` is host-eager for GPT-family routes.** Keep portable `edit` always. Do not make patch the only editor.
4. **Rename `execute_command` → `shell`.** Do not name it `bash`. Do not add `powershell`. This host is Windows-capable; `bash` as the public name pushes GPT toward bashisms.
5. **Do not copy Pi bash.** Keep backgrounding, Plan allow-list, approvals, workspace scope, mutation receipts, and output artifacts. Thin the contract: required `command`; optional `cwd` and `timeout`. Drop required-null `verification` from the model schema unless a later dedicated change reintroduces it as optional.
6. **One command follow-up, not three names.** Fold `read_command_output` into `manage_command` (Code only). Keep the host behaviors.
7. **One portable editor plus write.** Model-visible editors are `edit` and `write_to_file`, plus GPT-family `apply_patch`. Retire `apply_diff`, `search_replace`, and `edit_file` from the advertised catalog.
8. **Codex v2 agent set only.** Advertise `spawn_agent`, `wait_agent`, `send_message`, `followup_task`, `list_agents`, `close_agent`. Remove `delegate_task`, `interrupt_agent`, `cancel_agent`, and `report_progress` from the advertised catalog.
9. **Keep `new_task`.** Mode retirement already records it as a separate legacy blocking handoff. Do not retire it in this change.
10. **Do not restore `github_api`.** GitHub stays `gh` through `shell`. Do not add a universal `web_search` or revive `generate_image` as a coding primitive.
11. **Do not replace dedicated `search_files` / `list_files` / `read_file` with shell.** Those stay. `codebase_search` remains host-eager only when the Vertex index is enabled, configured, and initialized (already implemented in `filter-tools-for-mode.ts`).

## Locked target catalog

### Always advertised (when the mode group allows)

| Tool                    | Notes                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `read_file`             | Keep. Do not expand the schema. A later pass may slim description; out of scope unless a test forces it.    |
| `search_files`          | Keep.                                                                                                       |
| `list_files`            | Keep.                                                                                                       |
| `edit`                  | Portable exact replace. Prefer a single call with multiple disjoint replacements when you touch the schema. |
| `write_to_file`         | Create / full rewrite.                                                                                      |
| `shell`                 | Was `execute_command`. Same host. Thin JSON schema.                                                         |
| `manage_command`        | Code only. Wait / stop / input / read truncated artifact.                                                   |
| `update_todo_list`      | Code checklist. Not a substitute for Plan mode.                                                             |
| `ask_followup_question` | Keep.                                                                                                       |
| `attempt_completion`    | Keep.                                                                                                       |
| `skill`                 | Keep.                                                                                                       |
| `run_slash_command`     | Keep. User/host slash path.                                                                                 |
| `new_task`              | Keep. Legacy blocking handoff.                                                                              |
| `codebase_search`       | Only when the code index is live (existing gate).                                                           |

### Host-eager (advertise when the host predicate is true; never via `discover_tools`)

| Tool                                                                                                        | Predicate                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ticket tools (`list_tickets`, `read_ticket`, and in Code `create_ticket`, `update_ticket`, `delete_ticket`) | Read/edit groups as today. Stay eager.                                                                                                                                    |
| `apply_patch`                                                                                               | Current model is GPT-family (see detector below).                                                                                                                         |
| Managed agents (`spawn_agent`, `wait_agent`, `send_message`, `followup_task`, `list_agents`, `close_agent`) | Agents group. Plan already narrows to Explore/Review.                                                                                                                     |
| Browser tools                                                                                               | Live VS Code `vscode.lm.tools` catalog, already filtered by `availableBrowserToolNames`. Do not invent a second deferral.                                                 |
| MCP                                                                                                         | Existing trio: `discover_tools` + `access_mcp_resource` + callable `mcp--*` after discovery. Do not change the MCP deferral policy except to keep native tools out of it. |

### Retired from the advertised catalog (this change)

`apply_diff`, `search_replace`, `edit_file`, `execute_command` (name), `read_command_output` (name), `delegate_task`, `interrupt_agent`, `cancel_agent`, `report_progress`.

`github_api` and `generate_image` stay retired / non-advertised.

### Historical compatibility (non-negotiable)

Keep retired and renamed names in `toolNames`, usage schemas, transcript parsers, and aliases so old tasks remain readable and replay does not crash.

Required aliases (canonical on the right):

- `execute_command` → `shell`
- `read_command_output` → `manage_command`
- keep `write_file` → `write_to_file`
- keep `search_and_replace` → `edit`
- add `search_replace` → `edit` and `edit_file` → `edit` if those calls should still execute as portable edits
- `apply_diff` may alias to `edit` only if the executor can accept the old SEARCH/REPLACE payload; otherwise keep the executor for replay and reject new advertised use. Prefer executing old `apply_diff` through the existing `ApplyDiffTool` without advertising it.

A historical tool name must never restore an executable integration that this change removed from the catalog, except through an explicit alias to a living tool.

## GPT-family detector

Extend the existing Copilot preference helper in `src/api/providers/utils/router-tool-preferences.ts`. Today `copilotEditTool` already maps `gpt-*` / `o*` / `codex` → `apply_patch` and Claude/Gemini → `edit`.

Generalize that predicate so Vertex and Stellar GPT/OpenAI/Codex routes also host-eager `apply_patch`, and Claude/Gemini/Grok/Llama do not. Conflict between family and id must remain fail-closed (keep current Copilot behavior: no preference).

After the edit collapse, preferences must include **exactly one** surgical editor (`apply_patch` or `edit`) and must **not** keep `apply_diff` / `search_replace` / `edit_file` as included tools. `write_to_file` stays available.

Update `packages/types/src/providers/vertex.ts` Grok (and any other) `includedTools` / `excludedTools` that still name `search_replace` or `apply_diff`.

## Command contract

Model-facing `shell`:

- `command` (required string)
- `cwd` (optional string)
- `timeout` (optional number, seconds; existing agent-timeout-background behavior)

Do not require `verification`. Do not use `strict: true` if that forces nulls for optional fields. Plan mode keeps a stricter **description** and the existing host allow-list; it is the same tool name.

`manage_command` (Code only):

- existing `wait` / `stop` / `input` on `execution_id`
- add `read` (or equivalent) for truncated artifacts (`artifact_id`, optional `search` / `offset` / `limit`)
- optional fields stay omit-able; do not reintroduce `strict` nulls

Host implementation stays in `ExecuteCommandTool`, `ReadCommandOutputTool` / merged handler, `ParallelCommandRead`, Plan validation, and mutation receipts. Rename is catalog/parser/alias/UI. Do not rip out terminal integration.

Update `docs/github-cli.md` to say `shell` instead of `execute_command`.

## Edit contract

Advertised portable editor is `edit`:

- Keep `file_path`, exact match, `replace_all`
- If you change the schema, allow multiple disjoint replacements in one call (Pi `edits[]`) while still accepting the current `old_string` / `new_string` payload
- Do not require a prior `read_file` in the executor unless that invariant already exists and is tested

`apply_patch` stays the GPT-family structured patch tool. Do not add a freeform Lark/Responses-API variant. Alpha is provider-neutral.

## Agent contract

Advertised: `spawn_agent`, `wait_agent`, `send_message`, `followup_task`, `list_agents`, `close_agent`.

Remove from `getNativeTools` and `TOOL_GROUPS.agents`: `delegate_task`, `interrupt_agent`, `cancel_agent`, `report_progress`.

Keep types, parsers, and executors for historical rows. Update tests that assert those names appear in the **advertised** Code catalog. Do not silently delete managed-agent recovery paths that still mention the old names in fixtures.

## Method of work

Work in this order. Do not start phase N+1 until phase N's focused tests pass. Do not one-shot the whole catalog.

### Phase 0 — Inventory and contract tests

Read current owners before editing:

- `packages/types/src/tool.ts`
- `src/shared/tools.ts` (`TOOL_GROUPS`, `ALWAYS_AVAILABLE_TOOLS`, `TOOL_ALIASES`, `toolParamNames`)
- `src/core/prompts/tools/native-tools/index.ts`
- `src/core/prompts/tools/filter-tools-for-mode.ts`
- `src/core/tools/ToolRegistry.ts`
- `src/core/assistant-message/NativeToolCallParser.ts`
- `src/core/tools/validateToolUse.ts`
- `src/api/providers/utils/router-tool-preferences.ts`
- `src/core/task/__tests__/native-tools-filtering.spec.ts`
- `src/core/tools/__tests__/nativeToolDispatchContract.spec.ts`

Write or extend a catalog contract test that fails first:

- Code advertised names equal the locked set (plus live browser names and live MCP names).
- Plan advertised names exclude `manage_command`, editors, and ticket writes.
- `discover_tools` still only searches `mcp--*` candidates.
- `execute_command` is not advertised; alias resolves to `shell`.
- GPT-family includes `apply_patch`; Claude/Gemini/Grok do not.
- Retired advertised names are absent from `getNativeTools()`.

### Phase 1 — Types, groups, aliases

Update `toolNames` only if you add `shell`. Keep old names. Update `TOOL_GROUPS.command` to `shell` + `manage_command`. Remove retired names from advertised group lists and from `edit.customTools` except `edit` and `apply_patch`. Update `schemas/alphamodes.json` if it enumerates tools. Update `packages/types` tests (`mode-retirement`, tool schema).

### Phase 2 — `shell` rename and thin schema

1. Add `createShellTool` (or rename the factory) in `native-tools`.
2. Alias `execute_command` → `shell` in `TOOL_ALIASES` and `canonicalizeToolName`.
3. Keep `ExecuteCommandTool` execution; accept both names in the parser.
4. Thin the schema. Update Plan description. Update `docs/github-cli.md`.
5. Tests: `executeCommandTool.spec.ts`, `stageThreeCommandOutcome.integration.spec.ts`, `ParallelCommandRead*.spec.ts`, `plan-command.spec.ts`, `commands.spec.ts`, native parser.

### Phase 3 — Merge command follow-up

Fold artifact read into `manage_command`. Alias `read_command_output`. Keep Plan without `manage_command`. Update ChatRow / i18n if the UI names the tool. Do not localize with English-only new strings; use existing locale files.

### Phase 4 — Collapse editors

Stop advertising `apply_diff`, `search_replace`, `edit_file`. Keep executors for replay / aliases. Point model preferences at `edit` vs `apply_patch` only. Extend GPT-family detection beyond Copilot. Update Vertex Grok `includedTools`. Update Edit/ApplyDiff/SearchReplace/EditFile specs so catalog assertions match; do not delete executor tests.

If you add `edits[]` to `edit`, add a focused executor test: multiple disjoint replacements, overlap rejection, legacy single-replace payload.

### Phase 5 — Trim advertised agents

Remove the four extra names from `getNativeTools` and groups. Keep `new_task`. Update spawn/delegate/filter/native-tools-filtering/managed-agent tests that list advertised tools. Certification fixtures that execute `delegate_task` by name: either keep the executor callable for tests via explicit registry include, or migrate those fixtures to `spawn_agent` + `wait_agent`. Prefer migration of **advertised** expectations; do not break recovery tests that replay old transcripts.

### Phase 6 — Prompts and UI

Update tool-use / capabilities / tickets / command prompt sections so they name `shell`, `edit`, and `apply_patch` correctly. Remove instructions that tell the model to pick among five editors. Tickets section must still name `list_tickets` / `read_ticket`. GitHub section must name `shell` + `gh`.

### Phase 7 — Validation

Focused, then widen:

```sh
pnpm --dir src test core/task/__tests__/native-tools-filtering.spec.ts
pnpm --dir src test core/tools/__tests__/nativeToolDispatchContract.spec.ts
pnpm --dir src test api/providers/utils/__tests__/copilot-tool-preferences.spec.ts
pnpm --dir src test core/tools/__tests__/executeCommandTool.spec.ts
pnpm --dir src test core/prompts/tools/__tests__/filter-tools-for-mode.spec.ts
pnpm --dir packages/types test src/__tests__/mode-retirement.test.ts
pnpm --dir src check-types
```

If webview labels change:

```sh
pnpm --dir webview-ui test src/components/chat/
node scripts/find-missing-translations.js
```

If activation, tool policy, or packaging is affected, say so and run or record that you could not run:

```sh
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

Do not claim a check passed unless it ran.

## Non-goals

- Recreating a GitHub API tool
- Adding web search
- Adding Pi `grep` / `find` / `ls` as extra names
- Making Plan a model-switched mode
- Retiring `new_task` or managed-agent runtime
- Changing providers, embeddings, or VS Code 1.122.1 compatibility
- Repository-wide format, lockfile, or version bumps
- Prompt-only security (policy stays in `validateToolUse`, scheduler, and executors)

## Definition of done

1. Advertised Code/Plan catalogs match the locked tables.
2. `execute_command` and `read_command_output` still parse via aliases and do not appear in new schemas.
3. GPT-family sees `apply_patch` + `edit` + `write_to_file`; non-GPT sees `edit` + `write_to_file` only.
4. Tickets remain callable without `discover_tools`.
5. `discover_tools` still only promotes MCP tools.
6. Historical transcripts with retired names remain readable.
7. `gh` documentation and prompts use `shell`.
8. Focused tests and typecheck above passed. Residual risk and any skipped host gate are reported.

## Context the agent may read, not rewrite as research

- This file
- `AGENTS.md`
- The harness toolkit comparison canvas (`harness-toolkit-comparison.canvas.tsx`) — use **Suggested Alpha surface** plus the host-eager / `shell` revision. If that canvas and this file disagree, this file wins.
- `docs/github-cli.md`
- `docs/mode-retirement.md` (`new_task` stays)
- `docs/provider-reduction.md` (connections stay Copilot / Vertex / Stellar; do not expand providers)

If this file and an older canvas sentence disagree, this file wins.
