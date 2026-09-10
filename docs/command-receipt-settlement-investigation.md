# Command receipt settlement investigation

Investigated September 10, 2026 against Alpha 2.1.28, commit
`42bd0e5183ea1d0b3683fec2339b8001f89f8d72`. The screenshot came from **another person's computer**.
Its task history, original command, storage errors and installed-extension registry were unavailable locally.

## What the screenshot establishes

The reported message is produced by `Task.waitForCompletionGateDecision()`. A durable primary mutation reservation
remained, but the current Task had no tracked command or evidence publisher that could account for it. The guard waited
30 seconds and refused to claim completion. The displayed six files and content version 9 describe the accumulated
change set; they do not identify the command or edit that left its receipt pending. This is distinct from the provider
returning no assistant messages and from the earlier compaction bug.

A successful last Node command does not establish that all earlier edit receipts were persisted. The timeout protects
against false completion; increasing it or deleting the reservation would hide the unresolved operation.

## Reproduced defect and implemented change

`ToolRegistry.executeBaseTool` reserves file mutations before execution and records their final content afterwards.
Unlike the command implementation, its receipt-error path did not suspend the task. The scheduler reported a tool
error, but the model could continue with later operations and discover the unresolved reservation only at completion.

The new regression executes the real registry wrapper, filesystem observation, Task stopping policy and file-backed
AgentControlStore. It injects an `EBUSY` failure into the final persistence write after the file and reservation exist.
Before the fix, the regression failed because no suspension occurred. The file bytes and reservation survived. A
separate deterministic simulation runs a real `node --version`, records its successful outcome, and advances controlled
timers to reproduce both the screenshot's 30-second error and its missing-final-receipt explanation.

The fix marks receipt-finalization errors as runtime failures and invokes the existing Task suspension boundary.
Subsequent tools are stopped by the existing scheduler policy. The original error and unresolved token remain available;
the model is not asked to repair a persistence failure with more commands. Failed no-op reservation release is covered
as well. There is no new retry loop, completion bypass, provider-specific behavior or persisted-format migration.

This fixes **continuation after a failed file receipt**, not the underlying cause of an actual disk error. `EBUSY` is an
injected test condition, not an observed error on the reporter's computer. Existing orphan reservations are deliberately
not auto-cleared, and this work does not claim their recovery is solved.

The user-requested detailed error report now includes a bounded, content-free settlement projection: recent physical
command IDs/statuses, pending reservation IDs, change-set versions/counts, completion counters and task instance ID.
It also records the actual VS Code version, runtime version, active extension manifest version and extension directory
name. Command text, workspace paths and file fingerprints are excluded from the new projection. The existing report's
conversation history is still included for the user to review before sharing. Failure to collect the new diagnostics
does not discard the original report.

## Front-end tests

`apps/vscode-e2e/src/suite/command-settlement.test.ts` uses the existing ExtensionWorkflowHost, real composer follow-up
dispatch, canonical transcript checks and owned test profiles. Scripted runs replace only the model. Live runs use the
actual VS Code LM Copilot adapter and a bounded request budget.

The shared workload builds an HTML counter with increment, decrement and reset controls, then revises it in the same
task. Each revision runs a host-owned Node oracle which executes the browser script with click-event objects, checks
five control transitions and revision data, emits about 130 KB of output, and writes a sixth application file after
1.5 seconds. The command requests a one-second foreground timeout, exercising background completion and terminal reuse.
The oracle is protected from model edits, and a separate test proves it rejects broken controls. This is focused DOM
behavior coverage, not a visual/browser-layout certification of arbitrary HTML applications.

Every successful revision requires paired tool calls/results, successful physical command outcomes, no pending
reservations, no unresolved mutation scope, a current Node-written receipt, and no integrated-terminal fallback warning.
Default runs have three revisions; `ALPHA_E2E_SETTLEMENT_TURNS=12` selects the longer bounded workload. Neither variant
claims to exhaust the model context window.

