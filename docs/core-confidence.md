# Core loop confidence

Run `pnpm test:core:confidence` after changing the execution loop. It uses scripted providers and consumes zero live
Copilot requests. Code QA runs the same command on Windows for pull requests and pushes to the main branches.

The command composes the existing E2E runner, managed-agent certification, and evidence stores:

1. Run E2E unit tests, build fresh extension/webview artifacts, and pass the exact VS Code **1.122.1** smoke and LM contracts.
   Run the explicit `test:core:regressions` selection for tool repetition, ticket batches, read/MCP progress, failed turns,
   compaction, request accounting, and Worker persistence, which are not all included in managed-agent certification.
2. Run three small-answer trials: one request, zero tools, one completion, and matching runtime, persisted journal, and
   extension-side projected status.
3. Run completion review/idle/follow-up and managed-child acceptance in the real 1.122.1 host. Completion must stay idle
   through the 35-second observation window; child results, parent review, verification, and navigation use existing tests.
4. Run managed-agent certification, including React replay of **this run's** completion capture. Existing deterministic
   coverage exercises productive repetition, genuine stalls, retries, command settlement, cancellation, and persistence.
5. Verify that extension, webview, test, and replay artifacts stayed unchanged during execution.

Each invocation creates a new `artifacts/core-confidence/core-*/` directory. `gate-result.json` is the final verdict;
preparation receipts, individual host results, and certification evidence retain diagnostics. `hostEvidenceRoot` identifies
the retained host captures under the OS/CI temporary directory, outside the repository as required by the profile owner.
A failed prerequisite, wrong host/provider, missing capture, failed certification, or changed artifact prevents success.
CI keeps reports and failure diagnostics for 14 days. Profiles contain only dedicated scripted-test state and are excluded
from the CI upload. Local runs keep their dedicated profiles and evidence for investigation; old runs can be removed
explicitly after review. Never use an earlier green run to describe changed source.

## Bounded Copilot checks

`pnpm test:live:core` uses the existing live gate and a fixed nine-scenario subset: small repository inspection, refactoring,
search recovery, completion idle, empty-response recovery, provider-error recovery, streaming cancellation, reload, and
background isolation. It runs the offline host prerequisites before paid requests. Defaults: VS Code 1.122.1, one sample
per scenario, **300 total requests**, two hours overall, and ten minutes per attempt. The total request limit includes
recovery requests; increasing samples does not increase that budget. An exhausted budget leaves missing cells unpassed.

Select an exact available model and supported effort. This example plans a run without launching a host or consuming calls:

```powershell
pnpm test:live:core --model-id gpt-5.6-luna --effort high --max-requests 100 --samples 1 --root F:/alpha-vscode-e2e-runs/core-confidence --profile-dir F:/alpha-vscode-e2e-runs/20260906/profiles --dry-run
```

After choosing the budget, replace `--dry-run` with `--init-root` for the first run into a new empty campaign root. Later
runs use its existing marker and a new run ID. Follow [the profile guide](vscode-live-test-profiles.md) for authentication
and owned-profile setup. The example model is not an availability guarantee. This suite is Copilot-only; it does not change
Vertex setup or model routing. An explicitly selected 1.136.1 run is supplemental and cannot satisfy the 1.122.1 gate.

Gate results identify the scenario subset, exact model/effort, host, samples, total usage/budget, and each attempt's requests
and elapsed time. Every required cell needs retained evidence and actual usage. Historical failures, excess usage, duplicate
attempts, missing samples, changed builds, and provider substitutions cannot be hidden by green aggregate counters.

## Improvement cycle

Keep the scenario list fixed before measuring. Run offline checks on every loop change; run the bounded live suite for
changes involving model behavior, prompts, or Copilot. Use at least three samples per scenario when making a comparative
quality claim, with matching model, effort, host, fixture, budget, and cache conditions. Keep baseline and candidate reports.
Compare completed tasks first, then requests per completed task and elapsed time. Include every failed/blocked attempt and
report provider/infrastructure failures separately. Do not optimize a request count by accepting incomplete work.

For every observed defect: retain its failed run, reproduce it at the owning boundary, add a deterministic regression,
fix the invariant, and rerun the affected gate. A later pass does not erase the earlier failure. Expand the fixed suite when
a newly observed core-loop failure is not represented; avoid unrelated feature work.

These gates establish confidence in specific tested contracts. They do not establish a general live solve-rate improvement,
rendered-UI correctness from projected state alone, or completion of all eight pending managed-agent integration rows.
Full long-context and medium/hard frontier-task grading remain separate acceptance work in NOR-48. The broader live
`test:live:reliability` suite is still available when a change affects those additional scenarios.
