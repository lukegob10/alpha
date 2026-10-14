---
name: debug
description: Investigate a concrete bug with an unclear cause using reproduction, hypotheses, and runtime evidence. Use for an explicit debugging investigation, unexplained or intermittent incorrect behavior, or the same failure persisting after an attempted fix. Skip routine commands, ordinary implementation, code review, general debugging questions, and isolated build/test errors whose cause and correction are already clear. Mentioning a bug, error, log, or test alone does not trigger this skill.
---

# Debug

Resolve the reported failure with evidence that connects its cause to a verified correction. Keep the investigation focused on the user's symptom and requested scope. Use this workflow for the current investigation; stop applying it when the issue is resolved or the user changes tasks. An unrelated command or later request does not inherit a debugging requirement.

## Enter at the right depth

Briefly state the failure being investigated and the evidence you will seek. Reuse reproduction steps, logs, and investigation results already supplied. Ask only for missing information that changes the next experiment. Do useful independent inspection while waiting when possible.

Scale the work to uncertainty. If inspection or an existing failing test establishes the cause, proceed directly to a targeted correction and verification. Do not manufacture competing hypotheses, add logging, or ask for manual reproduction when the available evidence is sufficient. Respect requests to diagnose only or explain a failure without editing.

## Work within Alpha

This is a skill used through Alpha's ordinary skill tool, not an execution mode. Keep the current task, model, and host-controlled Code/Plan mode. Loading it grants no additional permissions. In Plan, use permitted inspection and verification; do not write instrumentation or fixes. If source changes become necessary, explain the finding and let the user choose Code through the existing host flow. Do not call a mode-switch tool or delegate around restrictions.

Use only tools exposed in the current task:

- Inspect the relevant source and nearby tests through the file/search tools. Establish the working-tree state before edits and identify the layer that owns the broken behavior.
- Run existing, focused reproduction or test commands with `shell`, adapting to the repository's scripts, package manager, shell, and working directory. An exit code alone is not proof that the intended scenario ran.
- If command output provides an artifact ID, use `manage_command` with its `read` action to search or page the relevant evidence. Retain the returned cursor. It reads output immediately; it does not wait for completion. A command timeout may leave the process running, so do not launch duplicate reproductions or assume termination.
- For a UI failure, use the integrated browser tools only when available and the affected page is accessible. Reuse an appropriate shared page and obtain current page state before interacting. Otherwise use a test harness or ask the user for the smallest manual reproduction.
- Use `ask_followup_question` when progress needs an action or observation only the user can provide. State the exact steps and the evidence needed; do not repeatedly ask whether to continue work already requested.

Do not assume a Cursor debug server, logging endpoint, debugger attachment, or hidden log collector exists. Prefer existing test output and application logging. Use an existing debugger or profiler only when it is actually available and appropriate.

## Establish the failure

Define expected versus observed behavior, the smallest triggering input or action sequence, and relevant environment conditions. Trace that path through its callers, state transitions, and persisted or external boundaries. Distinguish the original failure from incidental failures in the test environment or investigation tools.

Try the smallest deterministic reproduction first. Capture the exact command or steps, significant output, and whether the original symptom occurred. An existing regression test, a focused new test, or a small local harness can provide the baseline. Preserve unrelated changes and use the project's normal tests and fixtures.

If reproduction fails, say so. Investigate the missing conditions or request specific evidence instead of presenting a speculative patch as a confirmed fix. Avoid broad environment resets that erase the failing state.

## Discriminate between causes

When the cause remains uncertain, keep a small set of plausible explanations tied to the observed path. For each, identify an observation that would support or rule it out. Choose the cheapest experiment that distinguishes them. Record concise outcomes and update the hypotheses before changing production behavior.

For timing bugs, prefer controlled promises, barriers, fake clocks, or an injected scheduler to arbitrary sleeps. Correlate events by the actual operation, request, or task identity; timestamps alone may hide overlapping work. For a performance symptom, establish the workload and compare the same measured operation before and after.

Add temporary instrumentation only when existing evidence cannot answer the question:

- Place narrow probes at the disputed boundary, recording only the state, ordering, or branch decision needed to test a hypothesis. Bound output and distinguish separate reproduction runs so stale logs cannot become evidence for the current run.
- Preserve behavior: avoid evaluating side-effecting expressions twice, changing asynchronous ordering, or adding expensive work that masks the failure. Treat disappearance under instrumentation as a clue, not verification.
- Use an existing local logging path or test output. Do not add dependencies, a network collector, or telemetry merely to gather observations. Exclude credentials and sensitive payloads; log minimal redacted values or shape/count information instead.
- Track the exact probes, temporary files, and processes created by this investigation and their purpose. Keep this small record in the task's working notes so a follow-up can resume and clean up safely. Do not overwrite existing logs or user instrumentation.

Run the experiment yourself when the available tools and permissions allow it. If human interaction is required, provide concrete steps and the relevant log location, then wait for actual evidence. A suggested follow-up answer or generic acknowledgment is not proof of reproduction or successful verification.

## Correct and verify

Explain the causal link supported by the evidence, then make the smallest complete correction at the owning layer. Check equivalent paths relevant to the failure, such as retry, cancellation, reload, and concurrent operations. Avoid unrelated refactoring, speculative changes, and retries or resets that merely hide the symptom.

Add or update a regression test when practical. Demonstrate that it detects the original defect, then that it passes with the correction. Establish the failing baseline before the fix or use an isolated fixture; never revert the user's working tree to prove it. Keep assertions about observable behavior and run the repository's required affected-surface checks.

Repeat the original reproduction with the fix. For an intermittent failure, also verify the ordering or invariant responsible; one successful run is weak evidence. If results contradict the hypothesis, revise the investigation rather than stacking another guess onto the patch.

Remove only this investigation's temporary probes and artifacts, preserving the fix, useful regression tests, and external edits. Re-read changed files before cleanup; remove owned edits precisely rather than restoring whole files or deleting broad directories. Stop only processes started by this investigation. Run the focused check again after removing instrumentation so verification reflects the code being delivered.

If the task is interrupted, cancelled, or resumed, reconcile the current files and running processes with the working notes before further action. Respect cancellation; do not continue experiments after a stop. At the next permitted opportunity, report remaining temporary changes or processes and clean up within the current authorization.

## Finish or identify the missing evidence

Report the cause and supporting evidence, the correction, checks actually run, and any remaining uncertainty or temporary resources. Keep the answer proportional to the bug. Distinguish a confirmed fix from a candidate awaiting reproduction or verification.

When further work depends on unavailable runtime access or repeated experiments yield no new evidence, summarize what was ruled out and request the single next useful observation. Do not spin on unchanged logs, silently expand into a repository audit, or claim success because the tools completed.
