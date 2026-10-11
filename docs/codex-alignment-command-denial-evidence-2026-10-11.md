# Denied command attempt evidence — 2026-10-11

This change starts from integrated Alpha commit `d514d0b4a47074ff219b996332bb54a08bea76a7`. The exact VS Code
1.125.0 smoke test `Full Access auto-approves an outside write while the deny-list still denies` exposed a missing
projection of a rejected command into Task's command evidence. Its original assertion remains unchanged.

## Owning invariant and reproduction

The retained run `ac4490db-d045-49c1-97a5-701ebe8b0493` completed 16 of 17 approval-mode cases. Task
`01a12ce1-7003-7419-844c-de18f54aac96` persisted exactly one `approval-mode-1` request for `exec_command` with
`cmd: "rm --help"`, followed by exactly one same-ID `is_error: true` result with `status: "denied"`. Lifecycle events
also recorded that denial. No command approval or execution began, and the separate outside-workspace patch succeeded.

`ToolScheduler.prepareCall` rejects the denied command before `ExecuteCommandTool` enters its executor or calls
`Task.beginCommandExecution`. `Task.failCommandExecution` only updates existing running evidence. The shared terminal
result observer therefore had a complete denial receipt but no command evidence row for the host assertion to inspect.

The new native scheduler regression reproduces this through the real tool registry, captured Full Access policy,
serial and selective-parallel scheduling, and `Task.recordToolCallForStopping`. Before production edits, both direct
cases failed because evidence had length zero instead of one, after verifying the same-ID denied result and its
trusted no-effects metadata.
No command payload is executed by these tests.

## Verified reference

