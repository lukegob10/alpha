# Evaluating an Agent Skill

Use this guide for critical, frequently reused, script-backed, destructive, externally integrated, or routing-sensitive
skills. Scale the suite to the risk; a small explainable regression set is better than a large unreviewed benchmark.

The evaluation method follows the Agent Skills evaluation and description-optimization guides plus OpenAI's 2026
evaluation pattern:

- https://agentskills.io/skill-creation/evaluating-skills
- https://agentskills.io/skill-creation/optimizing-descriptions
- https://developers.openai.com/blog/eval-skills

## Define success before the run

Write a compact contract with four kinds of checks:

- **Outcome:** the requested artifact or result is correct and complete.
- **Process:** required ordering, approvals, tools, or evidence were used.
- **Safety:** forbidden mutations, disclosure, escalation, or external actions did not occur.
- **Efficiency:** the run avoided material repetition, unnecessary resources, or excessive context.

Separate must-pass checks from preferences. Prefer observable assertions over judging whether a response “looks good.”

Start with two or three realistic workflow cases and one edge case. When the suite should be durable, store it under the
skill's `evals/` directory using an explicit contract:

```json
{
	"skill_name": "example-skill",
	"evals": [
		{
			"id": "happy-path",
			"prompt": "A realistic user request",
			"expected_output": "Observable success criteria",
			"files": [],
			"assertions": ["A specific, evidence-backed requirement"]
		}
	]
}
```

Do not add eval files to a simple skill merely to satisfy a template. Persist them when they will be rerun, reviewed, or
used to prevent a meaningful regression.

## Test activation independently

Create a prompt set that covers routing before evaluating the workflow:

```csv
id,should_trigger,category,prompt
explicit-01,true,explicit,"Use the $example-skill skill to perform the target workflow."
direct-01,true,direct,"A natural request that exactly matches the skill."
context-01,true,contextual,"A realistic request with extra project context."
adjacent-01,false,adjacent,"A nearby task that the skill must not take over."
generic-01,false,generic,"A broad request sharing one keyword but not the workflow."
excluded-01,false,excluded,"A task explicitly excluded by the description."
```

For each case, capture whether the host exposed and selected the skill. An explicit invocation verifies discovery but not
implicit routing. A positive-only set cannot reveal over-triggering.

For a routing-critical skill, expand to 10–20 substantive prompts with difficult adjacent negatives. Keep part of the set
held out while editing the description and select changes by held-out performance, not by memorizing the draft cases.
Repeat cases when model selection is stochastic and report the activation rate.

Repair routing failures in this order:

1. Confirm the skill is in a discovered location and its frontmatter parses.
2. Make the description's primary capability and trigger terms earlier and more concrete.
3. Add a narrow exclusion for recurring false positives.
4. Split a skill that covers multiple unrelated jobs.
5. Re-run all positive and negative cases.

Do not inflate the description with the entire workflow. Metadata routes; the body executes.

## Test workflow behavior

Use isolated fixtures or disposable worktrees. Never exercise a destructive skill against valuable user state.

At minimum cover:

1. A normal happy path.
2. Missing or malformed input.
3. A missing prerequisite or unavailable dependency.
4. Permission denial or cancellation before the first side effect.
5. Partial failure after an intermediate step.
6. A second invocation, when idempotency or resume behavior matters.
7. Relevant Windows, macOS, and Linux path or shell behavior when portability is claimed.
8. Untrusted content attempting to redirect the workflow or expose secrets.

Record the prompt, host and version, model/provider when relevant, fixture revision, permissions, observed actions,
artifacts, final response, and check results. Do not compare runs performed under materially different conditions as if
they were the same benchmark.

## Compare against a meaningful baseline

When claiming that a skill improves quality or efficiency, run the same cases both with the candidate skill and with a
meaningful baseline:

- For a new skill, the baseline is the same agent without the skill.
- For a revision, preserve the original version and compare against it.
- Keep the model, host, permissions, fixture, tool availability, and warm or cold cache conditions the same.
- Launch paired runs close together and keep their artifacts separate.
- Use multiple samples and report mean and variability when one run could be noise.

Grade deterministic requirements before qualitative ones. For subjective output, use a blind comparison that hides which
version produced each artifact and requires evidence for the preference. Inspect traces as well as final outputs: repeated
searches, abandoned approaches, and duplicated helper code reveal instructions or resources that need improvement.

Do not claim improvement merely because the candidate completed once. Also check whether the baseline already passes;
an instruction that adds tokens and latency without changing behavior may not belong in the skill.

## Prefer deterministic checks

Use exact checks for facts a program can establish:

- Frontmatter parses and conforms to limits.
- Required files exist and unexpected files do not.
- Relative references stay inside the skill package and resolve.
- Scripts return documented exit codes and bounded output.
- Generated files parse, type-check, build, or satisfy a schema.
- Expected commands or tool calls occurred in the required order.
- Forbidden commands, paths, network calls, or secret patterns are absent.
- Repeated runs preserve intended state.

Add rubric-based grading only for qualities that deterministic checks cannot capture, such as clarity, usefulness, or
fidelity to a writing standard. Require structured rubric output with named checks and evidence. Do not let a model-based
score override a deterministic safety failure.

## Evaluate scripts as software

For every bundled script:

- Test valid input, invalid input, missing files, hostile paths, and dependency failure.
- Verify argument-safe process execution and path containment.
- Bound output, recursion, concurrency, retries, and network waits.
- Confirm cleanup after success, failure, and cancellation.
- Run the documented command from a location other than the script directory.
- Check that exit code `0` means success and nonzero failures include actionable stderr.

If a script cannot be tested in the current environment, state the exact missing dependency and leave a reproducible
command for the target environment.

## Use a repair loop

For each failure:

1. Identify whether discovery, routing, instructions, a resource, the host, or the environment owns the failure.
2. Make the smallest change at that layer.
3. Re-run the failing case.
4. Re-run adjacent positive and negative cases.
5. Record the result; do not delete a valid negative case to improve the score.

Promote real failures into the regression set. Remove redundant cases only when another case proves the same invariant
more directly.

## Completion criteria

A production-quality skill is ready when:

- Standard and target-host validation pass.
- Required positive prompts activate it and negative prompts do not.
- The workflow meets all must-pass outcome, process, and safety checks.
- Supporting resources are necessary, reachable, and tested.
- The package contains no secrets, stale artifacts, placeholders, or unexplained dependencies.
- The result is reproducible from the recorded fixture and commands.
- Remaining model or host variability is stated rather than hidden.

Report the number and categories of cases run, not just a percentage. One successful demonstration is evidence for that
case, not proof of general reliability.
