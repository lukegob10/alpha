# Copilot empty-response recovery

Investigated on 2026-09-11 from screenshots of Alpha 2.1.31, provider `vscode-lm`, model
`copilot/gpt-5.6-sol/gpt-5.6-sol/gpt-5.6-sol`. The original transcript, host version, request duration, and provider
diagnostics were unavailable. The reported failure was `Response contained no choices.`; a manual Continue succeeded.
This does not establish a timeout, context exhaustion, or the original upstream cause.

## Finding

The error text comes from Copilot rather than Alpha. Microsoft's
[chat fetcher](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompt/node/chatMLFetcher.ts)
returns this fallback when it cannot produce a successful completion or a more specific terminal result. Source retrieved
2026-09-11. The [Language Model API guide](https://code.visualstudio.com/api/extension-guides/ai/language-model) requires
handling failures both at request admission and while consuming the response stream.

Alpha previously forwarded this error without retry classification. Its main task loop asked for manual recovery on
first-chunk failures when tool auto-approval was disabled. A deterministic regression reproduced that pause. The
screenshots alone cannot tell whether this was the original user's approval configuration or whether another retry
limit was reached.

## Recovery contract

- The VS Code LM adapter recognizes only the exact no-choices error from request admission/streaming, with no error code
  or the `Unknown` code. It preserves the original error as the cause and supplies the existing `empty-response` category.
- Explicit non-retryable errors and other coded errors, including permission, filtering, and unavailable-model errors,
  retain their existing behavior. Cancellation takes precedence over normalization.
- The shared task loop can automatically recover explicitly retryable failures before semantic output even when tool
  auto-approval is disabled. Model-request recovery does not grant permission to execute tools.
- The existing policy allows two attempts total for empty responses and retains its 90-second elapsed budget. It does
  not retry partial text, reasoning, or tool calls. Repeated failures remain visible with the existing recovery boundary.
- The adapter does not implement its own retry loop. Existing task history, context recovery, request cancellation,
  lifecycle projection, and tool-result persistence remain owned by the shared execution path.

## Reproduction and validation

The new provider/task tests fail before the fix: no-choices errors lacked classification and the first attempt asked for
Continue instead of recovering. Coverage includes admission and stream errors, partial output, coded/non-retryable
errors, both auto-approval settings, and bounded repeated failure.

The exact VS Code 1.122.1 fixture adds the same error followed by a healthy response. It checks recovery with tool
auto-approval disabled, no failed-request ask, exactly two requests, unchanged request messages, and task completion.

`vscode-lm-empty-recovery.test.ts` is an opt-in live Copilot test. It uses the dedicated authenticated profile, a disposable
workspace, a six-request cap, and a three-minute deadline. The existing live-response fault controller first observes a
real provider part, then injects the exact error. A second real request must complete the task without a Continue action.
This is controlled fault injection over live Copilot, not proof of a naturally reproduced upstream failure. The test
records its model, actual host version, injection status, and request count in `empty-response-recovery.json`.

Run the focused checks and exact-host gate:

```sh
pnpm --dir src test -- api/providers/__tests__/vscode-lm.spec.ts api/transform/__tests__/vscode-lm-format.spec.ts core/task/__tests__/Task.spec.ts core/task/__tests__/Task.retry-wire.spec.ts core/agent/__tests__/AgentRetryPolicy.spec.ts
pnpm --dir src check-types
pnpm --dir src lint
pnpm --dir apps/vscode-e2e compile
pnpm --dir apps/vscode-e2e lint
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

Live execution uses the existing `runTest.js --provider live-copilot` runner with the three owned path arguments, an exact
discovered model ID, and `--file vscode-lm-empty-recovery.test`. See [live test profiles](vscode-live-test-profiles.md).
No credentials are copied or inspected. The release compatibility baseline remains VS Code 1.122.1.

### Observed results, 2026-09-11

- All 368 tests across the five focused provider/transform/task/retry files passed. Four older request tests needed their
  system-prompt setup stubbed so that their cancellation/countdown assertions reached the mocked provider instead of
  waiting on unrelated MCP prompt initialization.
- Extension typecheck and lint passed. E2E compile/lint and 21 focused harness tests passed.
- The full `test:smoke:1221` gate passed all 10 tests, including the new no-choices recovery test. Gate log:
  `%TEMP%/alpha-no-choices-smoke-1221.log`.
- Live run `no-choices-sol-1361-01` was blocked at preflight: this test account's catalog did not offer `gpt-5.6-sol`.
  No Sol model request was made; this is not evidence about the original reporter's access.
- Live run `no-choices-luna-1361-01` passed on actual VS Code 1.136.1 with Copilot `gpt-5.6-luna`, High effort. The injected
  failure observed one real provider part, and exactly two requests completed the task with auto-approval disabled and
  no manual provider recovery. The owned host exited successfully and evidence capture completed.

Live receipts remain under `F:/alpha-vscode-e2e-runs/no-choices-20260911/artifacts/`, in each named run directory. The
successful run's `empty-response-recovery.json` contains the two-request assertion; `run-result.json` and
`host-completion.json` record the actual host outcome. The original upstream failure was not naturally reproduced.