The explicit fault scenario fails one receipt publication after an actual model-requested file edit. It requires a
resumable uncompleted task, preserved debt, no later Node command, complete tool transactions and the original receipt
error instead of the later 30-second timeout. This is fault-injection evidence, not a spontaneous live disk failure.

Results on exact VS Code **1.122.1**:

| Workload                                                 | Result | Requests          | Evidence                                                        |
| -------------------------------------------------------- | ------ | ----------------- | --------------------------------------------------------------- |
| Scripted, separate command runner, 3 revisions, baseline | Passed | 21 scripted steps | `scripted-execa-baseline/16a7ed94-1178-42b3-a909-9330e81cbbc5`  |
| Scripted, integrated terminal, 3 revisions, baseline     | Passed | 21 scripted steps | `scripted-vscode-baseline/ed89d09e-028d-4104-b399-460271b6e39a` |
| Scripted, injected receipt failure, fixed build          | Passed | 1 scripted step   | `scripted-fault/f72d0d68-d89a-4dd9-8d28-d9bcb5ccff2c`           |
| Copilot Luna high, integrated terminal, 3 revisions      | Passed | 11                | `live-luna-vscode-v2/c8bbe8a6-3c59-4ebb-8fb9-a37a3b8037d8`      |
| Copilot Luna high, separate command runner, 3 revisions  | Passed | 17                | `live-luna-execa/ee98422e-8016-4a07-b699-685145ad6725`          |
| Copilot Luna high, injected receipt failure              | Passed | 1                 | `live-luna-fault/d4a44701-0b87-4e97-9ac0-b9648b8b2327`          |
| Copilot Luna high, integrated terminal, 12 revisions     | Passed | 51                | `live-long-vscode-v2/29cc7bf2-b283-48da-9cb6-d2a6374229ba`      |

Artifacts are retained under `F:/alpha-vscode-e2e-runs/receipt-20260910/`. The four successful live runs above consumed
80 model requests. In the shorter runs, integrated-terminal revision durations were 36.0, 33.3 and 21.0 seconds; separate-runner durations
were 51.4, 19.3 and 27.7 seconds. These are one sample per workload, with variable live model behavior, not a performance
comparison or a general accuracy claim.

The first twelve-revision attempt completed ten revisions and 59 model requests, then stopped at the isolated test
profile's 60-request auto-approval limit before its next provider call. All ten Node checks succeeded, all receipts
settled, and all tool transactions paired. Its last recorded context was 81,168 tokens. Evidence:
`live-long-vscode/f1359f00-2f8b-4c00-9605-fc43fbf4f70b`. This is an incomplete stress run, not a settlement failure or
a passing twelve-revision run. The harness now scales its finite request budget to the selected workload: 60 for the
default case and 96 for twelve revisions. Product approval limits and completion checks are unchanged.

The fresh twelve-revision rerun passed in 240.3 seconds with 51 model requests, 51 paired tool calls/results, twelve
completed turns, no failed turns, no pending reservations and no runtime settlement waiting. Its final recorded context
was 90,433 tokens. The different request count between live attempts is not attributed to the harness budget change;
model behavior varied. This exercises a substantial same-task history and repeated follow-up admission, but does not
prove behavior at the model's context limit or reproduce every historical long-context failure.

GPT-5.6 Sol, the screenshot's model, was unavailable in both the 1.122.1 and 1.136.1 Copilot profiles. Model-discovery
artifacts retain those blocked attempts. Luna was explicitly selected as supplemental evidence. The first Luna attempt
was stopped when its valid `event.currentTarget` handler exposed missing event data in the oracle. That checker was fixed
and regression-tested before the fresh successful run. The stopped attempt is not counted as a product failure or pass.

## Installation experiment

The isolated upgrade profile was populated using VS Code 1.122.1's actual extension installer: local packaged Alpha
2.1.18 first, followed by the existing packaged 2.1.28. Both directories remained on disk; the CLI listed only
`alphainc.alpha@2.1.28`.

