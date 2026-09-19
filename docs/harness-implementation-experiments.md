# Experiment producer and reporting implementation

Implemented against the migrated `f85371b02c7fbe2fd07c19e7d411aebe8f2a8dce` baseline on 2026-09-18.
The existing `packages/evals/src/experiments` remains the only pairing/statistics implementation. The host campaign
controller remains the execution owner; the new adapter reads its receipts and never runs a task.

## Local workflow

1. Declare the comparison before collecting observations: task/scenario set, exact host, sample count, budgets,
   provider/model/effort, allowed treatment fields, time-window/block label, and independent unit. Keep this declaration
   with the artifacts. Live usage still requires an explicit bounded campaign budget and credentials.
2. Run the existing host campaign for both builds. Ordinary campaigns now retain `evaluationIdentity` in `report.json`:
   Alpha source revision/tree, executed extension build, runner build, task-source and configuration hashes, and
   before/after drift status. The task fixture commit is a separate identity. Use disjoint owned campaign roots.
3. Export both receipts with the same predeclared block label:

    ```sh
    pnpm --filter @alpha-code/evals benchmark:export-host-campaign --input <control-report.json> --pair-window <block-label> --output <control.json>
    pnpm --filter @alpha-code/evals benchmark:export-host-campaign --input <candidate-report.json> --pair-window <block-label> --output <candidate.json>
    ```

4. Materialize the existing `ExperimentManifest` JSON from the declared design and the exported immutable identities.
   It names `schemaVersion: 1`, `id`, `template`, `taskSetIdentity`, `controlVariantIdentity`,
   `candidateVariantIdentity`, `pairs`, `allowedDifferenceFields`, and `independentUnit` (`task`, `repository`, or
   `attempt`). Each export carries its full variant, task-set and observation records; identities use the existing
   `immutableIdentity` function and pair keys are the observation's task/version/seed/repetition/profile/window fields.
   Both prompt and tool-schema digests can now be explicitly declared treatments. Do not infer the allowed fields
   from the observed diff after seeing outcomes.
5. Produce a portable report without PostgreSQL, Redis, Docker, GitHub, or a dashboard:

    ```sh
    pnpm --filter @alpha-code/evals benchmark:campaign-paired-report --control <control.json> --candidate <candidate.json> --experiment <experiment.json> --output <comparison.json>
    ```

    Instead of hand-building the manifest, replace `--experiment` with
    `--id <experiment-id> --template harness_only --independent-unit task --allowed-differences extensionBuildDigest`
    (substitute the treatment fields from your prior declaration, comma-separated). This materializes identities and
    pair keys without inferring an allowed treatment from outcomes.

    This writes digest-bound JSON, `comparison.json.experiment.json`, and `comparison.json.md`. Keep the inputs alongside the outputs. The legacy
    `benchmark:paired-report` command remains available for already materialized observation files.

The adapter rejects missing/drifting identity, reviewed repairs, incomplete scheduled sample matrices, failed retention, missing retained evidence,
wrong actual host/model/effort, mismatched task sets and mixed execution fidelity or decision source. It only includes
`sample` attempts; diagnostic reproduction and neighbor runs are not additional independent task samples. Host sample
`seed: 0` is a pairing block label, **not** a claim that live provider sampling was seeded. First-attempt/retry fields
refer to campaign sample/reproduction attempts, not provider-internal request retries.
The exported `accounting` record separately retains total attempts, scored sample attempts, diagnostic attempts, and
all-attempt cost (unavailable if any cost is missing). Reports label their outcome/cost/latency sample population and
show this extra diagnostic work, so sample cost is not confused with the total campaign bill.

Host source categories currently use an explicitly marked `conservative-whole-source` fingerprint. A source change
therefore changes all source component digests; it cannot masquerade as an isolated prompt/tool-schema ablation.
The separately captured executed bundle is authoritative for build identity. Source hashes do not prove that the
bundle was freshly rebuilt. Resource/permission/network/retry identity is the operational campaign configuration;
the host adapter does not attest physical machine equality or provider-cache state. Declare and control those external
conditions when interpreting a live comparison. The Markdown verdict remains inconclusive rather than inventing an
improvement decision from a small green sample.

## Legacy evaluator compatibility

`benchmark:run-model` writes `artifacts/campaigns/run-<id>/campaign.json` and `lifecycle.json` by default, relative to its
working directory (`packages/evals` under the package command). `--evidence-output <directory>` selects an absolute or
relative local location. Files are created exclusively with private permissions, retained until explicitly removed,
and include identifiers/configuration hashes rather than prompts, credentials or raw conversations.

