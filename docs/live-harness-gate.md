# On-demand live extension gate

Latest validation (2026-09-07): **1.136.1 passed 10/10 live workflows and the complete gate, exit 0**. The default two-host
gate is **not yet certified**: its live 1.122.1 run encountered an exception in bundled Copilot. Exact 1.122.1 deterministic
contracts pass. See the evidence and limitations below; single-host success must not be presented as two-host acceptance.

Run from the Alpha repository root with Node 20.19.2 and pnpm 10.8.1:

```powershell
pnpm test:live:gate --model-id gpt-5.6-luna --effort high --root F:/alpha-vscode-e2e-runs/live-gate --profile-dir F:/alpha-vscode-e2e-runs/20260906/profiles --init-root
```

Those absolute directories are examples matching this machine's existing authenticated test profiles. On another machine,
choose a dedicated campaign directory and prepare persistent Copilot profiles as described in
[profile setup](vscode-live-test-profiles.md). Keep `--profile-dir` unchanged on subsequent runs; the runner does not reset
sign-in or borrow normal VS Code credentials. `--init-root` only initializes empty or already marked campaign roots.
Each invocation generates a fresh campaign ID and disposable local repositories. Do not use your source repository or a
normal VS Code storage directory for either root. No GitHub.com repositories, pushes, or remote migrations are involved.

Add `--dry-run` to inspect the matrix and budgets without launching a host or spending model requests. Its output is
`planned`, never a gate pass. The package script still compiles the TypeScript runner. Run only one gate at a time for
this checkout and profile root. Finish active F5 tasks before starting: preparation rebuilds shared development outputs.
Do not edit, compile, or rebuild the extension/test runner during a gate; a changed artifact fingerprint fails acceptance.

## What the gate requires

The command extends the existing campaign runner; it does not create another agent or workflow engine.

1. Harness unit tests pass.
2. A fresh extension/webview build and the exact `test:smoke:1221` contract gate pass before paid requests.
3. Every registered workflow executes against live Copilot with the exact requested model and reasoning effort.
4. The existing workflow grader checks independent repository effects, persisted tool transactions and lifecycle outcomes.
   Deliberate cancellation/baseline failures follow each scenario's explicit contract, not a global ban on every error.
5. Each required host/scenario/sample cell has an actual live request, retained task/evidence identity, and a passing outcome.
6. Host cleanup and evidence retention finish. The built entrypoint, webview, and compiled runner fingerprint is unchanged.

The default matrix includes **both 1.122.1 and 1.136.1**, reference host first, one sample per workflow. Its current ten
workflows cover review/edit/test/commit/follow-up, cancellation/resume, a six-turn dependent thread, host restart and
continuation, repository bootstrap, Git inspection, refactoring, selective commits, merge conflicts, and idempotent JSON
migration. New entries in `WORKFLOW_SCENARIO_IDS` automatically enter the development gate.

For the current-host-only gate validated on this machine, use:

```powershell
pnpm test:live:gate --model-id gpt-5.6-luna --effort high --root F:/alpha-vscode-e2e-runs/live-gate --profile-dir F:/alpha-vscode-e2e-runs/20260906/profiles --init-root --vscode-version 1.136.1 --vscode-executable "C:/Users/Luke Goblirsch/AppData/Local/Programs/Microsoft VS Code/Code.exe"
```

That result is labelled `single-host-only`; it does **not** certify the full two-host matrix. The exact 1.122.1 deterministic
gate still runs during preparation. An unavailable reference-host live provider blocks full acceptance, even when newer
hosts work. Authentication, quota, time limits and missing evidence are not skips or passes.

## Result and failure workflow

The command prints progress when an attempt is durably recorded, then prints the `gate-result.json` path. Under the
campaign directory:

- `prepare-*.json`: bounded preparation output and exit status.
- `gate-plan.json`: requested matrix, budgets and built-artifact digest.
- `report-*.json`: immutable campaign checkpoints with attempts, failure fingerprints, usage and evidence references.
- `gate-result.json`: final per-cell `passed`, `failed` or `not-run` verdict, host scope and artifact stability.
- Per-attempt evidence indexes point to retained host receipts, workflow checks and canonical trace projections.

New campaign evidence stays under its own `host-evidence/` directory. Campaign runs do not automatically prune prior
evidence. The campaign audits its root and the persistent profile before launches and again before final acceptance;
over-budget or unreadable storage blocks the gate. This is independent of the standalone runner's 20-run retention target.

Exit **0** requires a clean gate. Exit **1** means acceptance failed; exit **2** means preparation, infrastructure,
authentication, cancellation, budgets, or another stop prevented completion. Setup/report errors also return nonzero;
if no final receipt exists, there is no valid pass. The command never converts a later passing reproduction into a clean
gate: original failures remain failures. Missing cells cannot be hidden by aggregate counters. Gate runs take exactly one
sample per required cell and continue after ordinary workflow failures without automatic reproduction. Infrastructure,
authentication, evidence and budget blockers still stop further launches. Diagnostic campaigns retain their existing
reproduction policy; reviewed source repairs still require a reproduced failure.

