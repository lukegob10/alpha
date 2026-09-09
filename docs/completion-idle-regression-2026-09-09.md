# Completion review incorrectly projected as a stalled model turn

## Reproduction and owning layer

The yellow `chat:stalledTurn` message is "No model output for a while. You can stop the task or steer it with a queued
message." `ChatView` shows it after 30 seconds when its projected turn is streaming without a newer activity timestamp.
It does not establish that the provider returned an empty response.

`attempt_completion` presents its result and waits at the existing completion-review ask before recording the tool's
terminal result. During that review, the canonical turn snapshot can correctly remain `in_progress` / `executing`.
The extension publishes task metadata with `lifecycle: waiting`, `isWaitingForInput: true`, and
`waitingReason: completion`. The webview's `applyLifecycleSnapshotsToExtensionState` overwrote that newer task boundary
with the executing turn projection, restoring `running` and clearing the waiting flag. A normal idle review then became
a false stalled-model warning. Text-only completions already had a terminal-turn preservation branch, explaining why
the behavior depended on how the model finished.

The correction belongs to that webview projection. The host's explicit completion-review boundary must survive turn
snapshot replay until the host publishes the next task transition. This preserves completion verification, pending
feedback, same-task continuation, tool-result persistence, and existing approval authority. It requires no provider retry
or fabricated terminal event.

## Repeatable test

The new `completion-idle.test` suite uses the existing isolated development-host runner, saved Copilot profile,
`ExtensionWorkflowHost`, request guard, and disposable statistics repository. It reviews, fixes and tests a bug, commits
the change, and adds a follow-up regression in the same task. It leaves completion reviews open throughout. It then asks
for a verified completion through `attempt_completion`, observes 35 seconds without input, captures only fixture
lifecycle/transcript state, and requires no additional provider requests. Finally it sends same-task feedback, accepts the
last completion, and checks durable lifecycle/tool transactions.

Host capture and rendered-webview acceptance are separate checks. A passing host run alone is insufficient: replay the
capture through `ChatView.spec.tsx` to verify that React leaves the composer idle and does not render the yellow bar.
The replay uses the actual webview context merger and chat component with the existing test component mocks; it is not
a screenshot or a claim of desktop UI automation. The default deterministic regression covers the same conflicting
host/turn states without a live model. The context regression checks duplicate snapshot replay and return to running
after a host follow-up transition.

Build the current extension and runner first, with Node 20.19.2 and pnpm 10.8.1:

```powershell
pnpm bundle
pnpm --dir apps/vscode-e2e compile
node apps/vscode-e2e/out/runTest.js --provider live-copilot --vscode-version 1.136.1 --vscode-executable 'C:/Users/Luke Goblirsch/AppData/Local/Programs/Microsoft VS Code/Code.exe' --profile-dir F:/alpha-vscode-e2e-runs/20260906/profiles --workspace F:/alpha-vscode-e2e-runs/completion-idle/workspaces/UNIQUE_RUN --artifacts-dir F:/alpha-vscode-e2e-runs/completion-idle/artifacts --init-profile --model-id gpt-5.6-luna --reasoning-effort high --file completion-idle.test --run-id UNIQUE_RUN
$env:ALPHA_COMPLETION_IDLE_EVIDENCE = 'F:/alpha-vscode-e2e-runs/completion-idle/artifacts/UNIQUE_RUN/completion-idle.json'
pnpm --dir webview-ui test -- src/components/chat/__tests__/ChatView.spec.tsx -t 'isolated live completion-idle'
Remove-Item Env:ALPHA_COMPLETION_IDLE_EVIDENCE
```

Use a fresh run ID and fixture workspace on every attempt. The suite enforces 70 provider requests and a ten-minute
workflow deadline itself. Do not pass `--request-limit` to this standalone suite: the existing runner only accepts that
option for registered `--scenario-id` workflows. Never reuse a normal editor profile or source repository as its fixture.
Scripted runs can select the same file on 1.122.1 using a separate owned test profile; they do not prove live Copilot
acceptance on that host.

## Evidence

Evidence is retained under `F:/alpha-vscode-e2e-runs/completion-idle/artifacts/`.

- Both deterministic regressions failed before the production fix: the context merger replaced waiting/idle with
  running, and the rendered chat contained the yellow stalled-turn status.
- `live-before-01` stopped at preflight because the standalone suite invocation incorrectly supplied `--request-limit`.
- `live-before-02` and `live-before-03` were closed after the first test design stopped admitting follow-ups to explicitly
  accepted completed tasks. They retain non-passing `host-completion-missing` records. Adding a durability join did not
  resolve that separate accepted-task admission behavior. The revised test leaves completion reviews open to match the
  reported workflow; these interrupted attempts are not passing acceptance evidence.
- `live-before-04` completed the isolated live host workflow with Copilot `gpt-5.6-luna`, high effort, on VS Code
  1.136.1. Its 35,027 ms idle window made zero additional requests (18 before and after); the same-task follow-up finished
  at 20 requests, five completed turns, and 19 complete tool transactions. Replaying its captured state against the
  pre-fix chat **failed**, rendering `chat:stalledTurn`. The same capture passed after the projection correction.

- `live-after-01` stopped admitting the follow-up after its commit review (10 requests) and was closed through its
  identity-verified test host. Its retained `host-completion-missing` result is not a pass. This establishes that the
  intermittent admission problem also occurs with an open completion review; the earlier accepted-task-only hypothesis
  was too narrow. Its cause remains unproven and is separate from the reproduced metadata-overwrite defect.
- `scripted-after-1221` passed the new full workflow on actual VS Code 1.122.1. Same-task follow-up completed at 23
  requests, five completed turns, and 18 matched tool calls/results with no trace errors. Its captured idle state also
  passed the rendered chat replay.
- `live-after-02` passed with the rebuilt extension and the same Copilot model/effort on actual VS Code 1.136.1.
  Its 35,015 ms idle window stayed at 17 requests. Same-task feedback completed at 19 requests, four completed turns,
  and 24 matched tool calls/results with no trace errors. The host exited normally, ownership was verified, and capture
  completed. All 138 affected webview tests passed with this fresh capture, including no stalled warning and an idle
  composer. This is one successful post-fix live acceptance run, not a claim that the intermittent admission issue is fixed.
- The full `test:smoke:1221` gate passed (three extension checks, two mode checks, four VS Code LM checks).
- The affected webview files passed all 138 tests with the original live capture, including both new deterministic
  regressions and the live replay. The harness unit suite passed 343 tests, with two skipped and no failures.
- Both touched packages passed lint and typechecking. The extension/webview bundle built successfully.
