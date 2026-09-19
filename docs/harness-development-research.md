# How Alpha should test and improve its coding-agent harness

Research completed **2026-09-18**, against Alpha commit
`f85371b02c7fbe2fd07c19e7d411aebe8f2a8dce` (the committed toolchain migration).
Reference host: **VS Code 1.122.1**. Development baseline: Node 24.14.1, pnpm 11.24.0, npm 11.11.0.

**Recommendation:** strengthen the testing and evidence systems Alpha already has. Use fast controlled tests to establish
mechanics, real-host checks to establish extension behavior, and repeated live-model comparisons to establish task-solving
quality. Connect all three to a short diagnosis and decision record. A larger test count or one higher benchmark score
is not the goal; the goal is to explain which change helped, for whom, and with what tradeoffs.

This is research before implementation. Tracked changes are documentation only. No new tests, runtime changes,
paid live campaigns, merges or publishing were performed. An unintended dependency setup during formatting is recorded
under validation limits below. Prior test results below are recorded
evidence, not tests rerun for this report. Bounded Luna Max workers gathered independent lab, coverage and observability
evidence; the orchestrator inspected the central sources/code and reconciled the recommendations.

## Reading guide and evidence standard

| Read                                                                  | Purpose                                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| This report                                                           | Findings, minimal matrix, metrics, development loop and ordered next work                       |
| [Lab evidence](harness-research/lab-evidence.md)                      | Anthropic and Google/DeepMind sources, publication dates, pinned Gemini CLI code and limits     |
| [OpenAI and methods evidence](harness-research/openai-and-methods.md) | OpenAI/Codex, pinned public tests, SWE-agent, Inspect, Harbor and statistical sources           |
| [Alpha coverage map](harness-research/alpha-coverage.md)              | Verified implementations, representative tests, exact commands and coverage limits              |
| [Alpha observability map](harness-research/alpha-observability.md)    | Existing events, persistence, evidence export and diagnosis gaps                                |
| [Evaluation design](harness-research/evaluation-design.md)            | Reproducibility, graders, paired comparisons, sample sizes, error accounting and decision rules |

**Published evidence** means an opened primary article, paper, documentation page or source file. **Repository evidence**
means inspected code at the Alpha revision above. **Inference/recommendation** means our proposed application of that
evidence. “Unverified” means this research did not establish the behavior; it does not mean the feature is absent.
Source tables record retrieval date 2026-09-18, publication dates where established and inspected revisions. No claim
here assumes access to undisclosed internal lab procedures.

## What the lab evidence actually says

The strongest common pattern is: define a useful outcome, expose failures, inspect the trajectory and resulting state,
change a specific mechanism, then compare again. Public evidence is much clearer about these building blocks than about
every lab's internal release thresholds.

