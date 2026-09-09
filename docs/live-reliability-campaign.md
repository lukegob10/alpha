# Live reliability campaign

This campaign uses isolated VS Code processes, the saved Copilot test profile, real model requests, and disposable
repositories. It extends the existing campaign controller, ownership checks, request guard, evidence retention, and
workflow driver. It does not use desktop mouse/keyboard automation or a replacement model.

## Implemented acceptance cells

| Scenario                  | Workload and acceptance                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `completion-admission`    | Implement, test, commit, and follow up through open reviews; then send feedback to an accepted completion. Each dispatch must reach the same task within 30 seconds.                             |
| `completion-idle`         | Leave the completion tool waiting for 35 seconds with no extra requests; resume the same task. The campaign adapter also requires the captured state to pass the rendered `ChatView` regression. |
| `stream-cancel-recovery`  | Hold the first genuine Copilot response part, cancel within ten seconds, release the late part, then resume and fix the fixture. Require cancellation and valid persisted tool transactions.     |
| `provider-error-recovery` | Throw a transport interruption after observing a genuine Copilot part. Allow normal explicit/automatic retry and require a successful real-model completion.                                     |
| `provider-empty-recovery` | Drain the first real response while withholding its parts from Alpha. Require another real request, successful recovery, and unchanged review-only fixture.                                      |
| `task-cycle-soak`         | Run six sequential review tasks in one host, checking completion, unique task IDs, valid tool transactions, and unchanged fixture files. Record heap usage and phase durations.                  |
| `context-compaction`      | Complete an implementation thread, explicitly compact with the real provider, require a newly persisted summary, and verify the same repository after follow-up.                                 |
| `background-isolation`    | Hold a foreground Copilot response while another task completes a real review in the background. Require distinct task IDs, retained foreground selection, valid histories, and unchanged files. |
| `cancel-resume`           | Existing live workflow: withhold an approved fixture command, cancel, resume, implement the correction, and verify results.                                                                      |
| `long-thread`             | Existing live workflow: repeated dependent fixture edits with independent file and test checks.                                                                                                  |
| `reload-continuation`     | Existing two-host-launch workflow: retain a completed task, exit, reload its saved state, and continue in the same repository.                                                                   |

Fault injection is opt-in, one-shot, task-handler-local, and installed behind the existing actual-request budget. It
never changes the shared frozen VS Code model object. Ordinary requests retain their original response identity.
Pause/error/empty variants intercept only the first response and preserve the normal provider for recovery.

## Running

Use Node 20.19.2 and pnpm 10.8.1. Never rebuild the same output directory concurrently with a live run. When another
task is building the repository, use a dedicated source checkout as well as a dedicated fixture/profile. This avoids
test-module deletion and extension replacement while the host is running.

From the source checkout:

```powershell
pnpm test:live:reliability --model-id gpt-5.6-luna --effort high --root F:/alpha-vscode-e2e-runs/reliability/campaigns --profile-dir F:/alpha-vscode-e2e-runs/20260906/profiles --vscode-version 1.136.1 --vscode-executable 'C:/Users/Luke Goblirsch/AppData/Local/Programs/Microsoft VS Code/Code.exe' --init-root --id UNIQUE_RUN
```

The gate performs preparation/build checks, fingerprints the runtime artifacts, runs every selected cell, retains
failures, and rejects missing, duplicate, failed, or changed-artifact evidence. It does not retry a failed cell into a
passing verdict. Its default suite budget is 1,200 model requests and two hours, with a ten-minute attempt deadline;
the existing controller enforces the remaining request budget at every actual dispatch. Use an explicit configuration
with smaller budgets for a targeted campaign. Never use a normal editor profile or a source repository as a fixture.
Append `--dry-run` to validate and print the complete matrix without launching a host. Run the gate through pnpm so its
preparation subprocesses use the repository's package manager.

Omitting the host selection requests both registered hosts, 1.122.1 and 1.136.1. Copilot/model availability must pass each
host's preflight independently. A current-host pass is not a reference-host live pass. The exact 1.122.1 smoke gate
remains required separately.

Individual new scenarios run through `runTest.js --scenario-id <id>` with the same profile, workspace, provider, model,
and budget options as existing workflows. Unlike the existing deterministic workflows, these new acceptance cells
reject a scripted provider. Offline tests exercise the fault controller and gate mechanics only.

## Evidence and limits

`workflow-result.json` records independent assertions and actual request counts. `reliability-observations.json` records
phase duration, request deltas, process heap observations, and whether a real response part reached the injected fault.
`reliability-failure-state.json` captures only the fixture task's projected metadata and final messages on failure.
The campaign stores the completion UI replay's process result separately as `completion-ui-replay.json`.

Heap observations are diagnostic, not a proven leak threshold; the VS Code extension host also contains Copilot and
other extensions. Token/cost fields remain unavailable where the existing provider evidence does not supply them.
Rendered-state replay is not a screenshot of the live webview. Background read isolation does not establish overlapping
write safety. A clean two-launch reload does not establish recovery from a crash halfway through a disk write.

Remaining coverage to build before claiming the broader eight-campaign plan complete:

- Controlled crash points around durable tool-result publication and atomic transcript replacement.
- Concurrent overlapping edits, external edits, and multiple editor/sidebar surfaces.
- Cancellation during command execution and compaction, duplicated/malformed response parts, and provider/model changes.
- Longer repeated samples with calibrated handle/process/memory thresholds and known warm/cold cache conditions.
- Installed-VSIX live runs, clean-profile upgrade/reload, trust-state variants, and supported OS coverage.

Do not call these missing cells passed or equate a single successful sample with general robustness. The existing
VS Code integration method is documented by Microsoft at
[Testing Extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension) (checked 2026-09-09).

## Initial validation, 2026-09-09

- `provider-error-01` passed a real Copilot `gpt-5.6-luna` / high run on VS Code 1.136.1: one genuine response part was
  intercepted, recovery reached a second request, and completion finished at three requests with independently valid
  fixture/tool history. Evidence: `F:/alpha-vscode-e2e-runs/reliability/artifacts/provider-error-01/`.
- `stream-cancel-01` was blocked before host preflight. Its main log reports that VS Code is being updated; it is not
  cancellation acceptance evidence. The installer began at 21:03 local time, after the successful error-recovery run.
- A separate concurrent build replaced shared compiled test files during an initial unit run. Validation moved to the
  detached source checkout `F:/alpha-vscode-e2e-runs/reliability/source`, based on commit `0387132`, with this change and
  the prior completion-warning fix copied in. Unrelated ticket edits were excluded.
- The isolated bundle built. The full harness suite passed 350 tests with two skipped; the final focused gate/fault
  checks passed 29 tests. Package lint and typechecking passed. The new pnpm entry point's dry run produced all 11 cells.
- The isolated `test:smoke:1221` attempt also stopped before preflight because the updater held `vscode-updating`.
  This attempt is blocked, even though the earlier completion-warning investigation passed the reference-host gate.
- The full new live matrix has **not** passed. Remaining cells await installer completion and live validation. The
  initial successful fault run predates final test-harness refinements and is retained as development evidence.
