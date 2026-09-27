# Problem-solving improvement loop

The goal is a live Copilot harness that completes more of the declared task set, then uses fewer
requests and less time. A change is kept only when a later run on the same declared tasks shows
that. Holdout tasks are for a promotion check. They are not an input to the change.

## What is stored

- This policy, which every iteration reads before changing the harness.
- One report per run: host, model, effort, build and evaluation input identities, resolved task-set
  digest, selected task IDs and repetitions, and for every attempt the verifier decision, failure
  class, requests, tokens, and cost. A missing price stays null.
- For every code change: the general rule it implements, the run that motivated it, and the
  confirmation run on a new build.

Reports live under `F:\alpha-vscode-e2e-runs\problem-solving-live-*`. The interrupted core-bank
baseline is `problem-solving-live-20260921-03`: verifier passed 6 of 9, solving score 0 of 9,
because every attempt stopped on a command approval. The confirmation run is
`problem-solving-live-20260921-04` on the same build and model: solving score 7 of 9. The two
misses each used one request and stopped on `unexpected_read_approval` for a file outside the
task workspace. `problem-solving-live-20260921-05` measured every local task the command grader
can score: 9 core bank, 19 development bank, and 4 native tasks. Solving score 24 of 32. The
eight misses each used one request and stopped on an outside-workspace read. The follow-up
denies that read or write and continues the attempt. It does not allow a path by name.
Confirmation run `problem-solving-live-20260921-06` scored 32 of 32 on the same subset, with
no new failure class. Its lifecycle and turn-event projections validated for all 32 attempts,
but its cross-stream joins were incomplete because the two journals use separate run IDs. The
evidence join now keys on the shared task/turn/step identity and retains both producer run IDs
when they differ. Holdout stays reserved. Terminal-Bench stays on its container verifier.

## One iteration

1. Run one sample of the declared subset. Grade each workspace when the attempt finishes. Keep
   every attempt, including failures.
2. Compare with the previous report. Verified completion comes first. Requests, time, and tokens
   come second.
3. Write one hypothesis that would still apply to a task with a different test command, layout,
   and language.
4. Implement that hypothesis only. Do not add a task id, fixture path, or transcript command to
   an allowlist.
5. Rerun the same subset on the new build. Keep the change when verified completions do not drop
   and no new failure class appears. Otherwise revert it.
6. Use holdout only after a change has survived step 5. Do not open holdout to invent the next
   hypothesis.

## Trajectory diagnosis

The live runner writes a unique `report.json` for each run and refuses to overwrite an existing
run directory. Use `benchmark:problem-solving-diagnose` to combine outcomes with content-free E2E
projections into a review packet. Tool results are grouped into allowlisted categories; raw tool
names, arguments, paths, prompts, and outputs remain out of that packet. The report records missing
evidence and unknown cost explicitly and only suggests a component change when an observed pattern
supports it.

The 2026-09-21 32/32 result is a reported campaign outcome, not yet a controlled capability
baseline or evidence for a specific prompt or engine fix. It had one sample per task, so it cannot
estimate live run variance. The next quality step is
to repeat the declared subset on the same host/model/effort, then review the diagnostic packet
independently before selecting one general change. The manifest currently has a Git-tagged local
diff-comparison task; it does not tag branch, commit, or worktree operations or live GitHub issue/PR
flows. Treat those as candidate additions after checking the task text and the new trajectory data.

The 2026-09-22 rerun is diagnostic, not a complete baseline. It selected 32 local tasks but stopped
after 28 attempts were recorded. The latest diagnosis distinguishes 26 attempts with task-execution
start evidence, one timeout with unknown start evidence, and one profile-busy preflight block; six
planned task executions remain unconfirmed, including the blocked task and four tasks never
recorded. The four Alpha-native tasks were never attempted.
Among the 28 attempts, 25 ended at the E2E command-approval gate, one timed out, one was blocked by
the profile lease, and one passed. The graders scored the post-attempt workspaces, but the dominant
gate interaction does not tell us what the model would do after a command was admitted. The run used
VS Code 1.136.1 and a dirty working tree, so it also does not establish behavior on the repository's
1.122.1 reference host or a clean source snapshot. The 1/27 result is this campaign's grader pass
rate, not a general estimate of agent quality. An independent model review agreed that prompt,
engine, and scheduler changes are not supported by this result.

The regenerated diagnosis also found three different `src/dist/extension.js` hashes across the 26
started attempts. This report has no prelaunch bundle fingerprint or task-set digest, so it cannot
serve as a single-artifact baseline even for the command-gate behavior. New campaigns record both
identities and compare every E2E capture with the prelaunch bundle hash; repeat only after building
once and holding that artifact and source snapshot fixed for the full campaign. The first hash was
captured on `repo-cache-invalidation`, the second on `repo-stream-backpressure`, and the third on the
other 24 starts. Task identity and artifact therefore move together in this run; do not attribute a
task outcome to a particular build.

The E2E gate now emits content-free rejection reasons for empty commands, shell operators, denied
prefixes, out-of-workspace arguments, and out-of-workspace working directories. The approval rules
did not change. The first three-task, two-repetition follow-up hit a busy-profile preflight block and
recorded no confirmed task executions; that report is preserved as a blocked preflight, not quality
evidence. After verifying that the lease owner was no longer running, a fresh campaign completed all
six planned attempts.

The diagnosis separates recorded attempts from execution-start evidence and excludes preflight
blocks from task-coverage tags. It treats a start as evidenced by a positive request receipt, a
model-request event, a tool/result event, a verification event, a turn/task event, or a verified pass;
initialization events alone do not count. An attempt with unknown start remains a failure in its
original report and also remains pending for execution evidence. Keep any retry in a new run report
so it cannot replace the original failure.

