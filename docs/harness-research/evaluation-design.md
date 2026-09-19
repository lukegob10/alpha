# A fair comparison and diagnosis protocol for Alpha

Research date: **2026-09-18**. This is a proposed operating method, not implemented behavior or a description of a
private lab's release process. Start with [the main report](../harness-development-research.md); implementation evidence
is in [Alpha coverage](alpha-coverage.md) and [observability](alpha-observability.md).

## 1. Decide which question the experiment answers

| Question                                           | Required evidence                                                                                          | What a pass does not establish                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Does the harness enforce a rule?                   | Controlled input, state transition and observable invariant; failure/cancel/reload variants where relevant | Whether a real model will choose a useful strategy                        |
| Can the installed extension perform this workflow? | Actual VS Code 1.122.1, real extension path, authoritative outcome and host/UI observations                | General coding capability when decisions are scripted                     |
| Does a harness change improve solving?             | Paired old/new harness runs with the same real model, representative tasks and independent grading         | Transfer to a different provider, task distribution or newer model        |
| Does a change reduce local work?                   | Same deterministic workload/cache state, attributed counters or timings and preserved correctness          | A proportional improvement in end-to-end latency, provider tokens or cost |
| Does the product feel better to use?               | Relevant host interaction timings plus human inspection or a calibrated rubric                             | A reduction in engineering effort merely because more code was generated  |

An acceptance test encodes behavior that must hold. A capability evaluation estimates success under variable model
decisions. A benchmark measures a declared workload. One test can contribute to several questions, but label what was
real and what was substituted. A deterministic grader can score a live-model trial; “deterministic” does not describe
the whole trial merely because the final assertion is executable.

## 2. Write a small experiment card before implementing

Record these fields in one versioned Markdown/JSON record, extending Alpha's existing experiment manifests:

1. **Problem and evidence:** link the failed run or profile, actual versus expected outcome, and owning layer.
2. **Hypothesis:** one causal sentence, such as “avoiding repeated schema construction reduces request-preparation work
   while preserving the outgoing request.” State a plausible failure mode of the intervention too.
3. **Intervention:** the exact allowed differences, including prompt/tool-schema differences if those are the treatment.
4. **Primary metric and guardrails:** one improvement target, required correctness/policy outcomes, maximum acceptable
   latency/cost regression, and treatment of missing measurements.
5. **Workload:** task versions, repository snapshots, scope, distribution/weights, public/private status, development
   versus held-out split, and independent reference/grader checks.
6. **Execution:** baseline/candidate builds, provider/model, settings, repetitions, task/order randomization, cache policy,
   host/OS/resources, retry policy, approval mode, maximum wall time and spend/request limits.
7. **Decision:** sample-size rationale, analysis method, stopping rule and conditions for keep/revise/revert/inconclusive.

Alpha already has [variant identities](../../packages/evals/src/experiments/types.ts),
[declared-difference validation](../../packages/evals/src/experiments/variantDiff.ts) and
[report admission](../../packages/evals/src/experiments/reporting.ts). Use those. The current allowed-difference enum
does not include `promptDigest` or `toolSchemaDigest`, even though the variant includes them. A future prompt/schema
experiment needs a deliberate compatible extension and validation; bypassing the check would discard the causal guard.

## 3. Hold the right things constant

Freeze the task snapshot, task instructions, verifier, harness build, tool implementations, tool schema, system
instructions/skills, policy, approval behavior, compaction settings, provider/model settings, environment image or local
toolchain, host binary, dependency lockfile, workspace seed, timeouts and budgets. Change only the treatment fields.
If changing a prompt, that prompt is allowed to differ; everything unrelated stays fixed. Record source SHA **and** build
digest and dirty-tree state so a stale bundle cannot silently represent a different variant.

Use separate, fresh owned workspaces and VS Code profiles for independent trials. Test resume/long-horizon behavior
inside one trial with deliberately preserved state. Resetting that state between steps would erase the behavior being
tested. Prevent one variant from seeing the other's changes, test outputs or grader feedback.

Interleave baseline/candidate runs in randomized blocks rather than running all baseline trials one day and all candidate
trials the next. Pair by task, repetition, configuration and time block. Do not run both sides simultaneously on a
saturated machine: contention becomes a hidden treatment. Cap concurrency and record it. Declare warm/cold disk and
provider-cache protocols; warmup runs are distinct from scored runs and their costs remain recorded.

Use exact model snapshots where available. With Copilot or provider aliases, record the requested identity, returned
identity and any unavailable revision metadata. Matching names do not prove identical backend weights. Log service
incidents, routing, quota/retry effects and timestamps; repeat comparisons in another block if drift is plausible. A
seed is useful provenance, not a guarantee of deterministic streaming, tool execution or inference.

Changing model and harness together produces a **system** comparison. If both need changing and attribution matters,
run the four cells old/new harness × old/new model; inspect the interaction. Keep provider-specific strata visible.
Alpha's neutral core can share mechanical tests, while provider adapters require their own order/opaque-state/usage/
tool-ID/error fixtures. A pass through one adapter does not certify another.

