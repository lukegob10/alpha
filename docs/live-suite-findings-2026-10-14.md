# Live suite findings — 2026-10-14

> Historical baseline note: this report retains the original 43 failures. The [repair and final validation report](live-suite-repair-2026-10-14.md) records subsequent fixes, the complete rerun and the fresh eight-test acceptance batch. Its browser section also corrects the original Count1 interpretation: text inside onclick source did not prove a successful click.

Status: **Live matrix finished; acceptance failed and workflow coverage remains blocked**. All 34 active selections
were attempted on exact VS Code 1.125.0: 22 workflow scenarios and 12 standalone suites. Their runner receipts record
50 tests, 7 passing and 43 failing, with zero pending tests. Of the failures, 23 are uncaught errors originating in the
bundled Copilot extension, rather than completed workflow assertions. The remaining 20 failures include test-oracle,
fixture-policy, provider-configuration, and unresolved session/browser findings detailed below.

Closing VS Code released the Windows update lock. The Alpha-Code workspace reopened successfully and the deterministic
exact-host gate subsequently passed all 42 tests across 13 suites. These passing checks do not make the live suite green.

## Run identity

| Field                          | Value                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| Repository commit              | `e628bf82ba2ca3ec29c6a2ac226d5d6327306e87`                                                       |
| Initial working tree           | Clean                                                                                            |
| Extension version              | `3.1.12`                                                                                         |
| Run start                      | 2026-10-14 19:38:38 America/New_York / 23:38:38 UTC                                              |
| Live matrix interval           | 2026-10-14 20:13:24–20:44:30 America/New_York; 31 minutes 6 seconds                              |
| Node / pnpm                    | `24.21.0` / `11.24.0`                                                                            |
| Required VS Code host          | `1.125.0`                                                                                        |
| Downloaded host product commit | `93cfdd489c3b228840d0f86ec77c3636277c93ea`                                                       |
| Actual extension-host version  | `1.125.0` in all 34 live launches and 13 exact-host suites                                       |
| Saved live provider selection  | Copilot `gpt-6-luna`, reasoning effort `max`                                                     |
| Actual live model / effort     | All 34 readiness probes completed for `gpt-6-luna` / `max`; legacy task attribution caveat below |
| Reusable owned profile         | `F:/alpha-e2e/profiles/1.125.0`                                                                  |
| New evidence directory         | `F:/alpha-e2e/full-live-20261014-01c26a9d`                                                       |

Each live launch completed one native Copilot readiness request, recorded separately from solving requests. The guarded
standalone receipts also record their task model and effort. The five legacy task/Markdown cases discard provider
configuration, so their successful Copilot preflight does not establish which provider their tasks used. Workflow solving
usage is unknown where the Copilot crash interrupted evidence. No total solving-request, token-cost, or quality estimate
is inferred from the readiness probes. The normal user profile was not used for tests. No application or provider source
was changed.

## Results

| Check                                                                            | Observed result                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| E2E runner unit tests, via development gate prerequisite                         | PASS: 592 passed, 2 platform-specific skips, 0 failures; 84.375 seconds                     |
| Extension bundle                                                                 | PASS: 4 successful Turborepo tasks restored from cache                                      |
| Production webview build                                                         | PASS: Vite completed in 52.25 seconds; large-chunk warning                                  |
| `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`                           | BLOCKED: first host exited 1 before executing tests                                         |
| Development live gate                                                            | BLOCKED: `preparation_failed`, process exit 2                                               |
| Exact-host gate retry after closing VS Code                                      | PASS: 13 suites, 42 tests, zero failures or pending tests; exit 0                           |
| `pnpm test:core:regressions`                                                     | PASS: 429 extension tests in 12 files, then 19 worktree tests in 2 files                    |
| `pnpm check-types`                                                               | PASS: all 9 tasks restored from cache                                                       |
| Direct `pnpm --dir src check-types`, runner `check-types`, webview `check-types` | PASS: all three freshly executed, exit 0                                                    |
| `pnpm certify:managed-agents`                                                    | PASS-DETERMINISTIC: 3,557 test executions, 26 passing rows; 8 live integration rows pending |
| Live workflow scenarios                                                          | BLOCKED: all 22 attempted; each host records one uncaught Copilot error                     |
| Standalone live suites                                                           | FAILED: all 12 attempted; 28 tests, 7 passing, 21 failing, zero pending                     |

