# Alpha Code: autonomous engineering harness assessment

**Revised September 16, 2026, after live validation.** Alpha Code 2.1.44; inspected source baseline
`6d31c93a91228f9341dad639f4f09b4d21b20cb1` plus the working-tree background-command outcome fix and
pre-existing changes; required Alpha host: VS Code 1.122.1. The Alpha score applies to this tested working build.

## The question being assessed

How reliably can the harness take responsibility for an engineering task: understand the problem, inspect the actual
environment, write or edit code within scope, use skills and MCP tools correctly, verify the result, and recover from
failures without repeatedly handing the work back to the user?

The workload spans small edits, standalone Python programs, complete web applications, changes to existing application
surfaces, debugging, reusable skills, and workflows executed through skills and MCP. A polished interface, many
integrations, or an issue-to-PR service earns no independent credit. Those features matter when they improve the
delivered result or reduce the human work needed to obtain it.

**The previous numerical ranking is withdrawn.** Alpha 82, Copilot 87, Cursor 89, Claude Code 90, and Codex 92 were
estimates of a broader feature/usefulness mix. They did not establish the requested ordering in autonomous engineering
quality. Calling those numbers estimates did not fix the mismatch between the evidence and the question.

The user's poor experience with Copilot is relevant qualitative evidence about their workflow. It does not establish
a population-wide failure rate or justify inventing a lower replacement score. The same evidentiary standard applies
to favorable claims about Alpha, Codex, Claude Code, and Cursor.

## What counts as the harness on its own

Assess the shipped agent loop with its normal supported tools, configuration, repository instructions, installed skills,
and connected MCP servers. Give each product equivalent task materials and tool access. Skill-based workflows are part
of the task: selecting a skill, following its instructions, running its resources, composing tool calls, and checking the
result all count.

Do not silently supplement one product with a human-built supervisor, a custom retry daemon, repeated rescue prompts,
or a separate coding agent. A workflow the agent creates as an explicitly requested deliverable counts; a controller
the evaluator writes to make that agent finish changes the system under test.

Keep the following configurations distinct:

| Subject        | Baseline for this assessment                                         | Do not silently add                                              |
| -------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Alpha Code     | Current extension, recorded provider/model, normal skills and MCP    | Future architecture or unshipped fixes                           |
| Codex          | A named local client/build with its supported native agent and tools | Cloud capacity or another client’s exclusive tools               |
| Claude Code    | A named local client/build with its native agent, skills, and MCP    | A different Claude product’s features                            |
| Cursor         | Local Agent in a recorded editor/build with supported tools          | Cloud agents, separate review services, or external supervisors  |
| GitHub Copilot | Copilot Chat Agent in a recorded VS Code/extension build             | GitHub cloud agent, another provider’s harness, or PR automation |

“Clade” is interpreted as Claude Code. Copilot cloud agent can be evaluated separately if requested. Its performance
must not be averaged into Copilot Chat Agent's score.

An agent always operates with a model. A comparison with different models measures the configured products, not the
isolated effect of their harnesses. For a harness-only comparison, match model/version, effort, budgets, permissions,
and tools where the products actually allow that match. Mark unmatched comparisons explicitly.

## The 100-point rubric

These are proposed scoring weights, not product ratings.

| Criterion                           |  Points | Evidence needed to earn the points                                                                                                    |
| ----------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------- |
| Problem solving and code quality    |      25 | Correct diagnosis; working implementation; edge cases; maintainable changes that fit the repository                                   |
| Verification and repair             |      20 | Relevant checks actually run; failures investigated and repaired; final evidence applies to the delivered version                     |
| Controlled edits                    |      15 | Requested scope respected; user changes preserved; no unrelated rewrites, weakened tests, or avoidable regressions                    |
| Grounding and truthful reporting    |      10 | Uses observed code, APIs, and tool results; distinguishes assumptions; never invents checks or claims unsupported success             |
| Skills, MCP, and workflow execution |      15 | Finds and follows the right skill; uses scripts/resources and tool schemas; completes dependent steps and verifies effects            |
| Autonomous follow-through           |      10 | Chooses useful next steps and keeps working without rescue prompts; avoids aimless retries; reports a specific blocker when necessary |
| Context and recovery                |       5 | Retains requirements and instruction authority through long tasks, tool failures, interruption, and resumption                        |
| **Total**                           | **100** | **Useful, controlled, independently verifiable engineering work**                                                                     |

