# Problem-solving improvement loop

The goal is a live Copilot harness that completes more of the declared task set, then uses fewer
requests and less time. A change is kept only when a later run on the same declared tasks shows
that. Holdout tasks are for a promotion check. They are not an input to the change.

## What is stored

- This policy, which every iteration reads before changing the harness.
- One report per run: host, model, effort, build, and for every attempt the verifier decision,
  failure class, requests, tokens, and cost. A missing price stays null.
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
no new failure class. Holdout stays reserved. Terminal-Bench stays on its container verifier.

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

## Overfitting

A fix is overfit when it names one task, one fixture file, or the exact command from one
transcript, or when the only passing evidence is the attempt that suggested it. The command gate
stays the extension deny list plus the task workspace boundary. The next confirmation run measures
that gate. It does not add `npm test` as a special case.

## Limits

Stop the iteration on authentication failure or a busy profile lease. One sample per task until a
baseline has been repeated. Development tasks may suggest a hypothesis. Core tasks confirm it.
Terminal-Bench stays on its own container verifier and is not mixed into a local Node score.
