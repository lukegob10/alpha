# Dedicated VS Code live-Copilot test profiles

This extends the existing extension-host runner. It does not replace the scripted or VS Code LM fixture gates, and it
does not modify the CLI or VS Code shim. VS Code **1.122.1** remains the release-gating host; **1.136.1** is the additional
compatibility target. A passing setup/preflight is not a passing Alpha task or a reliability benchmark.

**Persistence corrected 2026-09-06:** live runs now use the normal development-host path below. The actual
write/close/reopen/read regression passed on **both 1.122.1 and 1.136.1** for Alpha's global memento, workspace memento,
and a synthetic SecretStorage value. The previous extension-test path failed the same test because its underlying
state database is intentionally in memory. A separate real sign-in/close/reopen check on **1.122.1** subsequently
confirmed Alpha-owned `canSendRequest: true` for exact Luna with High, without a setup request probe. Authorization on
1.136.1 and actual live workflows remain unverified. No credentials were copied or inspected.

**Current live blocker:** the authenticated 1.122.1 workflow hit an uncaught exception in its bundled Copilot 0.50.1,
before an Alpha task was created. Repeating sign-in does not address that failure.

## Persistent storage requires a normal development host

Live Copilot now uses `launchKind: development-sidecar`: a normal Extension Development Host with Alpha and the small
E2E sidecar loaded as development extensions, **without `--extensionTestsPath`**. The sidecar invokes the existing suite;
model selection, setup controls, tool execution, scenarios, assertions, and request budgets are not reimplemented.
The fixed sidecar manifest is materialized atomically in the existing compiled `out/` directory before launch. That
directory is the sidecar extension root, so compiled suite modules have a recognized VS Code API identity.

