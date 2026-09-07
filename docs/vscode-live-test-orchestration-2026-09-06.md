# Live VS Code testing implementation coordination

This run implements Linear NOR-40 through NOR-43 in parallel. The existing extension runner is the integration point;
the production agent is not replaced. VS Code 1.122.1 remains the reference host and 1.136.1 is the forward-compatibility
target. Scripted evidence and live Copilot evidence must be reported separately.

## Ownership

| Ticket | Implementation ownership                                                     | Isolated worktree |
| ------ | ---------------------------------------------------------------------------- | ----------------- |
| NOR-40 | Host/profile launch, live LM preflight, shared runner/index/package wiring   | `15ba/Alpha-Code` |
| NOR-41 | Scenario driver, repository fixtures, independent outcome assertions         | `c8b4/Alpha-Code` |
| NOR-42 | Evidence capture/classification, storage fault and offline-recovery tests    | `7bac/Alpha-Code` |
| NOR-43 | External campaign controller, budgets, owned-host lifecycle, repair sequence | `b4f4/Alpha-Code` |

Each lead runs Astra xhigh and uses bounded Luna Max subagents for disjoint implementation or test work. The parent task
owns integration in the original checkout, final validation, and Linear status. Leads preserve inherited uncommitted
changes and report only their incremental changed files. They do not mark tickets complete before integrated verification.

NOR-41 and NOR-42 build independent modules while NOR-40 establishes launch contracts. NOR-43 implements its controller
against explicit injected operations, then must connect the actual runner/scenarios/evidence modules. Injection-only tests
are not sufficient proof that the integrated controller works. Shared runner and manifest changes are coordinated through
NOR-40 rather than independently rewritten by each lead.

## Integration gates

- All generated profiles and test repositories are dedicated campaign resources, separate from the source checkout and
  the user's normal VS Code profile. Persistent resources are not silently discarded after a failure.
- Default runner imports have no launch side effects. Existing disposable smoke and fixture behavior remains available.
- External budgets and process ownership survive a failed host; cancellation must settle owned processes and timers.
- Artifacts identify the actual bundle, host, model/configuration, task IDs, and measured outcomes without exposing secrets.
- Only validated test resources can be mutated or repaired. The original unknown-owner lock is not removed while user
  extension hosts are running. No age-based ownership shortcut is authorized.
- Narrow deterministic tests, package lint/typecheck, exact-host smoke, and forward-host checks precede the live campaign.
- Authentication, model availability, unsupported effort settings, and credit limits are explicit blockers, not passes or
  reasons to substitute a different provider. User interaction may be needed once to authenticate dedicated profiles.
- A ticket with unverified live acceptance remains open, even if its deterministic checks pass.

## Agreed integration seams

NOR-40 owns side-effect-free `readRunOptions` / `runExtensionTests` exports and a separate `live-copilot` provider mode.
Persistent profiles, scenario workspaces, artifacts, actual host version, model ID, and effort are explicit inputs.
NOR-41 supplies the `workflow.test` host entrypoint and scenario selection/phase/result paths. Reload preparation produces
`checkpointed`, never a successful overall result until continuation succeeds with the same task ID.

NOR-42 supplies the bounded evidence manifest and capture operation. NOR-43 adapts scenario results into campaign results
and runs the actual runner out of process. Scenarios and campaigns distinguish passed, failed, blocked, and checkpointed
states, with safe failure categories, independent checks, and truthful request accounting. Missing request counts are
unknown, not zero; launch count alone is not a provider-request budget.

Persistent-profile ownership is separate from directory recognition. A marker does not authorize adoption or termination
of an already-running manual setup host. Cancellation must settle owned work before another attempt or offline repair.
Standalone Node tests use `.spec.ts` names so the existing Mocha `.test.js` discovery does not import them accidentally.

## Integrated result, September 6, 2026

All four implementation handoffs are integrated in the original checkout: persistent live-provider profiles, realistic
workflow scenarios, bounded evidence and offline storage recovery, and an external campaign controller. This is extension
test infrastructure, not a replacement production agent. Live acceptance is still blocked and must not be marked complete.

### Validation actually observed