These are individual command results. Some lower-level checks overlap certification coverage; counts must not be added
into a distinct-test total. No latency or model-quality improvement is claimed.

Certification completed at 19:47:59 America/New_York in 226.359 seconds, against an unchanged clean source tree.
Its receipt explicitly records `liveAcceptance: NOT_RUN`. The new receipt is retained as
`managed-certification-evidence.json` in the new evidence directory. The pre-existing repository certification receipt
was backed up before replacement, then restored byte-for-byte; historical evidence was preserved.

The two runner skips are POSIX process-group termination fixtures that are inapplicable on Windows. The certification
tracks recorded these passing execution counts:

| Track                      | Passing executions |
| -------------------------- | -----------------: |
| Types contracts            |                120 |
| Worker worktree            |                 40 |
| Runtime invariants         |              1,289 |
| Lifecycle routing          |                809 |
| Terminal/process cleanup   |                 57 |
| Task-history compatibility |                 29 |
| Worker completion gate     |                207 |
| Provider protocol          |                492 |
| Task-tree UI               |                405 |
| Settings buffering         |                109 |

`core-regressions.log`, `check-types.log`, `extension-typecheck.log`, `runner-typecheck.log`,
`webview-typecheck.log`, and `managed-certification.log` retain their respective command output. Expected React errors
from the negative context-provider fixture appeared during the UI track; its structured result still recorded all
405 tests passing, so those expected errors are not a new test failure.

## Findings

### 1. Windows VS Code updater prevents every new reference-host launch

The first scripted exact-host run (`da28de72-ecbc-47f1-a06f-c0cc19b649f1`) logged `vscode-updating` at
23:42:09 UTC, waited 30.944 seconds, and exited 1 at 23:42:40 UTC. The error was:

```text
Code is currently being updated. Please wait for the update to complete before launching.
```

The runner retained a non-passing `host-preflight-missing` receipt, `hostExitObserved: true`, and
`captureComplete: true`. No test counts, actual extension-host version, or ownership-gate success was available.
Evidence capture succeeding does not mean a test executed.

Read-only process inspection found two matching VS Code setup processes, PIDs `64304` and `11584`, created at
10:32:50 America/New_York. A separate read-only `OpenExisting('vscode-updating')` check still found the named mutex at
19:45:06. This correlates the startup failure with an ongoing update; it does not independently identify the handle owner
or prove why setup has remained active.

