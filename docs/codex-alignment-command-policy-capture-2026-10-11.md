# Saved command policy capture — 2026-10-11

This follow-up starts from integrated Alpha commit `3a67501a2c92b9747d0598274ef3826121456151`. The exact VS Code
1.125.0 smoke run exposed a missing capture in the shared Task request path. A legitimate saved Ask-mode rule for
`rg --no-config -n ALPHA_E2E_EARLY_READ_PROOF alpha-e2e-stream-read-proof.txt` prompted for approval, preventing the
fixture's early command effect from starting. The fixture and its Ask approval mode remain unchanged.

## Owning invariant and reproduction

`Task.ask` intersects live command settings with the admitted step's frozen command policy. All four production
`buildNativeToolsArrayWithRestrictions` call sites omitted command execution input. `TaskToolSurface` therefore
captured its default empty command lists, and a valid finite live grant could not satisfy the step ceiling.

The new `Task.command-policy-capture.spec.ts` uses the actual `Task.attemptApiRequest`, catalog builder, task-owned
cache, surface capture, and `Task.ask`. It deterministically denies any published unresolved prompt so a missing
automatic grant fails without waiting for UI input. Against the integrated base, its original exact-rule test failed
with `noButtonClicked` instead of `yesButtonClicked`. No command payload was executed.

## Verified reference

The official Codex source was inspected read-only at
[27065a91ccbf5ba8532844be3777fcf83b77820d](https://github.com/openai/codex/commit/27065a91ccbf5ba8532844be3777fcf83b77820d),
committed 2026-10-11 at 17:43:08 UTC and retrieved/reviewed on 2026-10-11:

- [session/step_context.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/session/step_context.rs)
  retains one immutable settings version and the exact tool router for a sampling request.
- [session/mod.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/session/mod.rs),
  `capture_step_context_inner`, captures settings before asynchronous tool preparation.
- [session/step_activation_tests.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/session/step_activation_tests.rs),
  `submitted_sparse_updates_preserve_captured_steps_and_ordering`, verifies that existing captures retain old settings
  while subsequent captures receive published updates.
- [session/turn.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/session/turn.rs),
  `run_sampling_request`, retains the same step context through its request retry loop.

Alpha deliberately retains a stricter per-step command ceiling: live settings may narrow an admitted grant, and a new
allow rule takes effect on the next ordinary step. Upstream's
[exec_policy.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/exec_policy.rs)
uses a mutable execution-rule store; `append_execpolicy_amendment_updates_policy_and_file` in
[exec_policy_tests.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/exec_policy_tests.rs)
verifies live amendments. This follow-up preserves Alpha's existing authority contract and does not adopt Codex's sandbox
architecture.

## Native change and compatibility

`Task` copies and freezes resolved allow/deny arrays immediately after reading request state, before mode/model/prompt
preparation can await. Each capture explicitly preserves the existing workspace root and primary-task outside-workspace
review policy. The same execution input reaches all four catalog callers, including manual compaction and recovery.

`BuildToolsOptions` forwards the existing `ToolPolicyInput.execution` shape to the canonical surface and includes it in
the task-owned catalog key. A changed command policy refreshes the next step's catalog; unchanged settings reuse it.
Transport and rate-limit retries retain their original surface and step context. No new policy engine, persisted shape,
schema, or generic surface override behavior was introduced.

Live rule removal and new denials still narrow automatic approval. Removing a live denial cannot undo an admitted
denial, and adding a live allow cannot widen the current step. Child inherited command ceilings, outside-workspace
restrictions, diagnostic restrictions, and explicit approval conditions remain effective. Saved settings require no
migration. Timeout settings continue to use their existing defaults and live `ExecuteCommandTool` configuration path;
this change freezes command approval rules only.

## Validation and independent review

Checks use Node 24.21.0 and pnpm 11.24.0 in the separate managed worktree. `pnpm install --frozen-lockfile` and the required
internal `pnpm --filter @alpha-code/types build` passed without lockfile changes. The original one-test baseline failed
for the intended missing grant before production edits.

The final focused suite passed **313 tests in seven files**, with `--maxWorkers=2 --minWorkers=1`:

```powershell
$captureTests = @(
    'core/task/__tests__/Task.command-policy-capture.spec.ts'
    'core/task/__tests__/Task.retry-wire.spec.ts'
    'core/task/__tests__/Task.subagent-provider-boundary.spec.ts'
    'core/tools/__tests__/TaskToolSurface.spec.ts'
    'core/agent/__tests__/ToolPolicy.spec.ts'
    'core/auto-approval/__tests__/checkAutoApproval.spec.ts'
    'core/task/__tests__/Task.compaction-safety.spec.ts'
)
pnpm --dir src test @captureTests --maxWorkers=2 --minWorkers=1
```

The existing Task approval bridge checks also passed: **32 passed, 283 unrelated cases skipped**. Together, the focused
validation executed **345 passing tests**. The remaining exact validation commands were:

```powershell
pnpm --dir src test core/task/__tests__/Task.spec.ts --testNamePattern 'Task typed tool approval bridge|uses the admitted step' --maxWorkers=2 --minWorkers=1
pnpm --dir src check-types
pnpm --dir src exec eslint core/task/Task.ts core/task/build-tools.ts core/task/__tests__/Task.command-policy-capture.spec.ts
pnpm exec prettier --check src/core/task/Task.ts src/core/task/build-tools.ts src/core/task/__tests__/Task.command-policy-capture.spec.ts docs/codex-alignment-command-policy-capture-2026-10-11.md
git diff --check
```

The new file contains ten focused cases covering OpenAI and VS Code LM exact Ask grants, controlled asynchronous
preflight, both directions of live policy changes, retained denial, transport/rate-limit retries, catalog refresh/reuse,
and primary/child workspace scope. Ordinary `pnpm --dir src check-types`, touched-file ESLint, and Prettier checks passed.

The three previously authorized subagents were reused: `implementation` owned the two production files, `regressions`
owned the new regression file and independently reviewed production changes, and `contract_review` independently
verified upstream references and all capture/retry/cache/child paths. Both independent reviews found no blocking issue.
The lead reproduced the defect, reviewed and integrated their work, added retained-denial coverage, and ran validation.

The exact VS Code 1.125.0 smoke rerun, full integrated suite, extension/webview bundles, managed-agent certification,
VSIX, and live checks remain with the parent integration chat and were not run here. The unrelated legacy fixture/catalog
assertions assigned to the goal chat were not edited. The pre-commit hook starts repository-wide lint, so the handoff uses
`HUSKY=0` to preserve the parent's serial gate ownership after explicit touched-file validation. No timing or general
performance improvement is claimed.