| Check                                                              | Result                                                                                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| E2E compile, ESM `check-types`, ESLint, touched-file Prettier      | Passed                                                                                                                      |
| Current compiled Node unit suite (including failure diagnostics)   | 282 tests: 280 passed, two POSIX-only skips, zero failures                                                                  |
| Full `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`        | Passed: bundle step, explicit webview rebuild, eight actual reference-host checks                                           |
| External scripted matrix, final post-retention rerun               | Four scenarios on each host: eight passed, zero failed/blocked, 176 scripted requests; both long cases have 12 turns        |
| Reused-profile external campaign on 1.136.1                        | Cancellation/resume passed, six scripted requests, existing external profile root reused                                    |
| Full storage fault → close → offline quarantine → new healthy host | Passed separately on 1.122.1 and 1.136.1                                                                                    |
| Integrated concurrent shared-storage mode                          | Passed separately on both hosts: two distinct extension hosts, two completed scripted tasks, complete held evidence per run |
| Zero-matching-tests regression on actual 1.122.1                   | Before: erroneous exit 0/pass. After: exit 1, `no-tests-executed`, executed count 0                                         |
| Real Copilot discovery setup on 1.122.1                            | Passed: 22 models, exact `gpt-5.6-luna` ID/family; Finish closed the owned host and released its lease                      |
| Normal-host saved state across actual process restart              | Passed on both versions for three synthetic markers; actual Copilot/Alpha access also survives restart on 1.122.1           |
| Actual storage-budget admission stop                               | Expected nonzero `storage_budget`, zero provider requests, retained admission/report evidence                               |

The latest `pnpm --dir apps/vscode-e2e test:unit`, package ESM typecheck, and package ESLint passed after integrating
retention, persistent setup, and the long-thread collector/contract fixes. The fresh extension bundle and full reference-host
gate passed after the native-package fix described below, after shared-storage integration at 19:07:55 UTC, and after
the normal-host persistence adapter at 20:33:33 UTC. The post-change scripted
matrix completed at 18:52:40 UTC and was independently audited. Bundle SHA-256 remained
`5e357636a8549b2051a7116c526fc2e549f4c7078b29e1a65d829b547b8c3792`.

The full gate initially failed because the local dependency tree was incomplete, then restoration hit a locked esbuild
executable. After informing the user, the orchestrator stopped only the identity-verified Alpha Vite and esbuild watch
processes (34108 and 57120); their esbuild children exited with them. `pnpm install --frozen-lockfile --force --ignore-scripts`
then completed using pnpm 10.8.1 / Node 20.19.2. The lockfile was unchanged. No editor was closed. Restart `watch:webview`
and `watch:bundle` through the existing VS Code development tasks when returning to watch-mode development.

The matrix ran one sample per host/scenario, not a statistical reliability benchmark. It exercised review/edit/test/local
commit/follow-up, cancellation/resume, saved-task continuation across a real process restart, and a six-turn dependent
workflow in the earlier matrix, and a 12-turn dependent workflow in the final rerun. Token and cost metrics were unavailable
and remain null. A completed matrix never erases earlier failed samples.

### Failures found and fixed in the test harness

- Cancellation follow-up incorrectly treated posting a webview message as admission of new guidance. It now subscribes
  before dispatch and waits for the exact new same-task feedback event, preserving the cancelled task instance.
- Reload configured the scripted provider but did not restore the full explicit test approval policy before saved-task
  construction. Applying the bounded policy first fixes the harness setup without resetting history or weakening policy.
- The wait helper leaked its deadline timer when its condition rejected. Cleanup now runs on every exit path.
- Inherited Node test context could produce an apparently successful fixture subprocess with no tests. The fixture clears
  that context, uses the extension host's appropriate Node mode, and verifies an executed TAP test count.
- Mocha could similarly report zero failures for zero matches or all skipped tests. The host now records execution counts
  and fails closed when no non-pending test ran; explicit discovery/consent-only setup is not a workflow pass.
- Interactive setup previously closed after an unsuccessful check. It now remains open through empty catalogs, missing
  consent, and dismissed controls, until explicit Finish after readiness or Cancel. There is no default setup deadline;
  optional deadlines are explicit. Regression tests cover single-flight checks, cancellation/draining, and late results.