Both diagnostic campaigns report the same Git commit but different working-tree input digests and
dirty trees. Treat them as separate inputs, not a controlled repeat. The diagnosis counts
`verification_result` trajectory events separately from grader outcomes; the former measures
projected workflow events and is not an additional task score.

Before comparing live runs, record the prelaunch SHA-256 of `src/dist/extension.js` and compare it
with each E2E capture manifest's `bundleSha256`. The E2E digest is a later read of the entrypoint
file on disk; matching values do not fingerprint every packaged asset or prove the host loaded those
exact bytes. The report pins the resolved task set and selected IDs/repetitions. Event-level tool
policy hashes include workspace scope, so they do not establish policy equivalence across fresh
workspaces. The live runner now also records a stable SHA-256 identity of effective E2E approval
settings without workspace paths, plus the request limit. Older runs predate that field. Record host,
model, effort, and request limit with every comparison. The source input digest still does not pin
every host runtime setting. Terminal-Bench remains on its pinned container verifiers and outside the
local Copilot score.

The completed controlled cohort `problem-solving-live-2026-09-23T03-49-56-325Z-15efd8a1` used VS
Code 1.136.1, `gpt-5.6-luna`, high effort, request limit 40, and the same three selected core tasks
twice each. All six attempts started; all six E2E entrypoint reads matched one prelaunch hash;
capture manifests, lifecycle and turn projections, cross-stream joins, usage receipts, and tool
categories were complete. The source tree was dirty, and the task-set and tracked-input digests are
recorded in its packet.

| Task                       | Verified passes / scored attempts | Gate outcome                                           |
| -------------------------- | --------------------------------: | ------------------------------------------------------ |
| `repo-pagination-cursor`   |                               2/2 | Both passed (4 requests each).                         |
| `repo-cache-invalidation`  |                               0/2 | Both stopped with `unexpected_command_shell_operator`. |
| `repo-stream-backpressure` |                               0/2 | Both stopped with `unexpected_command_shell_operator`. |

The four failed workspaces did not pass grading, but those failures measure the E2E gate interaction
and resulting workspace, not behavior after a command was admitted. The pooled 2/6 Wilson interval
is descriptive only; it ignores task clustering and selection and is not a general success estimate.
The independent review judged a command-construction experiment reasonable, but found insufficient
evidence to claim a prompt defect. The `shell_operator` reason does not distinguish a true chain from
punctuation inside a quoted argument.

The deterministic E2E controls now admit a simple workspace command and reject both an actual `&&`
chain and quoted shell punctuation. The three compiled E2E scenario suites passed 37/37 checks;
the 1.122.1 `test:command-paths:1221:run` control also passed. The stable E2E approval-policy hash
stays the same across fresh workspace paths and changes when the request limit changes. The live
pagination task graded successfully in both same-prompt cohorts. Together these establish that the
repeated cache and stream stops occur under a deliberate text-level gate rule; they do not show a
core engine or scheduler defect.

The next experiment varies one task-independent user-prompt strategy while holding the built
extension, host, Copilot model, effort, request limit, selected tasks, grader, and effective approval
policy fixed. The `single-command` arm asks the model to issue one direct workspace command at a
time, use file tools for inspection and edits, and avoid shell operators or punctuation that this
gate rejects, including inside quoted arguments. It does not grant additional permissions. The
runner alternates arm order across repetitions and records each effective prompt hash and the
instruction hash without exporting prompt text.

Run the same three tasks twice under both prompt arms (12 attempts total). Review verified grader
passes per task and shell-operator gate stops first; requests, tokens, and elapsed time are secondary.
Treat pagination as the regression control. Check prompt hashes, bundle identity, effective policy
identity, and all planned starts before interpreting the comparison. This is an experiment on task
prompt guidance, not evidence that Alpha's shared system prompt should change. Have an independent
model review the sanitized diagnosis before carrying any lesson into shared prompts, engine, or
scheduler code. Keep the 1.122.1 compatibility gate separate from same-host quality measurement.

For a repeat of this cohort, retain the host/model/effort/request limit and task repetition settings:

```powershell
pnpm bundle
$env:PROBLEM_SOLVING_TASK_IDS = "repo-pagination-cursor,repo-cache-invalidation,repo-stream-backpressure"
$env:PROBLEM_SOLVING_REPETITIONS = "2"
$env:PROBLEM_SOLVING_HOST_VERSION = "1.136.1"
$env:PROBLEM_SOLVING_MODEL_ID = "gpt-5.6-luna"
$env:PROBLEM_SOLVING_EFFORT = "high"
$env:PROBLEM_SOLVING_REQUEST_LIMIT = "40"
$env:PROBLEM_SOLVING_PROMPT_VARIANTS = "baseline,single-command"
pnpm --dir packages/evals benchmark:problem-solving-live
```

The runner creates a unique run ID and report directory. Diagnose its `report.json` and preserve the
independent review before selecting one harness change. Treat a bundle mismatch or changed
approval-policy identity as invalid comparison evidence.

## Overfitting

A fix is overfit when it names one task, one fixture file, or the exact command from one
transcript, or when the only passing evidence is the attempt that suggested it. The command gate
stays the extension deny list plus the task workspace boundary. The next confirmation run measures
that gate. It does not add `npm test` as a special case.

## Limits

Stop the iteration on authentication failure or a busy profile lease. Use one sample per task for
broad screening; use two repetitions on a small cohort to inspect a local gate interaction, not to
estimate stable variance. That diagnostic cohort cannot establish a broad quality gain. Development
tasks may suggest a hypothesis. Core tasks confirm it. Terminal-Bench stays on its own container
verifier and is not mixed into a local Node score.
