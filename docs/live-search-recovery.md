# Focused live search and unverified handoff acceptance

These scenarios extend the existing development suite and launch the actual Alpha extension with live Copilot in a
dedicated VS Code development host. The model chooses its calls and reports; scripted runs are harness validation only.
Neither scenario runs the complete live matrix.

## Repository and assertions

The harness creates an owned, disposable local Git repository containing a dependency-free cart implementation, three
passing Node tests, package metadata, configuration, documentation, and an integration verifier. Copilot references exist
in `config/assistants.json` and `docs/integrations.md`, but not in `lib`. `AlphaMissingProvider947` is absent everywhere.
The integration verifier exits 2 because the intentionally unprovided local integration configuration is required.
Running the unit tests independently proves the app works; it does not satisfy the requested integration verification.

| Scenario                       | Task                                                                                                                               | Required evidence                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev-search-recovery`          | Start with terminal rg in lib, search lib and the full tracked repository, then search for an absent term in a same-task follow-up | Actual empty-scope and broad-search receipts, both matching files in the report, an honest absent-term report, complete tool transactions and completed turns |
| `dev-verification-unavailable` | Attempt required integration verification with missing prerequisites and report a blocked handoff                                  | Real exit-2 receipt, one accepted blocked handoff, ordinary visible report, interrupted rather than completed/failed lifecycle, task still resumable          |

Both check HEAD, index, all tracked and untracked bytes, fixture ownership, and actual cart behavior independently of
assistant claims. Recovery phases allow only their designated failure commands and expected exit codes; they do not
convert error receipts to success. The grader caps phase tool calls at 14 and identical command receipts at two, in
addition to the runner's request/time budgets. Command approval remains exact and scoped to the current phase/workspace.
Blocked inspection reads the durable turn after the resume boundary instead of waiting for the still-live task loop to
terminate. Normal completed-work scenarios keep their original strict completion/error checks.

## Focused demo commands

Build using `pnpm bundle`, `pnpm --filter @alpha-code/vscode-webview build`, and `pnpm --dir apps/vscode-e2e compile`.
Use an already authenticated dedicated profile from [live profile setup](vscode-live-test-profiles.md). Supply a fresh
workspace and run ID for each run. The runner creates the repository; no preliminary model bootstrap is necessary.

```powershell
node apps/vscode-e2e/out/runTest.js --provider live-copilot --vscode-version 1.136.1 --profile-dir F:/alpha-vscode-e2e-runs/20260906/profiles --workspace F:/alpha-recovery-demo/search-01 --artifacts-dir F:/alpha-recovery-demo/artifacts --init-profile --model-id gpt-5.6-luna --reasoning-effort high --scenario-id dev-search-recovery --scenario-phase run --request-limit 24 --run-id search-demo-01

node apps/vscode-e2e/out/runTest.js --provider live-copilot --vscode-version 1.136.1 --profile-dir F:/alpha-vscode-e2e-runs/20260906/profiles --workspace F:/alpha-recovery-demo/unverified-01 --artifacts-dir F:/alpha-recovery-demo/artifacts --init-profile --model-id gpt-5.6-luna --reasoning-effort high --scenario-id dev-verification-unavailable --scenario-phase run --request-limit 16 --run-id unverified-demo-01
```

Use the exact model ID available in that profile; the runner does not substitute providers or effort. Add
`--vscode-executable '<absolute Code.exe path>'` when using an installed matching host. Run from a normal terminal to test
ordinary PATH availability; Codex's injected rg can conceal a missing command. VS Code 1.122.1 remains the separate
required smoke gate, with its scripted LM fixture; a live 1.136.1 pass is not exact-host live acceptance.

## Investigation on 2026-09-08 UTC

Retained evidence root: `F:/alpha-vscode-e2e-runs/20260908/artifacts/`. Live runs used the signed-in dedicated 1.136.1
profile, exact Copilot `gpt-5.6-luna`, high effort, and process-local Machine + User PATH. No credentials or normal user
profile were copied or reset.

- `live-search-recovery-01`: 9 requests. Terminal rg was unavailable (`'rg' is not recognized`); Git grep returned exit 1
  for the empty lib scope, then exit 0 with the expected references. The absent-term follow-up also finished without
  repetition. The new grader incorrectly rejected the valid sentence “No tracked repository files contain…”. A failing
  regression captured that wording before the matcher was corrected. The failed run remains retained.
- `live-verification-unavailable-01`: 3 requests. Copilot accurately reported missing configuration and unverified
  integration, but offered a completed review. The strict grader rejected that completion boundary. The scenario now
  explicitly requires an incomplete blocked handoff when its required verification cannot run; this prompt clarification
  is distinct from a production behavior fix.

The current live samples did **not** reproduce the user's runaway tool loop. Deterministic Task regressions did reproduce
an independent presentation defect: the no-progress limit and blocked-operation retry limit used error suspension even
though the existing primary blocked-handoff path supports an ordinary report. Those two stopping branches now use that
path. They still stop further automatic requests and preserve incomplete status, retry restrictions, unknown outcomes,
and outstanding verification. Persistence failure and other genuine runtime failures retain error handling. No tool
results are relabeled, retry allowances increased, or completion gates bypassed.

Final live reruns on that same host/profile/model/effort:

| Run                                | Requests | Tool calls | Checks | Result                                                                                                            |
| ---------------------------------- | -------: | ---------: | -----: | ----------------------------------------------------------------------------------------------------------------- |
| `live-search-recovery-02`          |        8 |          6 |     88 | Passed: recovered from unavailable rg, found references, reported absence, preserved repository                   |
| `live-verification-unavailable-02` |        4 |          9 |     57 | Passed: actual prerequisite failure, accepted blocked handoff, ordinary visible report, incomplete/resumable task |

Both runs recorded the exact host/model/effort, numeric host exit, verified ownership, and complete evidence capture.
The whole live matrix was not run. These are bounded acceptance samples, not a reliability or speed benchmark.

## Validation

- Focused E2E harness, recovery oracle, fixture, driver, prompt/contract, and campaign-consumer unit tests: **66 passed**.
- Task, exploration, and failure-recovery Vitest files: **175 passed**. The new expectations failed before changing the
  two automatic stopping branches. A receipt-persistence failure still produces an error, and no extra request or
  successful-completion row is emitted at the blocked boundary.
- Extension and E2E package lint/typecheck passed.
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` passed: activation/commands (3), modes (2), scripted VS Code LM
  contracts (4), including provider-error recovery. This also built the extension and webview. The smoke inherited the
  development PATH; the separate live recovery runs used normal Windows PATH.
- One initial full Task-file run hit its existing one-second retry-announcement timing assertion while other builds
  were active. That assertion passed in isolation, and all 175 tests passed on the final full focused rerun unchanged.
- Final diff/whitespace checks passed. Pre-existing uncommitted work was preserved; the protected CLI/shim trees were
  not changed. Checkout HEAD for this investigation: `90bb4ea24cfc3848e4c245bebdbbea2aa20f80fd`, plus working-tree changes.
