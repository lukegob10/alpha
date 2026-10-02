# Approval mode policy

This document records the approval contract for Alpha's Ask, Auto, and Full Access modes.

## Decision

Auto approves read-only workspace access, validated in-workspace file changes, and commands run from the workspace.
The command grant is implicit in Auto; users do not need to save `*` or a Git prefix.
Auto approves Alpha Ticket changes for the current project, including deletion. Tickets are stored under the user's
`.alpha/tickets` directory, but the ticket tools bind each operation to the opened project; this grant does not allow
general file access outside the workspace. Auto asks before launching sub-agents, using MCP, changing protected files,
or changing files outside the opened workspace. Explicit command denies and detected outside or unresolved command
write paths still require denial or review, respectively.

Ask requests approval for file changes and commands by default; a saved non-wildcard command prefix can still allow its
matching commands without a prompt. Full Access continues to skip the ordinary per-action review for actions it permits,
while explicit command denials remain in force.

For an MCP tool call, the runtime resolves the captured server, source (`global` or `project`), and tool before asking.
Ask and Auto require review unless the user has enabled the legacy global MCP grant and saved an allow grant for that
exact resolved tool. MCP `readOnlyHint`, `destructiveHint`, and related annotations are displayed as context; provider
metadata cannot grant approval. Full Access skips the ordinary MCP tool review. Older approval records without a source
remain readable, while a new source-qualified call cannot borrow a grant from a same-named server in another scope.

## Command boundary

Approval metadata and complete review details travel separately. Large file snapshots or MCP review data do not count
against the bounded `description` field. The complete action still reaches the user and any injected reviewer, and
exact session approval identity still includes the original review data. Commands retain their exact description for
command amendments. See [file edit and approval alignment](file-edit-approval-codex-alignment.md) for the reproduction
and pinned Codex source comparison.

The [official Codex sandbox and approvals guidance](https://developers.openai.com/codex/security/) checked on
2026-09-26 describes Codex Auto as `workspace-write` plus `on-request`: routine commands can run inside the workspace
because the OS-enforced sandbox constrains their file and network access. Approval policy and sandboxing are separate
controls there.

Alpha does not run model-generated shell commands in an OS-enforced workspace sandbox. Auto uses command path preflight
to request review for detected writes outside the task root and unresolved destinations, and saved deny prefixes can
block commands. The analyzer cannot confine a process, prevent arbitrary network access, or guarantee that an unknown
program stays within the workspace. Auto therefore grants command approval inside the workspace, not OS-level
isolation. Full Access skips outside-path review; explicit deny rules still block commands in every mode.

The saved allow-prefix list remains available for Ask mode and for a more specific exception to a broader deny prefix.
It is not required for normal Auto operation. If Alpha later adds process confinement, keep the approval policy and
the confinement boundary separate.

## Existing settings migration

Earlier extension manifests seeded `git log`, `git diff`, and `git show` into global command rules. Those entries were
product defaults, not a deliberate user opt-in. On upgrade, a one-time migration removes only those exact built-in
prefixes from global state, preserving other saved prefixes. It does not edit VS Code user, workspace, or folder
settings. Users can re-add a prefix for Ask mode or to override a broader deny rule.

## Owning code

- `src/core/auto-approval/index.ts` decides whether tool calls and commands are approved.
- `src/core/auto-approval/mcpApprovalPolicy.ts` applies the same MCP decision inside that runtime path.
- `packages/types/src/approval-mode.ts` derives mode flags and command allowlists.
- `src/core/agent/ToolScheduler.ts` supplies trusted path-review requirements to the common approval decision.
- `src/services/tickets/TicketStore.ts` scopes ticket reads and mutations to the current project.
- `src/utils/migrateSettings.ts` removes the former built-in command prefixes from global state.
- `webview-ui/src/i18n/locales/en/settings.json` describes the mode and command rules.