## 4. Choose tasks and validate the measurement instrument

Start from actual Alpha work: a narrow lookup, a small edit, a cross-file bug, an underspecified request that should ask
for clarification, a task with failing tests, a safe command/path approval, and a long-running task that is cancelled or
resumed. Reuse existing scenarios where they express these needs. Include straightforward tasks: optimizing only hard
benchmark issues can make everyday work unnecessarily elaborate. Include hard cases in a separate capability slice.

Stratify by task size, language/repository, risk, provider path, interaction type and relevant lifecycle stress. Do not
create the full Cartesian product. Choose pairs that exercise a distinct risk, keep a small fixed sentinel set for
comparability, and add fresh held-out cases periodically. Split related issues by repository/family when practical so a
near-duplicate does not serve as independent validation.

For each grader:

- Run the unmodified broken fixture and confirm the intended check fails; run a correct reference and confirm it passes.
- Try at least one different valid solution and a plausible wrong solution. Include a no-op/empty patch control.
- Keep hidden outcome checks outside the writable task workspace. Check that the agent did not remove tests, disable
  enforcement, hardcode a visible answer or modify the grader. Detect integrity violations separately.
- Check the user's actual outcome, neighboring regressions and required policy constraints. A final “done” message,
  file existence, command invocation or exit code alone may be insufficient.
- Grade tool paths only when required by policy or the experiment. Permit harmless changes in tool choice/order.

Use an LLM judge for residual properties such as unnecessary complexity, useful explanation or visual quality, not as a
replacement for an executable correctness check. Fix the rubric/model/settings, blind variant labels, randomize answer
order, and supply concrete positive/negative anchors. Calibrate against independently reviewed examples, including
borderline cases; report false accepts, false rejects and disagreement by criterion. Human agreement itself should be
checked. Audit a sample of passes as well as failures and recheck calibration after changing judge/model/rubric.

