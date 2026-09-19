# OpenAI and evaluation-method evidence

Research date: **2026-09-18**. Companion to [the main report](../harness-development-research.md).
These are primary-source notes, not a claim of access to private lab procedures. Sources were opened and read;
search-result snippets alone were not used. Changing documentation is identified by retrieval date. No upstream code
was executed. Alpha recommendations are distinguished from published observations.

## Sources and what they establish

| ID  | Primary source                                                                                                                                                          | Publication / inspected version                                                      | Evidence and limit                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)                                                                              | 2026-01-23                                                                           | Describes model requests, tools, history, caching and compaction. An architecture explanation, not a controlled evaluation of each design choice.                                                                                                             |
| O2  | [Unlocking the Codex harness: App Server](https://openai.com/index/unlocking-the-codex-harness/)                                                                        | 2026-02-04                                                                           | Explains reuse of the core across clients and explicit item/turn/thread lifecycles. Supports shared-kernel design; does not publish a complete release gate.                                                                                                  |
| O3  | [Harness engineering](https://openai.com/index/harness-engineering/)                                                                                                    | 2026-02-11                                                                           | An internal product team describes making its application, tests and observability accessible to agents. This concerns the environment around development, not solely Codex runtime engineering. Its productivity estimate is not a randomized causal result. |
| O4  | [Testing Agent Skills Systematically with Evals](https://developers.openai.com/blog/eval-skills)                                                                        | 2026-01-22                                                                           | Defines outcome, process, style and efficiency goals; captures traces/artifacts; combines executable checks with rubric grading. A tutorial for skills, not a disclosure of all Codex internal evaluations.                                                   |
| O5  | [Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)                                                                    | Living documentation; retrieved 2026-09-18                                           | Recommends task-specific data, continuous evaluation and human calibration of graders. General guidance does not establish a universal sample size or a particular lab's ship criteria.                                                                       |
| O6  | [Agent improvement loop with traces, evals and Codex](https://developers.openai.com/cookbook/examples/agents_sdk/agent_improvement_loop)                                | Living cookbook; publication date not established; retrieved 2026-09-18              | Runnable illustration joining traces, reviewer feedback, generated tests and a proposed change handoff. Five synthetic financial-analysis runs are an example, not validation of autonomous harness optimization.                                             |
| O7  | [Why SWE-bench Verified no longer measures frontier coding capabilities](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)                        | 2026-02-23                                                                           | Audits task/test mismatch and contamination. The 59.4% issue rate is for 138 selected difficult problems, not an unbiased estimate for all 500 tasks.                                                                                                         |
| O8  | [Codex contributor instructions](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/AGENTS.md)                                               | Commit `7498521d288b9b3b96ffba4eedf089d8d6e06a84`, committed 2026-09-18 00:59:10 UTC | Public guidance requires integration coverage for agent-logic changes and considers external protocol/reload compatibility. Evidence of published engineering practice, not proof every release obeys it.                                                     |
| O9  | [Codex mocked response support](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/core/tests/common/responses.rs)                  | Same pinned commit                                                                   | Response mocks capture outgoing requests and expose call-ID-specific output assertions. Demonstrates checking protocol mechanics independently of model capability.                                                                                           |
| O10 | [Codex interrupt integration tests](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/app-server/tests/suite/v2/turn_interrupt.rs) | Same pinned commit                                                                   | Exercises an app-server process with mocked model responses, command execution and pending approval interruption; checks correlated terminal notifications. Some remote fixtures are explicitly skipped.                                                      |
| O11 | [Codex tool integration tests](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/core/tests/suite/tools.rs)                        | Same pinned commit                                                                   | Checks tool visibility, collision failure before inference, unsupported tools and replay-related behavior. This particular file is excluded on Windows; its presence alone does not establish cross-platform coverage.                                        |
| M1  | [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/html/2405.15793v3)                                                       | First submitted 2024-05-24; inspected v3, 2024-11-11                                 | Fixed-model interface experiments, development-set trajectory inspection, configuration sweeps and ablations. Stronger evidence about interface effects than comparing different vendor products; old models/tasks limit transfer.                            |
| M2  | [Adding Error Bars to Evals](https://arxiv.org/html/2411.00640v1)                                                                                                       | Evan Miller, Anthropic affiliation; v1, 2024-11-01                                   | Derives paired differences, clustered uncertainty and power planning. A methodological paper, not evidence of a uniform internal Anthropic deployment policy.                                                                                                 |
| M3  | [Inspect scoring policy](https://inspect.aisi.org.uk/scoring-policy.html)                                                                                               | Living UK AISI documentation; retrieved 2026-09-18                                   | Distinguishes incorrect output, scorer error and unscored verdict; documents their denominator consequences. An evaluation framework's choices must still match Alpha's question.                                                                             |
| M4  | [Inspect log files](https://inspect.aisi.org.uk/eval-logs.html) and [scoring](https://inspect.aisi.org.uk/scoring.html)                                                 | Living UK AISI documentation; retrieved 2026-09-18                                   | Logs retain configuration, samples, scoring and usage; scoring can be deferred or repeated over saved work. Useful design precedent, not a reason to replace Alpha's existing evaluator.                                                                      |
| M5  | [Harbor core concepts](https://docs.harborframework.com/core-concepts)                                                                                                  | Living project documentation; retrieved 2026-09-18                                   | Separates task, agent, sandbox, verifier, trial, job and trajectory. Useful vocabulary for portable evidence; container evaluation cannot establish VS Code UI correctness.                                                                                   |

All URLs above were retrieved on 2026-09-18. The Codex SHA was resolved through the public GitHub commits API and the
linked files read at that SHA. The dated articles remain historical descriptions even when their website navigation
shows newer models. No claims depend on search-engine relative publication dates.

## What OpenAI evidence supports

The public code makes an important distinction tangible: a real harness can run against a deliberately artificial model
stream. Request assertions can then identify lost tool results, wrong schemas or incorrect lifecycle events without
sampling noise. The app-server tests also cover process/protocol integration; they are not tests inside Alpha's reference
VS Code host. [O9](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/core/tests/common/responses.rs),
[O10](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/app-server/tests/suite/v2/turn_interrupt.rs)

Two different meanings of “harness” need to stay separate. The runtime controls model/tool interaction. The development
environment provides searchable knowledge, executable checks and inspectable application state. Improving either may
help, but a result from one does not demonstrate an improvement in the other. OpenAI's product-development account
describes isolated worktree instances and agent-readable logs, metrics and UI state; it does not measure an Alpha-like
provider-neutral extension. [O1](https://openai.com/index/unrolling-the-codex-agent-loop/),
[O3](https://openai.com/index/harness-engineering/)

The skill tutorial's small prompt set is a useful early diagnostic suite. Its illustrative command-presence checks are
weaker than evidence that a command completed successfully and the resulting application works. Alpha should preserve
that distinction instead of copying tutorial assertions literally. A test can require a particular process when that
process is itself a user or policy requirement; otherwise, grade the outcome and permit valid alternative solutions.
[O4](https://developers.openai.com/blog/eval-skills)

The cookbook connects feedback to proposed changes and specifically calls for human review of generated evals. It does
not establish that a system should automatically modify its own grader, declare itself improved and merge. Alpha's
first implementation should use reviewed, versioned expectations and a separately inspected result.
[O6](https://developers.openai.com/cookbook/examples/agents_sdk/agent_improvement_loop)

## Methodological consequences for Alpha

These paragraphs are recommendations, not statements about undisclosed lab practice.

- Define the intended effect before collecting candidate results. Distinguish a mechanical guarantee, a change in
  task-solving success and an improvement in local runtime work. Each requires a different measurement.
- Preserve the actual product route. An isolated model/tool experiment helps explain causality; final evidence still
  needs Alpha's extension runtime, adapter and reference host when those surfaces are affected.
- Keep immutable agent-run artifacts separate from grader revisions. Repairing a broken grader should permit rescoring
  both variants' saved outputs without obtaining a more favorable new model sample.
- Count missing measurements. “Unknown usage” is not zero cost; an unparseable grader verdict is not an agent success;
  a setup failure is not evidence about solving ability. Report coverage as well as scores.
- Treat observed trajectories as hypotheses about failure causes. Confirm a suspected scheduler, persistence or provider
  defect with a controlled test; do not infer the model's hidden reasoning from a textual rationale.
- Use an unchanged baseline and a held-out task set. Add failures found during development to the regression set, while
  maintaining a separate evaluation set that has not shaped the intervention.
- Prefer outcome-specific uncertainty over a universal “enough trials” number. Related tasks and repeated attempts at
  the same task do not supply the same information as new independent tasks.

For a mathematical basis, M2 recommends analyzing the differences on shared questions and accounting for related
question groups, with sample size based on variance and the effect of interest. It also warns that changing sampling
temperature to reduce noise changes the evaluated system. Alpha's proposed paired, task-aware analysis extends that
reasoning to repeated agent attempts; it is not a claim that a paper supplies an off-the-shelf analysis for every
multi-step workload. [M2](https://arxiv.org/html/2411.00640v1)

For error accounting, Inspect explicitly documents that a scoring malfunction and an incorrect agent answer are
different. Its displayed accuracy can exclude errors/unscored rows, which makes accompanying coverage counts necessary.
For Alpha, present both attempted-workflow reliability and the conditional capability score; neither denominator should
be hidden. [M3](https://inspect.aisi.org.uk/scoring-policy.html)

## Limits and disagreements

More elaborate orchestration is not intrinsically better. SWE-agent supplies evidence that a carefully designed
interface can help a fixed model, but its design resulted from particular models and benchmarks. Later or different
models may need fewer constraints. Carry the hypothesis-testing method forward, not a permanently fixed prompt or
tool vocabulary. [M1](https://arxiv.org/html/2405.15793v3)

Published benchmark audits also undermine the idea that a passing hidden test is infallible. OpenAI found overly narrow
and overly broad expectations, environment-dependent failures and contamination. This warrants grader calibration and
private representative tasks; it does not establish that every SWE-bench result is meaningless or that replacing it
with one named benchmark removes all bias. [O7](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)

Alpha can adopt portable task/trial/artifact concepts from Inspect and Harbor while retaining its actual extension
runner. A new evaluation platform, hosted trace service or standalone agent runtime is not necessary for the first useful
comparison. Public sources do not disclose every lab's test inventory, task distribution, minimum release effect,
confidence threshold, rollback policy or private user-feedback pipeline. The report's concrete operating policy is an
Alpha proposal.