After a failure, inspect the named workflow check, trace receipts and independent file/Git state. Classify extension,
test-harness, model, authentication or upstream-host causes before editing. Add a focused regression for a confirmed code
defect, fix the owning layer, run targeted validation, then invoke a **new** gate. Do not erase old evidence or relax the
oracle to turn a model mistake into success. The gate reports failures; it does not automatically patch production code.

## Adding a workflow

Prefer a variation in the existing fixture/driver rather than a parallel test implementation:

1. Add a stable ID to `DEVELOPMENT_SCENARIO_IDS` in `apps/vscode-e2e/src/scenarios/developmentCatalog.ts`. Define its task
   phases, precise local command authority, and required fresh command receipts. Keep prompts separate from graders.
2. Implement owned baseline creation and independent verification in `developmentFixture.ts`. Verify externally observable
   behavior, expected Git/data changes and preservation of unrelated state. Support valid alternative implementations.
3. Supply an offline `developmentScript` for deterministic harness validation. It must call Alpha's tools rather than
   directly perform the model's task through the fixture controller.
4. Add positive and negative tests: no-op, missing command, wrong effects, weakened tests, stale receipt, unexpected error,
   and data loss must fail. Update phase/fixture mappings exhaustively. The suite's catalog-coverage unit test guards
   against leaving a registered workflow out of the development gate.
5. Run owning-package lint, typecheck and unit tests, then the new scripted host scenario on both exact hosts.
6. Run live, inspect its trace and outcome, then rerun the complete gate. Record the actual host/model/effort and sample
   count. Unknown/new scenario IDs fail configuration; an arbitrary JSON prompt is not an executable test oracle.

Use the existing `test:campaign --config ...` path for focused reproduction or multi-sample soak. Custom subsets are
diagnostics, not the full gate. See [suite contracts](live-development-suite.md) and [campaign budgets](vscode-test-campaigns.md).

## Live validation: 2026-09-07

These command-level runs used the existing authenticated profiles, Copilot `gpt-5.6-luna`, effort `high`, and the normal
Windows Machine + User PATH. Evidence is retained under `F:/alpha-vscode-e2e-runs/20260907/gate-campaigns/`; each named
campaign contains its preparation receipts, final gate result, immutable reports, and per-attempt evidence indexes.

- `full-live-gate-20260907-01`: exact-host preparation passed; live 1.122.1 stopped with an uncaught exception inside
  bundled Copilot 0.50.1 (`copilot/dist/extension.js:1167`). Preflight selected the requested model and effort, but no
  workflow result was produced. The gate exited **2**, preserved the blocked attempt, and marked the other 19 cells
  not-run. Guarded request usage was unavailable, not zero. This is not full-matrix acceptance.
- `current-live-gate-20260907-01`: all ten scenarios were attempted on 1.136.1. Eight passed; cancellation and bootstrap
  each failed twice with the same respective failure. The completed campaign used 125 guarded requests and exited **1**.
  Its counts are eight passed attempts and four failed attempts, not twelve distinct workflows. Artifact fingerprints
  stayed unchanged and retention completed.
- `current-live-gate-20260907-02`: after the prompt corrections, eight workflows passed their assertions, including
  cancellation and bootstrap. The eighth attempt's retention failed, so the gate recorded seven passed cells, one blocked
  attempt and two not-run cells, used 90 requests, and exited **2**. A passed workflow cannot override failed retention.

Trace inspection found two test-instruction gaps, not evidence requiring an Alpha execution-kernel change:

1. The cancellation prompt said to wait for approval. Luna used `ask_followup_question` to ask conversational permission,
   never reaching the command-tool approval boundary the test needs. The prompt now explicitly requests submission through
   `execute_command`; the existing grader still rejects conversational approval and never approves the pending command.
2. Bootstrap required internal controller files to remain Git-ignored, but its prompt did not disclose that requirement.
   Luna created a conventional `node_modules/` ignore file and failed the independent protection check. The prompt now states
   the controller-file ignore requirements. The semantic Git oracle and its negative un-ignore test are unchanged.

The clean-worktree bootstrap/refactor phases also now permit a scoped read-only `git status` command. This closes a missing
inspection capability; it does not establish a cause for earlier duplicate-commit model behavior. No broad staging, reset,
remote authority, fixture auto-repair, or silent command deduplication was added.

Three focused prompt/capability contract regressions failed before the correction and passed afterward. The focused
28-test batch, harness lint and harness typecheck passed. Original failed evidence remains immutable; a correction must
earn a new gate result rather than relabel the earlier run.

