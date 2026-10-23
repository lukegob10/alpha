# Subagent approval and permission alignment

Reference retrieved 2026-10-23: Codex CLI commit
[`1c0c45bfc372fb7d7d581508fdef5eef8235eab7`](https://github.com/openai/codex/commit/1c0c45bfc372fb7d7d581508fdef5eef8235eab7).
This follows the lifetime/settings alignment in `agent-settings-codex-alignment-2026-10-23.md`.

## Verified upstream behavior

- [`child_config.rs`](https://github.com/openai/codex/blob/1c0c45bfc372fb7d7d581508fdef5eef8235eab7/codex-rs/core/src/agent/child_config.rs)
  clones the parent configuration and applies the invoking turn's current approval policy and permission snapshot after
  applying role configuration. A role cannot replace the parent's approval authority.
- [`role.rs`](https://github.com/openai/codex/blob/1c0c45bfc372fb7d7d581508fdef5eef8235eab7/codex-rs/core/src/agent/role.rs)
  projects a bounded set of role settings: instructions, model/reasoning settings, and selected capability disabling.
  Roles cannot select another provider, replace MCP servers, or change approval policy. Explorer is a task specialization,
  not an additional enforced read-only permission profile.
- [`role_tests.rs`](https://github.com/openai/codex/blob/1c0c45bfc372fb7d7d581508fdef5eef8235eab7/codex-rs/core/src/agent/role_tests.rs)
  tests `apply_role_preserves_parent_sandbox_permissions` and `apply_role_cannot_expand_parent_authority` preserve the parent
  permission, reviewer, provider, and MCP configuration even when a role file requests replacements.
- [`spawn.rs`](https://github.com/openai/codex/blob/1c0c45bfc372fb7d7d581508fdef5eef8235eab7/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs)
  delegates spawning to the thread host without a separate child-specific approval tier. Actions in the child still obey
  its inherited approval policy.
- [Official subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents) confirms inheritance from
  the current parent turn, including Full Access; custom agent files cannot override permissions. Interactive CLI approval
  requests can surface from inactive child threads. A noninteractive host that cannot obtain required approval fails the
  action and reports the failure to the parent. Parent-local one-off approval messages are not blanket child grants.

Codex's operating-system sandbox implementation is excluded from Alpha's alignment target. No sandbox has been added.

## Alpha divergences and implementation

| Previous behavior                                                                                                | New `spawn_agent` behavior                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role ceilings disabled network/external tools for every child and arbitrary commands/edits for Explorer/Reviewer | Roles inherit the parent's effective capability ceiling; the captured parent catalog determines callable tools                                                              |
| A small hardcoded child catalog removed MCP, Tickets, and other Alpha tools                                      | Capture the parent's callable catalog at the immutable step boundary, including deferred/MCP names; intersect with inherited authority and the child's current host surface |
| Worker instructions prohibited staging, committing, branches, and remotes                                        | Git uses the ordinary command approval path and task authorization, without a blanket child-only Git ban                                                                    |
| Workers rejected every absolute command working directory                                                        | Absolute directories inside the worktree are accepted; realpath confinement still rejects traversal and junction/symlink escapes                                            |
| Ask mode requested an additional group approval just to spawn a child                                            | A host-verified inherited spawn launches directly; child actions retain Ask approvals                                                                                       |
| Only Worker commands/protected writes surfaced approval cards in the parent                                      | Commands, ordinary tool approvals, protected writes, and MCP approvals surface for every managed role                                                                       |
| Child manifests captured command/file grants but omitted MCP review grants                                       | Capture credential-free, source-qualified MCP review grants and intersect live, invoking-step, and ancestor ceilings                                                        |

Inherited Ticket operations use the logical parent workspace rather than selecting a new project from the private
checkout's path. This preserves the user's existing Tickets project when Worker tools become available.

The new optional `runtimePolicy.authorityModel: "parent"` and captured execution mode distinguish this behavior from
historical manifests. They are included in policy/manifest digests. Cold reconstruction uses the same authority model,
scope, and execution mode. Existing manifests remain readable without rehashing or silently expanding saved authority.
Legacy launch arguments retain their explicitly narrower role grants. Without an invoking catalog, compatibility host
callers retain the existing conservative core-tool catalog rather than inventing additional authority.

Full Access skips ordinary per-action review only when both the invoking/captured grant and the live policy permit it.
Explicit command denials, revoked MCP grants, protected-file policy, and narrower captured authority remain effective.
MCP grants store server/tool/source identities, not server configuration or credentials. Auto requires both the live and
captured exact grant; grants from another source cannot substitute. Current settings can narrow a child's frozen grant.

## Retained Alpha host contracts

- Worker worktrees, exact-file/write-scope validation, stale-content checks, parent integration, and the shared workspace
  mutation gate remain Alpha capabilities. Explorer/Reviewer may inspect a shared workspace and use inherited edits when
  the assigned objective requires them; role wording alone is no longer a security boundary.
- User-selected Plan mode, disabled tools, `.alphaignore`, protected files, workspace boundaries, and managed-tree
  ownership remain enforced. Plan still admits only inspection roles and does not gain Code authority through Full Access.
- Background command agents use the process-owning command provider and cannot acquire foreground interactive terminals.
  Cancellation joins owned commands for all command-capable roles, not just Workers.
- Independent chats and their lifecycle authority remain separate from managed descendants. Child passive communication
  does not approve operations, start recipient turns, or grant peer/ancestor lifecycle control.
- Previously saved narrow grants are retained. This conservative persisted-ceiling behavior is an intentional Alpha
  compatibility/security choice; broader current settings do not silently upgrade a retained agent.

## Regression coverage

Focused tests reproduce the former Git working-directory and role/tool restrictions, then cover parent-derived tools for
all roles, explicit command denials under Full Access, source-qualified MCP grants/revocation, Ask launch behavior,
pending approvals with queued guidance, Plan inheritance, schema compatibility, command cancellation, and cold manifest
reconstruction. A real temporary Git repository test creates a Worker branch, stages and commits edits, stages another
edit, captures/applies the final tree, and verifies the parent's branch, HEAD, and index remain unchanged.

Validation results are recorded by the managed-agent certification runner and the exact VS Code 1.138.0 host gate.