- Retention was implemented but not connected to finalization. The runner and campaign now consume explicit retention
  receipts, protect failed/incomplete/in-use evidence, and release eligible passing runs only after durable reporting.
  A bounded metadata-only storage scan gates each phase. Unknown or over-budget storage blocks admission; this is not
  a hard disk quota and cannot prevent one operation or an external writer from overshooting between scans.

Regression tests cover these boundaries. The original cancellation/reload failures and the zero-test red baseline remain
retained. Later workflow runs used fresh owned fixtures; failing workspaces were not reset to manufacture a pass.

### Retained local evidence

All paths below are relative to the private run root `F:/alpha-vscode-e2e-runs/20260906/`:

- `campaign-matrix/scripted-matrix-20260906-01/report-00010.json`: eight-scenario final report and linked attempt evidence.
- `campaign-matrix/scripted-retention-matrix-20260906-01/report-00007.json`: preserved failed 12-turn capture/contract sample.
- `campaign-matrix/scripted-retention-matrix-20260906-02/report-00011.json`: final post-fix eight-case matrix, 176 requests,
  complete retained evidence. Both long workflows recorded 218 passing checks and 57 requests; all ten phase receipts
  include verified actual host identity, owned closure, and complete capture. Independent artifact/source hashes,
  12-turn lifecycle projections, tool-call/result pairing, and retention publication ordering were verified.
- `campaign-reused-profile/reused-profile-20260906-01/report-00003.json`: actual `--profile-dir` reuse smoke.
- `scripted-artifacts/no-tests-before-1221-01/` and `no-tests-after-1221-01/`: actual false-green regression pair.
- `scripted-artifacts/workflow-cancel-1221-01/` and `workflow-reload-1221-continue-01/`: original harness failures.
- `restart-1221-01/storage-restart-0006.json` and `restart-1361-01/storage-restart-0006.json`: complete two-host recovery
  receipts. Each fault made zero provider requests and recorded one failed terminal; each new healthy host made one
  scripted request and recorded one completed terminal. Both runs preserved hashes of five existing task-history files.
  These new fixtures had no existing `agent_control.json`; preservation of existing control bytes is separately covered
  by real-filesystem regression tests. Neither absence nor quarantine is described as deletion of control data.
- `setup-artifacts/copilot-discovery-1221-01/run-result.json`: authentication blocker, complete evidence capture, observed
  host exit, and verified runner ownership. Setup waited for interactive sign-in/Continue setup and timed out without it.
- `setup-artifacts/copilot-discovery-1221-02/`: empty-catalog evidence for the setup window that closed too quickly.
- `campaign-matrix/storage-budget-stop-20260906-01/report-00003.json`: actual one-byte storage-budget stop with zero
  provider requests and a durable admission record. This is an expected blocker test, not a passing workflow.

Only the exact injected transaction lock in each dedicated restart fixture was moved to a recoverable
`.offline-quarantine` sibling, while the runner still held its exclusive lease and after all recorded storage-writer PIDs
were verified dead. The user's normal-profile empty lock remains untouched. The cause of its empty publication is still
unknown; injected reproduction is not proof of the original writer or a repair of the user's existing profile.

### Remaining acceptance and next live run

The user completed discovery setup in `copilot-discovery-1221-03`: Copilot returned 22 models, including exact ID and
family `gpt-5.6-luna`. Explicit Finish closed the owned host at 19:26:00 UTC with exit 0, complete evidence, and lease release.
The persistent profile is `F:/alpha-vscode-e2e-runs/20260906/profiles/1.122.1/`; do not reset it or copy credentials. Alpha's
static capability resolver supports High for this family, but actual Alpha-specific access and live requests remain
unverified. The first restarted live campaign was blocked by an empty model catalog before task creation; see below.
Use High for live Copilot checks as the user's latest selection; the Codex development workers' Max setting is separate.
Rendered UI submission/visible recovery and simultaneous hosts sharing storage also require separate acceptance; webview
transport and projected state do not prove what is rendered. The ordinary launcher rejects a second same-profile lease.
The specialized one-lease shared-storage mode passed one integrated sample on each host version. It proves simultaneous
text-only task execution and durable shared state, not concurrent tool-mutation stress. Native UI control was unavailable and the E2E package has no real-renderer
driver. The existing JSDOM persisted-recovery test passed separately in the scenario lead's worktree (one selected,
101 skipped); that is not actual VS Code renderer acceptance. The source-boundary audit is in
`docs/vscode-workflow-scenarios.md`, "Remaining acceptance gaps". Keep the incomplete tickets open in Linear.