The second campaign exposed an additional ownership defect: each held host invoked standalone pruning against the shared
campaign evidence root. That cleanup deleted some older passing snapshots and partially removed two others before Windows
returned access-denied errors on their `live-host-started.json` files. Original failed evidence and raw repositories/task
histories remain; deleted passing snapshots have not been restored. The old root still contains unreadable pruning
quarantines and has not been force-repaired. Its historical reports must not be treated as proof that every old artifact
is still available.

The correction keeps new evidence beside its campaign, makes child receipts explicitly campaign-owned, and moves quota
acceptance to the existing aggregate storage audit without automatic campaign deletion. The full matrix needs 22 host
launches (reload has two phases), so a standalone 20-run target was also incompatible with complete coverage. Three
retention regressions failed before this correction and passed afterward; the 35-test runner/adapter/retention batch, lint
and typecheck passed. Standalone pruning behavior is unchanged. See [retention ownership](vscode-test-campaigns.md#retained-storage-and-evidence-retention).

The next campaign, `current-live-gate-20260907-03`, used the new root `F:/alpha-vscode-e2e-runs/live-gate/` and retained all
its evidence successfully. It made 115 requests, recorded five passing and four failing attempts, and stopped as
`unreproduced` before the final five scenarios. No model failure was relabelled as passing. Trace review found:

- Two long-thread attempts documented the correct example using Markdown backticks and “equals” or “returns”; the grader
  required a literal equals sign. The documentation check now accepts these equivalent forms and rejects wrong operands,
  negation and wrong numeric results, including values that merely begin with `-1`. Independent behavior tests remain.
- Bootstrap combined individually permitted commands with `&&`. The exact command boundary correctly rejected the batch;
  all development prompts now explicitly require separate command calls and forbid shell operators.
- A later bootstrap created a valid private package but omitted the undisclosed `scripts.test` requirement. The prompt now
  requests that entrypoint explicitly; the grader has not been weakened.

These three checks and a final-storage-audit regression failed before their fixes. The latter covers the separate offline
storage-recovery campaign: its parent must audit storage after the healthy launch too, because a held child receipt does
not certify final aggregate quota compliance. Gate sampling now covers remaining cells instead of invoking the diagnostic
campaign's reproduction loop. Ordinary failures remain failures; source repair cannot opt out of reproduction.

`current-live-gate-20260907-04` completed all ten live workflows on 1.136.1 with no workflow failures (127 requests,
02:43:04–02:57:38 UTC), but the final aggregate scan exceeded its ten-second deadline. The command correctly exited **2**
instead of accepting ten passing cells with blocked retention. Its artifact fingerprint stayed unchanged. All 11 host
evidence directories were captured; nothing was pruned. Two subsequent read-only scans completed, one measured at
9,234 ms for 9,244 entries / 519,697,096 bytes. The original failed gate receipt is not rewritten.

The scanner now allows 30 seconds and distinguishes `timeout` from `unreadable`; this is bounded I/O headroom, not a speed
improvement. Ownership, changing-file detection, symlink rejection and byte/entry/depth limits are unchanged. A simulated
20-second successful scan and explicit timeout classification both failed before the correction; permission failures must
still report unreadable data. This addresses retained-profile workloads rather than exempting a particular scenario.

### Final current-host validation

`F:/alpha-vscode-e2e-runs/live-gate/current-live-gate-20260907-05/gate-result.json` records **passed**, scope
`single-host-only`, and exit **0**. All ten workflows passed on 1.136.1 / live Copilot Luna / high, with 128 guarded requests
from 03:05:09–03:19:52 UTC, plus preparation and final audit time. The 11 physical host launches produced complete trace
projections and 575 passing check rows. The final audit counted 539,561,507 bytes / 10,531 entries across both owned roots;
retention completed without pruning. Runtime fingerprint `8870396af23e0b18b04b549da0989d7492d16d844967b2bebaa0553f54f06a4e`
was unchanged throughout the run.

The command's prerequisites passed: **330 harness unit tests**, two platform-specific skips, and **eight exact 1.122.1
smoke contracts**. Owning-package lint/typecheck and scoped formatting passed separately. Earlier failed gate receipts are
unchanged. This is one successful complete live-gate sample, not a statistical guarantee for all model runs. The separate
1.122.1 live-provider blocker remains unresolved; no provider substitution or patched vendor bundle was used.

## Coverage boundaries

This is an on-demand acceptance gate for the **registered extension scenarios**, not proof that an arbitrary agent task can
never fail. It does not install CI/branch protection or replace the repository's lint, typecheck and broader unit gates.
Live-model results are variable and complement deterministic contract tests. The suite exercises the real extension
host and webview message path, but not rendered DOM/focus behavior, every normal-profile setting, crash-during-write lock
creation, every language or every possible long thread. Keep separate UI, storage/concurrency and provider contract gates.
These runs inherit the launching process environment. Run from a normal development terminal; when launching through
Codex on Windows, use the Machine + User PATH as in the incident validation so tool-injected PATH cannot mask host setup.
Artifact fingerprints bind tested output bytes, not all source files or a security attestation of external dependencies.