The behavior matches the official
[VS Code 1.125.0 startup implementation](https://github.com/microsoft/vscode/blob/1.125.0/src/vs/code/electron-main/main.ts#L480),
retrieved 2026-10-14: versioned Windows builds wait for the update mutex before refusing startup. Alpha's launcher already
supplies `--disable-updates`; that option does not skip this startup check. Resolving the normal editor's update/restart
was necessary to unblock launch. No setup process was terminated, no downloaded host was patched, and no other VS Code version
was substituted.

The initial run paused for the user to resolve the update. At 20:06:42 America/New_York, a normal window-close request
was sent. The user then explicitly authorized force-closing the remaining sessions. At 20:07:04–20:07:07, the remaining
verified `Code.exe` processes were stopped; inspection found zero remaining VS Code processes and an absent update
mutex. The normal Alpha-Code workspace reopened at 20:07:47, with the mutex still absent. The exact-host gate was
retried immediately, using the original downloaded 1.125.0 host.

`vscode-close-request.json`, `vscode-force-close.json`, `vscode-reopen.json`, and `exact-host-retry.log` retain this
resolution and its validation in the same evidence directory.

The retry finished at 20:12:25 America/New_York. All 13 selected suites executed on actual VS Code 1.125.0; all 42 tests
passed without pending cases, with verified host ownership and observed numeric exits. The emitted runner receipts are
preserved in `exact-host-retry-results.json`; successful disposable profile directories were cleaned up by the runner.

Evidence:

- `development/full-live-development-20261014/prepare-test-smoke-1250.json` and `gate-result.json` inside the new evidence directory.
- Retained first-host receipt: `F:/alpha-e2e/tmp/alpha-vscode-e2e-cqOONk/artifacts/da28de72-ecbc-47f1-a06f-c0cc19b649f1/run-result.json`.
- `interim-summary.json` records the observed blocker and completed lower-level checks.

### 2. Bundled Copilot throws during Git repository observation, blocking 22 workflows

All 22 workflow launches and the standalone completion-idle launch report the same uncaught error:

```text
TypeError: e is not iterable
copilot/dist/extension.js:1167:19963
copilot/dist/extension.js:1167:19702
copilot/dist/extension.js:1167:11921
ok.init ... extension.js:2795:10375
```

The component is the reference host's bundled GitHub Copilot Chat `0.53.0`. Read-only inspection of its bundled code
places this stack in the branch observer's cached mapping over Git repositories during initialization. Opening fixture
repositories correlates with the failure. Why the mapped input becomes non-iterable is not isolated; repository
corruption, an Alpha defect, or a particular Copilot/Git API race has not been established.

Readiness succeeded before the error in every affected launch. The workflow controller then classified the host failure
as an infrastructure blocker and exited 2. Each host receipt records one failed `uncaught` runnable, verified ownership,
an observed numeric exit. Capture is complete for 33 of the 34 live launches; selective-commit has the evidence gap in
finding 8. This accounts for 22 of the 43 failed test records; completion-idle adds
the 23rd. Those records do not mean cancellation, reload, compaction, long-context recovery, Git editing, or background
isolation acceptance was exercised successfully. No host upgrade or bundled-source workaround was substituted.

Evidence: `copilot-git-branch-error.json`, each workflow's `host-evidence` directory, and
`standalone-completion-idle/artifacts/standalone-completion-idle/host-preflight.json` under the evidence root.

### 3. Three quality failures score reasoning as part of the final answer

`live-quality.test.ts` passed `late-span` but failed `supported-total`, `exported-symbol`, and `refund-absence`.
Their persisted final assistant messages contain separate `reasoning` and `text` parts. The final text answers are
respectively `700`, `250`, and `no refund window is stated`. The helper `text()` in
`apps/vscode-e2e/src/suite/live-file-tool-support.ts` extracts `.text` from every part without checking its type, then
passes the merged reasoning and answer to the exact-answer scorer.

Read-only offline rescoring of the original histories, filtering only the final `text` parts and retaining the same
scorers, passes all four quality cases. Tool correctness and step-efficiency scores also pass. This confirms an oracle
defect for these three failures. The original live result remains **1 pass / 3 failures**; the offline diagnosis is not a
passing rerun and has not changed any raw receipt. Evidence: `oracle-diagnostics.json` and `diagnose-oracles.cjs`.

### 4. Approval fixtures conflate resolved asks and actual review boundaries

`approval-github-live.test.ts` fails because it rejects any persisted `ask: command` row. The captured `gh --version`
command actually executed once, exited 0, and returned GitHub CLI `2.92.0`. Its command ask has `isAnswered: true`; there
are zero unanswered command asks and no human response was supplied. `Task.ask()` deliberately annotates automatically
resolved asks this way. The assertion must distinguish a resolved audit row from a pending human approval boundary.
Evidence: the approval section of `oracle-diagnostics.json` and `approval-github-live.json` in that suite's artifacts.

Separately, all eight command/file/read-evidence cases fail at **real unanswered command-review boundaries**:
`command-file-diff-live` (1), `file-tools-live` (3), and `read-evidence-live` (4). Their receipts say
`Unexpected boundary: command`; the intended file/diff/read assertions were not reached. The captured inline Node
write command in command-file-diff is unanswered and has no completed tool transaction, unlike the resolved GitHub ask.

The preceding workflow fixture persists a finite `deniedCommands` policy (`git push`, `git remote`, `git config`,
`npm install`, `pnpm install`) and its disposal does not restore the previous configuration. The standalone helper
copies current configuration and overrides allowed prefixes without isolating that deny list.
`src/core/auto-approval/indirectCommandExecution.ts` intentionally retains review for opaque inline JavaScript/Python
under finite deny policies. This explains the inline-command conflict in the shared test profile and exposes fixture
isolation risk. A clean-policy comparison was not run, so no general product approval regression is established.
Production safeguards were not weakened to force a pass.

### 5. Acceptance-repair counts file reads as extra validation runs

The harness acceptance-repair case fails `4 !== 2` when counting all `exec_command` calls as validation checks. The
captured commands are one failing `node live-acceptance/check.cjs`, two `type` file reads, and one passing invocation of
the same checker (`3 checks passed`). The repair patch succeeds and the plan completes. There are exactly two checker
executions, as requested. The oracle must identify validation commands rather than count every command tool call.
The original failure is retained in `acceptance-repair.json`.

### 6. Command-session and browser-session failures need further isolation

The command-session oracle requires `READY` in a `write_stdin` poll even though the captured initial `exec_command`
result already contains it. The server check exits 0 and the final session poll exits 0. However, the final poll is empty
and the captured polls contain no `SERVER_STOPPED`, so fixing readiness-placement scoring alone would not settle the
stdout/termination contract. Evidence: `command-session.json`; no passing rescore is claimed.

In the browser-session case, `click_element` returns a snapshot containing `Count1`, but the next successful `read_page`
returns the old `Count0` snapshot. Later page operations fail with `Page not found`; no successful `read_page` contains
`Count1`. The case uses 18 task requests. This is unresolved browser/session evidence, with no proven cache, lifecycle,
or timing root cause. Evidence: `browser-session.json` under the harness suite's artifacts.

### 7. Five legacy cases discard the selected provider and fall back to Vertex

The one task case and four Markdown cases time out or fail bounded cleanup while their own persisted histories report
`Could not load the default credentials`. Their `startNewTask` configuration contains only mode/auto-approval fields.
The scripted task branch spreads the original configuration, but the live branch does not; all four Markdown cases
also omit it.

`src/extension/api.ts` passes caller configuration as the authoritative `apiConfiguration`,
`AlphaProvider.createTask` preserves that override, and `src/api/index.ts` defaults a missing provider to `vertex`.
Thus these tasks take the Vertex path despite a successful Copilot preflight. This is a confirmed fixture/provider
attribution defect, not a Copilot model-quality result. No Google credentials were added. A follow-up should preserve
the selected provider in these fixtures and assert the actual task provider, rather than treating readiness metadata
as task attribution. The corresponding own task IDs and sanitized errors are retained in `legacy-provider-errors.json`.

### 8. First workflow provenance changes when the sidecar is materialized

The first campaign reports `identity_changed_during_campaign`. Read-only identity comparison finds only `harnessDigest`
changed, with no missing identity fields; source, build, and working-tree identities remain stable. The non-gated path
captures its initial identity before the live sidecar first materializes the compiled harness manifest. The other 21
workflow identities remain unchanged. Evidence: `first-campaign-provenance-comparison.json`.

This is preparation-order/provenance evidence, separate from the Copilot crash. Initialize the sidecar before the
initial campaign fingerprint in a follow-up; do not rewrite the original invalid provenance result.

One interrupted `workflow-result.json` in the selective-commit host evidence is empty/unreadable. Its valid
`run-result.json` records the failed host and **`captureComplete: false`**. `live-summary.json` lists the exact unreadable
path and does not treat it as a pass. This is an evidence-write gap; user task-transcript loss has not been established.

### 9. Eight legacy suites are disabled at their declarations

Current source contains `suite.skip` in seven `apps/vscode-e2e/src/suite/tools/` files and `subtasks.test.ts`, covering
37 declared tests. They remain disabled independently of the local environment:

| File                            | Declared tests |
| ------------------------------- | -------------: |
| `tools/apply-diff.test.ts`      |              5 |
| `tools/execute-command.test.ts` |              4 |
| `tools/list-files.test.ts`      |              4 |
| `tools/read-file.test.ts`       |              7 |
| `tools/search-files.test.ts`    |              8 |
| `tools/use-mcp-tool.test.ts`    |              6 |
| `tools/write-to-file.test.ts`   |              2 |
| `subtasks.test.ts`              |              1 |

This is a source inventory, not a new runtime skip result. Current file, command, read-evidence, and harness live suites
are included in the active plan. Disabled historical coverage must not be counted as a successful full live run.

### 10. Retained managed-agent manual procedures need adaptation

The warning at the top of `docs/certification/managed-agent-live-acceptance.md` explicitly says its historical
`report_progress`, `interrupt_agent`, and `cancel_agent` calls are no longer advertised and the prompts are not ready to
run against the current catalog. Its command-only preflight passing does not exercise the five manual live procedures.
Certification also lists eight `PENDING-INTEGRATION` boundaries requiring actual provider, host, process, or multi-window
evidence. Offline certification cannot establish those live acceptance results.

### 11. Webview build reports large chunks

Vite warned that some minified chunks exceed 500 kB. The build succeeded. This warning alone does not establish a runtime
performance regression; no performance fix or benchmark claim is included in this testing task.

## Complete active live inventory

One sample was attempted for each unique workflow scenario, including both opt-in long-context scenarios. The ordinary
core and smoke selections are subsets; the soak selection repeats development scenarios rather than introducing
additional cases. Each campaign allowed at most three iterations and one reproduction, with a 200-request ceiling,
20-minute attempt timeout, 10-minute scenario timeout, and 40-minute campaign bound. Infrastructure blockers stopped their individual campaign after
one launch; the external driver continued to the next selection. No failed workflow was repaired or rescored.

All launches used the exact host and saved profile/model selection, with separate marked workspaces and evidence
directories, serialized profile access, and lease checks between launches. The driver finished with exit 1, preserving
the non-passing result. All 34 host receipts verified ownership and observed a numeric exit; 33 record complete capture.
Final inspection found no remaining test-host processes or profile lease. The reopened normal editor was left open.

Workflow cells: **all 22 BLOCKED by the Copilot uncaught error in finding 2**, with one failed host test record each:

1. `review-edit-test-commit-followup`
2. `cancel-resume`
3. `long-thread`
4. `reload-continuation` (prepare blocked; continuation launch not reached)
5. `dev-repo-bootstrap`
6. `dev-git-inspect`
7. `dev-refactor`
8. `dev-selective-commit`
9. `dev-merge-conflict`
10. `dev-local-migration`
11. `dev-search-recovery`
12. `dev-verification-unavailable`
13. `completion-admission`
14. `completion-idle`
15. `stream-cancel-recovery`
16. `provider-error-recovery`
17. `provider-empty-recovery`
18. `task-cycle-soak`
19. `context-compaction`
20. `background-isolation`
21. `long-context-recovery`
22. `long-context-empty-exhaustion`

Standalone suites:

| File under `apps/vscode-e2e/src/suite/` |  Pass |   Fail | Observation                                                                 |
| --------------------------------------- | ----: | -----: | --------------------------------------------------------------------------- |
| `alpha-tickets-live.test.ts`            |     1 |      0 | Native ticket listing persisted; 2 task requests                            |
| `approval-github-live.test.ts`          |     0 |      1 | Resolved command ask misclassified as human approval                        |
| `command-file-diff-live.test.ts`        |     0 |      1 | Unanswered command-review boundary                                          |
| `file-tools-live.test.ts`               |     0 |      3 | Unanswered command-review boundaries                                        |
| `read-evidence-live.test.ts`            |     0 |      4 | Unanswered command-review boundaries                                        |
| `live-quality.test.ts`                  |     1 |      3 | `late-span` passes; reasoning/final-answer oracle defect in other cases     |
| `harness-quality-live.test.ts`          |     1 |      3 | Skill composition passes; repair-count, session, browser findings           |
| `vscode-lm-empty-recovery.test.ts`      |     1 |      0 | Injected no-choices response recovers automatically in 2 task requests      |
| `command-settlement.test.ts`            |     3 |      0 | Receipt fault blocks correctly; execa and VS Code terminal revisions settle |
| `completion-idle.test.ts`               |     0 |      1 | Uncaught bundled Copilot error                                              |
| `task.test.ts`                          |     0 |      1 | Provider omitted; Vertex credentials error and completion/cleanup failure   |
| `markdown-lists.test.ts`                |     0 |      4 | Provider omitted; Vertex credentials errors and timeouts                    |
| **Total**                               | **7** | **21** | **28 recorded tests; zero pending**                                         |

The skill-composition pass used 14 task requests and retained both skills, plan, patch, and read constraints. Command
settlement recorded the deliberate receipt-fault case in 3 requests, execa's three revisions in 15 requests, and VS Code
terminal's three revisions in 14 requests. These are individual sample observations, not general quality estimates.

`problem-solving-attempt` is an evaluation adapter that requires an externally prepared `prompt.md` and an independent
problem grader. It is excluded from the repository's development/reliability suite definitions; no dataset evaluation
result is claimed. Discovery-only, scripted/fake-provider, LM-fixture, and rendered-UI fixtures are not counted as live
model executions. The managed-agent acceptance/budget/cancellation host fixtures explicitly use `fake-ai`; their names
do not establish real-provider acceptance.

## Behavioral reference

Current Codex CLI source was retrieved on 2026-10-14 America/New_York at commit
`4ca84a10696623fcd7c200db3df9c41671d3bad0` for the reasoning and approval findings. Its
[protocol response items](https://github.com/openai/codex/blob/4ca84a10696623fcd7c200db3df9c41671d3bad0/codex-rs/protocol/src/models.rs#L1036)
distinguish reasoning from messages; its
[approval tests](https://github.com/openai/codex/blob/4ca84a10696623fcd7c200db3df9c41671d3bad0/codex-rs/core/src/tools/approvals_tests.rs#L80)
distinguish automatic decisions from the branch that sends a human approval request. These support preserving response
part types and testing actual user boundaries. Alpha's own inline-command security policy remains authoritative; Codex's
sandbox architecture is outside the repository's alignment target. No upstream implementation or prompts were copied.

`codex-reference.json` and the retained source excerpts in the evidence directory record retrieval identity. Alpha source
was checked directly; older design documents were not treated as proof of current behavior.

## Evidence and follow-up

The evidence root is `F:/alpha-e2e/full-live-20261014-01c26a9d`. It contains:

- `summary.json`: final consolidated result; `interim-summary.json` preserves the initial update blocker.
- `live-plan.json`, `live-summary.json`, and `remaining-complete.json`: selections, aggregated native receipts, and every
  launch's command arguments, timestamps, and process exit.
- `run-remaining.cjs` and each `<selection>.command.json` / `<selection>.log`: the exact external driver and run commands.
  Workflow directories retain configuration, atomic campaign reports, and native host evidence; standalone directories
  retain native receipts and test-specific evidence. The driver used existing compiled repository runners.
- `development.log`, `development/full-live-development-20261014/prepare-*.json`, and `gate-result.json`: initial
  prerequisite results and failed development gate. The original gate remains blocked; later separate runs do not
  retroactively pass it.
- `exact-host-retry.log` and `exact-host-retry-results.json`: the passing exact-host gate and extracted runner receipts.
- `oracle-diagnostics.json`, `legacy-provider-errors.json`, `copilot-git-branch-error.json`, and
  `first-campaign-provenance-comparison.json`: scoped diagnoses, with original live outcomes preserved.
- The lower-level check logs and `managed-certification-evidence.json` described above.

For a new run, use a **new evidence root and new campaign/run IDs** with the recorded commands, retaining exact 1.125.0
and the authenticated test profile. The saved driver uses exclusive new-directory creation and must not be rerun
unchanged into this consumed root. `ELECTRON_RUN_AS_NODE` was removed before launch and TEMP/TMP/RUNNER_TEMP pointed to
`F:/alpha-e2e/tmp`. Evidence contains no copied authentication store or credentials.

Recommended repair order is the bundled Copilot/Git observer blocker, provider and policy isolation in fixtures, the
three confirmed oracle defects, then session/browser isolation and sidecar/evidence preparation order. A subsequent
acceptance run must retain original failures and produce new live receipts. The 22 workflow behaviors, disabled legacy
coverage, and manual managed-agent boundaries remain unverified. No production/test source fixes, dependency changes,
release packaging changes, or acceptance waivers are included in this documentation-only change.
