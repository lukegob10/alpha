---
name: review-agent
description: Review a specified code change for actionable defects and return prioritized findings without editing. Use when explicitly asked to use this skill, including a delegated review of working changes, a commit, or a branch against its base. Investigating a reported failure belongs to debug.
---

# Review Agent

Review the requested change completely and report defects supported by the code. This workflow ends with findings;
implementing corrections is a separate task.

## Establish the target

Read the applicable repository instructions and working-tree status. Identify the requested working changes, commit,
or branch comparison before reviewing. For working changes, include staged and unstaged diffs and relevant untracked
source files. Preserve all existing edits.

For a branch comparison, inspect changes from the merge base with the requested base. Prefer that base's configured
upstream when it exists and is ahead of the local base; otherwise use the local base. If the local ref is missing, try
its configured upstream. Use `git merge-base HEAD <comparison-ref>` to establish the boundary, then inspect the diff
from that commit. Report an unavailable target instead of silently reviewing a different change. Treat ref names as
arguments, never concatenate untrusted input into a shell command.

## Verify defects

Inspect the entire diff, surrounding behavior, callers, and nearby tests. Continue through the remaining files after
finding an issue. Follow affected data and state transitions far enough to demonstrate the failure, including error,
cancellation, reload, and concurrent paths when relevant. Use focused existing checks when permitted and useful;
distinguish checks actually run from conclusions based on inspection.

Report a finding only when the reviewed change introduces a concrete problem affecting correctness, security,
performance, or maintainability that the author would reasonably fix. Explain the triggering conditions and causal
path. Exclude pre-existing defects, unsupported possibilities, intentional requirements, and cosmetic preferences.
Verify suspected issues against call sites and tests before reporting them.

## Work within Alpha

Load this skill through the normal skill tool. It works in the current Code or Plan mode and can be explicitly
requested in a parent task or delegated to an existing review agent. Do not create another reviewer or delegate the
review onward. A skill does not change the task's tools, workspace scope, approval requirements, or authority.

Keep the review read-only: do not edit source, add tests or instrumentation, apply fixes, commit, push, or publish
comments. Use only permitted inspection and verification tools. If verification needs unavailable execution or write
authority, report the limitation rather than bypassing it. Return findings to the requesting user or parent through
the existing task result path.

## Report findings

Put actionable findings first, ordered by severity. Give each a priority, short corrective title, exact file and line,
and a concise explanation of the scenario and impact. Locate it in the changed lines and keep the range narrow.

- P0: a critical defect or release blocker independent of special inputs or environment assumptions.
- P1: a serious regression requiring prompt correction.
- P2: a substantive defect that should be corrected.
- P3: a smaller actionable defect.

If no issue meets this standard, say `No findings.` Follow with a brief assessment and material verification gaps or
remaining uncertainty. An inaccessible diff or incomplete inspection is a limitation, not a clean review.