The previous test-mode launcher was incompatible with saved authentication/settings: VS Code forces its application,
shared, profile, and workspace storage into memory when `extensionTestsLocationURI` is set. A directory surviving on
disk did not prove those values survived. The coordinating thread reproduced this on **2026-09-06**, on both exact
hosts: a random test value matched `globalState`, `workspaceState`, and a uniquely named synthetic SecretStorage entry
in the first process; all three were missing after a fresh launch. These probes do not read real authentication entries.
Reference: [exact 1.122.1 storage implementation](https://github.com/microsoft/vscode/blob/8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e/src/vs/platform/storage/electron-main/storageMainService.ts#L98).

Normal live hosts also receive an owned `--shared-data-dir` under `profiles/<exact-version>/shared-data`. Existing
schema-1 profile markers and user-data/extensions directories remain intact; no credentials or stores are copied,
migrated, or reset. Symlink/reparse escapes are rejected before creating shared data. Both exact versions support this
argument: [1.122.1](https://github.com/microsoft/vscode/blob/8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e/src/vs/platform/environment/node/argv.ts#L122)
and [1.136.1](https://github.com/microsoft/vscode/blob/a44adf7f53e00964ab890f9f8758a334f1fc15bc/src/vs/platform/environment/node/argv.ts#L122).

Deterministic scripted and LM-fixture gates retain their default `extension-test` launch. For an explicit, owned,
scripted persistence diagnostic, programmatic callers may use
`runExtensionTests(options, { launchKind: "development-sidecar" })`. This does not add a CLI mode flag or change default
gates. Live Copilot cannot be overridden back to the in-memory test mode.

Normal hosts publish `live-host-started.json` and then `host-completion.json` in their exclusive run directory. These
small, strictly validated receipts correlate run ID, per-launch nonce, exact host version, launch kind, and process
identity. Completion is mandatory: zero exit or an earlier passing preflight is insufficient. Manual early close,
missing/stale/malformed receipts, failed suites, and nonzero host exits remain failures. `run-result.json` records the
completion path/status; the raw receipts are retained run-owned sidecars, not copies inside the projected manifest.

Startup has a **60-second** deadline. After a valid startup receipt, interactive setup may wait indefinitely unless the
user supplied its explicit timeout. Following terminal completion, the sidecar requests normal window close to permit
storage flushing; the launcher requires a numeric exit within **10 seconds**. A startup/close timeout does not force-kill
a window or fabricate an exit: `hostExitObserved` remains false, the lease and source data stay retained, and the run is
not eligible for cleanup. Evidence collected while a writer may remain alive is diagnostic, not proof of quiescent
storage. Close that dedicated window normally and inspect ownership before another launch.
Normal hosts do not inherit the campaign runner's console pipes, so a retained window cannot hold those handles open.
Use the safe receipts and existing owned profile logs for diagnostics; deterministic test-mode console output is unchanged.

Before asking for sign-in again, run the coordinating persistence probe through write → owned close → fresh read on
both target versions, requiring all three synthetic values to survive. Even that passing result does **not** prove
GitHub authorization; verify actual Copilot/Alpha access separately. Development-mode webviews use Alpha's existing
local HMR probe and built-HTML fallback; do not change production behavior or serve an unrelated Vite UI for acceptance.

## Prepare and discover

Use the repository toolchain: Node 20.19.2 and pnpm 10.8.1. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm bundle
pnpm --filter @alpha-code/vscode-webview build
pnpm --dir apps/vscode-e2e compile
```

Choose three **absolute**, separate locations outside this checkout and outside normal VS Code data. For example,
`F:\alpha-e2e\profiles`, `F:\alpha-e2e\workspace`, and `F:\alpha-e2e\artifacts`. The profile and workspace must initially be
empty or absent. The runner will never adopt an arbitrary nonempty repository or normal editor profile.

Live Copilot requires these three path options together. Other provider modes may omit all three for the default
disposable profile. `--artifacts-dir` alone
does not enable persistent output. Invalid path groups report `profile-invalid` with diagnostic `profile-paths-required`
and fixed, actionable guidance; raw exception text and arbitrary option values are not printed.

Run the following as one command, substituting your own absolute paths:

```sh
node apps/vscode-e2e/out/runTest.js --provider live-copilot --vscode-version 1.136.1 --profile-dir F:\alpha-e2e\profiles --workspace F:\alpha-e2e\workspace --artifacts-dir F:\alpha-e2e\artifacts --init-profile --setup
```

An installed host can be selected with `--vscode-executable "C:\path with spaces\Code.exe"`. The actual extension host
must still report exactly the requested version; an executable override does not bypass compatibility validation.
Without the override, `@vscode/test-electron` resolves/downloads the requested host.

In the dedicated window, install/enable GitHub Copilot if needed and sign in using Accounts. Then click **Continue setup**
in the Alpha test-profile notification, or open **Copilot test setup** in the status bar and choose **Continue / Retry**.
Each action performs one check. Empty catalogs and unready authentication keep the window open; concurrent clicks do not
start overlapping checks. Dismissing either the notification or the picker does nothing. There is no default timeout.

After a successful check, choose **Finish** in those status-bar controls to record success and close the test window.
Readiness alone never closes it. **Cancel** aborts/drains the bounded active check and records a non-passing cancellation.
Until Finish, host preflight remains blocked (`setup-incomplete` or the last check failure); closing the window manually
is not a successful setup receipt. For intentionally bounded setup, add `--setup-timeout-ms` with an integer from 1 to 86400000. It is accepted only with `--setup`; expiry records `setup-timeout`, not success.

This is an interactive credential boundary: the runner does not copy tokens, automate sign-in, inspect secrets, or reuse
the normal user-data/extensions directories. It does not poll the provider or automatically retry consent requests.

With no `--model-id`, setup only discovers the current Copilot model catalog. Read
`artifacts/<run-id>/live-copilot-preflight.json`, then repeat setup with the **exact returned ID**, optionally its exact
family, and an explicit supported effort:

```sh
node apps/vscode-e2e/out/runTest.js --provider live-copilot --vscode-version 1.136.1 --profile-dir F:\alpha-e2e\profiles --workspace F:\alpha-e2e\workspace --artifacts-dir F:\alpha-e2e\artifacts --setup --model-id EXACT_DISCOVERED_ID --model-family EXACT_DISCOVERED_FAMILY --reasoning-effort max
```

These model placeholders are not model aliases. No model name, prefix, or “close enough” family is substituted. Unknown
or unsupported effort is blocked; selecting a lower effort requires an explicit argument. Omitting effort disables
Alpha's explicit effort override, which is recorded separately from an applied effort. Capability checks use the same
model-information resolver as Alpha's VS Code LM adapter; they do not prove that a provider honored an option.

The optional setup probe requests consent only following the user's setup action. Its result is not an Alpha task
receipt. Alpha's own extension-context access check must succeed; unknown access remains blocked. A genuine request
through an Alpha workflow is the live-provider acceptance check.

Repeat setup with `--vscode-version 1.122.1`. Profile state is separated as
`profiles/<exact-version>/user-data` and `profiles/<exact-version>/extensions`; authentication may be required separately.
Do not copy credential stores between versions. Persistent profiles and workspaces are never automatically deleted.

## Cold-start provider readiness

Setup discovery and live preflight share one readiness path. It subscribes to the stable
`lm.onDidChangeChatModels` event, explicitly activates the installed `GitHub.copilot-chat` extension if inactive, and
queries the Copilot catalog. An empty catalog waits for an actual model-change event before a single-flight, coalesced
requery. There is no interval polling, fallback model, automatic extension install/enable, or repeated consent request.
One **15-second total deadline** covers API loading, activation, queries, and event waits; events do not renew it.
Cancellation removes listeners/timers and prevents later auth checks/configuration writes. VS Code's activation and
selection promises are not cancellable, so their late results are ignored rather than reported as cancelled operations.

Preflight artifacts add optional `readiness` metadata (under `discovery` for model-selection preflight): terminal status,
activation progress, query count, and whether a catalog event was observed. Empty/hung startup times out with
`discovery-unavailable`; a nonempty catalog missing the exact requested identity still reports `model-unavailable`.
Provider exceptions remain redacted and are not retried. Catalog readiness does **not** establish saved sign-in or Alpha
consent; those checks remain separate. Reuse the dedicated profile, but verify authentication instead of assuming it.

The cold-start regression was observed on **2026-09-06**, actual **1.122.1**: a warm setup returned 22 Copilot models, but
the next automated launch read an empty catalog and stopped before Copilot activation. The focused regression failed
before the readiness fix and passed afterward; live-host verification remains a separate requirement.
Implementation was checked against VS Code commit `8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e`:
[stable activation and model-event APIs](https://github.com/microsoft/vscode/blob/8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e/src/vscode-dts/vscode.d.ts),
[language-model service](https://github.com/microsoft/vscode/blob/8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e/src/vs/workbench/contrib/chat/common/languageModels.ts),
and [extension-test startup ordering](https://github.com/microsoft/vscode/blob/8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e/src/vs/workbench/api/common/extHostExtensionService.ts).

## Run scenarios and preserve evidence

Keep the same `--profile-dir` on subsequent runs and select the exact host version. Do not reinitialize or replace
the profile when resetting a task fixture. `--setup` is for initial sign-in/consent or genuine reauthentication, not
every test run; **Finish** closes the setup window normally so VS Code can flush its state. Sign-out, revoked access,
unavailable encryption, or provider policy can still require user action later. Never back up or copy credentials as
a workaround. Settings, extension state, and shared storage are isolated by exact version; a new version can require
its own initial setup.

After authentication, use an explicit scenario, run ID, and request cap. NOR-41 owns the workflow implementation:

```sh
node apps/vscode-e2e/out/runTest.js --provider live-copilot --vscode-version 1.122.1 --profile-dir F:\alpha-e2e\profiles --workspace F:\alpha-e2e\workspace --artifacts-dir F:\alpha-e2e\artifacts --model-id EXACT_DISCOVERED_ID --reasoning-effort max --scenario-id review-edit-test-commit-followup --scenario-phase run --request-limit 60 --run-id live-review-1221-01
```

`--scenario-id` defaults the test file to `workflow.test`; `--file` and `--grep` remain available for focused suites.
Scenario phases are `run`, `prepare`, and `continue`. The default scenario result is
`artifacts/<run-id>/workflow-result.json`. An explicit `--scenario-result-path` must be directly inside that owned run
directory. Request limits require the guarded workflow; they are not silently ignored for arbitrary live suites/setup.

Each run uses an exclusive artifact directory. Reusing a run ID is an error. Artifacts include launch configuration,
actual-host preflight, private host identity, live-provider preflight, projected evidence, and a durable `run-result.json`.
The evidence manifest uses the observed host version, or `null` when unavailable, never the requested version as a
substitute. Model/effort evidence similarly distinguishes request from actual selected preflight configuration.

Normal Mocha suites require at least one executed, non-pending test. Empty file matches, zero `--grep` matches, and fully
skipped suites fail with `no-tests-executed`; zero failures alone is insufficient. `host-preflight.json` records total,
passed, pending, executed, and failed counts at `stage: "suite-complete"`. Actual assertion/hook failures remain failures.
Explicit discovery-only and consent-preflight-only setup stages return before Mocha and are not workflow-test passes.

Observed pre-fix regression, reported by the coordinating thread on **2026-09-06**: the actual **1.122.1** host ran
`--provider scripted --file extension.test --grep '^ALPHA_NO_MATCH_20260906$'` under the dedicated scripted profile with
run ID `no-tests-before-1221-01`. It reported **0 passing**, exited **0**, and persisted **status: passed**. This is an
observed false success, not a valid passing gate. Its retained evidence is under
`F:\alpha-vscode-e2e-runs\20260906\scripted-artifacts\no-tests-before-1221-01`. The post-fix real-host rerun must fail with
`no-tests-executed` and `testCounts.executed: 0`; ordinary nonempty suites must still pass independently.

Post-fix evidence, reported by the coordinating thread on **2026-09-06**: the same actual-host command and grep in run
`no-tests-after-1221-01` exited **1**, persisted **status: failed / failure: no-tests-executed**, and recorded
`stage: suite-complete` with `testCounts.executed: 0`. Evidence capture completed, numeric host exit was observed, and
ownership was verified. The retained artifact directory is
`F:\alpha-vscode-e2e-runs\20260906\scripted-artifacts\no-tests-after-1221-01`.
The coordinating thread also ran `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` successfully after a fresh webview
build and restored extension bundle: **all 8 real-host tests passed**. These checks validate the zero-test guard and
nonempty deterministic host gate; they do not establish authenticated live-Copilot workflow success.

Evidence capture is awaited before cleanup. Incomplete capture changes a successful host result into `evidence-failed`
and retains the source directories. Raw profile logs/storage remain local; the collector exports bounded structural
projections/hashes, not authentication files or provider response bodies. Failed disposable runs are also retained.
Successful disposable legacy runs are cleaned up only when ownership and complete evidence capture permit it.

The runner now invokes the canonical artifact pruner automatically, with default targets of **20 runs**, **100 MiB**, and
**7 days**. It deletes only explicitly inactive, complete, successful run artifacts. Failed, blocked, incomplete, active,
legacy, malformed, and currently protected evidence is retained. No raw workspace/profile/storage directories are pruned
by this policy; the existing successful-disposable cleanup rule above is unchanged.

`run-result.json` preserves the primary host/evidence outcome and points to the additional `retention-result.json`.
That sidecar reports `complete`, `blocked`, or `failed`, with measured retained bytes/counts, protected and removed IDs,
and whether the scan was complete and targets were met. Incomplete or raced measurements are diagnostic snapshots, not
quota compliance.
Retention failure or unmet limits produce a nonzero overall operation result while preserving any original provider or
host failure. Controllers must consume the sidecar before starting another phase; the primary receipt alone is no longer
sufficient to determine overall operation success. Standalone eligibility-publication failures additionally produce
`retention-error.json` and never release that run for pruning.

Standalone runs publish their inactive receipt only after complete evidence, callbacks, the primary receipt, known owned
host close, profile-lease release, and the retention report. Publication is the last artifact write. Use
`--retain-evidence-for-campaign` for controller-managed phases: their reports say `eligibility: "held"`, and only the
controller can release recorded successful phases after its durable terminal report. The current run is always protected
during its own pruning call. Programmatic callers can set `evidenceRetention.maxRuns`, `maxBytes`, and `maxAgeMs`; protected
evidence can legitimately keep a target unmet, in which case further work must stop for storage review.

The per-version `.alpha-e2e-launch.json` lease serializes cooperating runners. Unknown, empty, or crashed leases are not
stolen because of their age. A persistent host must be a verified descendant of the launching runner before the suite
explicitly activates/configures Alpha. This does not suppress the host's own automatic extension activation events.
If an existing window receives a forwarded launch, ownership validation blocks it. Close that dedicated window first.
Never terminate unrelated editor processes to clear a test failure.

`hostExitObserved` proves only the direct launcher's numeric close. Recorded extension-host PIDs plus ancestry are inputs
to recovery checks, **not** proof that every storage writer has stopped. Offline repair requires the separate NOR-42/43
ownership/liveness checks; a missing receipt, live process, or unknown writer remains blocked. Do not delete profile
storage or lock metadata just to make a run pass.

## Validation and implementation references

```sh
pnpm --dir apps/vscode-e2e test:unit
pnpm --dir apps/vscode-e2e lint
pnpm --dir apps/vscode-e2e check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

`runTest.ts` exports `readRunOptions` and `runExtensionTests` without launch-on-import side effects. The external campaign
controller uses that same boundary. An injected launcher is explicitly reported as `execution: "test-seam"` and cannot
claim a real host exit. Production uses argument-safe `spawn(..., { shell: false })`; download/version resolution remains
in `@vscode/test-electron`. Its installed **2.5.2** `out/runTest.js` uses a Windows shell and rejects nonzero test exits;
the narrow launch adapter preserves literal paths and obtains explicit numeric-close evidence instead. Real-child unit
tests cover paths containing spaces and shell metacharacters, not just mocked argument arrays.

Programmatic callers can pass `signal: AbortSignal` to cancel the direct owned host. The launcher waits for its close
event; Node's early `AbortError` alone is not an exit receipt. Cancellation reports `host-cancelled`; unknown/nonnumeric
exit leaves the profile lease for offline inspection. This is not a descendant-tree termination guarantee. Bounded
recovery phases should supply an explicit installed/cached executable because the upstream host downloader does not
accept an AbortSignal; cancellation is checked before and after download resolution.

Primary references checked **2026-09-06**:
[VS Code extension testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension) and
[Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model), reconciled against the installed
VS Code API types and Alpha's actual adapter. The host gate and real provider samples remain necessary; local unit/type
checks alone do not establish either host's live-provider compatibility.