Treat candidate output as untrusted evidence for the judge, never as grading instructions. A judge parse/API failure is
an unscored/error result with preserved raw local evidence, not a passing answer. Repairing a defective grader changes
the instrument: version it, record why, and rescore saved baseline and candidate artifacts together. Do not tune the
grader until the candidate wins. These safeguards follow the combined lesson of
[OpenAI's benchmark audit](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/) and
[evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices).

Public benchmarks provide outside challenge tasks and reproducible conventions, but cannot be the sole product gate.
Training contamination, repeated development against the same tests, narrow task distributions and hidden assumptions
all weaken transfer. Private recent tasks reduce some exposure; they do not guarantee an unbiased benchmark.

## 5. Analyze repeated trials honestly

**Proposed primary estimand:** the change in independently verified task-success probability for a declared Alpha
workload under a fixed attempt budget. Report task counts, repository/family counts, attempts per task and missingness.
Weight tasks according to a predeclared scheme; otherwise tasks with more repeats receive accidental extra influence.

For each task, compute candidate minus baseline mean success over its repetitions. Estimate uncertainty using paired
task resampling or a suitable paired hierarchical model; account for repository/family clustering when related tasks
are sampled together. For an immutable finite suite, distinguish uncertainty about repeated attempts on those tasks
from generalization to a wider workload. With very few independent tasks/clusters, label intervals exploratory.

For one binary trial per independent task, report the paired win/loss/tie table and an appropriate paired interval/test
(an exact McNemar test can assess discordant outcomes). With repeated attempts, do not feed every attempt into that
independent-pair analysis. Report effect sizes and uncertainty, not just a significance flag. Also report high-risk
regressions individually; an aggregate improvement cannot pay for a policy violation.

Alpha's current [statistics](../../packages/evals/src/experiments/statistics.ts) include per-observation percentile
bootstrap rates, wins/losses/ties, consistency, latency quantiles and cost per success. This is useful infrastructure,
but it does not yet estimate a paired, task-clustered difference interval. Resampling an all-success array yields
`[1, 1]`; that describes the empirical resamples, not certainty of perfect reliability on future work. Add an appropriate
binomial bound for genuinely independent binary trials, or a cluster-aware analysis where needed.

Also reconcile the current denominators before attaching new significance calculations. Outcome rates filter to
scoreable statuses, while the paired tally treats every non-`passed` status as failure, including infrastructure and
grader errors. Its `retryAssistedCapability` field currently repeats final eligible success rate without using
`retryAssisted`; it does not isolate the gain from retries. Retain these observations for a focused reporter audit.
The existing [promotion policy](../../packages/evals/src/experiments/policy.ts) is guardrail admission, not a statistical
test of improvement; its PR, nightly and release profiles currently share the same thresholds.

The principles of pairing, clustering and power planning have an explicit derivation in
[Miller's statistical paper](https://arxiv.org/html/2411.00640v1). The following numbers are **illustrative planning
calculations for Alpha**, not lab-prescribed sample sizes:

| Stage / claim              | Sensible starting scale or calculation                                                                                                                           | Interpretation                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Debugging a mechanical bug | One controlled reproducer plus relevant boundary variants                                                                                                        | Enough to demonstrate a particular invariant violation and fix; no population capability claim                   |
| Live pilot                 | Roughly 12–20 diverse tasks, 3 attempts per variant, within an explicit budget                                                                                   | Find failure classes, estimate expense/variance and validate the runner; weak basis for small improvements       |
| Initial comparative study  | Often 50–100 tasks with a few attempts each, adjusted after the pilot                                                                                            | Useful for material differences and diagnosis; not automatically powered for a 1–2 percentage-point gain         |
| Precision illustration     | A single independent binary success rate near 50% needs about 385 samples for a normal-approximation 95% margin of ±5 percentage points                          | This is not the sample size for a paired difference or clustered repeated tasks                                  |
| Power illustration         | If independent paired outcomes disagree 20% of the time, detecting a 5-point difference with 80% power at two-sided 5% significance needs roughly 620 task pairs | Uses a large-sample variance approximation; pilot variance, clustering and multiple claims can increase the need |
| Reliability illustration   | Zero failures in 20 independent trials still permits about a 14% failure rate at a one-sided 95% exact bound; in 100 trials about 3%                             | A short perfect streak cannot establish 99% reliability                                                          |

The precision estimate is `1.96² × 0.25 / 0.05²`; the power illustration is
`(1.96 + 0.84)² × (0.20 - 0.05²) / 0.05²`; the zero-failure bound is `1 - 0.05^(1/n)`.
Repeated runs on one task improve knowledge about that task's variance; they do not manufacture hundreds of independent
task examples. Use power simulation or an appropriate formula once the pilot reveals variance and clustering.

Predeclare a maximum sample/spend budget and a stopping rule. Do not repeatedly check significance and stop at the first
favorable value; use a valid sequential design if sequential decisions are necessary. Select one primary endpoint and
label exploratory slices; account for multiple comparisons when selecting among many candidates. Confirm the selected
change on held-out tasks before making a broad claim.

## 6. Keep denominators, retries and costs visible

Report these separately:

- **Workflow reliability:** verified successes divided by all scheduled eligible attempts, with setup, provider, runner,
  grader, cancellation and handoff counts visible. Specify what user-cancelled/not-started work means for this measure.
- **Conditional capability:** success among valid, scoreable trials. Agent failures and exhausted budgets stay failures;
  independently established invalid infrastructure/grader cases can be excluded with reasons and coverage counts.
- **First-attempt success:** before any harness retries or human intervention.
- **Retry-assisted success:** after the predeclared bounded retry policy, including every retry's time and cost.
- **Consistency over k attempts:** ability to succeed repeatedly. **Pass@k** instead asks whether at least one of k
  attempts works; neither should be presented as single-attempt reliability.

Retries that protect CI from a transient service failure answer a different question from retrying a failed coding task.
Preserve the original row and artifact for both. If failures are missing differentially between variants, the conditional
comparison may be biased; show sensitivity bounds or call it inconclusive. Inspect's
[explicit scoring/error taxonomy](https://inspect.aisi.org.uk/scoring-policy.html) illustrates why denominator policy is
part of the experiment.

Compare latency on all attempted work with failures/timeouts visible, and separately on pairs where both outcomes pass.
The latter is a useful equal-quality comparison but can select easier tasks. Do not make that subset the only headline.
When many runs time out, report completion-by-deadline or censored-time analysis rather than treating a timeout as an
ordinary fast result. P95 from a tiny sample is unstable; show the sample count and avoid precise tail claims.

Cost per verified success is total attributable attempt cost divided by verified successes, including wasted work. It is
undefined when none succeed and unavailable when required usage/pricing is missing. Record provider-reported input,
output, cache-read/write and reasoning fields with their semantics; do not double-count cached input. Keep local token
estimates and bytes separately labeled. Copilot subscription access is not a measured marginal dollar cost of zero.

## 7. Decide, explain, and preserve

For a correctness repair, require the reproducer to fail before and pass after, neighboring checks and required host
gates to pass, and remaining uncertainty to be explicit. The baseline is expected to fail that contract; do not reject
the comparison merely because it is a repair rather than an equal-quality optimization.

For a claimed capability improvement, require a practically useful paired effect supported by the predeclared analysis,
acceptable failure/coverage rates and no guardrail breach. For a speed/token improvement, require preserved correctness
within the declared tolerance plus the measured efficiency benefit. “No statistically significant quality regression”
is not proof of equivalence; a non-inferiority claim needs a margin and adequate precision.

Possible decisions are **keep**, **revise**, **revert**, or **inconclusive**. A simpler behavior-preserving implementation
may be kept for maintainability with green contract checks, while explicitly declining a speed/capability claim. Save
the experiment card, source/build identities, all attempts, grader version, paired results, diagnostic explanation and
decision. Convert a confirmed failure into a regression test at its owning layer and link it back to the run.