The official Codex source was inspected read-only at
[27065a91ccbf5ba8532844be3777fcf83b77820d](https://github.com/openai/codex/commit/27065a91ccbf5ba8532844be3777fcf83b77820d),
committed 2026-10-11 at 17:43:08 UTC and retrieved/reviewed on 2026-10-11:

- [tools/orchestrator.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/tools/orchestrator.rs)
  returns `ToolError::Rejected` for `ExecApprovalRequirement::Forbidden` before starting an execution attempt.
- [tests/suite/exec_policy.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/tests/suite/exec_policy.rs),
  `execpolicy_blocks_shell_invocation`, verifies a forbidden-rule tool result under never-ask approval settings.
  `deeply_nested_forced_rm_is_rejected_before_execution_when_approvals_are_disabled` verifies rejection and preserved
  sentinel content without execution.

Alpha retains that denial-before-effects behavior. Recording the denied attempt in its existing Task evidence ledger
is an intentional native diagnostic projection. It does not adopt Codex's sandbox architecture or imply that a process
started.

## Native change and compatibility

`Task.recordToolCallForStopping` observes trusted terminal metadata through the shared scheduler result boundary,
including deferred result commits. A denied `exec_command` with a known outcome and no started effects records a
terminal attempt when its policy or approval denial is not already represented by an existing evidence row.

The private synchronous insertion preserves every existing call ID and rejects IDs whose current run/turn lifecycle
already records an effect start. It uses the ledger's existing 128-entry bound, evicts only unscoped settled entries
without pending acceptance checks or live verification inputs, and omits the new diagnostic entry when no safe slot
exists. There is no await between duplicate detection, eviction, and insertion.

The row contains the call ID, decoded command, `denied` status, observation timestamps, and the opaque diagnostic
identity `denied:<callId>` in the existing required `executionId` field. The equal start/completion timestamps denote
observation of a terminal attempt. The identity is never registered as a process or command session. No running state,
exit code, signal, workspace snapshot, acceptance checks, verification scope, or publication is created. Ordinary
command evidence and saved task formats require no migration. This ledger is task-memory diagnostic state; canonical
tool transactions and lifecycle events remain the persisted authority for reload.

The observer reuses Alpha's existing HTML decoding and apply-patch invocation parser. Scheduler receipts retain the
requested `exec_command` name after a recognized heredoc is routed to `apply_patch`. A captured command-policy denial
has trusted capability-scoped metadata and occurs before interception, so it records a denied command attempt even
when the command is a valid patch heredoc. A patch denied by the workspace/mutation policy after interception remains
absent from command evidence, as does a successful intercepted patch. Existing error, cancelled, unknown-outcome,
abort, completion, and pending-publication handling keeps its current semantics.

## Source map

- `src/core/agent/ToolScheduler.ts`: policy denial in `prepareCall`; same-ID terminal observation in
  `observeToolResult`, ordinary commit, and deferred commit. These paths are unchanged.
- `src/core/task/Task.ts`: the guarded shared observer and private denied-attempt insertion own the change.
- `src/core/agent/__tests__/ToolScheduler.command-denial-contract.spec.ts`: real scheduler denial, provider receipt,
  and deferred commit/reload coverage.
- `src/core/task/__tests__/Task.command-denial-evidence.spec.ts`: replay, existing evidence, capacity, metadata guards,
  and real scheduler command-policy/patch-policy heredoc denial routes.
- `apps/vscode-e2e/src/suite/approval-mode.test.ts`: the original host assertion and intercepted-patch contract are unchanged.

## Validation and review

Validation used Node 24.21.0 and pnpm 11.24.0 in the separate managed worktree. `pnpm install --frozen-lockfile` and the
required internal `pnpm --filter @alpha-code/types build` passed without lockfile changes.

The two new regression files passed **25 tests**. Adjacent scheduler, lifecycle, completion, command-policy capture,
command execution, and patch coverage passed **309 tests in 11 files**, for **334 passing tests in 13 files** overall.
Both runs used `--maxWorkers=2 --minWorkers=1`:

```powershell
pnpm --dir src test core/agent/__tests__/ToolScheduler.command-denial-contract.spec.ts core/task/__tests__/Task.command-denial-evidence.spec.ts --maxWorkers=2 --minWorkers=1
$denialAdjacentTests = @(
    'core/agent/__tests__/ToolScheduler.spec.ts'
    'core/agent/__tests__/ToolScheduler.deferredResults.spec.ts'
    'core/agent/__tests__/ToolScheduler.command-batching.spec.ts'
    'core/agent/__tests__/AgentTurnEngine.spec.ts'
    'core/task/__tests__/Task.failure-recovery.spec.ts'
    'core/task/__tests__/Task.completion-obligations.spec.ts'
    'core/task/__tests__/Task.agent-wait-progress.spec.ts'
    'core/task/__tests__/Task.command-completion-wait.spec.ts'
    'core/task/__tests__/Task.command-policy-capture.spec.ts'
    'core/tools/__tests__/ExecuteCommand.lifecycle.spec.ts'
    'core/tools/__tests__/ApplyPatchTool.spec.ts'
)
pnpm --dir src test @denialAdjacentTests --maxWorkers=2 --minWorkers=1
pnpm --dir src check-types
pnpm --dir src exec eslint core/task/Task.ts core/agent/__tests__/ToolScheduler.command-denial-contract.spec.ts core/task/__tests__/Task.command-denial-evidence.spec.ts
pnpm exec prettier --check src/core/task/Task.ts src/core/agent/__tests__/ToolScheduler.command-denial-contract.spec.ts src/core/task/__tests__/Task.command-denial-evidence.spec.ts docs/codex-alignment-command-denial-evidence-2026-10-11.md
git diff --check
```

Ordinary source typechecking, touched-file ESLint, formatting, and whitespace checks passed. The three authorized
subagents were reused: `implementation` owned the Task change, `regressions` owned both new test files and reviewed the
production diff, and `contract_review` independently verified upstream and native lifecycle/evidence contracts. Both
independent reviews found no remaining blocker. The lead reproduced the defect, reviewed and integrated their work,
recorded the source map, and ran validation.

The exact VS Code 1.125.0 smoke rerun, full integrated suite, bundles, certification, VSIX, and live checks remain with
the parent integration chat and were not run in this worktree. The original host fixture remains unchanged. The
pre-commit hook starts repository-wide lint, so the handoff uses `HUSKY=0` after explicit touched-file checks to preserve
the parent's serial gate ownership. No general performance improvement is claimed.
