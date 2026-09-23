# Problem-solving task set v1

This is the smallest curated set for Alpha's software and workflow work. It reuses the
`frontier-v1` task bank, pins a filtered Terminal-Bench 4.0.0 subset, and adds four
Alpha-native tasks. The manifest is `v1.yaml`. Loading it checks source releases, fixture
digests, lanes, and the core exclusions below. Grading stays on the existing command-grader
and grader-control contracts.

## Lanes

| Lane        | Use                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| core        | Stable comparison set. No science, GPU, hardware, credential-dependent, or required-network work.                |
| development | The rest of the visible bank, plus in-scope Terminal-Bench tasks and the new native tasks, for iteration.        |
| holdout     | Existing `holdout-001` through `holdout-012`, plus four withheld Terminal-Bench tasks. Do not use these to tune. |

Alpha bank tasks are local Node fixtures with networking disabled. Their wall-clock values
come from the frontier budgets. The 2 CPU / 2048 MB figures are the declared local profile.
Terminal-Bench CPU, memory, and the 28800-second agent budget come from the published
`v4.0.0` task manifests. Those digests are the SHA-256 of each task's `task.toml` text,
retrieved from the Hugging Face mirror of `harbor-framework/terminal-bench` tag `v4.0.0`
on 2026-09-21. Alpha fixture digests use the benchmark directory digest.

## Core coverage

The core lane includes debugging, JavaScript and TypeScript, Python, web, backend, CLI,
and selected data and finance work:

- Bank: cache invalidation, stream backpressure, workspace package order, CLI config layering, pagination, repository rules, validation after edit, API idempotency, and path policy.
- Terminal-Bench: `session-window-debug`, `bun-sourcemap-leak`, `nextjs-performance`, `react-lead-form`, `mvcc-lsm-compaction`, `wal-recovery-ordering`, `data-anonymization`, and `fin-saccr-rwa`.

## Terminal-Bench tasks left out of core

Left out of the whole set, not only core:

- Science and formal work, including biology, chemistry, physics, linguistics, and theorem proving.
- GPU and ML-serving work, including `jax-speedrun-gpu`, `fp8-rmsnorm-gemm`, and tasks whose published environment requests a GPU.
- Hardware, CAD, firmware, and photonic or console design.
- Live or credential-sensitive work: `kv-live-surgery`, browser claims processing, and network forensics.
- Media, music, and layout-recreation tasks that are outside software workflow.

Development keeps heavier in-scope tasks such as `cumulative-layout-shift`,
`vf2-speedup-networkx`, and the stateful CLI and data tasks. Holdout Terminal-Bench tasks
are `live-database-cutover`, `payments-pipeline-fix`, `intrastat-meldung`, and
`telecom-entity-resolution`.

## Alpha-native tasks

These four fixtures start broken. A reference solution, a different correct solution, a
wrong edit, and the untouched fixture are graded with the existing command grader:

| Task                       | Outcome                                              |
| -------------------------- | ---------------------------------------------------- |
| `alpha-pr-comparison`      | Decide whether two diffs make the same line changes. |
| `alpha-change-integration` | Wire the existing archive module into the router.    |
| `alpha-cleanup`            | Remove the debug suffix and unused export.           |
| `alpha-skill-workflow`     | Follow `skill/SKILL.md` for the ready-record total.  |

Core bank tasks and the four native tasks are certified locally: a reference solution passes
repeatedly, a different correct solution passes, and a wrong edit and the untouched fixture fail.
The other visible bank tasks must match their existing keyless calibration reports, which already
require 20 passing gold repetitions and rejected broken solutions. Terminal-Bench oracle runs stay
on Harbor's published oracle agent. Selected bank digests must equal the fixture digests recorded
in `frontier-v1`.

One selected local task can be prepared for the existing VS Code extension campaign. Each attempt
gets a fresh workspace and profile. The final workspace is graded with the existing command grader.
A scripted or preflight run is not counted as solving evidence, and provider, cancellation, budget,
and task failures stay distinct.

Live improvement runs follow `improvement-loop.md`: one declared subset, one general harness
change, then the same subset on the new build. Holdout stays out of that change.

## Live trajectory reports

Run live quality measurements through the actual VS Code extension and Copilot provider:

```sh
pnpm --dir packages/evals benchmark:problem-solving-live
```

Every invocation creates a unique run directory and refuses to reuse an existing one. The report
stores the Git commit, clean/dirty state, a digest of the build and evaluation inputs, the resolved
task-set digest, and the exact selected task IDs and repetitions. The default is one sample for each
of the 32 eligible local tasks. `PROBLEM_SOLVING_TASK_IDS` accepts a
comma-separated subset, `PROBLEM_SOLVING_REPETITIONS` accepts 1 through 3, and the host, model,
effort, request limit, run ID, attempt root, and profile root can be set with the corresponding
`PROBLEM_SOLVING_*` environment variables. Terminal-Bench and holdout remain excluded from this
local grader path.

Create a privacy-safe diagnostic packet from a completed run:

```sh
pnpm --dir packages/evals benchmark:problem-solving-diagnose --report <run-root>/report.json --output <new-path>/diagnosis.json
```

The command writes JSON and Markdown. It includes outcome uncertainty, the planned selection,
task-set and extension-entrypoint digests, per-attempt execution-start evidence, task tags, requests
and tokens, event counts, retries, approvals, verification, scheduler batch timing/parallelism,
effective tool-policy digests, evidence integrity, and coarse tool categories. It never copies
prompts, assistant text, tool names, arguments, paths, or output. A reviewer can use this packet to
challenge the diagnosis and choose the next experiment without receiving task transcripts or
workspace contents. Policy hashes include each attempt's workspace scope, so differences across
tasks or run roots do not by themselves mean that policy behavior changed. The extension digest
covers `src/dist/extension.js` on disk; matching the later E2E capture digest does not attest to
every packaged asset or directly prove which bytes VS Code loaded.
The diagnosis flags campaigns with multiple runner-captured entrypoint digests as mixed-artifact
evidence rather than treating them as one controlled run.

The report flags tag-based coverage candidates such as branch/worktree operations, live GitHub
issue/PR flows, concurrent workspace edits, and delegation. These flags are prompts for task-text
review, not proof that a behavior is absent. For example, the current live set includes a `git`
tagged PR diff-comparison task, but that is not evidence for a branch/commit/worktree lifecycle.

The diagnosis distinguishes attempts recorded from task executions with positive start evidence. It
lists every planned task and repetition, tasks that remain pending, and a bounded stop signal for
early exits such as a busy VS Code profile. Initialization-only events do not count as task starts;
an attempt with unknown start evidence remains a failure in its original report and remains pending
for execution coverage. Blocked attempts do not enter the grader-scored pass-rate denominator. The
E2E command gate also reports a fixed rejection reason without copying the command or weakening the
approval boundary.

Use the exact same host, model, effort, and task subset to repeat a baseline before changing the
agent. Then change one general harness rule, run that same subset on the new build, and compare
verified completion first, followed by requests, tokens, policy/tool categories, retries,
validation, and trace completeness. Keep a distinct report per run; unknown cost remains null. The
live runner's default host is a measurement setting; the repository's exact VS Code 1.122.1
compatibility gate still runs separately when a change affects the extension host contract.