The runner now accepts `--installed-extension <absolute-installed-directory>` inside its owned profile. It launches only
the test sidecar as a development extension, so the source checkout cannot override the installed Alpha artifact.
The installed-extension suite verifies the actual active export, version, directory and bundle hash, then runs the
existing scripted two-turn migration/Node verification workflow. This passed with one active Alpha identity and 11
scripted steps. Evidence: `upgrade-artifacts/9e98501b-9bcb-4c63-b1ab-bc2cb754db05`.

The installed 2.1.28 bundle SHA-256 was
`81d257ffc206a72ec69e415dad3377c551624ecd393d9b8019cb7dd05acca5b5`. This is the previously packaged build, not a new release
of the fix. An initial experiment using an extension-test launch without a development extension never started its
tests and was stopped; the installed mode consequently uses the established sidecar launch path.

This experiment does not support blaming leftover same-ID version folders. Different publisher IDs, another VS Code
profile, a remote extension host, a pending reload, or an actual installation/storage problem on the reporting computer
remain possibilities. Microsoft documents version/profile installation and listing through the
[extension manager](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace) and
[VS Code CLI](https://code.visualstudio.com/docs/configure/command-line), consulted September 10, 2026.

## Validation

### Follow-up screenshot and recovery guidance

A second screenshot supplied later on September 10 shows the same
`primary-change:01a08960-bdc6-70f7-9c2b-830f06bb657b` at content version 13 with eight files, compared with version 9 and
six files in the first screenshot. The missing-receipt completion error remains. This establishes that the same change
set continued to evolve while completion was blocked; the screenshots do not expose reservation IDs, so they cannot
prove whether exactly the same individual receipt remained pending.

The assistant's statement that it called completion prematurely is not an established cause. The runtime already waits
for tracked commands and receipt publishers. The 30-second orphan deadline applies when no tracked operation accounts
for the missing receipt. Its old instruction to resume after an existing operation settles was misleading at that
boundary. The assistant's browser-test claims are also not independently verified by a screenshot of its own report.

The additional deterministic test records six files, strands one edit receipt, successfully records two later files,
shuts down and reloads the actual file-backed store, and checks completion again. The same change-set ID and original
reservation survive, the file count grows to eight, and the content version increases. A successful newer receipt does
not settle the earlier token. Both orphan tests failed against the old recovery guidance before the message change.

The orphan timeout now gives a localized explanation that no active operation is tracked for the missing receipt,
that repeated completion/verification will not repair it, and that the original tool/storage error needs investigation
through detailed diagnostics. The generic decision-read timeout and waits for tracked operations keep their existing
behavior; the deadline, approval policy and durable
records are unchanged. This correction does not implement recovery of an existing orphan or establish the reporter's
original storage/runtime failure. The earlier live runs tested receipt failure handling; they are not rerun or presented
as live validation of this subsequent wording change.

### Completion badge in the original chat

The user confirmed that the third screenshot's green **Task Completed** label is in the original HTML-building chat.
Its report says the stored task ended as `interrupted`. That claim still requires the underlying records to verify,
but inspecting the frontend identified an independent presentation defect: `ChatRow` unconditionally styled every
`completion_result` as successful, regardless of the projected task status. A completion report can remain while
finalization is pending or interrupted, including when removing its success styling cannot be persisted.

The new component regression reproduces the green success label for an interrupted, blocked, failed or unknown task.
All four cases failed before the fix. Completion rows now use a neutral localized **Completion report** label until
the matching task's projected status is `completed`. Both report and legacy ask forms use the same rule. The test also
checks that the label changes when completion is confirmed and that another task's stale snapshot cannot authorize it.
This uses the existing row environment; it adds no transcript-wide subscription or parallel lifecycle state machine.

This corrects the misleading success display; it does not turn an interrupted task into a completed one, repair its
receipt, or prove why the original finalization failed. The subagent-only blocked-history path was also inspected;
it does not establish a cause for this primary-task incident. Old saved tasks without a known completion status now
show a neutral report rather than assuming success.

### Checks

- The new failed-receipt regression was red before the fix and passed afterwards.
- Focused file-receipt, settlement-diagnostic and error-report tests: 13 passed. Adjacent completion/command-outcome
  and webview-message tests also passed.
- Follow-up coverage: five file-receipt tests passed, including the persisted six-to-eight-file reproduction. The 77
  adjacent completion/command-outcome tests passed. The localized-message tests explicitly load the real English
  resources because the production i18n loader intentionally skips resources in unit-test mode.
- Completion-row and adjacent subtask-link component tests: 11 passed. Four interrupted/blocked/failed/unknown-status
  cases reproduced the false success badge before the UI fix. No additional live model calls were used for this display
  regression. Manual visual inspection in the VS Code window was unavailable through this session's UI tools.
- Extension and webview typechecks and lint of touched TypeScript files passed.
- E2E harness unit suite: 362 passed, 2 skipped. After the final runner/workload edits, the 20 affected unit tests passed.
- E2E package compile, typecheck and lint passed.
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` passed all nine tests, including extension activation, modes
  and VS Code LM error/cancellation contracts; the command also rebuilt the extension and webview successfully.
  It passed again after the completion-label change; final log: `completion-label-exact-host.log` under the evidence root.
- `node scripts/find-missing-translations.js` ran and reported existing webview/manifest translation gaps. All 18
  backend locale files, including the added receipt errors, have complete keys. The new completion-report label is
  translated in all 18 webview locales. Unrelated translations were not changed.

No version, dependency lockfile or packaged release was changed. The fix is local and unpublished.

## Repeat the tests

Build and compile once, then use a fresh owned workspace/artifact path for each invocation. The profile can be reused.
`--init-profile` initializes only empty roots or accepts existing ownership markers.

```powershell
pnpm bundle
pnpm --dir apps/vscode-e2e compile

# Choose exactly one case per fresh workspace: --grep vscode, --grep execa, or --grep injected.
# Set this only for the longer workload; omit it for the default three revisions.
$env:ALPHA_E2E_SETTLEMENT_TURNS = '12'
pnpm --dir apps/vscode-e2e exec node out/runTest.js --provider live-copilot --vscode-version 1.122.1 --model-id gpt-5.6-luna --reasoning-effort high --file command-settlement.test --grep vscode --profile-dir F:/alpha-vscode-e2e-runs/20260906/profiles --workspace F:/alpha-vscode-e2e-runs/receipt-repeat/workspace --artifacts-dir F:/alpha-vscode-e2e-runs/receipt-repeat/artifacts --init-profile

# Use --provider scripted and omit --model-id / --reasoning-effort for the model-free equivalent.
# After installing a VSIX in a separate owned test profile:
$env:ALPHA_E2E_INSTALLED_EXTENSION_VERSION = '2.1.28'
pnpm --dir apps/vscode-e2e exec node out/runTest.js --provider scripted --vscode-version 1.122.1 --installed-extension F:/alpha-vscode-e2e-runs/receipt-20260910/upgrade-profile/1.122.1/extensions/alphainc.alpha-2.1.28 --file installed-extension.test --scenario-id dev-local-migration --profile-dir F:/alpha-vscode-e2e-runs/receipt-20260910/upgrade-profile --workspace F:/alpha-vscode-e2e-runs/receipt-repeat/installed-workspace --artifacts-dir F:/alpha-vscode-e2e-runs/receipt-repeat/installed-artifacts --init-profile
```

For the reporter's exact incident, obtain **Get detailed error info** and the Alpha/extension-host output around
`2026-09-10T03:52:13.913Z`, especially the first earlier tool/persistence error and any window reload. The screenshot alone
cannot establish which reservation was stranded or why its durable write failed. Preserve the existing task storage
before attempting repair; this investigation does not authorize deleting its ledger or claiming its work verified.
