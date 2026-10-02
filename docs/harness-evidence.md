# Harness evidence runbook

The local harness composes the existing package runners. It does not implement another agent, grader, task loop or test
framework. Alpha's extension remains the system under test; exact-host runs use VS Code **1.125.0**. Node **24.14.1** and
pnpm **11.24.0** are required. See [the hardening investigation](testing-evaluation-hardening.md) for reproduced failures,
upstream sources and compatibility changes.

## Running the affected gates

On a fresh checkout, build the shared types before invoking the harness. Its reused host evidence helpers consume runtime
schemas from `@alpha-code/types`, so lane commands cannot supply that prerequisite after the harness has already loaded.
QA and release workflows build the package before invoking any harness lane or matrix command.

Windows ownership inspection has a 30-second process deadline to allow cold CIM initialization. The host must still
prove its ancestry; unavailable inspection, incomplete chains, foreign owners and cycles cannot pass. A real child-process
test exercises the OS lookup in addition to controlled ancestry tests. Host startup failures retain the inspector's
bounded message so an inspection failure can be distinguished from a foreign process. The local COM lookup follows
[Microsoft's Get-CimInstance contract](https://learn.microsoft.com/en-us/powershell/module/cimcmdlets/get-ciminstance?view=powershell-5.1),
retrieved 2026-10-02; it records only process and parent IDs, without command lines or environment values.

```sh
pnpm --filter @alpha-code/types build
pnpm harness doctor
pnpm harness run static
pnpm harness run unit
pnpm harness run tooling
pnpm harness run offline
pnpm harness run focused core/agent/__tests__/AgentTurnEngine.spec.ts
pnpm harness run host
pnpm harness run confidence
pnpm harness run outcomes
pnpm harness matrix --output artifacts/harness/evidence-matrix.json --require static --require offline --require host --require confidence --require outcomes
```

Run build and host lanes sequentially. Their shared lease prevents one runner from replacing binaries used by another.
Focused checks accept test paths, without a standalone `--` or arbitrary runner options. Vitest workers are bounded to
two in harness processes. Source changes during a run invalidate that run; editing after a run makes its receipt stale
for the edited checkout. Repeat the required lanes after the final source change.

| Lane             | Existing owner and evidence scope                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `static`         | Root lint and type checks for extension, webview and host runner; mechanical command evidence               |
| `unit`           | Root bundle and Turbo package tests; command exit evidence only                                             |
| `tooling`        | Repository Node tests and compiled host-runner Node tests; observed file counts and outcomes                |
| `offline`        | Evaluator unit, contract and certification suites; complete configured test inventory                       |
| `focused`        | Selected extension Vitest files; observed execution for that selected scope                                 |
| `host`           | The literal `test:smoke:1250` owner, including the LM fixture contract; every selected test required        |
| `confidence`     | Core confidence owner, full smoke plus five core host suites, and deterministic managed-agent certification |
| `outcomes`       | Existing smoke campaign, one sample each of three independently asserted scripted workflows                 |
| `services`       | Existing PostgreSQL/Redis integration suite, requiring dedicated test service URLs                          |
| `infrastructure` | Optional Docker adapter suite, requiring its configured engine and images                                   |

The three outcome scenarios are `dev-git-inspect`, `dev-repo-bootstrap` and `review-edit-test-commit-followup`. They run
real extension tasks with a scripted provider and inspect repository effects independently. They establish bounded
workflow correctness, not a live model success rate or full task-bank coverage. Campaign profiles and workspaces stay
under an owned external temporary root; the repository stores the normalized evidence receipt.

Root lint/type scripts intentionally exclude developer-only evaluator packages. For evaluator changes, also run
`pnpm --filter @alpha-code/evals lint` and `pnpm --filter @alpha-code/evals check-types`.
CI runs both in the offline evaluator job.
The `services` readiness command is `pnpm --filter @alpha-code/evals services:check`. Offline and scripted host lanes do
not require those services, Docker, Copilot authentication or paid provider requests.

## Reading the matrix

`scripts/harness/inventory.mjs` maps current owners and nearest tests to 18 surfaces and eight evidence columns:
mechanical, component, end-to-end, regression, robustness, security, performance and live. The surfaces cover the agent
loop, instructions, providers, context, persistence, search, diagnostics/LSP, reads, edits, shell, verification, Git,
tool routing, subagents, permissions, recovery, compaction and extension UI. Each entry retains its source/test references,
execution history, current observations and unexecuted files.

An existing file is **discovered** evidence, not an executed test. **Executed-pass** applies only to the admitted scope;
partial groups keep their missing files visible. Failures and skips remain distinct. **Stale** means the source,
toolchain, boundary identity or age is not comparable. **Unavailable** denotes a required evidence kind that was not
established. Empty surface/column intersections remain **coverage-gap**. These labels do not collapse into a single
repository quality score.

The Node reporter consumes structured per-file and cumulative summaries from the
[Node 24.14.1 test-runner contract](https://github.com/nodejs/node/blob/v24.14.1/doc/api/test.md)
(retrieved 2026-10-02). A test against the pinned runtime verifies that boundary; console reporter text is not parsed.

The 15 layers are explicitly represented, with zero-based IDs matching the JSON:

| ID  | Layer                     | What current evidence can establish                                                        |
| --- | ------------------------- | ------------------------------------------------------------------------------------------ |
| 0   | Mechanical                | Executed lint and type commands                                                            |
| 1   | Unit                      | Admitted component test files                                                              |
| 2   | Contract                  | Grader, provider, tool and exact-host contract checks                                      |
| 3   | Independent task outcomes | The three bound scripted workflows; grader unit tests alone do not qualify                 |
| 4   | Regression                | Executed regression files within their declared scope                                      |
| 5   | Capability                | Bounded scripted task outcomes; broad live capability remains unavailable                  |
| 6   | Trajectory                | Observed loop, lifecycle and reconstruction contracts                                      |
| 7   | Robustness                | Explicit recovery, cancellation and fault tests                                            |
| 8   | Security                  | Explicit policy, containment and redaction tests                                           |
| 9   | Performance               | Unavailable without comparable before/after workload measurements                          |
| 10  | Variance                  | Unavailable without real repeated comparable observations                                  |
| 11  | Replay                    | Narrow reconstruction contracts exist; real workload replay/shadow evidence is unavailable |
| 12  | Canary                    | Unavailable without a production deployment and observations                               |
| 13  | A/B                       | Statistical machinery exists; production A/B evidence is unavailable                       |
| 14  | Monitoring                | Unavailable without configured production signals and objectives                           |

Component tests of statistics, replay machinery or a grader never promote themselves into production, live capability or
performance evidence. The matrix deliberately leaves layers 9–14 unavailable. Filling those gaps requires separately
owned observations and an explicit admission contract, not another test-file label.

## Admission and failure behavior

Each run writes `artifacts/harness/<run-id>/result.json` and a human-readable `result.md`. Schema-v2 reports bind the
command selection, pinned toolchain, commit, dirty state, lockfile and full source-content digest at both run boundaries.
Admission compares those identities with the current checkout and rejects receipts older than 24 hours. It validates
ordered report/step times, configured test inventories, per-file/aggregate counts and declared runner kinds. Skips,
TODOs, zero execution and missing receipts cannot satisfy a strict required lane. Reports from overlapping focused runs
retain their history; current evidence follows completion order so an older success cannot hide a newly completed failure.

The host owner exports only actual extension-host results, never its unit-test seam. Required suites bind unique run IDs,
the exact actual host version, each file's expected provider, complete test counts, ownership, capture and retention.
Confidence requires all 17 host suites from its existing smoke prerequisites and core checks. Unit-runner children clear
the host-receipt destination while retaining their separate Node execution collector, so negative unit fixtures cannot
publish host evidence.
Outcome admission additionally binds unique scenario/attempt/run identities and the campaign's source, build and task
configuration to captured task evidence. Completed capture alone is insufficient: task outcome, task IDs, required
artifacts and their digests must agree. Saved reports are revalidated on matrix import instead of trusting a saved pass
label or scenario summary.

The broad `unit` lane currently has no unified per-file execution receipt across Turbo package runners. Its command must
succeed in CI and release workflows, but `--require unit` intentionally fails because that command result cannot prove
each test executed. Windows host-runner tooling has two POSIX-specific process-group skips: its successful command is
retained as partial evidence, and `--require tooling` rejects that partial receipt. Linux CI requires complete tooling
evidence. The matrix never converts those exceptions into tests that passed.

Run logs remain with their existing owners. Normalized receipts omit test names, assertion messages, prompts, raw tool
output and environment values. Raw Vitest JSON is reduced to bounded execution metadata and removed. Missing,
malformed, oversized, cancelled, unfinished or contradictory evidence fails admission; diagnostics identify the failing
lane or receipt boundary. An unverified process cleanup preserves the build lease for inspection.

## CI and release use

Code QA retains the existing unit and tooling command gates on Linux and Windows. It adds current-source matrix checks
for mechanical, offline evaluator, confidence, and exact-host/task-outcome jobs. Each job admits its own checkout and
retains its evidence; results from different operating systems are not silently merged into one comparable run.

Both stable and preview release workflows run mechanical, unit, tooling, offline, exact-host, managed-agent confidence
and scripted-outcome checks, plus evaluator lint and type checks, before packaging and publication. They require current
`static`, `offline`, `host`, `confidence` and `outcomes` evidence in addition to command success. Each release owns its
confidence gate because a separate QA workflow does not order publication. Existing command-path approval and VSIX-content
checks remain required.
Upload steps run on failure too and retain reports/projected artifacts for 14 days, without uploading campaign profile or
workspace directories.

Live Copilot work remains a separate opt-in owner: use a current successful preflight, exact model identity, a signed-in
Alpha-owned 1.125.0 profile and an agreed request budget. A retained historical preflight is not current readiness. No
local or scripted receipt substitutes for that live evidence, service integration, or production rollout approval.