The following setup command is for initial setup or explicit consent/reauthentication, not a prerequisite before every run:

```powershell
pnpm --dir apps/vscode-e2e test:copilot --vscode-version 1.122.1 --profile-dir F:/alpha-vscode-e2e-runs/20260906/profiles --workspace F:/alpha-vscode-e2e-runs/20260906/setup-workspace --artifacts-dir F:/alpha-vscode-e2e-runs/20260906/setup-artifacts --setup
```

Choose **Continue setup** to check once; the window remains open. Use **Copilot test setup** in the status bar to retry or
explicitly **Finish** after readiness. Then follow `docs/vscode-live-test-profiles.md` to select the exact discovered model
and verify Alpha's own consent and High effort. Repeat for 1.136.1 using the version-separated profile. No live
scenario should start before that preflight succeeds. The campaign entry point now compiles its runner automatically:

```powershell
pnpm --dir apps/vscode-e2e test:campaign --config C:/alpha-tests/campaign.json --root C:/alpha-tests/runs --profile-dir F:/alpha-vscode-e2e-runs/20260906/profiles --init-root
```

Use a new empty campaign root and a new configuration ID; see `docs/vscode-test-campaigns.md` for the bounded matrix schema.
Report-only is the default. Opted-in source changes require a pre-reviewed regression/diagnosis/hash-checked patch plan;
the controller does not autonomously diagnose arbitrary bugs or generate fixes. No source commit or push was performed.

## Integration review ledger

These are review requirements, not claims that verification has completed:

- Runner failures retain closed actionable classes, including authentication/model/effort/version/ownership failures.
- Provider-request budgets are enforced before dispatch, including retries; unknown usage is never treated as zero.
- Transcript validation matches call IDs with exactly one result, not merely equal aggregate counts.
- Reload verifies the saved task and repository commit; long-thread follow-ups make dependent state changes.
- Evidence capture loops across short reads, detects source changes, and reports missing required evidence explicitly.
- Source ownership is checked independently of artifact-directory ownership. Root validation occurs before filesystem
  mutations and respects platform case sensitivity and symlink/junction boundaries.
- Campaign completion is distinct from passing all scenarios; reproduced failures in report-only mode remain failures.
- Process timeout, termination failure, and early-root-exit cases must not authorize repair using unverified quiescence.
- Internal webview projection checks are not described as rendered-UI or real F5 interaction tests.

## Follow-up audit: post-retention real-host runs

This is a focused follow-up audit of testing infrastructure, not a claim that the extension is free of defects.

- **Verified:** `restart-retention-1221-01/storage-restart-0008.json` and
  `restart-retention-1361-01/storage-restart-0008.json` both passed the complete injected failure/offline quarantine/healthy
  restart sequence. Each fault recorded zero requests and one failed terminal; each healthy task recorded one scripted
  request and one completed terminal. Both versions preserved five task-file hashes, recorded unchanged absent initial
  control data, and retained complete, held evidence for both phases. Independent artifact hash/length audits passed.
- **Found and fixed:** `campaign-matrix/scripted-retention-matrix-20260906-01/report-00007.json` stopped with
  `evidence_failed` after three passing scenarios on 1.122.1. The 12-turn task's own receipt reports 57 requests and 218
  passing checks, but the campaign validator rejects more than 200 checks. Independently, its 278,834-byte lifecycle log
  exceeds the collector's shared 256-KiB whole-file input limit. It contains 501 records, below the 2,000-event limit.
  The overall campaign was correctly not reported as passing; its old aggregate usage remains unknown. Do not rewrite
  these original receipts. The correction uses one shared 1,024-check contract, separates the bounded source-reading
  budget from output limits, streams JSONL with change detection, and preserves validated usage through later evidence
  failures. Regression tests fail on the old boundaries. Matrix02 above passed both 12-turn cases, including complete
  capture of the 278,840- and 278,837-byte lifecycle logs. The incomplete original run remains protected; four complete phase receipts became eligible
  only after durable terminal reporting, and the final prune kept all five current phase directories.
