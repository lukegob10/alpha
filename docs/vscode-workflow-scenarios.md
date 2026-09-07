# Realistic extension workflow scenarios

The [live development acceptance suite](live-development-suite.md) adds repository bootstrap, read-only Git inspection,
multi-file refactoring, selective commits, merge conflicts, and idempotent local migrations to this driver. Its live
acceptance requires persisted trace receipts plus independent effects; scripted results validate only the harness.

These scenarios exercise Alpha's extension task loop, tools, approvals, saved history, and webview message path. They do
not test `apps/cli` or the VS Code shim. The exact-host release gate remains VS Code **1.122.1**; repeat the same scenarios on
**1.136.1** for the user's newer host. A successful newer-host run does not substitute for the exact-host gate.

## Scenarios and evidence

| Scenario ID                        | Work performed in one task                                                                                                         | Independent evidence                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review-edit-test-commit-followup` | Review the empty-array bug; fix it; run tests; make one local commit; add a negative-number regression and README example          | Fixture ownership, source behavior, tests, clean committed Git state, follow-up files, persisted tool-call/result IDs, lifecycle terminals        |
| `cancel-resume`                    | Stop at a known pending command approval, cancel, resume the same task, then fix and test                                          | Baseline unchanged before resume; cancelled turn; same task ID; later completed turn and passing tests                                            |
| `long-thread`                      | The four-turn review/edit/commit/follow-up chain, then dependent regression additions                                              | Each later turn preserves the prior JSON cases and appends a case whose input depends on the preceding sum; tests and receipts checked again      |
| `reload-continuation`              | `prepare`: complete a read-only review and save a checkpoint. Exit the host. `continue`: reopen the same saved task, fix, and test | Exact workspace, initial commit, host version and task identity; old and new lifecycle turns; persisted tool receipts; no new-task/reset fallback |

The deliberately failing baseline requires `sum([]) === 0` before its implementation is fixed. Independent module checks
prevent a model from passing merely by deleting a failing test. Source formatting is not the behavior contract. Git commits
remain local, have no remotes, and use test-only identity/signing/hook settings. No dependency installation, push, production
migration, external service, or delegation is part of these scenarios.

Task completion text is not evidence of success. `transactionAssertions.ts` checks each accepted tool-call ID has exactly
one corresponding result, in order. Error receipts remain errors; they are not rewritten as successes. Lifecycle checks
require terminal outcomes without duplicate completion or activity after termination. The host adapter joins the Task-owned
durability boundary before inspecting saved files; it never polls until an integrity error happens to disappear.

## Running

Use the existing `@alpha-code/vscode-e2e` runner after bundling the extension/webview and compiling the E2E package. Select
`workflow.test` explicitly and supply a dedicated absolute workspace and dedicated profile through the runner. Do not run
against a normal editor profile, source checkout, or unrelated directory. The suite skips when no scenario is selected.

For example, after the normal build/compile steps, start a fresh scripted sample with the integrated runner:

```powershell
node apps/vscode-e2e/out/runTest.js --provider scripted --vscode-version 1.122.1 `
  --workspace C:\AlphaE2E\sample-001\workspace --profile-dir C:\AlphaE2E\sample-001\profile `
  --init-profile --artifacts-dir C:\AlphaE2E\artifacts `
  --scenario-id review-edit-test-commit-followup --scenario-phase run --request-limit 60
```

Scenario selection defaults the test file to `workflow.test`. The runner assigns `ALPHA_E2E_RUN_ID` and a new owned result
destination. For another sample, use a new sample directory; do not erase a failed workspace. Live Copilot first requires
the dedicated-profile setup/preflight flow documented with the runner.

The runner/controller supplies these environment variables to the extension host:

