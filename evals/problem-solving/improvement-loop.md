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

The last 32/32 result is a useful capability baseline, not evidence for a specific prompt or engine
fix. It had one sample per task, so it cannot estimate live run variance. The next quality step is
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
once and holding that artifact and source snapshot fixed for the full campaign.

The E2E gate now emits content-free rejection reasons for empty commands, shell operators, denied
prefixes, out-of-workspace arguments, and out-of-workspace working directories. The approval rules
did not change. A follow-up plan of three tasks repeated twice recorded one profile-busy preflight
block and had zero confirmed task executions; all six planned executions, including the blocked task,
remain pending. Start a fresh campaign for this selection after the profile lease releases. The
diagnosis now separates recorded attempts from execution-start evidence and excludes preflight
blocks from task-coverage tags. It treats an execution start as evidenced by a positive request
receipt, a model-request event, a tool/result event, a verification event, a turn/task event, or a
verified pass; initialization events alone do not count.
An attempt with unknown execution start remains a failure in its original report and also remains
pending for execution evidence. Keep any retry in a new run report so it cannot replace the original
failure. Unit tests cover the new reasons and blocked-run classification, but the rejection categories
still need a live run after the profile is available.

Both diagnostic campaigns report the same Git commit but different working-tree input digests and
dirty trees. Treat them as separate inputs, not a controlled repeat. The diagnosis counts
`verification_result` trajectory events separately from grader outcomes; the former measures
projected workflow events and is not an additional task score.

Before the next live comparison, use an immutable source snapshot, record the prelaunch SHA-256 of
`src/dist/extension.js`, and compare it with each E2E capture manifest's `bundleSha256`. The E2E
digest is a later read of the entrypoint file on disk; matching values do not fingerprint every
packaged asset or prove the host loaded those exact bytes. The report now pins the resolved task set
and selected IDs/repetitions, and carries the effective tool-policy snapshot hashes from each
attempt. Those policy hashes include workspace scope, so compare them within a task attempt and use
the source input identity to establish code/configuration sameness across run roots. Reproduce the
previous passing task and two command-gate failures twice each on the same model setup. First add
deterministic controls for one permitted command, one expected denial, and one completed graded
task. Keep the 1.122.1 compatibility gate separate from that same-host reproduction. Terminal-Bench
remains on its pinned container verifiers and outside the local Copilot score.

For that first controlled cohort, use the same host/model/effort as the diagnostic run and repeat the
previous pass plus the two command-gate failures twice each. After the dedicated profile is
available and the built extension is fixed for the run, the PowerShell invocation is:

```powershell
$env:PROBLEM_SOLVING_TASK_IDS = "repo-pagination-cursor,repo-cache-invalidation,repo-stream-backpressure"
$env:PROBLEM_SOLVING_REPETITIONS = "2"
$env:PROBLEM_SOLVING_HOST_VERSION = "1.136.1"
$env:PROBLEM_SOLVING_MODEL_ID = "gpt-5.6-luna"
$env:PROBLEM_SOLVING_EFFORT = "high"
pnpm --dir packages/evals benchmark:problem-solving-live
```

The runner creates a unique run ID and report directory. Diagnose its `report.json` before asking
the independent reviewer to choose a harness hypothesis; treat any bundle mismatch as invalid
comparison evidence.

## Overfitting

A fix is overfit when it names one task, one fixture file, or the exact command from one
transcript, or when the only passing evidence is the attempt that suggested it. The command gate
stays the extension deny list plus the task workspace boundary. The next confirmation run measures
that gate. It does not add `npm test` as a special case.

## Limits

Stop the iteration on authentication failure or a busy profile lease. One sample per task until a
baseline has been repeated. Development tasks may suggest a hypothesis. Core tasks confirm it.
Terminal-Bench stays on its own container verifier and is not mixed into a local Node score.
