# Alpha harness coverage and comparison map

Research date: **2026-09-18**. Reviewed at detached commit
`f85371b02c7fbe2fd07c19e7d411aebe8f2a8dce` in the assigned worktree. This is source and manifest inspection only;
no tests, provider requests or Docker services were run for this note. A formatting command unintentionally materialized
workspace dependencies from the existing pnpm store; see the main report's validation record. The prior migration
results quoted below are reported evidence, not rerun results.

The repository has a fairly complete ladder from deterministic source checks to a real VS Code host and a private
grader/evaluator. Its comparison machinery is more mature than the current model-campaign wiring: immutable paired
reports exist and reject mismatched inputs, but the routine benchmark campaign still produces run/task/calibration
records rather than those paired observations. That distinction is the main practical limit on a claim that an existing
campaign is a baseline/candidate experiment.

## Coverage by layer

| Surface and owner                                                                             | Representative command or test                                                                                                                                                                                                                                        | What is actually exercised                                                                                                                                                                                             | Evidence and isolation                                                                                                                                                                                                                | Fidelity boundary                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension/core unit tests (`src/`, provider adapters, task, agent kernel, tools, persistence) | `pnpm test`; focused form `pnpm --dir src test core/agent/__tests__/AgentTurnEngine.spec.ts`; `pnpm --dir src check-types`                                                                                                                                            | Provider-neutral turn sequencing, scheduler/policy, task persistence, tool effects and adapter fixtures in Node/Vitest                                                                                                 | Disposable fixtures and injected providers/processes; no VS Code host or paid model                                                                                                                                                   | Strong local contract coverage; does not establish activation, host API behavior, model strategy, or live task quality                                                                                              |
| Webview unit tests (`webview-ui/`)                                                            | `pnpm --dir webview-ui test <file>`; included by `pnpm test`                                                                                                                                                                                                          | React state, message projection and completion/UI behavior with fixture messages                                                                                                                                       | Testing-library/Vitest fixtures; no extension host                                                                                                                                                                                    | Does not prove extension-side lifecycle ownership or rendered behavior in a real webview                                                                                                                            |
| E2E runner/controller/evidence unit tests (`apps/vscode-e2e/src`)                             | `pnpm --dir apps/vscode-e2e test:unit`                                                                                                                                                                                                                                | Runner option validation, profile ownership, campaign controller, scripted workflow contracts, evidence capture/retention, storage recovery and host receipts                                                          | Injected launch/process seams are reported as `execution: "test-seam"`; evidence tests use synthetic receipts where stated                                                                                                            | Tests the runner's contracts, not a real host launch unless a host gate is invoked                                                                                                                                  |
| Scripted exact-host smoke and VS Code LM fixture                                              | `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`; smoke uses `test:smoke:1221:run`; `test:command-paths:1221:run` is a separate gate; `test:vscode-lm:1221:run` repeats its LM fixture slice                                                                    | Fresh bundled extension/webview in real VS Code 1.122.1; extension/mode commands and VS Code LM response-part/tool/usage contract through a deterministic fixture provider                                             | `runTest.ts` requires actual host preflight/version, owned profile, host identity and terminal receipt; each run has an evidence directory                                                                                            | Real host behavior is covered, but scripted/fixture provider decisions are not live model solving                                                                                                                   |
| Core confidence composition                                                                   | `pnpm test:core:confidence`; underlying `runCoreConfidence.ts` runs `test:unit`, `test:smoke:1221`, `test:core:regressions`, then `core-loop.test`, `completion-idle.test`, `managed-agents.acceptance.test` on 1.122.1 and deterministic certification               | Selected core lifecycle, completion idle/replay, managed-agent acceptance and artifact stability                                                                                                                       | Fresh campaign/report root; host evidence outside the repo; completion capture from this invocation is replayed; artifact digest is checked before/after                                                                              | A deterministic exact-host confidence gate, not live solve-rate, latency, token-use, or full managed-agent integration acceptance                                                                                   |
| Live Copilot extension host                                                                   | `pnpm test:live:core`, `pnpm test:live:reliability`, `pnpm --dir apps/vscode-e2e test:copilot ...`                                                                                                                                                                    | Real Alpha extension through the VS Code LM adapter, exact returned Copilot model and explicit effort, workflow/tool/persistence/recovery scenarios; normal development-sidecar host is mandatory for live persistence | Dedicated owned profile/workspace/artifact roots; preflight records actual model/effort; host ancestry, PID, exact version and close receipts are checked; campaign cells need retained evidence and positive request usage           | Paid, provider/account/time dependent; 1.122.1 remains the release host, while 1.136.1 runs are supplemental. E2E `CampaignUsage` may leave tokens and cost `null`; a setup/preflight is not a task result          |
| Evaluator offline harness (`packages/evals`)                                                  | `pnpm test:evals:offline`; `pnpm evals:offline-certify` (or `:full`)                                                                                                                                                                                                  | Eval lifecycle, schemas, evidence integrity, grader registry/plugins, benchmark manifests, fixture state and authoring checks with credentials removed by `scripts/offline-certify.mjs`                                | Local benchmark sandboxes copy fixtures into fresh workspaces; hidden graders can be brokered outside the runner; evidence journals/artifacts are content-addressed and integrity checked                                             | No provider request, real model choice, Docker/DB service, or live VS Code workflow. User-provided migration result: 239 offline eval checks (217 unit + 17 contract + 5 certification), reported rather than rerun |
| Model benchmark campaign and private grading                                                  | `pnpm --filter @alpha-code/evals benchmark:run-model --role <role> --model-id <model> --provider <provider> --tier <tier> --partition <partition> --iterations <n>`; direct CLI form is `pnpm --filter @alpha-code/evals exec tsx src/benchmark/cli.ts run-model ...` | Governed model runs create DB run/task/trial rows, execute the extension through VS Code, capture usage/trace/workspace evidence, run visible/private graders and classify terminal outcomes                           | `processTask.ts` creates a local isolated task sandbox or bounded Docker runner, records runtime identities, event journal and artifact digests; private grader broker stays trusted on the host                                      | Requires credentials and DB/Redis/Docker as configured; current `modelCampaign.ts` ingests five-or-more repeats into per-task keyless calibration reports, not the richer paired experiment report described below  |
| Managed-agent certification                                                                   | `pnpm certify:managed-agents`; strict host composition `pnpm certify:managed-agents:automated`                                                                                                                                                                        | Deterministic source probes and focused extension/webview tests, plus a separate scripted host acceptance track                                                                                                        | Evidence is written under `artifacts/certification`; source stability, command counts, matrix digest and output confinement are checked. The generated scope is `deterministic-offline-only` and records live acceptance as `NOT_RUN` | It cannot certify real provider, multi-window, live UI or pending integration rows; the certification record says so explicitly                                                                                     |
| Historical benchmark scripts and reports                                                      | `pnpm exec node scripts/benchmarks/nor38-failure-overhead.mjs`; `scripts/benchmarks/nor38-live-comparison.mjs`; NOR36 JSON records under `docs/benchmarks/`                                                                                                           | NOR38 failure-overhead is an in-process detector microbenchmark; NOR38 live comparison arranges alternating baseline/candidate campaigns; NOR36 preflight measures request construction and local counts               | NOR38 captures source/build/fixture digests and AB/BA samples; NOR36 captures revision, tree state, harness/fixture digests, configuration/cache labels and explicit unavailable metrics                                              | NOR38 live wrapper declares `performanceVerdict: "not-computed"`; failure-overhead excludes Task/scheduler/model/host; NOR36 explicitly makes no provider-token or latency claim                                    |