| Variable                                                      | Values / meaning                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `ALPHA_E2E_WORKSPACE`                                         | The real, single-root fixture workspace opened by this host                     |
| `ALPHA_E2E_PROVIDER_MODE`                                     | `scripted` or `live-copilot`; no silent provider substitution                   |
| `ALPHA_E2E_SCENARIO_ID`                                       | One of the four IDs above                                                       |
| `ALPHA_E2E_SCENARIO_PHASE`                                    | `run`, or `prepare` / `continue` for reload                                     |
| `ALPHA_E2E_SCENARIO_RESULT_PATH`                              | Absolute, new result file; defaults to a protected workflow file in the fixture |
| `ALPHA_E2E_REQUEST_LIMIT`                                     | Predispatch request limit, default 60; accepted range 1–200                     |
| `ALPHA_E2E_SCENARIO_TURNS`                                    | Long-thread turns, default 6; range 4–12                                        |
| `ALPHA_E2E_SCENARIO_TIMEOUT_MS`                               | Whole-scenario deadline, default 300,000; range 1,000–1,200,000                 |
| `ALPHA_E2E_ACTUAL_MODEL_ID` / `ALPHA_E2E_ACTUAL_MODEL_FAMILY` | Selected real model identity from live preflight                                |
| `ALPHA_E2E_ACTUAL_REASONING_EFFORT`                           | Actual reasoning setting applied by live preflight                              |

The fixture initializer accepts an empty directory, a fresh directory containing only the canonically validated runner
ownership marker, or its exact existing fixture ownership marker. It preserves the runner marker and does not clean, reset,
or overwrite an existing repository. The workflow independently verifies the baseline before a new scenario. Checkpoints and
results are excluded from Git and protected by `.alphaignore`; publication refuses existing artifact files and symlink
destinations. Use a fresh workspace and result destination for a new sample. Preserve a failing sample for inspection.

Reload uses two separate runner invocations with the **same dedicated profile, storage and fixture**. `prepare` returns
`checkpointed`, not `passed`. Only `continue` may complete this scenario. A missing or mismatched checkpoint is a failure,
not permission to create another task. This is a clean process-restart test at a durable turn boundary, not a claim of
crash-during-write or concurrent-host coverage.

## Scripted versus live

`scripted` sends deterministic provider responses into Alpha's actual tool loop. Its provider does not directly write
fixture files or execute shell commands. The fake-provider callback is reinjected when reopening a saved scripted task
after process exit; the task ID, history, persistence and normal reload path remain intact. These runs provide deterministic
extension contract evidence, **not evidence of GitHub Copilot model quality**.

`live-copilot` uses the runner's authenticated dedicated profile and explicit model preflight. `requestBudget.ts` guards
the actual task VS Code LM client's `sendRequest` boundary before dispatch, including retries and completion requests. It
does not mutate the shared provider client and reinstalls the guard if the Task replaces its adapter. Unknown adapter shape,
unexpected model identity, or exhausted budget stops the scenario. Report model ID/family, host version, reasoning setting,
request count and sample count. Do not label a fixture provider or an unavailable model as a successful live sample.

The result includes `passed`, `failed`, `blocked` or `checkpointed`, named checks, stable task IDs, actual host/model metadata,
request count and a static failure category/code. It omits arbitrary exception text, prompts, credentials and file contents.
Provider/configuration blockers are distinguishable from repository assertions, policy refusals, persistence/lifecycle
defects and timeouts. The controller must count requests across both reload phases and treat missing usage as unknown,
not as free usage. A cleanup failure cannot turn into a passing result.

## UI coverage boundary

The suite requires the actual sidebar webview to be launched. Follow-ups use the public `sendMessage` API, which takes the
webview `invoke=sendMessage` ingress when launched, and checks current task identity in the extension-side projected state.
This catches disconnected task routing. It is **not** a rendered DOM, screenshot, focus, accessibility or manual F5 acceptance
test. Report those separately; do not relabel projected state as rendered UI verification.

Posting a message is not the admission boundary: the adapter subscribes before dispatch and waits for a newly created
same-task `user_feedback` event containing the submitted guidance. Only the exact prior ask may remain in flight; a new
recovery or approval still fails with a closed diagnostic code. Resume also reapplies the full bounded scenario policy before
constructing a saved task, because restoring a provider does not restore global approval settings. The shared E2E wait helper
releases its deadline timer even when a condition rejects.

## Remaining acceptance gaps