Use fixed 0–4 anchors for each applicable criterion: 0 absent or failed, 1 substantially deficient, 2 partial,
3 good with a limited defect, 4 fully meets the predefined criterion. Convert the criterion mean to its weighted points.
A criterion that does not apply to a task is excluded for that task, not awarded free points. Every criterion must have
a published, representative set of applicable tasks before an overall score is reported.

Calculate:

```text
criterion points = criterion weight × mean(applicable trial ratings / 4)
overall score = sum(criterion points), maximum 100
```

Report task-family results alongside the overall score so excellent small edits cannot hide poor full-application or
skill-workflow performance. Publish the grading anchors and task mix before running the comparison.

A score is not a completion percentage. Report these separately:

- **Accepted result rate:** independently accepted outcomes / all attempts.
- **Autonomous verified completion rate:** accepted outcomes with appropriate agent-run verification and no rescue prompts / all attempts.
- **False completion rate:** claims of completion contradicted by the artifact or recorded checks / all attempts.
- **Operator effort:** rescue prompts, manual repairs, and active operator minutes.
- **Efficiency:** time and total cost per accepted outcome, including failed attempts.
- **Critical failures:** unauthorized effects, overwritten user work, or fabricated verification evidence.

Any critical failure makes that attempt unaccepted and must remain visible separately from the aggregate. Honest
blocking can earn truthful-reporting credit, but it is not a completed task. An agent should not receive extra credit
for running indefinitely.

## Provisional assessment requested by the user

The user requested an assessment for each harness after clarifying the outcome criteria. The following scores are
**low-confidence analyst forecasts**, not measured results, completion percentages, or a reinstatement of the previous
feature-based ranking. They express a judgment about likely suitability for the stated workload with a strong supported
model, working tools, adequate budgets, and ordinary repository instructions. They are not calculated from trial ratings:
the rubric above defines what the forecast is about; the evaluation below is how it would be tested.

| Harness            | Previous forecast | Updated forecast / 100 | Assessment for autonomous engineering work                                                                                                                                      |
| ------------------ | ----------------: | ---------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex              |                88 |                 **88** | Leading candidate for sustained repository work, implementation, verification, and skill/MCP workflows. No new matched outcome evidence warrants a score change.                |
| Claude Code        |                88 |                 **88** | Leading candidate for investigation, multi-file implementation, and reusable workflows. Context retention and verification completeness still need outcome testing.             |
| Cursor             |                85 |                 **85** | Leading candidate for application development and editing with browser feedback. Its relative quality and efficiency remain unmeasured here.                                    |
| Alpha Code         |                78 |                 **80** | A concrete background-command evidence gap is fixed, and the modified harness passed six live revisions across two execution paths. Broader task reliability remains uncertain. |
| Copilot Chat Agent |                78 |                 **78** | Supported agent capabilities remain substantial, but this user's follow-through concerns are unresolved. Alpha using Copilot models does not test Copilot Chat's harness.       |

**Interpretation:** treat the first three as one leading group. Alpha and Copilot Chat's relative position is unresolved;
the two-point forecast difference does not establish superiority. Allow roughly ten points of judgment uncertainty for the first group
and fifteen for Alpha/Copilot Chat. Those are rough uncertainty allowances, not statistical confidence intervals.
No harness is credited with being hallucination-free. Source inspection, vendor claims, and the user's report do not
provide matched hallucination or unsafe-edit rates.

Alpha's two-point increase is an analyst judgment about a repaired mechanism and stronger evidence in one narrow
workflow. It is not a measured two-percent improvement, a calculated rubric score, or proof of fewer model turns. The
live sample is not representative of the full workload. Its source-visible optional verification policy remains a
limitation of the completion guarantee, not proof that Alpha produces worse code than another product.

### What the live results change

The existing command-settlement scenario ran on VS Code **1.122.1** with Copilot-provided **GPT-5.6 Luna/high**. Each of
two runs built a small HTML/JavaScript counter and made two subsequent revisions. The model ran a host-owned Node oracle
with five behavioral checks per revision; the command returned in the background. These are two runs of one scenario,
not six independent task families or a production web-application trial.

| Observation                                                            | Execa | VS Code integrated terminal |
| ---------------------------------------------------------------------- | ----: | --------------------------: |
| Revisions passed                                                       |   3/3 |                         3/3 |
| Model requests, including build/edit/completion steps                  |    13 |                          12 |
| Verification command invocations                                       |     3 |                           3 |
| Receipt-file reads                                                     |     3 |                           3 |
| Commands with running and successful outcomes visible in model history |   3/3 |                         3/3 |