That evaluator currently launches an installed extension through `code`. Its task workspace HEAD cannot identify the
installed extension. Runtime evidence now records `workspaceCommit` on the task, an explicit
`executed_harness_unavailable` variant marker, and a separately named settings digest. It no longer calls settings a
tool-schema digest. Old manifests remain readable. These legacy campaign receipts intentionally cannot enter causal
pairing until the execution owner supplies real build attestation; available run/task/trial/attempt identities remain
in the local lifecycle export. The actual-host campaign adapter above is the supported complete producer path.

## Statistical contract

The report envelope remains version 1 and records `statisticsVersion: 2`:

- Scoreable outcomes include passed, outcome/safety/agent failures, and budget exhaustion. Infrastructure, grader,
  cancellation and handoff outcomes remain explicit exclusions. Paired wins/losses/ties and paired effects require
  **both** observations to be scoreable; excluded pair counts are shown.
- Existing outcome rate and bootstrap fields remain descriptive attempt-level statistics for compatibility.
  `uncertainty` reports equal-weight cluster means and paired within-cluster deltas, deterministic cluster bootstrap
  intervals, and cluster counts. Task clustering includes repository, task ID and task version. Repository clustering
  first averages repetitions within each task, then equally weights tasks within each repository, then equally weights
  repositories; additional repetitions on one task do not increase its weight. Repository clustering requires a
  repository identity on every included observation. The compatibility default is task; new manifests
  should explicitly declare their independent unit.