The following boundaries were audited against the integrated harness on **2026-09-06**. Passing the four scenario IDs on
both host versions does not satisfy these additional criteria.

### Concurrent extension hosts sharing storage

The specialized shared-storage campaign runs this criterion under **one** controller-held profile lease. It is separate
from the four workflow scenario IDs: `campaign/controller.ts` continues to await ordinary scenarios sequentially, and
`runTest.ts` still rejects independent launchers sharing a leased profile. No second task engine or general runner is added.

Build the extension normally, then use the existing campaign entry point with an explicit installed Code executable:

```powershell
pnpm --dir apps/vscode-e2e compile
pnpm --dir apps/vscode-e2e test:campaign --shared-storage-root C:/alpha-test-campaigns/shared-storage --vscode-version 1.122.1 --vscode-executable C:/path/to/Code.exe
```

The root must be new/empty or already marked by the canonical campaign-root helper. Use a separate dedicated root, never
a setup/authentication root. Hosts use fresh owned profiles; existing authentication and normal editor data are not copied.
Do not mix this mode with `--storage-recovery-root`, `--config`, `--root`,
`--profile-dir` or campaign flags. Version defaults to **1.122.1**; **1.136.1** is also selectable. Only one version runs per
invocation, with a fresh profile and two single-folder `.code-workspace` files opened in one owned Code process family.
The host entry is produced by the normal TypeScript compile; no spike bundle or `.spike-output` build step is required.

The controller requires distinct real host PIDs, actual common storage, nonce-bound immutable receipts, concurrent held
provider callbacks, and one durably completed text-only scripted task per host. It uses a monotonic **180-second runtime
budget**, forwards cancellation, and awaits the existing bounded process-family cleanup. Cross-process wall-clock
deadlines are supplementary. Cleanup and evidence capture finish safely even on expiry; the final status is rechecked
against the monotonic deadline before report publication, so slow finalization cannot produce a passing result. The
extension bundle hash is recorded before/after and must be unchanged.

Before launch, the canonical retained-storage audit scans the **entire root, including all prior profiles and evidence**.
An over-budget or incomplete scan blocks launch. All runs remain held/protected (no retention-eligible marker or automatic
deletion); the existing default admission limits apply. This deliberately stops repeated runs when retained data reaches
the budget. Inspect retained failures offline; do not clear a lease merely because it is old.

After verified family cleanup, the canonical bounded/redacted evidence collector captures the shared storage once using
both task IDs. The lease remains held during capture. Unverified cleanup retains the lease/profile and skips storage
capture; partial identity receipts remain available without a claim of quiescence. Unknown request totals remain `null`,
while validated usage survives later capture failures. The immutable `shared-storage-<run-id>.json` root report links the
artifact directory and records admission, host counts, identity verification, cleanup, capture, usage, and failure stage.

Separate profiles are not an equivalent substitute. `testProfile.ts` isolates user data by exact host version.
`ClineProvider` obtains `AgentControlStore` from the actual `globalStorageUri`, and `AgentControlStore.forGlobalStorage`
constructs its persistence directly there. A shared `customStoragePath` can redirect task/history files through the storage
adapter, but it does not make those separate agent-control stores shared.

Existing `storage-restart.test.ts` covers sequential host restart. `storage-recovery.test.ts` exercises the bundled
persistence implementation with fresh instances and a controlled live-owner barrier inside one extension host. Those are
useful checks, not concurrent-extension-host evidence. Run the specialized campaign separately on each exact host; it is
not implicitly included in the smoke gate. Do not bypass the profile lease, share a normal editor profile, or replace this
check with same-process instances.

On 2026-09-06, the corrected pre-integration spike passed one **1.122.1** sample: two actual
extension hosts, one text-only scripted Alpha task per host, two provider requests total, identical canonical
`globalStorageUri`/`agent_control.json` paths, both provider callbacks held at a shared barrier, and both task roots durably
completed in the shared control file. Run `0ce44521-83d6-436e-a44c-bb1913cc21db` retained separate ready/entered/done receipts
and an overlap receipt. The owned process family was verified closed before releasing the lease; the frozen extension
bundle hash was unchanged. One initial Code launch opened two single-folder `.code-workspace` files. Two plain folder
arguments would instead create one multi-root window in this host's launcher.