- **Verified experiment and integrated mode:** two actual 1.122.1 extension hosts shared the same canonical global
  storage and control file while both tasks were inside their scripted provider calls. Both completed, offline control
  data contained both completed task IDs, and the owned process family was verified closed. Evidence is under
  `C:/Users/Luke Goblirsch/AppData/Local/Temp/alpha-pair-spike-IEY51k/artifacts/0ce44521-83d6-436e-a44c-bb1913cc21db/`.
  This is one text-only sample, not tool-contention or rendered-UI coverage. The first retained experiment failed before
  provider dispatch because its scripted fixture omitted the required top-level registration ID. A regression using
  the real production adapter's registration/rehydration contract preceded the corrected experiment. A specialized
  mode in the existing campaign entrypoint is now integrated; no second production task engine is introduced. The fresh
  integrated runs passed on both versions with two verified distinct extension hosts, a shared provider barrier, two
  completed tasks, two scripted requests, unchanged bundle hash, verified cleanup, released lease, and complete held
  capture. Reports are `shared-storage-1221-01/shared-storage-f830ce16-3da9-4929-8dec-89313ed32e5a.json` and
  `shared-storage-1361-01/shared-storage-a45245d2-eaec-41ff-8500-396b4ecf4861.json` under the private run root. A final review
  found that deadline expiry during cleanup/capture could falsely pass; two red regressions preceded the fix. Safe cleanup
  still drains, while the final outcome accounts for expired budgets. All 29 focused shared-storage tests passed in the
  main 227-test suite. These are one text-only sample per version, not load, tool-mutation, or live-provider proof.
  Independent read-only audits matched all nine captured artifacts, seven control/task source hashes, and 31/35 log
  source hashes for the respective hosts. Actual extension-host logs matched both PID pairs, all recorded host/controller
  processes were absent afterward, and lease/transaction-lock/eligibility-marker absence agreed with the held reports.
- **Build blocker fixed and validated:** the later full exact-host gate failed during a fresh extension bundle, before its
  host checks. The old native-library inventory lists only three x64 packages, while resolved LanceDB 0.27.2 declares
  seven optional native packages, all installed after forced dependency restoration. Esbuild attempts to bundle four
  omitted ARM `.node` entries and fails. An in-memory reproduction confirmed metadata-derived externals eliminate those
  errors. A single validated metadata-derived inventory now drives both copying and externalization; malformed installed
  packages and output-name collisions fail closed. The failed build temporarily removed `src/dist/extension.js`; a fresh
  successful `pnpm bundle` restored it before subsequent host validation.
  Copying all seven installed bindings preserves the existing installed-package policy but totals approximately 827 MB
  before compression in this all-architecture dependency environment. Ten focused native-package tests, full extension
  typecheck/lint, fresh bundle, `pnpm vsix`, the contents verifier, and the full exact-host gate passed. The resulting
  `bin/alpha-2.1.24.vsix` contains 1,788 entries (331.94 MB compressed); all seven archived native binding hashes match
  the distribution, and the Windows x64 binding loads locally. This is not execution coverage for the other architectures.
- **Authorization verified on 1.122.1; live workflows not yet verified:** after real user sign-in and normal window
  close, the fresh `copilot-persistent-setup-1221-02` host discovered 22 models, selected exact `gpt-5.6-luna` with High,
  and read `canSendRequest: true` from Alpha's own access information. No setup request probe was needed. The old
  extension-test launch used an in-memory state database; the normal-host correction also passes synthetic persistence
  on both versions. Actual authorization on 1.136.1 and live task execution remain separate acceptance boundaries.
  Rendered-UI submission/recovery remains unavailable with the current native-control tooling. No live Copilot request
  has been counted as passing, and no claim of zero errors or broad statistical reliability is made.
- **Out of scope:** CLI/shim changes, production agent rewrites, and repair of the user's normal-profile unknown-owner
  lock. Existing unrelated changes remain preserved.

### Ticket disposition

NOR-42 is Done: bounded evidence and dedicated-profile recovery acceptance passed with independent audits. NOR-40 and
NOR-43 remain In Progress for the remaining setup/evidence issues and bounded live-Copilot acceptance. Retained Alpha
access is now verified on 1.122.1; its first authenticated workflow is blocked by an upstream Copilot exception below.
NOR-41 remains In Progress
for rendered submission/recovery and live validation; its workflow and integrated shared-storage scripted cases pass.
The focused clean-code review required regression-first fixes and explicit finite-evidence boundaries; it is not a full
repository audit or proof that the user's original incident is resolved.

