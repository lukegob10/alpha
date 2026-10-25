# Problem-solving improvement loop

Use `benchmark:improve` to turn retained attempt evidence into reviewed regressions and an implementation handoff.
The stages connect sealed evidence, human or model feedback, explicit human adjudication, a draft regression,
local control validation, and ranked changes. After implementing a reviewed change, use the existing real-host runner
for fresh confirmation. The workflow does not apply source patches, admit generated tasks, merge changes, or deploy.

This follows the evidence and feedback approach in OpenAI's
[agent improvement loop cookbook](https://developers.openai.com/cookbook/examples/agents_sdk/agent_improvement_loop)
(retrieved 2026-10-23), implemented through Alpha's existing TypeScript evaluator and extension harness.

## Keep the evidence graph immutable

Choose an absolute artifact-store root outside the checkout and normal editor data. Each iteration has named stage
records, sealed content-addressed artifacts, and exact parent references. `--from` names prior stage IDs in the same
iteration; the store records their digests. Reusing an ID with changed content is rejected. Create a new record to
correct an observation or decision, and keep the original attempt and failed checks.

Feedback binds the run, trial, attempt, and sealed bundle digest, with optional event-sequence and artifact-digest
anchors. Use actual producer evidence and its matching artifact store. A diagnosis report, assistant claim, or copied
success message does not replace that evidence. Stage-manifest digests and the record's content digest are distinct;
proposal approval requires the proposal's `value.digest`.

Regrading archived output measures the saved output under the chosen checks. Running draft controls tests the new
verifier against untouched, reference, alternative, and deliberately incorrect implementations. Neither observation
establishes how a changed agent behaves on a fresh task. Live quality claims require fresh producer receipts with
matching source, build, host, model, policy, task, and declared run conditions.

## Choose an evidence source

| Source                                                   | Import                                                               | Supported use                                                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Existing evaluator full capture                          | `capture` with a sealed `EvidenceBundle` and its matching CAS        | The reviewed feedback, archived grading, and regression workflow below, after integrity checks.                                     |
| Retained native host projections                         | `capture-host` with an eligible owned campaign report and attempt ID | Observation of retained host/model identity, lifecycle, usage, and recorded outcomes. Missing whole-task content stays unavailable. |
| New native full capture explicitly enabled before a task | `capture-native` with the actual successful rich-capture receipt     | The full workflow only when the producer reports `captured` and bundle, artifact, source-task, and runtime-task identities verify.  |

Existing campaign history does not acquire full transcripts, final responses, diffs, workspace snapshots, or complete
verifier output through import. `capture-host` produces a distinct `host-observation` record with
`semanticGradingEligible: false` and `regressionGenerationEligible: false`; it cannot replace the full `capture` parent
required by feedback and regression generation. It verifies eligible exact-host Copilot campaign evidence against its
retained index, phase receipts, and artifacts. A raw report or unowned log directory alone is insufficient.

For example, prepare an input file using a real retained campaign report and an attempt ID found in that report:

```json
{
	"id": "retained-host-observation-1",
	"reportPath": "<existing-relative-report-file.json>",
	"attemptId": "<actual-report-attempt-id>"
}
```

```powershell
pnpm --filter @alpha-code/evals benchmark:improve capture-host --store '<absolute-owned-artifact-store>' --iteration 'retained-review-1' --id retained --input '<absolute-host-observation-input.json>' --source-root '<absolute-owned-campaign-run-directory>'
```

For future native evidence, explicitly add both `--improvement-evidence` and
`--improvement-task-id '<public-task-id>@<version>'` to the existing prepared `runTest.js` invocation for a single
`problem-solving-attempt` in its `run` phase on exact VS Code `1.138.0`. Use explicit owned profile, workspace, and
artifact paths. The public task must resolve in the trusted catalog; setup and unrelated scenarios cannot enable this
capture. Capture is private and scoped to the requested task; normal privacy projections keep their existing format.

For a deterministic capture diagnostic, first build with the existing commands in [Prepare one controlled run](#prepare-one-controlled-run).
Choose a new absolute root outside the checkout and normal editor data. This example copies the existing public
fixture, marks the workspace with the same ownership contract as the benchmark launcher, and uses a fresh scripted profile:

```powershell
$nativeRoot = '<new-absolute-owned-capture-root>'
if (Test-Path -LiteralPath $nativeRoot) { throw 'Choose a new capture root.' }
$nativeWorkspace = Join-Path $nativeRoot 'workspace'
New-Item -ItemType Directory -Path $nativeWorkspace | Out-Null
Get-ChildItem -LiteralPath 'evals/javascript/repo-cache-invalidation' -Force | Copy-Item -Destination $nativeWorkspace -Recurse
[System.IO.File]::WriteAllText((Join-Path $nativeWorkspace '.alpha-e2e-owned.json'), '{"schemaVersion":1,"purpose":"alpha-vscode-e2e","kind":"workspace"}', [System.Text.UTF8Encoding]::new($false))
node apps/vscode-e2e/out/runTest.js --vscode-version 1.138.0 --provider scripted --workspace "$nativeWorkspace" --profile-dir "$nativeRoot/profile" --artifacts-dir "$nativeRoot/artifacts" --init-profile --retain-evidence-for-campaign --run-id native-capture-contract --file workflow.test --scenario-id problem-solving-attempt --scenario-phase run --request-limit 8 --improvement-evidence --improvement-task-id repo-cache-invalidation@1 --require-all-tests
```

The producer writes `improvement/context.json`, `improvement/capture-result.json`, and, when capture succeeds,
`improvement/bundle.json` with `improvement/artifacts/` inside the actual run directory. Check the capture result;
requesting capture does not guarantee a complete bundle. Inspect `missingArtifacts`, per-source capture statuses, and
integrity results. `incomplete` or `failed` results cannot enter the full workflow.
After a result actually reports `captured`, prepare this importer input:

```json
{ "captureResultPath": "improvement/capture-result.json" }
```

```powershell
pnpm --filter @alpha-code/evals benchmark:improve capture-native --store '<absolute-owned-artifact-store>' --iteration 'native-review-1' --id observed --input '<absolute-native-capture-input.json>' --source-root '<absolute-owned-native-run-directory>'
```

The CLI takes a contained relative path under `--source-root`, verifies it, then passes the exact absolute run-owned
path to the assembler API. Use `improvement/capture-result.json` for the standard producer output.
This importer retains the verified public source-task and runtime-task mapping in an immutable parent record. Later
`propose` and `feedback-model` still require the operator's trusted `--catalog-root` and `--task`; they inherit the captured
runtime manifest and reject a changed or conflicting mapping. Manual full-bundle import with `capture` still requires
the matching `--runtime-manifest` when its evidence uses a runtime task identity.

The native `test_output` artifact contains actual paired agent tool output with `independentGrade: false`. It preserves
observed execution results without inventing an independent benchmark score; run the existing independent verifiers
for that claim. The scripted capture contract currently accepts `repo-cache-invalidation@1`. A successful scripted
sample supports only the deterministic capture contract. It does not demonstrate a model solving the source benchmark
or a live quality improvement. Historical observations, newly captured task evidence, archived grader results, and
fresh control/candidate confirmation retain their separate scopes.

## Offline human path

Run from the repository root with dependencies installed. This path performs no model calls. Substitute absolute
paths and the identity of the sealed public source task; holdout tasks cannot generate public regressions. If the
producer uses a runtime task-manifest identity, also pass its matching `--runtime-manifest` to `propose`.
The sequence below starts with a full evaluator bundle and its CAS. A successful `capture-native` stage can supply the
same `observed` parent instead; an observation-only `capture-host` stage cannot.
Control validation requires Docker and an already available Linux image with Node.js 24, selected by immutable image
digest. The validator does not pull an image. Choose explicit CPU, memory, process, and time limits before execution.

Prepare these JSON inputs in an owned directory outside the checkout:

| File                   | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observed.bundle.json` | The original sealed `EvidenceBundle`; retain its source CAS directory.                                                                                                                                                                                                                                                                                                                                                                                         |
| `context.json`         | `{ "sourcePaths": ["<source-relative-owning-file>"], "identityReceipt": ... }`. Supply the complete raw report from an existing report-only host campaign as the observed provider reference. Include all proposed owning and allowed change paths. The `context` stage recomputes current checkout, built extension, harness, and task-set fingerprints and hashes actual source files; it checks the current frame twice. Build the selected checkout first. |
| `human.json`           | A human `FeedbackInput` with the observed finding, expected behavior, severity, classification, and exact evidence reference.                                                                                                                                                                                                                                                                                                                                  |
| `adjudication.json`    | A human `FeedbackReviewInput` with the sealed feedback digest, decision, and rationale. Only `accepted` permits a proposal.                                                                                                                                                                                                                                                                                                                                    |
| `proposal.json`        | `{ "draft": ..., "policy": ... }` using the [draft and host-policy schemas](../../packages/evals/src/improvement/regressions.ts). Review source files, test files, exact command arguments, one reference, one alternative, and at least three incorrect controls. The draft's expected behavior must equal the accepted feedback.                                                                                                                             |
| `materialize.json`     | `{ "ownedRoot": "<existing-absolute-owned-directory>", "destinationName": "reviewed-regression", "policy": ... }`, with the exact proposal policy. The destination must be new.                                                                                                                                                                                                                                                                                |
| `regrade.json`         | `{ "specs": [...], "ownedRoot": "<existing-absolute-owned-directory>", "destinationName": "archived-review" }`. Use read-only [grader specs](../../packages/evals/src/grading/types.ts) over retained `artifacts/` or restored `workspace/` paths. No archived code or command grader executes.                                                                                                                                                                |
| `validate.json`        | `{ "policy": ..., "execution": { "image": "sha256:<local-image-id>", "limits": { "cpus": 1, "memoryBytes": 536870912, "pids": 64, "timeoutMs": 15000 } } }`, with the same policy and a locally available immutable image. See the [execution configuration](../../packages/evals/src/improvement/execution.ts).                                                                                                                                               |
| `handoff.json`         | `{ "id": ..., "createdAt": ..., "candidates": [...] }` using the [handoff contracts](../../packages/evals/src/improvement/handoff.ts). Bind the feedback, review, and proposal digests. The command takes its sealed context from the `context` parent stage. Optional `output: { "ownedRoot": "<existing-absolute-owned-directory>", "destinationName": "handoff-output" }` writes the manifest and `codex_handoff.md` to a new owned directory.              |

The [feedback schemas](../../packages/evals/src/improvement/contracts.ts) are strict. For example, populate this
annotation from the retained bundle and the event or artifact you actually inspected:

```json
{
	"schemaVersion": 1,
	"recordType": "feedback",
	"id": "human-finding-1",
	"createdAt": "<ISO-8601-timestamp>",
	"source": { "type": "human", "reviewerId": "<reviewer-id>" },
	"finding": "<observed behavior>",
	"expectedBehavior": "<specific behavior to preserve in a regression>",
	"severity": "high",
	"classification": "implementation-defect",
	"evidence": {
		"runId": "<bundle-run-id>",
		"trialId": "<bundle-trial-id>",
		"attemptId": "<bundle-attempt-id>",
		"bundleDigest": "sha256:<actual-bundle-digest>",
		"eventSequence": 1,
		"artifactDigest": "sha256:<actual-inspected-artifact-digest>"
	}
}
```

Replace `eventSequence` with the inspected event, or omit it when using only an artifact anchor. Use classifications
`missing-requirement`, `execution-failure`, `implementation-defect`, or `observability-defect` according to the evidence.
Record explicit adjudication after sealing the feedback:

```json
{
	"schemaVersion": 1,
	"recordType": "feedback-review",
	"id": "review-1",
	"createdAt": "<timestamp-at-or-after-feedback>",
	"source": { "type": "human", "reviewerId": "<adjudicating-reviewer-id>" },
	"feedbackDigest": "sha256:<sealed-feedback-content-digest>",
	"decision": "accepted",
	"rationale": "<why the cited evidence supports this finding and expected behavior>"
}
```

The local CLI records reviewer identities; the operator owns authenticating the human decision. Model feedback cannot
adjudicate itself. Use `rejected` or `needs-info` when the evidence does not support proceeding.

This PowerShell sequence shows the complete offline stage order. Prepare each input only after inspecting the previous
stage's output; the file names below are operator-authored inputs, not automatically generated approvals.

```powershell
$store = '<absolute-owned-artifact-store>'
$inputs = '<absolute-reviewed-input-directory>'
$sourceArtifacts = '<absolute-original-evidence-CAS-root>'
$catalog = '<absolute-checkout>/evals'
$source = '<absolute-checkout>'
$common = @('--store', $store, '--iteration', 'reviewed-iteration-1')

function Invoke-Improvement {
    & pnpm --filter @alpha-code/evals benchmark:improve @args
    if ($LASTEXITCODE -ne 0) { throw "Improvement stage exited $LASTEXITCODE; inspect retained evidence before continuing." }
}

Invoke-Improvement capture @common --id observed --input "$inputs/observed.bundle.json" --source-artifacts "$sourceArtifacts"
Invoke-Improvement context @common --id context --input "$inputs/context.json" --source-root "$source"
Invoke-Improvement feedback-human @common --id human --from observed --input "$inputs/human.json"
Invoke-Improvement show @common --id human

# Fill adjudication.json with human.value.digest before continuing.
Invoke-Improvement adjudicate @common --id reviewed --from 'human,observed' --input "$inputs/adjudication.json"
Invoke-Improvement propose @common --id proposed --from 'observed,human,reviewed' --input "$inputs/proposal.json" --catalog-root "$catalog" --task '<source-task-id>@<version>'
Invoke-Improvement show @common --id proposed

# Inspect the full draft and policy, then copy proposed.value.digest.
$proposalDigest = 'sha256:<reviewed-proposal-content-digest>'
Invoke-Improvement materialize @common --id materialized --from 'proposed,observed' --input "$inputs/materialize.json" --approve-proposal-digest "$proposalDigest"
Invoke-Improvement regrade @common --id archived --from 'proposed,observed,context' --input "$inputs/regrade.json" --source-root "$source"
Invoke-Improvement validate @common --id validated --from 'materialized,proposed,observed,archived' --input "$inputs/validate.json" --approve-proposal-digest "$proposalDigest" --allow-execution

# Review validation results and prepare the source-bound handoff input.
Invoke-Improvement handoff @common --id handoff --from 'observed,context,human,reviewed,proposed,validated' --input "$inputs/handoff.json" --source-root "$source"
Invoke-Improvement show @common --id handoff
```

Stop on any rejected stage or failing control validation. An archived regrade can correctly retain a failure: it records
what the original output satisfies, independently of the draft control results. `--allow-execution` authorizes the
reviewed commands in the isolated control environment. Generated commands are not accepted merely because a model
suggested them. The materialized task stays `draft` even
when controls pass. Handoff output includes ranked JSON and Markdown with evidence, adjudication, code scope, and
validation references. These reports and handoffs are private tool artifacts under the chosen store, not documents to
add to the checkout. Review the proposed implementation and its diff through the normal engineering workflow.

## Optional model feedback

`feedback-model` is an explicit alternative feedback stage. It requires `--allow-network`, `--configuration`, a selected
public source task, current harness context, rubric, and chosen evidence anchors. Its configuration selects the exact
endpoint and model, API-key environment-variable name, timeout, request/response byte limits, and output-token budget.
Supply the credential through that environment variable; do not put it in JSON or evidence. There is no implicit model
selection or automatic model-review dispatch. See the [model review input and configuration schemas](../../packages/evals/src/improvement/modelReview.ts).

The result remains untrusted feedback and optional regression drafts. Select one observation with `--feedback-record`
for adjudication and proposal. Each observation still needs a human decision and the same local validation stages.
Native capture artifacts remain private; private artifact selections are rejected by default. To authorize one model
review of selected private evidence, add `--approve-private-artifact-digests` with one to eight unique exact SHA-256
digests, together with `--allow-network` and the explicit model configuration. For example, using the same full
`observed` capture stage and trusted public task:

```powershell
Invoke-Improvement feedback-model @common --id model-feedback --from observed --input "$inputs/model-review.json" --configuration "$inputs/model-configuration.json" --catalog-root "$catalog" --task '<source-task-id>@<version>' --allow-network --approve-private-artifact-digests 'sha256:<selected-private-artifact-digest>'
```

Prepare `model-review.json` and `model-configuration.json` from the linked schemas. The CLI binds disclosure approval
to that bundle, the selected private digests, and the configured endpoint and model. Extra, unselected, or public
artifact approvals are rejected; holdout remains refused. This approves sending only that selected evidence for the
configured review. Artifact access labels stay private, and the response still needs human adjudication before a
proposal can proceed. Capture or a model-supplied input cannot authorize disclosure on its own.

## Fresh confirmation

Record the reviewed repair before applying it. `review-repair` checks the handoff item, human decision, allowed paths,
and current source hashes; it seals the reviewed patch data without applying it. Preserve the control checkout and
prepare the candidate through the normal reviewed implementation workflow. Freeze a confirmation plan before running
the comparison, then use `confirm-run` to dispatch the existing extension-host campaign runner for its control and
candidate arms. It requires explicit `--allow-execution`; live quality also requires `--allow-network`, an exact selected
model, dedicated profiles, and bounded campaign requests and duration.
Use `confirm-import` only to inspect imported observations: an imported result cannot establish a fresh-run keep decision.
The `report` stage records the confirmation outcome; it does not promote a baseline. Missing or mismatched producer
receipts remain inconclusive.

Prepare `repair.json` using the [human-reviewed repair contract](../../packages/evals/src/improvement/handoff.ts),
`confirmation-plan.json` using the [confirmation plan contract](../../packages/evals/src/improvement/confirmation.ts),
and `confirmation-run.json` containing `{ "adapter": { "control": ..., "candidate": ... } }`. Each adapter arm supplies
absolute `repositoryRoot`, `campaignRoot`, and `profileRoot` paths plus an existing runner `config`. The config must
match the declared registered scenarios, exact hosts, model, and budgets. Set up and build both arms before dispatch;
the confirmation command uses their existing compiled runner.
Map each reviewed regression ID to a registered host scenario in the plan's targeted requirements, and include
neighbor scenarios. Materializing a draft does not register a host scenario or admit it to a live suite.

```powershell
Invoke-Improvement review-repair @common --id repair --from 'handoff,context' --input "$inputs/repair.json" --source-root "$source"
Invoke-Improvement confirmation-plan @common --id plan --input "$inputs/confirmation-plan.json"

# Run only after reviewing the plan, prepared control/candidate, profile ownership, and total budget.
Invoke-Improvement confirm-run @common --id confirmed --from 'observed,human,reviewed,proposed,handoff,repair,plan' --input "$inputs/confirmation-run.json" --allow-execution --allow-network
Invoke-Improvement report @common --id report --from 'confirmed,human,reviewed,proposed,handoff,repair'
```

The command shown opts into live quality. For a scripted host regression plan, omit `--allow-network`; its receipts
establish deterministic host behavior, not model quality. Preserve both kinds of confirmation with their declared scope.
Validation exits `0` for passed controls, `1` for failure, and `2` for inconclusive results. Confirmation exits `0` for
`keep`, `1` for `revise` or `revert`, and `2` for `inconclusive`. The wrapper stops on a nonzero exit; inspect the retained
stage, then run `report` explicitly when needed. A successful report command means analysis completed, not that the
candidate was kept.

Compare verified completion first, then requests, time, and tokens. Holdout tasks are reserved for promotion checks and
must not inform the change being evaluated. The task manifest and private graders remain the source of truth for
eligibility and scoring.

## Prepare one controlled run

Build once before the campaign. Keep the source, extension bundle, host, model, effort, request limit, task selection,
grader, and approval policy fixed throughout it. Run builds and campaigns serially.

```sh
pnpm bundle
pnpm --filter @alpha-code/vscode-webview build
pnpm --dir apps/vscode-e2e compile
```

Use a dedicated, initialized live profile as described in [live tests](../../README.md#live-tests). The runner
requires explicit absolute `PROBLEM_SOLVING_PROFILE_DIR` and `PROBLEM_SOLVING_ATTEMPT_ROOT` paths. Choose a new attempt
root outside the repository and normal editor data for every run; an existing run directory is rejected. No dated
machine-specific profile or output location is selected automatically.

After substituting the paths and a currently available model, this PowerShell example selects a small diagnostic cohort:

```powershell
$env:PROBLEM_SOLVING_PROFILE_DIR = '<absolute-owned-profile-root>'
$env:PROBLEM_SOLVING_ATTEMPT_ROOT = '<new-absolute-attempt-root>'
$env:PROBLEM_SOLVING_TASK_IDS = 'repo-pagination-cursor,repo-cache-invalidation,repo-stream-backpressure'
$env:PROBLEM_SOLVING_REPETITIONS = '2'
$env:PROBLEM_SOLVING_HOST_VERSION = '1.138.0'
$env:PROBLEM_SOLVING_MODEL_ID = '<exact-discovered-model-id>'
$env:PROBLEM_SOLVING_EFFORT = '<supported-effort>'
$env:PROBLEM_SOLVING_REQUEST_LIMIT = '40'
$env:PROBLEM_SOLVING_PROMPT_VARIANTS = 'baseline,single-command'
pnpm --filter @alpha-code/evals benchmark:problem-solving-live
```

The request limit applies to each attempt. Predeclare the total task, repetition, prompt-arm, time, and request budget
before launching a campaign. The runner alternates the two prompt arms across repetitions. The `single-command` arm
changes task-independent command guidance; it does not grant additional permissions.

## Keep evidence with its run

Each unique run retains host/model/effort, build and evaluation identities, task-set digest, selected IDs and repetitions,
and every verifier decision, failure class, request count, token measurement, and available cost. Missing prices remain
null. Do not overwrite failed attempts with a later retry.

The runner compares the prelaunch SHA-256 of `src/dist/extension.js` with each E2E capture. Matching entrypoint reads do
not fingerprint every packaged asset or prove that the host loaded those exact bytes. Preserve source and build
identities together; a dirty-tree digest is not interchangeable with a clean source revision. Workspace-dependent tool
policy hashes alone cannot establish equivalent approval settings across fresh workspaces.

Use `benchmark:problem-solving-diagnose` to combine the run's `report.json` and content-free E2E projections into a review
packet. The packet keeps allowlisted tool categories and reports missing evidence and unknown cost. Raw prompts, tool
arguments, file contents, commands, and outputs stay outside it. Recorded attempts, evidence of execution start, workflow
verification events, and grader outcomes are separate observations; initialization alone is not a confirmed task start.

## One iteration

1. Declare the tasks, reference/candidate identities, repetitions, prompt arms, cache conditions, budgets, and decision
   rule before running. Keep all failed, blocked, and incomplete attempts in the denominator appropriate to the claim.
2. Grade each resulting workspace and compare verified completions first. Requests, time, and tokens are secondary.
3. Review the diagnosis and write one hypothesis that applies to a different task, language, test command, and layout.
4. Implement only that hypothesis and add a deterministic regression at the owning boundary. Do not add task IDs,
   fixture paths, or transcript commands to approval allowlists.
5. Run the same declared workload on a new fixed build. Keep, revise, or revert according to the predeclared rule; a new
   failure class or a drop in verified completion requires investigation.
6. Use holdout only after the change survives confirmation. Record the motivating run, general rule, and confirming
   evidence with the change.

Stop automatic dispatch on authentication, provider, profile-lease, infrastructure, cancellation, or grader failures.
Resolve the admission problem before a new campaign. A grader score after an approval block measures the resulting
workspace; it does not establish what a model would have done after an admitted command.

A single sample can screen for a defect. Two repetitions of a small selected cohort can diagnose a local gate
interaction. Neither establishes stable variance or a general quality improvement. Comparative claims need repeated,
matched observations and an uncertainty analysis appropriate to task selection and clustering. Keep the exact 1.138.0
host gate and 1.125.0 compatibility gate separate from same-host live quality measurements.

Terminal-Bench uses its pinned container verifiers and stays outside the local Node/Copilot score. Preserve historical
evaluation data, including interrupted campaigns; current operating guidance does not treat past results as current
acceptance.
