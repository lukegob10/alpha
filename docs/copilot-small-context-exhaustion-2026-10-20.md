# Copilot small-window context exhaustion

Investigated on 2026-10-20 against the current checkout. The question is whether selecting the smaller GitHub Copilot
context window, filling it, and attempting or disabling compaction can crash Alpha or leave its panel disabled.

## Scope and result

The deterministic provider and task tests reproduce the input limit and summary rejection without reproducing an
extension crash. Claude Sonnet 4.6 is selected with `vsCodeLmContextSize: 200_000` while the live-model fixture advertises
`maxInputTokens: 936_000`. Both normal and summary requests carry `contextSize: 200_000` through `modelOptions` and the
host configuration route. The larger advertised window does not silently override the selection.

These tests use synthetic token counts and scripted responses. No runtime change was needed. The provider tests execute
the real `VsCodeLmHandler` and context manager with a mocked VS Code API. Extension-host acceptance uses the real task
engine with `fake-ai`, deriving its input window from the same Copilot window resolver. Neither is a live request to
GitHub's backend.
React component tests exercise composer availability; they do not establish that a particular GPU, webview renderer, or
remote extension host cannot fail.

## Observed boundaries

For an input-only 200,000-token window, the existing 10% safety margin places the automatic hard trigger at 180,000
tokens, even with the compaction percentage set to 100. Output tokens are not reserved again from an input-only ceiling.

| Workload                                             | Result                                                                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| About 168k tokens                                    | History stays active; a normal request completes.                                                                                                                    |
| About 185k tokens                                    | Automatic summarization reduces active history before the next request.                                                                                              |
| At the 200k ceiling                                  | Recovery reduces the input; the next request completes.                                                                                                              |
| About 220k tokens, including oversized summary input | The provider rejects the summary; bounded sliding-window truncation hides older complete steps, and the next request completes.                                      |
| Overflow with automatic summarization disabled       | No summary request is made during preflight; sliding-window truncation still runs.                                                                                   |
| Manual compaction of oversized history               | The summary fails visibly, saved history stays intact, and the manual admission guard is released. Manual compaction does not run the automatic truncation fallback. |
| A single irreducible oversized input                 | Recovery reports exhaustion and stops rather than issuing unbounded requests or deleting the input.                                                                  |
| A stalled summary followed by Stop                   | Cancellation reaches the LM request, its cancellation source is disposed, and no summary is committed.                                                               |
| Failed manual compaction completion message          | The composer becomes available again, including when request and response updates are batched.                                                                       |

Truncation is not semantic summarization: older records remain saved for rewind, but their details are absent from the
next active model request. The tests verify that the source messages remain unchanged and the archive is retained.

Turning off automatic summarization therefore does **not** mean Alpha sends an unlimited transcript. Forced recovery
after a provider context rejection also explicitly enables a summary attempt, independently of the proactive setting.

For irreducible input, the primary task reaches its visible `resume_task` boundary. The failed API request row contains
`cancelReason: "streaming_failed"` and the context error. This is an explicit wait for user recovery, not an unresolved
provider request or successful completion. Retrying unchanged oversized input can fail again; the saved input is retained.

## A provider stall can resemble a hang

An over-limit response that returns an error is different from a provider that never resolves a request or stream read.
`apiRequestTimeout` defaults to 600 seconds. Initial automatic or manual compaction can consequently show a busy panel
for up to ten minutes when the provider stalls. Setting the timeout to zero disables that deadline; an unresponsive
provider can then remain pending until Stop. Forced context recovery additionally inherits the remaining automatic retry
deadline, whose default sequence budget is 90 seconds. Existing deterministic tests cover those deadlines and Stop with
timeouts disabled. The new LM test covers Stop while the summary request itself is stuck.

Manual compaction deliberately disables sending while it is pending. A stuck provider can therefore leave the composer
grayed out during that wait. The completion notification releases the state after success or failure in the tested flows.

This is a plausible explanation for a perceived hang, not evidence that a stalled provider caused a reported gray panel.