The migration record is consistent with this ladder. [docs/toolchain-migration-step-3.md](../../docs/toolchain-migration-step-3.md#L34) reports the pinned-tool
source/webview/tooling/E2E/package checks and exact-host smoke, while `:L51-L52` and `:L88-L89` say Docker, live
provider, external registry and evaluator runs were not performed. [docs/migration-starting-point.md](../../docs/migration-starting-point.md#L55) keeps
live quality/speed/token improvement and full service-backed evaluator coverage unestablished. The reported source and
webview totals are 9,428 and 1,829; the E2E runner report is 374 tests with two skips; tooling was later reported as
15 tests. A focused and CI-worker-limited `Task.ticket-progress.spec.ts` run was reported passing, while the earlier
75 ms real-filesystem timing failure remains a reliability record. This note does not rerun or diagnose it.

## Command and evidence table

| Purpose                                 | Exact command                                                                                                                                                                                                                                                                        | Result interpretation                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source/webview workspace gate           | `pnpm lint`; `pnpm check-types`; `pnpm test`                                                                                                                                                                                                                                         | Current code and fixture tests; `pnpm test` bundles first. Does not replace the exact-host gate                                                                                           |
| Exact 1.122.1 smoke                     | `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`                                                                                                                                                                                                                               | Required extension activation/commands/modes and LM fixture contract on the release host                                                                                                  |
| Exact core host contracts               | `pnpm --filter @alpha-code/vscode-e2e test:core:1221`                                                                                                                                                                                                                                | Smoke plus scripted core-loop, completion-idle and managed-agent host suites                                                                                                              |
| Command/path approval                   | `pnpm --dir apps/vscode-e2e test:command-paths:1221:run`                                                                                                                                                                                                                             | Focused host policy boundary; compiles its runner but needs the current extension bundle                                                                                                  |
| Deterministic confidence                | `pnpm test:core:confidence`                                                                                                                                                                                                                                                          | Composed prerequisites, exact host scenarios, managed-agent certification and artifact stability                                                                                          |
| Offline evaluator                       | `pnpm test:evals:offline`                                                                                                                                                                                                                                                            | Unit/contract/certification evaluator tests without DB/provider; `pnpm evals:offline-certify` adds source-critical, benchmark and authoring checks                                        |
| Managed-agent tracks                    | `pnpm certify:managed-agents:list`; `pnpm certify:managed-agents`; `pnpm certify:managed-agents:host-e2e`; `pnpm certify:managed-agents:automated`                                                                                                                                   | `--list` resolves the matrix; strict certification produces deterministic evidence; host-e2e is a separate scripted VS Code track                                                         |
| Live bounded gate                       | `pnpm test:live:core --model-id <exact-id> --effort <supported-effort> --root <new-absolute-root> --profile-dir <owned-profile> --dry-run` then replace `--dry-run` with `--init-root`                                                                                               | Dry-run validates configuration without requests; a real run requires credentials and records per-cell host/model/effort/request/evidence checks. Keep 1.136.1 runs labelled supplemental |
| Focused live file tools                 | `pnpm bundle`; `pnpm --dir apps/vscode-e2e test:copilot --vscode-version 1.136.1 --profile-dir <owned-profile> --workspace <fresh-workspace> --artifacts-dir <artifacts> --init-profile --model-id <exact-id> --reasoning-effort high --file file-tools-live.test --run-id <new-id>` | Three real-model tool probes with bounded requests and byte/file-hash evidence; one sample is diagnostic, not a general quality estimate                                                  |
| Benchmark catalog/fixture/author checks | `pnpm --filter @alpha-code/evals benchmark:validate`; `pnpm --filter @alpha-code/evals benchmark:fixture-check`; `pnpm --filter @alpha-code/evals benchmark:author-check`                                                                                                            | Public task/grader contracts, initial-state certification and similarity/private-fingerprint authoring checks                                                                             |
| Paired report CLI                       | `pnpm --filter @alpha-code/evals benchmark:paired-report --control <json> --candidate <json> --experiment <json> --task-set <json> --control-variant <json> --candidate-variant <json> --output <json>`                                                                              | Reads already materialized observation and manifest JSON; validates/pairs them and writes a digest-bearing report. It does not query a run or create observations                         |
| Governed model run                      | `pnpm --filter @alpha-code/evals benchmark:run-model --role luna-high --model-id <model> --provider <openai> --tier <t1..t5> --partition <visible / frontier> --iterations <n>`                                                                                                      | Paid run only after tier/budget rules and required credentials; T1/T2/T3/T5 constraints are enforced by the CLI. A run ID alone is not a paired comparison                                |

The E2E runner's source of truth is [apps/vscode-e2e/src/runTest.ts](../../apps/vscode-e2e/src/runTest.ts#L28): it distinguishes `live`,
`scripted`, `vscode-lm-fixture` and `live-copilot`, reports test-seam versus extension-host execution, requires actual
host preflight/version and verifies owned host identity. The campaign controller runs cells sequentially and retains
evidence before allowing another attempt ([apps/vscode-e2e/src/campaign/controller.ts](../../apps/vscode-e2e/src/campaign/controller.ts#L26)). This serial ownership
choice protects persistent profiles and mutation ordering; it is not a statistical randomization or baseline/candidate
pairing policy.

## Evidence, grader and isolation owners

The VS Code evidence path is intentionally bounded and privacy-aware. [apps/vscode-e2e/src/evidence/capture.ts](../../apps/vscode-e2e/src/evidence/capture.ts#L344)
requires a runner-owned source validator, rejects evidence/source overlap, hashes bounded files and records incomplete
capture warnings. The manifest keeps actual host/provider/model/task/timestamp/outcome metadata, an extension bundle
hash and projected task/journal evidence ([apps/vscode-e2e/src/evidence/types.ts](../../apps/vscode-e2e/src/evidence/types.ts#L4)); raw prompts, response text
and logs remain outside the projected artifact or are reduced to file identities. `captureRepositoryEvidence` may record
the workspace HEAD commit ([capture.ts](../../apps/vscode-e2e/src/evidence/capture.ts#L181)), but that is the evaluated workspace snapshot, not an Alpha harness
source/build identity.

Live model selection is stricter than ordinary configuration: [liveModelSelection.ts](../../apps/vscode-e2e/src/liveModelSelection.ts#L392) records the
requested and selected opaque model IDs, family, requested/applied effort, readiness/auth/configuration state and
writes `live-copilot-preflight.json` atomically. [suite/index.ts](../../apps/vscode-e2e/src/suite/index.ts#L117) adds actual VS Code version,
actual model/effort, host ownership and preflight status. A successful preflight therefore proves readiness and exact
selection, not task success. [runCampaign.ts](../../apps/vscode-e2e/src/runCampaign.ts#L214) fingerprints built extension/webview/E2E artifacts for a
`--gate` run and rejects drift before/after; the ordinary `CampaignReport` itself has no artifact or source commit
field.

The evaluator's [processTask.ts](../../packages/evals/src/cli/processTask.ts#L102) is a stronger end-to-end evidence path. It creates a fresh local sandbox
for benchmark tasks or a bounded Docker runner, persists task/variant identities before execution, records normalized
agent trace and usage, captures workspace/transcript/extension-log/final-response artifacts, validates the evidence
bundle before and after grading, and classifies infrastructure/grader/safety/agent/budget outcomes separately.
[runtimeIdentities.ts](../../packages/evals/src/evidence/runtimeIdentities.ts#L21) hashes fixture/prompt and records model, settings-derived tool digest, workspace commit/status
and runner image. `runtimeEnvironment` records Node/platform, model, runner/image/network/permission/limits/concurrency
([processTask.ts](../../packages/evals/src/cli/processTask.ts#L683)). The private grader broker and six typed grader families (command, filesystem, diff policy,
trace, static analysis and usage policy) are registered in `grading/registry.ts` and invoked serially by
`runUnitTest.ts`; hidden grader bundles are validated as read-only, network-disabled inputs by the loader.

There are two different identity levels in the evaluator:

- The narrow runtime `VariantManifest` has extensionCommit, workingTreeDigest, model, promptDigest, toolSchemaDigest and
  runnerImageDigest ([packages/evals/src/evidence/manifests.ts](../../packages/evals/src/evidence/manifests.ts#L18)). In `createRuntimeIdentities`, `extensionCommit`
  is read from the task workspace's `git rev-parse HEAD` ([runtimeIdentities.ts](../../packages/evals/src/evidence/runtimeIdentities.ts#L37)); for the local benchmark copy
  that is the prepared fixture commit, not the Alpha extension or E2E harness commit. The settings-derived
  `toolSchemaDigest` is also not a separately captured tool implementation/schema build digest.
- The richer experiment `ExperimentVariant` requires extension/build, model/settings, prompt, tool schema/implementation,
  skills, policy, compaction, runner image, resource, permission, network and retry digests
  ([packages/evals/src/experiments/types.ts](../../packages/evals/src/experiments/types.ts#L7)). It is the right identity contract for causal comparison, but no
  current `runBenchmarkModelCampaign` adapter populates it from the DB campaign.

This separation is useful: it avoids treating a task workspace commit as proof of the evaluated harness, but it also
means routine campaign results cannot yet prove that two rows used only the intended harness difference.

## Paired reports and baseline/candidate identity

The existing paired machinery is a good foundation and should be extended rather than replaced.

[packages/evals/src/experiments/types.ts](../../packages/evals/src/experiments/types.ts#L35) makes each pair carry task/version/seed/repetition/resource,
permission, network, retry and time-window fields, and the experiment manifest names the immutable task set and both
variant identities. [pairing.ts](../../packages/evals/src/experiments/pairing.ts#L16) rejects duplicate candidate identities, missing or extra pairs, and any
mismatched pair key. [reporting.ts](../../packages/evals/src/experiments/reporting.ts#L39) then checks that observations use one variant identity each, that
those identities hash to the supplied variant manifests, that the experiment manifest points to those identities, that
the task-set identity and exact declared pair set match, and that every observed task is in the task set. It also
requires explicit allowed differences, checks the `harness_only`/`model_only` template, records variant differences and
hashes the report. These checks are real safeguards when this API is used.

The current routine model path stops short of that API. [benchmark/cli.ts](../../packages/evals/src/benchmark/cli.ts#L308) implements `paired-report` as a
file-to-file formatter: callers must supply control/candidate observations and the experiment, task-set and two variant manifests. It does not
load DB runs, derive pair keys, register experiment rows or persist the report. [modelCampaign.ts](../../packages/evals/src/benchmark/modelCampaign.ts#L17) creates a
run and repeated task rows, executes `runEvals`, and only invokes `ingestModelCampaign`; the ingestion path turns five
or more observations of one task into a legacy keyless calibration report. The DB has experiment/variant/pair/report
tables and insert helpers ([db/queries/experiments.ts](../../packages/evals/src/db/queries/experiments.ts#L21), [db/schema.ts](../../packages/evals/src/db/schema.ts#L315)), but source search found no
call from the model campaign that connects its `trials` to those `experimentPairs` or builds `TrialObservation` values.
Thus the checks are strong but not globally enforced for every benchmark run.

There is also a schema-level ablation limit. [variantDiff.ts](../../packages/evals/src/experiments/variantDiff.ts#L5) correctly treats only model/model-settings changes
as model-only, while harness-only differences can include prompt or tool schema changes in principle. However
`experimentManifestSchema`'s `allowedDifferenceFields` enum ([types.ts](../../packages/evals/src/experiments/types.ts#L55)) omits `promptDigest` and
`toolSchemaDigest`. A prompt or schema ablation therefore cannot satisfy the current explicit-declaration check. This
requires a versioned schema/validation extension; disabling the check would remove the causal guard.

## Statistical implementation and fidelity limits

`experiments/statistics.ts` currently reports useful descriptive slices, but its estimand and denominators need care:

- `summarizeExperiment` filters outcome-rate observations to `passed`, `outcome_failed`, `safety_failed`, `agent_error`
  and `budget_exhausted` ([statistics.ts](../../packages/evals/src/experiments/statistics.ts#L30)), then calls raw observation-level `bootstrapMean95`. The bootstrap
  has no task/repository cluster argument ([statistics.ts](../../packages/evals/src/experiments/statistics.ts#L127)), so repeated attempts on one task receive extra
  resampling weight and the interval is not uncertainty over independent tasks.
- The report includes paired wins/losses/ties ([statistics.ts](../../packages/evals/src/experiments/statistics.ts#L40)) but no paired delta/effect interval or exact
  discordant-pair test. An all-success array necessarily returns `[1, 1]`; that is the empirical resampling interval,
  not a future reliability bound.
- `groupByTask` groups only by `taskId` ([statistics.ts](../../packages/evals/src/experiments/statistics.ts#L148)), not task version, repository, fixture or family.
  The segmentation fields are useful diagnostics but do not repair the independence problem.
- Outcome-rate exclusions are not carried consistently into other metrics: latency quantiles use all observations and
  cost-per-success sums all observation costs ([statistics.ts](../../packages/evals/src/experiments/statistics.ts#L61)), while paired status counts treat every
  non-`passed` status as a loss/tie. `TrialObservation.cost` is required to be a number ([experiments/types.ts](../../packages/evals/src/experiments/types.ts#L91)),
  but live E2E campaign usage permits `cost: null` ([apps/vscode-e2e/src/campaign/types.ts](../../apps/vscode-e2e/src/campaign/types.ts#L43)); an adapter needs a
  declared missing-cost policy rather than silently using zero.
- `retryAssistedCapability` currently repeats final eligible pass fraction ([statistics.ts](../../packages/evals/src/experiments/statistics.ts#L74)) instead of
  conditioning on `retryAssisted`. The DB trial has first-attempt/retry fields, so this is an existing reporter
  semantics gap, not evidence of a live run defect.

The historical records show the right restraint. NOR36 records source revision/tree state, configuration and cache
labels, but sets provider tokens and useful-answer timing to unavailable and says it is a request/response parity/local
count measurement (`docs/benchmarks/nor36-preflight-comparison-20260905.json`). The NOR36 engine oracle similarly says
its fixed AgentTurnEngine/ToolScheduler fixture is not the Task lifecycle, timing is unavailable, and paired performance
admission is unavailable (`docs/benchmarks/nor36-engine-oracle-pair-20260905.json`). NOR38's failure-overhead report
captures source hashes, environment, AB/BA ordering and raw samples but labels its scope as in-process detector code and
lists no provider/host/filesystem/model/quality claim ([scripts/benchmarks/nor38-failure-overhead.mjs](../../scripts/benchmarks/nor38-failure-overhead.mjs#L253)).

NOR38's live wrapper is the closest existing baseline/candidate harness. It fixes alternating order, model/effort,
scenario set and budgets ([scripts/benchmarks/nor38-live-comparison.mjs](../../scripts/benchmarks/nor38-live-comparison.mjs#L8)); hashes extension bundle, harness
source/compiled output and fixture/build inputs; requires baseline/candidate harness equality and a declared candidate
bundle (`:L93-L122`); isolates source, campaign and profile roots (`:L165-L180`); freezes identities before each block and
rejects drift (`:L214-L251`); and rejects missing evidence, wrong actual host/model/effort, infrastructure/auth/usage
failures or absent request usage (`:L142-L162,L284-L327`). Its plan openly lists unavailable provider-cache, token, cost
and first-token metrics and ends with `performanceVerdict: "not-computed"`. It runs 1.136.1 in this script and delegates host execution to existing campaign operations. Therefore it is a
strong preflight/collection wrapper, not a completed paired performance analysis.

## Current gaps, unverified areas and overlap candidates

The following are gaps or unverified contracts, not claims that every item is broken:

1. **Campaign-to-experiment join:** no verified adapter turns DB trials, task identities, runtime evidence and metrics
   into the richer `TrialObservation`/`PairKey`/`ExperimentManifest` path. A paired report can be correct for supplied
   JSON while a model campaign remains unpaired or lacks declared baseline/candidate identity.
2. **Harness identity in routine reports:** live E2E gate artifacts have a digest and `launch.json`/preflight have
   requested and actual host/provider details, but ordinary `CampaignReport` has no source commit, harness source/out
   digest, extension build digest, fixture/prompt/config digest or host executable digest. NOR38 captures most of these
   fields only in its specialized wrapper.
3. **Statistical uncertainty:** task/repository-clustered resampling, paired delta intervals, and a nondegenerate exact
   bound for all-success small samples are absent. No change should present raw bootstrap or a green gate as a broad
   capability estimate.
4. **Missing usage semantics:** live E2E request counts are authoritative for the gate, but token/cost fields can be
   unavailable; the rich trial schema requires numeric cost. The report needs explicit excluded/missing strata before
   cost or latency comparisons are combined with pass rates.
5. **Live and service-backed coverage:** the migration records leave paid live evaluator runs, PostgreSQL/Redis-backed
   evaluator tests, Docker image execution, corporate registry access, live 1.122.1 workflow acceptance and the
   managed-agent pending integration rows unverified. A passing offline certification does not close these rows.
6. **Prompt/schema experiment contract:** the existing manifest cannot declare prompt or tool-schema treatment fields,
   even though variant identities contain their digests. Extend the schema deliberately if that experiment is required.

Potential overlap should be reviewed by owners before deleting anything:

- `modelCalibration` and `experiments/reporting` both summarize repeated model outcomes, but the former is a per-task
  five-trial keyless fixture/admission and human-review record, while the latter is an immutable paired variant report.
  They are adjacent contracts, not proven duplicates.
- `runCoreConfidence` invokes exact-host suites that also have standalone package commands, but it adds regression
  prerequisites, this-run completion replay, certification evidence and artifact-stability checks. The composition is
  intentional overlap, not a redundant second host engine.
- E2E `captureRunEvidence` and evaluator `processTask` both retain bounded evidence, but they serve different execution
  owners (extension-host campaign versus DB/Docker benchmark) and have different schemas. A shared evidence vocabulary
  may be useful; deleting one path without an adapter would lose host or grader authority.
- NOR38 live comparison and `paired-report` both mention baseline/candidate, but NOR38 currently collects controlled
  campaign blocks and explicitly does not compute a performance verdict; `paired-report` validates already formed
  observations and manifests. They are complementary, with an unbuilt join between them.

## Recommended extensions to current machinery

1. Add one evaluator adapter at the existing `modelCampaign`/DB boundary. It should materialize validated
   `TrialObservation` rows from `trials`, `attempts`, task metrics, grader results and evidence status; map infrastructure,
   grader, cancellation, safety, budget and agent outcomes explicitly; preserve first-attempt/retry fields; and reject
   missing required cost/latency instead of coercing them. Register task-set/variant/experiment identities and fill
   `experimentPairs` transactionally, then call the existing `buildPairedExperimentReport` and persistence helpers.
2. Reuse the NOR38 `captureIdentity` pattern for every comparative campaign, not just the wrapper: capture source commit
   and dirty-tree digest, extension bundle/build digest, E2E harness source/compiled digest, fixture/prompt/tool/policy
   config digests, exact host executable/version, Node/OS/resources, network/permission/retry profile, cache state and
   run config. Keep a canonical JSON identity and its digest in the campaign report and each observation.
3. Extend experiment schema/versioned validation for declared `promptDigest` and `toolSchemaDigest` treatments when
   needed. Keep template checks and require the declared difference to be present and unchanged elsewhere.
4. Extend `statistics.ts` in place: preserve descriptive fields for compatibility, add a task-level/cluster-aware
   bootstrap option, paired within-key delta intervals/effect sizes, discordant-pair counts, and an exact/Wilson-style
   bound for independent all-success binary slices. Require the caller to declare the independent unit (task,
   repository or attempt) and show cluster counts.
5. Make denominators explicit in the report: separate scoreable outcome rate, infrastructure/grader coverage,
   all-attempt latency, valid-cost latency/cost, first-attempt success and retry-assisted success. Treat unavailable
   cost/token/cache fields as unavailable, with a coverage count, rather than zero.
6. Add one documented end-to-end command that runs the existing campaign, exports the two immutable observation files,
   and invokes `benchmark:paired-report`. Until that adapter exists, label `paired-report` as a schema/fixture tool and
   live campaign results as per-run evidence rather than a causal comparison.

These extensions preserve the current ownership boundaries: the VS Code runner remains authoritative for host execution
and receipts, evaluator `processTask` remains authoritative for grader/evidence lifecycle, and `experiments/reporting`
remains the single paired-analysis implementation.
