# Outside-workspace access and approval

Implemented 2026-09-14 after investigating the Code-mode report.

## Current behavior

- Primary tasks can use native file tools to inspect other directories. With automatic read approval and **outside-workspace reads** enabled, these reads run automatically. Otherwise Alpha asks for approval.
- Native writes outside the task workspace always require explicit approval. This includes additions, edits, deletions, patch moves, and generated images. The old outside-write auto-approval setting is retained for saved-setting compatibility but ignored; its checkbox is removed.
- Workspace scope belongs to the task's captured root, including background tasks. Other VS Code workspace folders count as outside this task's root. Symlinks, junctions, and missing targets under existing ancestors are resolved when classifying scope.
- The scheduler checks native patch targets, including move destinations. It rejects a changed path target before execution and after approval, so approval cannot silently follow a retargeted junction.
- Primary Code commands can request an outside `cwd`. The requested directory is shown with the command. Plan and managed-worker command-directory restrictions remain in place.
- **All host commands require explicit approval**, including delegated commands and commands covered by a wildcard allow rule. A working directory cannot confine a script's writes. Command deny rules and inherited authority still apply; an allow rule does not replace approval.
- Plan remains read-only at the native file-tool boundary. Managed children retain their workspace limits; a primary task's outside-access capability is removed when capturing a child surface.
- Outside files do not enter workspace checkpoints or verification receipts. Their approvals and results are recorded in the tool transaction. A mixed patch still records its in-workspace changes in the workspace mutation ledger.

## This is an application policy, not an OS sandbox

Alpha's terminal adapters launch processes on the host. There is no OS filesystem sandbox and no sandbox on/off switch or per-command escape flag. An approved command can access files allowed by the host OS, including paths referenced indirectly by scripts or hooks.

Native tool path checks and approval gates are enforced in code. They do not isolate already-approved arbitrary processes, MCP servers, or browser automation. A real process sandbox would require a separate launcher design with platform-specific enforcement and tests proving that the OS denies an ungranted write.

The intended workflow is to give a file tool an absolute path or a path relative to the task workspace, then approve an outside write when requested. For a command in another project, use `execute_command` with that project's `cwd` and approve the command. No wider workspace root is needed.

## Root cause of the original failure

At baseline commit `e10e1f62cdcdc8dce75efa790df6e7883d444755` (with local changes), the scheduler rejected every explicit outside path before the tool could reach its read/write approval flow. The outside-file settings only influenced that later approval flow. An explicit outside command directory was rejected, while an outside path embedded in a shell command was not inspected.

A temporary characterization confirmed the mismatch for `read_file`, `list_files`, `search_files`, and `write_to_file`, and demonstrated a real host command reading and writing temporary sibling directories. Seven diagnostic cases plus existing policy and approval tests passed (50 tests). The user confirmed Code mode; the exact failed tool call was unavailable.

The repair separates primary outside-file access from automatic approval in the captured tool policy. It also handles the workspace-only mutation ledger, patch move checks, and task-specific path presentation that would otherwise keep outside writes broken or misclassified.

## Compatibility and validation

Saved policy snapshots without the new outside-access capability remain restricted. Explicit inherited policies are not widened. The public persisted `sandboxMode: "workspace-write"` spelling remains readable; model-facing text now describes an application file policy and host commands accurately.

Regression coverage includes outside reads with settings enabled/disabled, explicit write approval despite legacy settings, approved/denied external writes, mixed patch receipts, move destinations, background roots, junction retargeting, command approval, inherited grants, Plan restrictions, and the settings edit buffer.

Required validation: affected extension and webview tests, lint and typechecks, translation coverage, VS Code 1.122.1 smoke tests, and managed-agent certification for the stricter command approval boundary.

### Verification results

- The latest focused extension run passed **231 tests across nine files**. Earlier broader coverage passed 372 tests, including verification receipts, native reads, and primary mutation persistence. Native schema coverage also passed.
- Focused settings and command UI coverage passed **37 tests**. Extension, webview, and E2E lint checks ran successfully; touched-file whitespace checks passed.
- The exact **VS Code 1.122.1 smoke gate passed** on the final sequential run: three extension, two mode, and five VS Code LM tests, with complete evidence capture. Earlier attempts hit shared build-output deletion while other work was running.
- The **VS Code 1.122.1 managed-agent host test passed**, including explicit per-request command decisions for both the worker and parent, nested Apply, discard, verification, and completion.
- Both package typechecks passed before another task began modifying the shared scheduler and command execution contracts. The latest shared-tree checks fail in that task's `ParallelCommandRead.ts`, command-batching test, and `packages/core/src/message-utils/consolidateCommands.ts` changes. Those overlapping edits were preserved; a clean final typecheck is still required once they settle.
- Full strict managed-agent certification is **not green**. Its latest run encountered an unrelated lock-recovery race test (all seven cases passed on an isolated rerun), an existing opt-in live-evidence test skipped without `ALPHA_COMPLETION_IDLE_EVIDENCE`, and a changing working tree. The affected lifecycle track passed all 435 tests after correcting an invalid patch fixture.
- The translation checker reported existing missing translations elsewhere. All four changed command-setting strings are translated in all 18 frontend locales; this change adds no translation keys.

These results verify the implemented access and approval behavior but do not certify the concurrently changing shared tree as release-ready. No OS sandbox was added.