## First live restart: persistent profile, empty startup catalog

The first report-only live campaign reused the **same** 1.122.1 profile directory, exact catalog ID `gpt-5.6-luna`,
and requested High. Configuration `F:/alpha-vscode-e2e-runs/20260906/live-review-luna-high-1221-01.json` limits work to one
review/edit/test/local-commit/follow-up sample, one attempt, 60 requests, and a ten-minute attempt deadline. Its immutable
terminal report is `campaign-live/live-review-luna-high-1221-20260906-01/report-00004.json` under the private run root.

The host closed after approximately 4.6 seconds, before creating any Alpha task. Preflight recorded `model-unavailable`,
`modelCount: 0`, no selected model, and no request probe. Capture and retention completed, the profile lease was released,
and the campaign correctly stopped. Aggregate usage remains unknown/null because no workflow usage receipt exists; this
is not a passing live-model sample. Original failure artifacts remain protected and are not rewritten.

The exact host log records eager extension activation, but no Copilot activation before shutdown. The earlier setup host
did activate built-in `GitHub.copilot-chat` 0.50.1 and later discovered the catalog. VS Code 1.122.1 source at commit
`8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e` does not make extension-test execution wait for every `onStartupFinished`
activation. Its language-model service can return an empty catalog before a vendor/provider is registered. These facts
identify a missing provider-readiness boundary in the E2E preflight; they do not prove that saved authentication was lost.

A focused correctness follow-up added a bounded installed-provider activation/catalog-readiness barrier with
regression tests. It retains exact model/effort and Alpha consent checks, uses no blind model-request retries, performs
no installation or enablement changes, and does not manipulate credentials. The integrated suite passed 250 of 252 tests
with two platform skips; package lint/typecheck and touched-file formatting passed. The full exact 1.122.1 smoke gate
also passed at 19:55:03 UTC after the webview build. The next real workflow is held for
the separate storage-mode defect below. This pass is not a production provider rewrite or an authentication bypass.