| Organization / project        | Published evidence                                                                                                                                                                                               | Implication for Alpha                                                                                                                                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI/Codex                  | Public source requires integration coverage for agent-logic changes; mocked response streams check requests and tool transactions. App Server describes shared core logic with explicit item/turn/thread events. | Exercise Alpha's real kernel with controlled providers, and keep UI surfaces as projections of one runtime. [Code](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/AGENTS.md), [architecture](https://openai.com/index/unlocking-the-codex-harness/) |
| Anthropic/Claude Code         | Describes progression from employee/user feedback to narrow and then complex behavior evals, supplemented by monitoring and A/B tests.                                                                           | Preserve both stable regressions and challenging capability cases. [Engineering account](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)                                                                                                                   |
| Anthropic harness experiments | A later app-development study removed orchestration components as stronger models made them less useful.                                                                                                         | Re-test scaffolding assumptions after model changes; more machinery can become overhead. [Case study](https://www.anthropic.com/engineering/harness-design-long-running-apps)                                                                                                      |
| Google/Gemini CLI             | Pinned public eval guidance and workflow expose realistic workspace tests, nightly repetitions, staged promotion and baseline verification.                                                                      | Give new probabilistic checks an incubation period; retain first-attempt failures even when retries allow CI to proceed. [Public eval guide](https://github.com/google-gemini/gemini-cli/blob/4577750da8e9fcee42297a2f54fbae18c0fa6324/evals/README.md)                            |
| Google/DeepMind research      | Controlled architecture comparisons show coordination effects depend on task structure and overhead.                                                                                                             | Treat delegation as a workload-specific hypothesis, including parent verification cost. [Paper, v3](https://arxiv.org/html/2512.08296v3)                                                                                                                                           |
| SWE-agent                     | Describes inspecting development trajectories, sweeping interface configurations and running fixed-model ablations.                                                                                              | Derive tool/harness ideas from observed difficulty and test the mechanism, rather than copy another agent's prompt. [Paper, v3](https://arxiv.org/html/2405.15793v3)                                                                                                               |

This supports the user's intuition that good tests improve the ability to invent: a useful test makes an expectation
concrete and provides quick feedback on an experiment. It does **not** imply that every new idea needs a huge benchmark,
that test quantity measures quality, or that all cells in a matrix deserve a dedicated suite.

There are real tensions. Gemini's retry/promotion policy is designed to keep probabilistic CI usable; retry-assisted
passing is a different metric from first-attempt reliability. A terminal benchmark can exercise a real agent but still
miss extension lifecycle and UI defects. A lab's successful web-app demonstration can suggest a hypothesis without
establishing its average benefit. Independent grading improves scrutiny, but an LLM evaluator can still be wrong.

The reports also concern different objects: model capability, the agent runtime, an evaluation runner, and the developer's
repository/test environment. Changing all four together can improve the overall system while leaving the harness's
individual contribution unknown. Alpha should declare which object each experiment changes.

## Alpha's starting point

Alpha has substantial infrastructure already. The next work is an audit of fidelity, evidence connections and decision
quality—not a new standalone agent or parallel evaluation engine.

| Existing owner                                                                                                                                                                                           | Verified role                                                                                                  | Limit to retain                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [Agent kernel](../src/core/agent/) and [Task integration](../src/core/task/Task.ts)                                                                                                                      | Turn sequencing, captured step context, scheduling, policy and lifecycle integration with focused tests        | A mocked dependency can narrow what a test proves; read assertions and setup rather than rely on filenames                  |
| [Provider adapters](../src/api/providers/) and [transforms](../src/api/transform/)                                                                                                                       | Provider-boundary behavior and history/stream transformations                                                  | One provider's passing path does not establish ordering, opaque-state or cancellation behavior for every adapter            |
| [VS Code runner](../apps/vscode-e2e/package.json)                                                                                                                                                        | Exact 1.122.1 smoke, scripted scenarios, VS Code LM fixture, command/path approvals and live Copilot campaigns | Scripted choices establish mechanics; smoke coverage is smaller than all extension behavior                                 |
| [Evaluator](../packages/evals/src/) and [fixtures](../evals/)                                                                                                                                            | Task definitions, graders, evidence, calibration and benchmark execution/reporting                             | Offline evaluator tests establish machinery and fixtures; they are not new live-model success results                       |
| [Experiment reports](../packages/evals/src/experiments/reporting.ts)                                                                                                                                     | Immutable manifests, explicit variant differences, full pairing, safety/regression summaries                   | Statistical and producer-to-report gaps remain; see below                                                                   |
| [Turn event log](../src/core/agent/AgentTurnEventLog.ts), [lifecycle journal](../src/core/agent/lifecycle/AgentLifecycleJournal.ts), [host evidence capture](../apps/vscode-e2e/src/evidence/capture.ts) | Per-run records, lifecycle replay and bounded export mechanisms                                                | Existing local records and safe exports serve different purposes; missing exported payload does not imply no local evidence |
| [NOR-36 measurement](nor36-efficiency-acceptance.md)                                                                                                                                                     | A documented same-workload comparison with request identity and quality checks                                 | Its 2→1 schema-building result is local work removed, not a 50% latency or provider-token improvement                       |

The [migration record](toolchain-migration-step-3.md) reports 9,428 passing source tests and 1,829 webview tests, exact-host
smoke, command/path approvals, 239 offline evaluator checks, 15 tooling tests, 374 passing host-runner unit tests, and
lint/types/build/package checks. These are useful baseline results with different scopes. They do not establish current
comparative live capability or corporate deployment readiness.

Carry forward the evidence that was not green or settled:

- An unrestricted source run timed out in `Task.ticket-progress.spec.ts`; the focused file and full suite with CI worker
  limits passed later. Preserve the initial timeout and investigate contention, fixture cleanup, scheduling and actual
  state progress before assigning a root cause.
- The migration investigation traced an earlier Windows failure to a 75 ms real-filesystem admission deadline in
  `AgentControlStore.queue-diagnostics.spec.ts`. That diagnosis applies to that incident; it does not explain every timeout.
- The older [starting-point review](migration-starting-point.md) records a managed-agent UI skip rejected by strict local
  certification and pending real-environment checks. Do not infer that unrelated later green suites resolved them.
- Corporate Artifactory authentication, the full service-backed/Docker evaluator path and a new paired live-provider
  improvement campaign remain unverified here.

Concrete comparison limitations found in code include observation-level bootstrap intervals without a paired
task-clustered effect interval, and a variant-difference schema that currently cannot admit prompt/tool-schema changes
through its declared allowlist. Campaign usage can be unavailable while experiment observations require a numeric cost.
The routine model campaign also does not yet populate the richer paired observations: the report CLI consumes prepared
JSON. Runtime evidence can identify the task fixture commit where a comparison needs the Alpha harness/build identity.
Strengthen these existing paths and preserve unknown usage. Detailed findings are in the linked Alpha maps.

Two diagnosis findings deserve early attention. Stable request/attempt identities are not consistently carried between
the lifecycle journal, detailed event log, telemetry and exported projections. Also, the user-requested
[diagnostics handler](../src/core/webview/diagnosticsHandler.ts) currently writes the full provider conversation history
to a local review file without the size/projection policy already present in E2E capture. No automatic sending is
performed by that handler; a bounded default diagnosis export is a concrete improvement opportunity.

Potential overlap among host campaigns, evaluator reports and proportional-scope reporters deserves an ownership review.
They have different fidelity and privacy contracts. Similar terminology alone is insufficient evidence of removable
duplication. Unused-looking fixtures or historical artifacts should be traced to callers and retention obligations before
cleanup.

## The smallest useful test matrix

The user's two axes are useful, but “unit/integration/real host” describes **execution fidelity**, while
"scripted/live" describes **who makes decisions**. Keep both labels. The columns below are the questions being measured;
the limited capability claims are intentional. This is a selection guide, not a demand to populate every combination.

| How: execution surface + decision source                | Mechanics, policy and lifecycle                                                                          | Correct task completion / adaptive quality                                                                              | Performance and efficiency                                                                     | User/host behavior                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Unit/component; synthetic inputs                        | Fast rules, reducers, adapter order, paths and terminal outcomes; strong existing coverage               | Only the specified local function/component outcome                                                                     | Deterministic counters; focused microbenchmarks where relevant                                 | React interaction/ARIA tests; no real VS Code proof                        |
| Real kernel/Task seams; scripted provider               | Cross-layer tool transactions, retries, cancellation, context/persistence; existing integration coverage | Expected scripted outcome; cannot grade planning ability                                                                | Scheduler/preflight work and fixed-path counts; workload boundaries required                   | Does not replace host activation, terminals or webview integration         |
| Actual VS Code 1.122.1; scripted provider or LM fixture | Host API, activation, commands, policy, reload and real adapter contracts; existing smoke/core lanes     | Verifies the workflow with controlled decisions                                                                         | Host overhead, stop/reload latency and bounded resource checks                                 | Real host exercised; inspect which UI interactions are actually driven     |
| Actual Alpha extension; live provider/model             | Integration can expose unexpected sequences; retain deterministic reproducer afterward                   | Independent task graders plus repeated baseline/candidate comparisons; existing runner, new comparative evidence needed | End-to-end time, calls, reported tokens/cost, retries; service noise and missing usage visible | Realistic adaptive interaction, with specified host/provider/access        |
| Representative human use in the corporate host          | Finds unmodeled environments and recovery paths                                                          | Acceptance, usefulness, needless work and review burden                                                                 | Time to usable result; bounded local diagnostics                                               | Keyboard/focus, sidebar layout, accessibility and perceived responsiveness |

Test the **evaluation machinery itself** alongside these rows: fixture validity, reference/no-op controls, grader errors,
manifest mismatches, missing usage, incomplete traces and report integrity. A broken ruler can make every row misleading.
Alpha already has grader, evidence and runner tests; strengthen demonstrated gaps.

Playwright can test webview interactions or an application Alpha creates, where a controlled host bridge is available.
A standalone browser rendering does not certify VS Code 1.122.1 activation, terminal integration, LM APIs or reload.
Headless execution of the actual extension host remains a real-host check; an imitation of its APIs does not.

## A compact scorecard

Correctness and policy are gates. Choose one primary improvement metric per experiment, with the relevant supporting
metrics below. Avoid a weighted aggregate that can hide a safety failure behind cheaper tokens.

| Priority / dimension              | Definition and diagnostic use                                                                                                     | Important limit                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1. Verified task success          | Required outcome checks pass, relevant regressions absent, policy respected, within the declared budget                           | A completion message or tool invocation is not verified success; grader errors remain separate               |
| 1. Lifecycle and policy integrity | Exactly one terminal outcome per accepted call/turn; cancel propagation, cleanup, replay/reload and authority invariants hold     | Exercise denied/error/cancelled/timeout states and background tasks; successful happy paths are insufficient |
| 2. Reliable completion            | First-attempt and retry-assisted success, failures by class, stalls, recovery and repeated-task consistency                       | Include original failed attempts, exhausted budgets and coverage/missingness                                 |
| 2. Time to useful result          | User submission to a task-specific usable artifact/answer; also total verified-completion time and cancellation responsiveness    | First token can be empty progress; mark unobserved useful-result time unavailable                            |
| 3. Work and cost                  | Model requests, tool/command calls, retries, input/output/cache usage and total cost per verified success                         | Preserve provider semantics; bytes/local token estimates are different; unavailable cost is not zero         |
| 3. Product responsiveness         | Extension activation/host stalls, webview commits or long tasks, memory/handle growth under a specified streaming/reload workload | Require before/after measurements on the same host/resources; no universal “snappy” threshold                |

Add a calibrated review rubric only where executable checks fall short: excessive code/scope, clarity of handoff,
unnecessary approval burden or UI usability. Provider neutrality means shared invariants and explicit adapter-specific
coverage, not identical scores from every model.

## Observability that closes the loop

Keep Alpha's canonical events and persistence as the source of truth. Add a **run evidence index** over existing artifacts
where joins are missing, rather than a second lifecycle store. The [detailed map](harness-research/alpha-observability.md)
identifies current owners and boundaries.

The proposed record should let a reviewer move from experiment → variant/build → trial → task/run → turn/step → provider
attempt/tool call → terminal result → independent grade. Use stable IDs, per-run sequence ordering and monotonic durations.
Agree the join contract for `taskId`, `runId`, `turnId`, `stepId`, `requestId`, `attemptId` and correlation/causation links
before wiring producers. Attach model/config/policy/schema identities and explicit missing/truncated/failed-capture indicators. Preserve the
difference between a logical step and its retried provider attempts, and parent versus child task work.

For one failed trial, a reviewer should be able to answer:

1. **What happened?** Inputs/configuration, relevant ordered events, workspace diff, tests, final state and terminal reason.
2. **Where did it go wrong?** Provider/transport, harness, tool, policy, persistence, UI, environment or grader; cite the
   first divergent event and uncertainty, not an invented account of model reasoning.
3. **What changed?** Baseline/candidate identities and allowed differences, plus equivalent successful and failing traces.
4. **Did the fix help?** Reproducer, neighbor tests, required host result and paired metrics with their limitations.

Maintain two artifact levels: restricted local replay material where necessary, and allowlisted bounded summaries for
comparison/sharing. Redaction is not a guarantee that arbitrary prompts, tool output or patches contain no confidential
content. Use synthetic fixtures where possible, omit raw secrets/content by default from exports, preserve hashes and
structural counters, impose byte/event/time/retention limits and record omissions. Preserve required opaque provider
protocol state/signatures in private replay history; this does not require collecting hidden model reasoning.

Replay itself has levels: re-rendering saved events, replaying controlled provider/tool fixtures, and rerunning a live
provider are different operations. A live rerun cannot promise the same decisions. Link a confirmed failure to its
regression test, change and decision record so the next agent can retrieve evidence without rescanning every transcript.

## The development loop, in plain English

1. **Look at a real problem or opportunity.** Keep the failing trace/profile and say what the user should have experienced.
2. **Write down one thing to change and why.** Choose the owning layer and a measurable expectation before editing.
3. **Make the failure or workload repeatable.** Check the fixture and grader; save a baseline. Use the smallest useful test.
4. **Make one bounded change.** Preserve unrelated code, policy and test expectations.
5. **Check mechanics first, then the affected product path.** Use the matrix and required exact-host gate.
6. **Compare live runs when the claim depends on model decisions.** Same tasks/model/settings, repeated pairs, full failures.
7. **Read the differences.** Explain whether the change helped, hurt or remains uncertain; revise, keep or undo accordingly.
8. **Save the lesson.** Link the evidence, regression test, measured result and next question.

This process has three different worked forms:

| Case                     | Example investigation and decision                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bug / unreliable test    | Start with the recorded ticket-progress timeout. Capture workers, active handles, pending state and cleanup; use controlled promises to reproduce a suspected race. Compare focused and concurrent workloads. A fixture timing assumption may need a fixture fix; a runtime deadlock needs the owning runtime fix. Fail-before/pass-after evidence must distinguish them. A green rerun alone closes neither diagnosis.            |
| Desired behavior change  | Illustrative only: if a future request says “after a completed foreground turn, restore composer focus,” specify keyboard behavior, background-task non-interference and focus exceptions. Add interaction plus real-host checks, update the contract and verify it. Live models are optional unless focus depends on adaptive conversation behavior. **This is not the user's chosen feature; that feature remains unspecified.** |
| Harness-performance idea | Hypothesize that two independent reads are being serialized unnecessarily. First prove eligibility and ordering/cancel/policy correctness using controlled tools. Benchmark the same read workload with fixed delays/resources and quality checks. Then use repeated live tasks to test whether the saved tool time survives model/network overhead. Keep a local speed claim local if no end-to-end gain is established.          |

For performance and capability work, the [comparison protocol](harness-research/evaluation-design.md) specifies task
selection, held-out cases, judge calibration, pairing, sample-size planning and keep/revert rules. Twenty successful
live trials are useful diagnostic evidence, but cannot establish 99% reliability or a small universal improvement.

## When each check belongs

| Point in development                 | Required selection                                                                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| During edits                         | Focused owning tests; fail-first reproducer or stable benchmark baseline; format touched files only                                                                                                       |
| Before commit/PR                     | Affected package typechecks/tests and consumers; review final diff; exact VS Code 1.122.1 gate for host/lifecycle/provider/UI scope; relevant deterministic evidence/grader checks                        |
| Before release                       | Combined affected-surface gates, exact-host smoke plus relevant acceptance cases, bundle/VSIX/content verification; current managed-agent certification when its contract changes; material UI inspection |
| Periodic / model or provider changes | Bounded live sentinel and held-out comparisons, provider drift checks, longer recovery/resource workloads, grader calibration and fresh representative tasks                                              |
| Corporate rehearsal                  | Fresh Artifactory-backed install, development/debugging, approved Copilot/API path, exact-host tests, Playwright where applicable, package/install, saved-task reload and rollback rehearsal              |

Useful **existing** commands (not executed in this research):

```sh
pnpm --dir src test core/agent/__tests__/AgentTurnEngine.spec.ts
pnpm --dir src check-types
pnpm --dir webview-ui check-types
pnpm --filter @alpha-code/vscode-e2e test:unit
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
pnpm --filter @alpha-code/vscode-e2e test:command-paths:1221:run
pnpm test:evals:offline
pnpm certify:managed-agents:automated
pnpm bundle
pnpm vsix
node scripts/verify-vsix-contents.mjs bin/alpha-2.1.49.vsix
```

Choose the actual generated VSIX path if its version changes. The command/path `:run` command needs a current built
extension; the full smoke script above builds its prerequisites. Focused Vitest paths follow `test` directly without a
standalone `--`. Full root test, lint and type commands have an extension-focused workspace boundary; optional evaluator
services and live calls are separate. Consult the [command map](harness-research/alpha-coverage.md) before execution.

## Ordered next work

This refines [corporate roadmap steps 4–8](corporate-migration-roadmap.md); it does not authorize implementation in this
research task or claim those steps are complete.

| Order | Concrete next task                                                                                                     | Dependencies / parallel work                                                                                                              | Finished when                                                                                                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1A    | Audit test reliability: ticket-progress timeout, 75 ms fixture case, rejected managed-agent UI skip and pending checks | Can run alongside 1B and 1C with distinct file ownership                                                                                  | Every incident has preserved evidence, a reproduced cause or an explicit unresolved status, and an appropriately scoped repair proposal                                       |
| 1B    | Review cleanup candidates by callers, ownership and retained evidence                                                  | Parallel with 1A/1C; coordinate shared scripts/manifests                                                                                  | Removals have evidence of disuse, history is retained, and combined checks are selected before edits                                                                          |
| 1C    | Select a small representative task bank and audit its graders                                                          | Parallel with 1A/1B; reuse current fixtures                                                                                               | Each task has a stated user outcome, valid reference, failing negative control, isolated environment and declared regression/development/held-out role                        |
| 2     | Connect one existing host trial to a complete, bounded diagnosis bundle; address the raw-history export default        | Use findings from 1A/1C and existing event/evidence owners                                                                                | A failure can be traced to run/build/task/step/tool and independent outcome without raw sensitive export; missing data stays explicit                                         |
| 3     | Strengthen existing paired reporting and prove its producer path                                                       | Can develop analysis beside 2 after agreeing identities/statuses                                                                          | Real runner output reaches validated manifests; unknown usage stays unknown; paired uncertainty, clustering, exclusions and prompt/schema interventions have tested semantics |
| 4     | Specify and implement the user's desired behavior change                                                               | Feature remains unspecified; after initial review/cleanup and before corporate move; can overlap 2–3 if its validation does not need them | User-visible behavior has a clear contract, focused regressions and required host checks; no invented feature substitutes for the user's request                              |
| 5     | Try the whole improvement loop on one bounded, justified idea                                                          | Needs 1C, 2 and 3 for a capability/efficiency claim; coordinate with 4                                                                    | A baseline/candidate experiment yields a defensible keep/revise/revert/inconclusive record with quality, cost/time and all failed attempts                                    |
| 6     | Rehearse the development/evaluation path in the corporate environment                                                  | Setup planning can proceed earlier; execution follows access/tooling readiness and intended behavior work                                 | Fresh install/debug/test/package/live-access path works using approved services; task reload and rollback work; unresolved environment gaps are recorded                      |
| 7     | Use it on representative work and feed failures back into the task bank                                                | After rehearsal                                                                                                                           | An ordinary developer or coding agent can repeat the loop, find evidence and explain the next change without reconstructing this research                                     |

For step 3, avoid starting with a dashboard project. A validated machine-readable report plus a readable Markdown
comparison is sufficient. Keep future live runs budgeted and explicit; the existing live commands can consume provider
capacity. Do not assume corporate Docker/Postgres/Redis access merely because local code and Playwright are available.
Use Artifactory for approved dependencies, preserve exact tool/host versions and keep credentials out of artifacts.

## Material unknowns and validation limits

The public sources do not disclose complete lab task banks, internal ship/revert thresholds or every experiment's raw
data. Source-code inspection establishes implementation mechanisms, not their current success in Alpha's corporate
environment. This research did not rerun unit/host/certification suites, execute upstream projects or purchase live trials.
It did not establish full provider coverage, a calibrated quality judge, a representative private task distribution,
repeatable live model snapshots, general speed gains, or end-to-end evidence interoperability for every runner.

Documentation validation for this change consists of source/command cross-checks, local link checks, Markdown formatting
and rendered review, and final diff/scope inspection. Remaining uncertainties are tasks to verify, not reasons to report
green results from tests that were never run.

**Process deviation:** despite the no-install scope, a worker ran `pnpm exec prettier --check` in the worktree.
It triggered dependency materialization across 12 projects from the existing pnpm store (zero downloads reported).
No tracked code, manifests or lockfiles changed. The newly created dependency directories and generated Husky hooks
were moved into a recoverable temporary quarantine after automatic approval review blocked recursive deletion.
The quarantine is `C:/Users/Luke Goblirsch/AppData/Local/Temp/alpha-harness-research-20260918/dependency-quarantine`.
The install lifecycle also rewrote the shared repository Git configuration's `core.hooksPath` to `.husky/_`;
its previous value was not captured, so it was not guessed or overwritten again. Final formatting used an already
available Prettier executable directly, without pnpm. This was an execution mistake, not an authorized research step.