Each verification command ran once and exited zero. Both runs had no tool-transaction errors, failed task turns,
unresolved mutation receipts, or terminal fallback warnings. The new outcome field demonstrably reached the model.
That strengthens confidence in process evidence delivery and completion on this fixture.

The remaining uncertainty is specific: the model still read a receipt once per revision, and no pre-change run of the
same workload/model/settings was collected. We cannot attribute request savings to the fix. Failed-check repair,
browser-driven application quality, single-file Python tasks, skill selection and execution, MCP recovery, and long-task
resumption did not receive new live evidence from these runs. Their assessment is unchanged.

See [implementation and live validation](background-command-outcomes-2026-09-16.md#live-copilot-validation) for commands,
timings, source/build provenance, and local artifact locations. This is evidence about **Alpha's harness using Copilot
as the model provider**, not Copilot Chat Agent. The other four harnesses were not run against this fixture.

For Copilot, the user's reported friction matters to this workload forecast, but it is not sufficient evidence for a
large universal penalty. GitHub's June 25, 2026 evaluation reports broadly comparable results for **Copilot CLI** against
model-vendor harnesses under matched models across several benchmarks, including SkillsBench. These are vendor-reported
results on specified configurations; they neither establish a Chat Agent success rate nor support declaring Copilot
generally incapable. [GitHub's harness evaluation](https://github.blog/ai-and-ml/github-copilot/evaluating-performance-and-efficiency-of-the-github-copilot-agentic-harness-across-models-and-tasks/).

Cursor also describes model-specific tool formats, online quality evaluation, and tracking whether generated code is
retained. That supports treating it as a serious contender for the core execution problem, without converting its
engineering claims into a measured comparison. [Cursor's harness engineering account](https://cursor.com/blog/continually-improving-agent-harness).

The additional research did not yield a current matched comparison covering all five products and this task mix.
An observational PR study reviewed during this revision uses 2025 data and reports confounding from task and repository
differences; its acceptance rates are not converted into these scores.
[Study and methodology](https://arxiv.org/html/2602.08915v1).

## What the existing evidence supports

**Measured comparative outcome scores: not established.** No matched trial of these five harnesses has been run for
this assessment. The forecasts above provide the requested provisional judgment; the outcome rates and measured
scores below remain unknown. Documentation is not being presented as empirical validation of those forecasts.

| Harness            | Evidence available                                                          | Supported assessment                                                                                                       | Measured score / 100 |
| ------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Alpha Code         | Source/contract tests plus two live runs with six successful revisions      | Background outcomes and completion work on the tested fixture; full-spectrum and comparative reliability remain unmeasured | Not established      |
| Codex              | Official skills/MCP documentation and available local tool surface          | Relevant workflow mechanisms exist; their comparative success rate is unmeasured here                                      | Not established      |
| Claude Code        | Official explanation of its edit/execute/feedback loop and context handling | Relevant execution and recovery mechanisms exist; their comparative success rate is unmeasured here                        | Not established      |
| Cursor             | Official Agent, browser, checkpoint, and skills documentation               | Relevant editing and application-feedback mechanisms exist; their comparative success rate is unmeasured here              | Not established      |
| Copilot Chat Agent | Official agent/skills documentation and user-reported poor experience       | Capability support is documented; strong autonomous execution is not established by that support                           | Not established      |

Documentation can explain how a feature is intended to work. Source inspection can establish a particular runtime
mechanism. Existing deterministic tests can exercise a contract. None alone establishes how often a live agent solves
representative tasks, hallucinates, edits safely, or finishes without intervention.

The evidence is asymmetric: Alpha's internal mechanisms are visible, while this assessment primarily has public
documentation for competing products. Do not treat unknown competitor defects as absent, or visible Alpha defects
as evidence that Alpha is necessarily worse.

## Alpha: concrete findings relevant to the corrected question

The following observations are grounded in the current source. The preceding implementation and live-testing work
supplied the new command-outcome evidence; no additional test campaign was run for this documentation update.

| Concern                            | Source evidence                                                                                                                                                                | Practical implication and limit                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turn sequencing and tool effects   | [AgentTurnEngine](../src/core/agent/AgentTurnEngine.ts), [ToolScheduler](../src/core/agent/ToolScheduler.ts), [StepContext](../src/core/agent/StepContext.ts)                  | There is a shared execution structure to inspect and test. Its existence does not measure model judgment or whole-task quality.                                                                 |
| Controlled workspace mutations     | [WorkspaceMutationGate](../src/core/task/WorkspaceMutationGate.ts), [gate tests](../src/core/task/__tests__/WorkspaceMutationGate.spec.ts)                                     | Admitted mutations are serialized and queued cancellation is handled. This gate alone does not prove every edit is minimal or correct.                                                          |
| Completion decisions               | [Task](../src/core/task/Task.ts), method `getCompletionGateDecision`                                                                                                           | Checks open work, runtime activity, durable decisions, and changes in command evidence. This is meaningful lifecycle control, not a universal acceptance test for requested behavior.           |
| Background command outcomes        | [CommandOutcomeContext](../src/core/agent/CommandOutcomeContext.ts), [environment projection](../src/core/environment/getEnvironmentDetails.ts), and the live evidence above   | Bounded recorded process status reaches subsequent model steps without another status tool. It does not establish test coverage, validate later edits, or eliminate the observed receipt reads. |
| Limits of verification enforcement | [ParentVerification](../src/core/agent/ParentVerification.ts), functions `isBlockingParentVerification` and `parentEvidenceMessage`                                            | Review/effect settlement can block completion. Optional command evidence can remain failed or missing without blocking completion. A successful process also does not establish test coverage.  |
| Bounded recovery                   | [CompletionRecovery](../src/core/agent/CompletionRecovery.ts), [recovery tests](../src/core/agent/__tests__/CompletionRecovery.spec.ts)                                        | Tracks unresolved obligations with scoped retry accounting. Reading more files does not fabricate resolution. This is not proof that the model finds the right repair.                          |
| Skill invocation                   | [SkillsManager](../src/services/skills/SkillsManager.ts), [SkillTool](../src/core/tools/SkillTool.ts), [skill tests](../src/core/tools/__tests__/skillTool.spec.ts)            | Discovery, mode-aware lookup, and managed-child skill identity are implemented. Correct loading is a prerequisite; faithful execution of all workflow steps needs outcome evaluation.           |
| MCP execution                      | [UseMcpToolTool](../src/core/tools/UseMcpToolTool.ts), [MCP tool tests](../src/core/tools/__tests__/useMcpToolTool.spec.ts)                                                    | Validates the requested tool, requests approval, and preserves cancellation/error handling. Successful calls do not by themselves prove a multi-step external workflow completed correctly.     |
| Persistence                        | [ProviderTranscriptStore](../src/core/task-persistence/ProviderTranscriptStore.ts), [transcript tests](../src/core/task-persistence/__tests__/ProviderTranscriptStore.spec.ts) | Provides a concrete persistence boundary to evaluate under interruption. Resumption must still retain the user's requirements and current evidence.                                             |
| Web application feedback           | [VSCodeBrowserTools](../src/services/browser/VSCodeBrowserTools.ts), [browser adapter tests](../src/services/browser/__tests__/VSCodeBrowserTools.spec.ts)                     | A browser adapter exists. A real application task on exact host 1.122.1 must demonstrate that discovery, interaction, screenshots, repair, and rechecking compose successfully.                 |

**Alpha's most important unanswered question is whether these mechanisms consistently produce a correct, verified
result without human rescue.** Adding more integrations would not answer it.

The verification finding is deliberately narrow: optional process evidence is advisory in the inspected policy.
It does not mean Alpha has no completion gate, and it does not establish that other products enforce acceptance
more strongly. Requiring every repository test for every small edit would also be a poor substitute for relevant
verification.

For grounding, test cases should include a nonexistent API, misleading repository documentation, an MCP error
returned in a successful transport response, and stale “passed” evidence from an earlier file version. Observe
whether the agent investigates and corrects its beliefs before claiming success.

## Competitor mechanisms relevant to this evaluation

Official pages below were retrieved on **September 16, 2026**. They document capabilities, not comparative outcome
rates. Exact installed client builds and models have not been recorded or tested for the competitors.

**Codex.** Official OpenAI documentation describes skills with instructions, resources, and optional scripts,
progressive loading, explicit or implicit invocation, and a built-in skill creator. Its local clients support MCP
connections to external tools and context. These are directly relevant to the user's task mix, but neither a loaded
skill nor a configured MCP connection proves that the agent executes the workflow faithfully.
[Skills](https://learn.chatgpt.com/docs/build-skills);
[MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Official OpenAI verification guidance was rechecked for this update. It recommends proportionate checks and repeating
or broadening verification only when new edits, failures, or unresolved concerns justify it. This supports the direction
of Alpha's efficiency work; it does not prove that Codex always uses fewer turns or that Alpha now matches its outcomes.
[Testing and verification guidance](https://developers.openai.com/api/docs/guides/latest-model#testing-and-verification).

**Claude Code.** Its documented loop feeds file, command, and other tool results back into subsequent decisions;
the documentation describes testing after changes, skills, MCP, session resumption, and file checkpoints. It also
explicitly discusses loss of detailed early instructions during context compaction. The right comparison tests
whether the agent notices failed checks and preserves the task through those transitions.
[How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works).

**Cursor.** Agent documentation describes file editing, terminal execution, browser interaction, and checkpoints.
Skills include instructions and executable resources with on-demand loading. These enable the desired workflows.
They do not establish a superior frontend result, fewer unsafe edits, or a higher completion rate without task trials.
[Agent](https://cursor.com/docs/agent/overview);
[Skills](https://cursor.com/docs/skills).

**Copilot Chat Agent.** VS Code documents planning, editing, command execution, iteration, and application validation.
Skills can package procedures, scripts, and resources. VS Code also distinguishes Copilot from other agent harness
targets. Selecting a different harness must be recorded as a different configuration, even when it appears in the
same editor.
[Agents](https://code.visualstudio.com/docs/agents/overview);
[Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills).

Copilot's GitHub hosting, scheduling, PR creation, and separate review services do not compensate for poor core task
execution in this assessment. Equally, Codex's artifact previews, Cursor's editor experience, and Alpha's provider
count do not earn points unless they improve actual outcomes.

## A practical comparison that would answer the question

Use 40 tasks, with five in each family:

| Task family                   | Representative acceptance challenge                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| Small controlled edits        | Fix one behavior while preserving nearby behavior and existing user edits                                |
| Standalone Python             | Produce a runnable program with malformed-input cases, useful errors, and checks                         |
| Complete web features         | Build a feature across UI, API, and persistence; verify its actual user journey                          |
| Existing application surfaces | Edit responsive UI and interactions without breaking accessibility or other routes                       |
| Investigation and debugging   | Find a seeded root cause, repair it, and cover the regression without weakening checks                   |
| Skills and reusable workflows | Use an existing skill; author or adapt a workflow and demonstrate reuse on unseen input                  |
| MCP-dependent work            | Discover a schema, execute dependent operations, recover from an injected tool error, verify final state |
| Long-task recovery            | Resume after interruption and external edits while preserving requirements, scope, and evidence          |

Three independent trials per task per product yield 120 trials per product and **600 trials total**.
A smaller paired pilot can first validate fixtures and grading; it should not be marketed as a precise universal ranking.

Freeze the initial repository, skill contents, MCP fixtures, permissions, and budgets. Give each product the same
acceptance criteria, but keep some grading checks independent so agents cannot pass by merely weakening their own
tests. Include browser inspection and human assessment where behavior or visual quality cannot be covered by unit
tests alone.

Predefine what counts as an intervention. Initial requirement clarification and necessary authorization are not
rescue prompts. “You forgot the backend,” “run the failing test,” manual code repair, and selecting the next obvious
step for a stalled agent are interventions. Record those separately from routine approvals.

For skills and MCP, assess the entire chain:

```text
discover → load instructions/resources → choose tools → execute dependencies
    → inspect actual results → recover when needed → verify final artifact/state
```

For code and application work, assess:

```text
understand → inspect → implement within scope → run relevant checks
    → diagnose failure → repair → verify final version → truthful handoff
```

Keep timeouts, premature stops, rate limits, regressions, and failed attempts in the dataset. Use paired task results
and uncertainty intervals rather than treating every repeated run as an unrelated task. Report speed and cost only
after recording them.

## Review status and remaining limitation

This revision changes only this assessment document. It retains the outcome rubric, raises Alpha's forecast from
78 to 80 using the preceding fix and focused live evidence, and leaves all competitor forecasts unchanged. Codex skill
and verification guidance, Claude Code's loop documentation, Cursor Agent/skills, and VS Code's agent overview were
rechecked on September 16, 2026. Documentation supports capability descriptions, not the numerical ranking.

Measured comparative product scores remain unresolved. Two Alpha live runs are recorded; no matched trial of the
five harnesses, reduction in verification turns, or broad solution-lifecycle parity is claimed.

Concurrent edits to `src/core/tools/ReadFileTool.ts` and
`src/core/tools/__tests__/readFileTool.spec.ts` were preserved. The pre-existing
`docs/solution-lifecycle-scorecard-2026-09-16.md` was also preserved and was not used as measurement evidence.