- A Wilson binary interval prevents a one-task all-success result from appearing certain when there is exactly one
  observation per independent cluster. It is unavailable when any cluster contains repeated observations, where a binary
  interval would be inappropriate. Empirical bootstrap intervals can still
  degenerate on an all-success sample; they are not future reliability guarantees. The formula follows
  [NIST's proportion confidence interval guidance](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm)
  (retrieved 2026-09-18).
- Retry-assisted capability is success among scoreable observations actually marked retry-assisted, or unavailable
  when no retry-assisted observations exist. First-attempt reliability retains its all-observation denominator.
- Cost per success includes the cost of all observations and is unavailable if any cost is unknown. Token/cost coverage
  counts distinguish missing data from zero. Latency remains the descriptive all-observation distribution; it is not
  silently restricted to successful/scored outcomes. Historical pass-at-k/consistency calculations remain conservative
  all-observation measures, now separated by repository/task/version; they include infrastructure failures as nonpasses.
- Pair metadata (repository, capabilities, risk, family, difficulty) must agree so segmentation cannot conceal a
  changed population. Reports still enforce full pair coverage, immutable manifests and explicitly declared differences.

## Completed correctness loop

Research identified that retry-assisted capability duplicated final pass rate. A deterministic controlled input used
nine direct passes on one task and one failed retry on another. The actual baseline `statistics.ts` from Git and the
working implementation were transpiled and executed against the same values:

| Metric                                                        |    Baseline |    Repaired |
| ------------------------------------------------------------- | ----------: | ----------: |
| Retry-assisted capability                                     |         0.9 |           0 |
| Cost per success with one passed observation and unknown cost |           0 | unavailable |
| Equal task-cluster mean                                       | unavailable |         0.5 |

The first value previously claimed successful retries despite the only retry failing. The null-cost case demonstrates
why coercing missing usage into arithmetic manufactures free successes. Regression tests cover both cases, exclusion
denominators, task/version separation, repository identity requirements, nondegenerate all-success bounds and the full
host-receipt-to-paired-report path. **Decision: keep the correctness repair.** This is not evidence of higher agent
capability or faster execution.

Validation on Node 24.14.1 / pnpm 11.24.0: 47 focused experiment, evidence and campaign tests passed. The actual CLI
export/export/paired-report chain also completed against a clearly labelled synthetic adapter fixture, without live
calls or database services. Local outputs are in `artifacts/harness/paired-adapter-fixture/`; they verify the adapter
and commands, not actual host execution or planning quality. The final evaluator typecheck passed, after the grader
fixture owner repaired a separately detected readonly-array typing issue. Diff whitespace checks passed. Broader
workspace and exact-host validation is recorded in the top-level implementation progress notes. No paid live calls or
service-backed evaluator runs were made here.

## Exact-host validation diagnosis (read-only)

The first exact-host validation recorded in `artifacts/harness/host-validation.log` passed `extension.test` and timed
out in `modes.test` after a first task completion and during the same-task follow-up. It overlapped another bundle
operation and is therefore not a clean baseline. Inspection of the retained task journal, rather than increasing the
timeout, found the actual boundary: sequence 12 was `turn_failed` with `spawn <workspace>/src/dist/node_modules/
@vscode/ripgrep/bin/rg.exe ENOENT`. The UI projection had already stored follow-up user feedback, then an operation
failure, then `resume_task`; no second model request was recorded. This supports removal/replacement of the generated
bundle during the overlapping build as the cause. It does not establish a mode-switch product defect. The justified
next check is a serial rebuild followed by the exact-host gate, with no concurrent output mutation.

The retained diagnostic source was task `01a0b632-7929-70b1-adb9-893b7b33b0c4` in failed host run
`10a3fb74-9ed1-45e0-93fe-a0c8751f1bf0`; the run evidence manifest retained its storage root. No runtime or fixture change
was made for this failure. Parent coordination owns the final serial host rerun and its result.

## Focused follow-up audit

The clean-code-review follow-up covered the active CLI producer/export/report path, manifest admission, statistical
denominators and clustered inference, runtime identity capture, and failure propagation. It did not claim another
whole-repository audit or run a host/build/live campaign.

Four concrete defects were reproduced with failing tests and repaired:

- **High, fixed:** equal pair profiles could contradict both supplied variant manifests yet still produce a fully
  paired report. Resource, permission, network and retry fields are now checked against each observation's variant,
  in addition to matching across the pair.
- **Medium, fixed:** if campaign execution and local evidence export both failed, the export exception from `finally`
  discarded the execution error. An `AggregateError` now retains both causes; a single failure preserves its original
  error. Evidence export still runs after execution fails.
- **High, fixed:** the build digest ignored packaged external/native runtime files, so mutating or deleting bundled
  `rg.exe` did not change it. Identity capture now fingerprints the entire packaged `src/dist` tree (including native
  bindings, WASM and bundled externals), manifest and webview. Mutation/removal regressions passed. The inspected dist
  contained 242 files / 275,456,726 bytes, within the existing bounded traversal; downloaded VS Code was not scanned.
- **Medium, fixed:** malformed host samples without failure classifications, or with unknown classifications, could
  be admitted and assigned misleading scoring/exclusion semantics. The adapter now requires the owner's known failure
  classes for failed/blocked results. The report also explicitly states that latency/cost include all sample attempts,
  whereas outcome rates exclude unscoreable statuses.

Validation: 49 focused evaluator experiment/campaign/evidence tests and three source-executed identity tests passed.
The identity tests used `pnpm --dir packages/evals exec tsx --test ../../apps/vscode-e2e/src/campaign/evaluationIdentity.spec.ts`,
so they did not compile or replace host outputs. Final typecheck results are in the implementation progress record.

Remaining boundaries: component-level prompt/schema attribution still needs finer producer capture; current conservative
source treatment declarations are explicit. Physical machine/provider-cache equivalence and service-backed/paid live
outcomes were not inferred. Existing legacy installed-extension identity gaps remain marked unavailable. No statistical
or performance improvement claim is made from these validation fixtures.

## Docker-free evaluator follow-up (2026-09-18)

Separated real Redis contracts from Docker contracts and added read-only bounded service readiness. `test:services` retains PostgreSQL integration and Redis lease coverage without containers; `test:all` and compatibility infrastructure command retain all prior coverage. Destructive DB setup now validates exact loopback `/evals_test` URL components before creating the client and omits credentials from reset logs. Local benchmark runs preserve the source checkout; legacy reset/commit rejects parent-repository subdirectories. VS Code launching uses argument arrays, native temp paths, and Windows named pipes. See [Docker-free workflow](harness-docker-free.md) for service provisioning and security limits.

Validation: `pnpm --dir packages/evals test:unit` passed 26 files / 251 tests; `pnpm --dir packages/evals check-types` passed. No actual service, Docker, paid-provider, or native installed-extension campaign was run for this follow-up. Actual-host campaigns remain the build-attested service-free producer; local process separation is explicitly not a security sandbox.

Final cleanup review: reproduced two controller regressions where heartbeat cleanup replaced the primary failure or skipped logger closure. Nested cleanup now preserves the original run error and always closes the logger; cleanup-only failure still rejects. Database setup now throws a sanitized error without the driver's potentially sensitive cause. Seven focused tests and evaluator typecheck passed; no services or builds executed.

Final lint/lifetime correction: controller setup now shares the logger lifetime, captures primary and cleanup failures, and throws only after finally. Checkout and heartbeat-start rejection regressions confirm logger closure without stopping an unowned heartbeat. Service tests now perform read-only PostgreSQL/Redis readiness before any integration reset. Eight focused controller tests, package lint, and typecheck passed.

## Shared-storage mailbox race fixture extension

Extended the existing two-host fixture and controller, without a second store or runtime. Both durable tasks complete before one nonce-bound control event is appended; both real stores then contend at a shared file barrier, with ACK withheld until both claim receipts arrive. The controller requires exactly one winner, validates both empty post-ACK retry claims, and independently checks one persisted acknowledged event with the winning claim identity. Optional mailboxClaimRace capability and mailboxClaimsVerified evidence fields preserve legacy receipt readers while the current controller rejects missing capability. This tests terminal-tree mailbox contention under live runtime owner leases; it does not assert two hosts may own one active agent tree.

Validation before actual host execution: 33 focused protocol/controller tests passed, including replay, duplicate winner, absent capability, and missing durable ACK negatives; E2E lint and noEmit typecheck passed. Actual-host execution is pending parent coordination. No pending-matrix classification was changed.

Legacy local-adapter lifetime follow-up: reproduced IPC-exhaustion and premature-disconnect leaks before fixing the encompassing lifetime. Process rejection is now observed immediately during startup; every exit disconnects its current IPC client, aborts and boundedly waits for its spawned process, and closes the logger without replacing a primary error. Conversation capture remains after subprocess cleanup. The wait helper clears its timer and fails closed after a timeout/forced-kill request rather than reporting cleanup success. This owns the spawned CLI process, not an attestation of every GUI process that an installed Code launcher may create; actual-host family ownership remains the stronger campaign path. Validation: 29 focused adapter/subprocess/task-lifecycle tests, evaluator lint, and typecheck passed. No hosts, builds, services, or paid calls run.

## Real shared Worker mailbox extension (source ready; actual run pending)

The existing shared-storage campaign now accepts explicit `sharedWorkerMailbox: true`; its basic campaign remains unchanged. `pnpm harness:acceptance shared-workers --output <fresh absolute path> --vscode-executable <exact 1.122.1 Code.exe>` uses the same build lease and paired host launcher. It initializes Git only in the two already-owned fixture workspaces, enables proactive Code-mode Worker admission, and refuses any explicit-approval requirement rather than fabricating a human grant.

Each host runs a real held root and held Worker. A's existing parent-control method interrupts its Worker while B retains the same running instance with an unsettled, non-aborted provider request. A consumes and ACKs the actual interruption result, follows up the same Worker identity/path, then completes the follow-up without editing the baseline. Both hosts race the actual completed `kind=result` event using the canonical shared store. Only the winner may ACK after both outcomes are recorded. Retry receipts distinguish an empty mailbox from foreign-root ownership denial; the offline audit verifies the exact event, sender/recipient/root/payload identity, one ACKed completed result, one ACKed interrupted result, and no replayed completed result.

Finally B's Worker is cancelled, both Worker handles are closed, all active-child records are absent, and held roots are cancelled before the helper reports success. Receipts retain all four additional task IDs and five provider requests separately from the original two simple tasks. Partial failures set total requests unknown and retain bounded phase/request-count diagnostics. Root/child cancellation uses the actual provider signals; cleanup does not establish the success assertions.

Source validation: three focused tests pass (signal cancellation/same-ID follow-up; invalid/stale/duplicate claims; duplicate result/missing ACK/wrong tombstone-parent rejection), wrapper tests pass, and E2E typecheck/lint pass. Actual two-host execution is still pending. This path does not claim A-host reload while B continues; no second runtime or host launcher was added.

### Shared Worker first-host failure and receipt fidelity (2026-09-18)

The first real two-host Worker attempt (`73554acc-a622-456e-ad67-ebd4a24ea0ac`, retained under `C:/Temp/alpha-workers-review-C2IbO4/fixture`) failed during Worker admission in both hosts, after one held root request each. The fixture had explicitly disabled write auto-approval, while canonical Worker auto-admission requires both read and write authority. The fixture now explicitly enables both for its owned scoped Git baseline, keeps command/MCP execution disabled, and still rejects any requirement to fabricate approval. This correction awaits an actual rerun; unit results do not establish Worker acceptance.

Known fixture failure receipts now include only an allowlisted basename and numeric stack position; no error message or absolute stack path is retained. Injected shared-campaign dependencies label reports `test-seam`; normal real launches label `extension-host`. Churn promotion and the local wrapper require actual-host execution receipts. A thrown wrapper driver records a sanitized failed stage while preserving the original failure and conservative lease retention.

Validation: shared controller/protocol/Worker focused tests 38 passed; wrapper tests 4 passed. E2E noEmit and lint passed after the admission/receipt changes. No host or build was launched by this audit.

Second real Worker attempt (`5bb088d9-53b6-4fe5-b0cb-d3204792ffed`, retained under `C:/Temp/alpha-workers-review-KpoXN5/fixture`) reached actual interruption, same-ID follow-up, competing claim, ACK/no-redelivery, and Worker close. Root cleanup then rejected from `cancelTask`; logs show original root abort/disposal but no replacement construction. The exact exception was not retained, so a foreign shared fake-provider profile during rehydration remains an inference, not a proven error message. Fixture shutdown now uses canonical `removeTaskFromStack({taskId, requireAbortSuccess:true})`, which joins cancellation before unregistering and avoids user-facing rehydration. It still rejects cleanup failures and separately awaits the original root instance. Focused tests4 and E2E noEmit pass; actual complete campaign remains pending. The earlier blocked report is preserved.