The first spike exposed a test-fixture omission, not a demonstrated storage defect: its scripted provider lacked the
top-level registration `id` required by the real FakeAI adapter. The corrected fixture has a nonce/role-qualified ID and a
regression against actual adapter registration and serialized-ID rehydration. The six spike source files have been migrated
into the regular campaign, evidence, scenario, and suite modules. This historical text-only sample does not establish
concurrent tool-mutation reliability, newer-host compatibility, rendered UI behavior, or acceptance of the integrated mode.
Report subsequent integrated real-host samples separately from the controller's simulated-receipt unit tests.

The integrated mode subsequently passed one real sample on each version on 2026-09-06. Under
`F:/alpha-vscode-e2e-runs/20260906/`, reports
`shared-storage-1221-01/shared-storage-f830ce16-3da9-4929-8dec-89313ed32e5a.json` and
`shared-storage-1361-01/shared-storage-a45245d2-eaec-41ff-8500-396b4ecf4861.json` each record two distinct verified extension
hosts, shared storage and overlapping provider callbacks, two completed tasks/two scripted requests, unchanged bundle,
verified family closure, lease release, and complete held evidence. These integrated samples cover the normal compiled
entry and campaign mode, but remain text-only and single-sample. The 29 focused tests additionally cover malformed identity,
missing host, request limit, cancellation, cleanup failure, capture failure, storage admission, and deadline expiry during
cleanup/capture; the latter must never produce a passing final report. The full exact 1.122.1 smoke gate passed afterward.

### Rendered submission and visible recovery

Real submission transport is exercised: `suite/index.ts` focuses the sidebar and waits for readiness; the public
`src/extension/api.ts` `sendMessage` method posts `invoke=sendMessage` to the launched webview; `ChatView.tsx` handles that
message; and `ExtensionWorkflowHost.followup` requires newly admitted same-task user feedback. However, `assertUiTask`
reads `getStateToPostToWebview()` in the extension, not the rendered transcript or controls. It cannot prove that a recovery
message is visible, that typing/clicking works, or that focus is correct.

`webview-ui/vitest.config.ts` uses JSDOM. The existing `ChatView.spec.tsx` test named "keeps a persisted recovery error
visible while hiding the resume ask after rehydration" checks recovery text after repeated injected state in that simulated
DOM. It is complementary regression coverage, not a screenshot or real VS Code renderer check.

The existing `apps/vscode-e2e` package provides extension-host tests through `@vscode/test-electron`, not a rendered-webview
DOM/screenshot driver. Native UI-control APIs were disabled in this execution environment, so the small actual-renderer
submission/recovery check could not be completed during this audit. It needs an enabled, sanctioned UI-control facility or
a human check in the dedicated development host on each exact version. Do not substitute a browser mock, projected state,
or an alternate debug/OS-control route for that missing evidence. This is an automation/evidence limitation, not a diagnosed
rendering failure.

## Focused validation

From the repository root on PowerShell:

```powershell
$workflowSpecs = @(rg --files apps/vscode-e2e/src/scenarios -g '*.spec.ts')
pnpm exec tsx --test @workflowSpecs
pnpm --dir apps/vscode-e2e check-types
pnpm --dir apps/vscode-e2e lint
```

These lower-level tests exercise the driver, fixtures, command allowlist, request budget, lifecycle and receipt assertions.
They do not launch VS Code. Run the actual host scenarios separately, plus the existing exact-host gate:

```sh
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

Live samples are supplemental to deterministic host contracts. Neither one successful sample nor this finite scenario bank
proves that an agent has zero possible failures or that an overnight campaign may run without explicit budgets.

Independent Node test subprocesses clear the inherited Node test-runner context, use Electron's Node mode when running
inside an extension host, select test files explicitly, and require at least two executed tests in TAP output. A successful
process that discovered no tests is an infrastructure failure, not a passing fixture.
