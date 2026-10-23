# Problem-solving improvement loop

Use the live Copilot runner to compare verified completion on a declared task set, then requests, time, and tokens.
Holdout tasks are reserved for promotion checks and must not inform the change being evaluated. The task manifest and
private graders remain the source of truth for eligibility and scoring.

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