## Ownership and upstream reference

- `packages/types/src/providers/vscode-llm.ts` resolves the configured input ceiling; `src/api/providers/vscode-lm.ts`
  forwards it and owns LM cancellation and request cleanup.
- `src/core/context-management/` owns the trigger, summary admission, and bounded truncation fallback.
- `Task` owns context preparation, atomic history replacement, exhaustion, and automatic start/finish notifications.
- `AlphaProvider.condenseTaskContext()` owns the manual finish notification in `finally`; `ChatView` uses the task-scoped
  response to clear its compaction indicator and restore composer availability.

Codex CLI was inspected at upstream commit
[`db58a987b8a0b94b81ab321f0e0192757758df67`](https://github.com/openai/codex/commit/db58a987b8a0b94b81ab321f0e0192757758df67),
retrieved on 2026-10-20 local time. In
[`compact.rs`](https://github.com/openai/codex/blob/db58a987b8a0b94b81ab321f0e0192757758df67/codex-rs/core/src/compact.rs),
summary context overflow removes the oldest input item and retries until it can proceed or no further reduction is
possible. The upstream
[`manual_compact_retries_after_context_window_error` test](https://github.com/openai/codex/blob/db58a987b8a0b94b81ab321f0e0192757758df67/codex-rs/core/tests/suite/compact.rs#L4367)
asserts that reduction. Alpha's existing behavior differs: automatic recovery falls back to hiding complete steps, and
manual summary failure leaves history unchanged and reports an error. This investigation preserves that behavior;
matching CLI's summary-input retry strategy would be a separate contract change.

The [VS Code Language Model API guide](https://code.visualstudio.com/api/extension-guides/ai/language-model), retrieved on
2026-10-20, requires handling errors both at request admission and while reading the stream. A provider rejection alone
does not establish an extension-host or webview-process crash.

## Reproduction and validation

The **18 new cases** are in `vscode-lm.spec.ts` (eight cases), `Task.compaction-safety.spec.ts` (five cases), `ChatView.spec.tsx`
(two cases), and `compaction-acceptance.test.ts` (three exact-host cases). The host fixture grows a real task through two
large completed answers, crosses the selected 200k input ceiling, rejects summary input when enabled, and verifies
completed lifecycle state, inactive streaming flags, archived answers, and a subsequent same-task prompt.
The third case verifies irreducible input reaches visible recovery and that a fresh short task can then complete.

```sh
pnpm --dir src test api/providers/__tests__/vscode-lm.spec.ts --testNamePattern="small Copilot context exhaustion"
pnpm --dir src test core/task/__tests__/Task.compaction-safety.spec.ts --testNamePattern="small Copilot context exhaustion"
pnpm --dir webview-ui test src/components/chat/__tests__/ChatView.spec.tsx --testNamePattern="failed manual summary"
pnpm --filter @alpha-code/vscode-e2e compile
pnpm --dir apps/vscode-e2e exec node ./out/runTest.js --vscode-version 1.138.0 --provider scripted --require-all-tests --file compaction-acceptance.test --grep "200k"
```

Verified checks:

- The affected extension unit selection passed **327 tests**, including provider, task, context-policy, error-classification,
  and manual-notification coverage. The complete ChatView file passed **227 tests**.
- The complete compaction acceptance file passed **six tests** on exact VS Code **1.138.0**, including all three new host
  cases, in isolated temporary profiles with model ID `small-copilot-window-exhaustion-scripted`. The successful final run
  receipt is `091ac4ef-fd3e-441a-b5e9-3390edf845ec`; all six selected tests executed with no skips.
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1380` passed, including context recovery, VS Code LM streaming,
  cancellation, reload, and command lifecycle checks.
- `pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250` passed **19 tests** on exact VS Code **1.125.0** with no
  skips, including the real VS Code LM fixture contract.
- Extension, webview, and E2E typechecks passed. ESLint on the touched test files, Prettier checks, and `git diff --check`
  passed.