Primary sources checked on 2026-09-06: the exact installed host's extension-host and language-model service code, plus
[VS Code's Language Model API contract](https://code.visualstudio.com/api/references/vscode-api#lm), which specifies empty
catalogs and re-querying when the model set changes. A model-change event alone cannot guarantee provider activation.

## Persistence root cause: extension-test storage is intentionally ephemeral

Exact VS Code 1.122.1 `StorageMainService.getStorageOptions()` sets `useInMemoryStorage` whenever
`extensionTestsLocationURI` exists. This applies to application, shared application, profile, and workspace databases.
Before the correction, the E2E launcher unconditionally passed `--extensionTestsPath`, including interactive setup. Thus signing in
successfully inside one setup window does not persist its underlying state across process restarts. The earlier claim
that saving the profile directory was sufficient was incorrect. The explicit `--use-inmemory-secretstorage` flag is a
different layer and is not the only way the underlying state can be ephemeral.

The source condition was verified in the installed compiled exact host and the corresponding
[upstream storage service](https://github.com/microsoft/vscode/blob/8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e/src/vs/platform/storage/electron-main/storageMainService.ts#L98-L101).
No credential databases were inspected. Windows normal-host GitHub authentication also uses application-shared storage,
whose default location is outside the per-profile user-data directory; a normal-host test adapter must explicitly own
that location rather than silently reuse the user's normal shared store.

The next live campaign is not launched. The bounded follow-up is a normal development-host entry for persistent live
setup/workflows, retaining the existing deterministic extension-test gates. Require a non-secret memento
write/close/reopen/read regression on both target versions before requesting sign-in again. Credential copying,
patching downloaded VS Code binaries, bypassing Alpha consent, or weakening encryption are excluded. Authentication
persistence and live acceptance remain unchecked in NOR-40.

### Actual red persistence regression on both target hosts

`suite/profile-persistence.test.ts` writes a unique non-secret sentinel to Alpha's real `globalState` and
`workspaceState` during `prepare`, then checks those same keys in a fresh `continue` host using the same dedicated
profile and workspace. No provider request is made and no authentication store is read. On both **1.122.1** and
**1.136.1**, prepare saw both values, but the restarted host saw neither value and failed the intended persistence
assertion. Both reported extension mode 3 (Test); their main-process logs explicitly report `:memory:` databases.
Thus this is a reproduced host-mode defect, not an inference from empty model catalogs.

The four immutable phase artifacts are under
`F:/alpha-vscode-e2e-runs/20260906/persistence-probe/artifacts/persistence-testmode-{1221,1361}-{prepare,continue}-01/`.
Each contains `profile-persistence.json`, actual-host preflight, complete evidence capture, and a numeric owned-close
receipt. The two continuation failures are protected from pruning. The compiled 1.136.1 storage condition matches
the reference host; its installed product commit is `a44adf7f53e00964ab890f9f8758a334f1fc15bc`.

The expanded `-02` phases additionally store the public synthetic nonce through Alpha's `context.secrets` API under
one unique probe-owned key. They never enumerate keys or read real authentication entries. Both versions retained all
three values inside prepare and lost all three after restarting: global memento, workspace memento, and synthetic
SecretStorage value. All four `-02` phases completed capture/retention and observed numeric owned host close. These
runs are explicitly held for the investigation; their expected failing continue receipts are not live-task passes.

The normal-development-host adapter was then approved for implementation in the existing E2E runner, with a mandatory
nonce/identity-correlated terminal receipt, graceful owned-window close, and separate owned shared storage. The exact
same sentinel suite must pass after that change. This does not yet establish Copilot credential persistence, Alpha
consent, or a passing live workflow.

### Actual green persistence regression on both target hosts

The bounded normal-development-host adapter is integrated. Live Copilot automatically uses it, without
`--extensionTestsPath`; deterministic test gates keep their existing default. Programmatic scripted diagnostics select
the same path with `runExtensionTests(options, { launchKind: "development-sidecar" })`.

The identical expanded sentinel suite passed prepare and fresh-host continue on **both 1.122.1 and 1.136.1**. All three
values survived restart: global state, workspace state, and the public synthetic SecretStorage marker. Each phase
reported extension mode 2 (Development), exact host version, matching launch/start/completion nonces and process
identities, normal numeric close, complete capture, and held retention. Using the same marker name on the second
version also verified that its prepare phase could not already read the first version's values. Both main-process
logs point to their own `profiles/<version>/shared-data/sharedStorage/state.vscdb`, not `:memory:` or normal editor
shared storage. No database contents were inspected.

Evidence is under `persistence-probe/artifacts/persistence-normal-{1221,1361}-{prepare,continue}-01/` in the private run
root. Independent receipt checks matched correlation fields and found all recorded launcher/extension-host processes
absent afterward. The integrated Node unit suite passed **272 of 274 tests**, with two platform skips, zero failures,
and passing E2E lint/typecheck. The final full exact-host smoke rerun passed at 20:33:33 UTC, including the explicit
webview rebuild and all eight reference-host checks.

This resolves the reproduced state-loss defect. It does not establish retained GitHub authorization, a real Copilot
request, or long-horizon live reliability; those remain the next acceptance boundary. A fresh interactive setup can
now use the persisted normal host rather than repeating sign-in inside an intentionally ephemeral test database.

The full review/edit/test/local-commit/follow-up scenario also passed in normal-development mode on both versions,
with 74 independent checks per run, the scripted provider, verified terminal completion, observed owned close, and
complete held evidence. The run IDs are `normal-scripted-review-1221-01` and `normal-scripted-review-1361-01` under
`normal-workflows/artifacts/`. This is a real extension/tool workflow using deterministic responses, not live Copilot.

### Real Copilot access survives the corrected profile restart

The user signed in through corrected setup `copilot-persistent-setup-1221-01`, then closed that dedicated window
normally. Its terminal run result correctly records `host-cancelled`, not successful setup: Finish was not selected.
Capture completed, the owned profile lease was released, and both recorded host processes and all other processes
referencing this exact dedicated profile were absent before relaunch. No credential storage was inspected or reset.

Fresh setup `copilot-persistent-setup-1221-02` reused the same `profiles/1.122.1` and `setup-workspace`. Its preflight at
**21:18:59 UTC** reports actual 1.122.1, `ready: true`, 22 models, exact `gpt-5.6-luna` ID/family, supported/applied High,
and Alpha-owned `canSendRequest: true`. Authentication status is available; no request probe ran. Evidence is
`setup-artifacts/copilot-persistent-setup-1221-02/live-copilot-preflight.json` under the private run root. This establishes
retained Copilot/Alpha access on that host, not a real model response or a passing workflow.

The user reported the status-bar setup picker did not open in the first window. The computer-use helper also fails
to attach to the dedicated host with a window-owner mismatch, despite listing its correct title. This UI problem is
unresolved; do not count rendered setup interaction as validated or erase the failed first run. A manual close after
verified readiness remains a non-passing setup outcome, even if a later independent workflow succeeds with the profile.

### Authenticated workflow: upstream Copilot exception on exact 1.122.1

The second bounded live campaign, `live-review-luna-high-1221-20260906-02`, reused the saved profile without setup.
Its noninteractive preflight again passed for exact Luna with High and Alpha access. The single sample then stopped
after 10.7 seconds: one executed Mocha test failed, no Alpha task was created, and no workflow result was written.
The terminal campaign report is `campaign-live/live-review-luna-high-1221-20260906-02/report-00004.json`; its outcome is
blocked/infrastructure (`host-failed`), not a live task pass. Request/token/cost usage remains unknown/null.

Independent inspection found that VS Code Git opened the newly initialized fixture at **21:22:40.932 UTC**, followed
by an uncaught `TypeError: e is not iterable` at **21:22:40.951 UTC** inside built-in Copilot 0.50.1, not Alpha. The stack
points to `copilot/dist/extension.js:1167:19963` (`g3e.setItems`) through `kP.init:3174:1663`, a Git branch observer.
Mocha's failed-suite receipt precedes normal sidecar close. This run is not evidence of the crash/respawn loop reported
elsewhere: the observed extension host exited normally after the failed suite.

[Upstream issue 319423](https://github.com/microsoft/vscode/issues/319423), checked **2026-09-06**, reports the identical
version and stack. Its proposed Claude-participant cause and suggested newer-build remedy are not independently
verified here. Do not patch downloaded Copilot/VS Code, suppress its uncaught errors, or change fixture timing merely
to obtain a passing result. Live 1.122.1 retries are stopped under the user's host-compatibility blocker condition.
Live 1.136.1 and long-horizon reliability remain unverified; the exact deterministic release gate remains unchanged.

Two harness diagnostics required repair: setup-02's manual-close path truncated `host-preflight.json` to zero bytes,
and the normal host's ignored console pipes left Mocha's specific failure out of structured run evidence. The separate
`live-copilot-preflight.json` remained intact. Original evidence is preserved; neither diagnostic weakness invalidates
the observed access check nor turns the failed workflow into success.

### Regression-backed failure evidence correction

The follow-up changes only three E2E files: `suite/index.ts`, new `suite/preflightEvidence.ts`, and its unit tests.
Lifecycle preflights now publish through one serialized temp-write/rename queue. Serialization failures cannot let
later updates overtake an in-flight write, and a failed exclusive temp creation never deletes an existing file.
If a write fails after creating a partial temp, that uncertain temp is retained in the failed run for inspection;
the previously published preflight remains intact. No stale preflight or manual close is promoted to success.

Mocha's existing failure event now records at most eight diagnostics in `host-preflight.json`. Each contains a closed
error type, runnable kind (including uncaught), inferred source category, and at most three constant code-location labels
with bounded line/column numbers. Source categories are diagnostic hints, not ownership or approval authority. Titles,
messages, raw stacks, arbitrary path suffixes, and provider payloads are not serialized. Source parsing is bounded to
16,384 characters and 64 lines. The normal failed-suite outcome is unchanged; no exception is swallowed.

The parent rejected an additional workflow catch/fallback patch: it does not cover an external uncaught exception that
Mocha completes outside the workflow's async promise. The focused review also caught and corrected an intermediate queue
ordering defect and a path-redaction gap before integration. Eight focused tests, the full parent E2E unit suite
(280 passed, two platform skips), package typecheck, and lint passed. The full exact-host smoke rerun passed at
**21:47:34 UTC**, including the explicit webview rebuild and all eight 1.122.1 checks. No live Copilot retry was run.
