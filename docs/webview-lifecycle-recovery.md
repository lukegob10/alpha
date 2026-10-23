# Webview lifecycle recovery

Reviewed 2026-10-22 in correctness cleanup mode, with ten focused agent investigations.
The target is to keep a replacement webview responsive and release compaction controls on every outcome.

## Confirmed causes and ownership

- **High, must-fix:** Initial `webviewDidLaunch` messages waited behind long-running global commands such as manual
  compaction. A recreated React tree renders nothing until its first state arrives. Bootstrap now uses the existing
  immediate, tracked operation lane.
- **High, must-fix:** Compaction searched the presenting provider's local task stack. A task owned by another view is
  available through the shared session registry instead. A missing task also threw before notifying the composer to
  clear its busy state. Lookup now uses the registry inside the existing completion `finally`.
- **High, must-fix:** Webview subscriptions and disposal callbacks could outlive their view. Replacement cleanup,
  initialization, and readiness must stay bound to the originating view, including disposal while HTML is loading.

The fixes belong in the extension's webview adapter. Task execution, policy, transcripts, and persisted/wire schemas
retain their existing owners. Cross-view compaction executes through the original task, acknowledges the requesting
view, and cannot look up a task in a different storage host.

## Primary sources

Codex CLI source was retrieved at commit `eca79b000c48bace74eaef474ec4c5d1ae5ba34a` on 2026-10-22. Its
[compaction state](https://github.com/openai/codex/blob/eca79b000c48bace74eaef474ec4c5d1ae5ba34a/codex-rs/tui/src/chatwidget/compaction.rs)
is distinct from turn state. Its
[compaction tests](https://github.com/openai/codex/blob/eca79b000c48bace74eaef474ec4c5d1ae5ba34a/codex-rs/tui/src/chatwidget/tests/compaction_tests.rs)
require compaction status to clear after start rejection or terminal completion, interruption, or failure.
Alpha keeps that cleanup invariant using its existing response message and shared TypeScript task registry.
Multiple VS Code views require view-scoped subscription ownership; no Codex runtime or prompt is introduced.

The VS Code extension-host webview implementation was checked at exact
[1.125.0](https://github.com/microsoft/vscode/blob/1.125.0/src/vs/workbench/api/common/extHostWebviewView.ts) and
[1.138.0](https://github.com/microsoft/vscode/blob/1.138.0/src/vs/workbench/api/common/extHostWebviewView.ts).
Both await the provider's resolution independently from disposal and fire `onDidDispose` before destroying the
webview. Disposal therefore needs registration before awaiting HTML. No newer API is required.

## Scope and validation

The ten investigations covered composer state, session disposal, lifecycle projection, cancellation/retry, render
crashes, reload/persistence, overlays/theme, replacement races, shared compaction ownership, and implementation simplicity.
No additional reproducible lifecycle defect was established in the other reviewed paths during this first pass.

Regressions use held promises and retained old callbacks to exercise blocked bootstrap, cross-view compaction,
missing tasks, and replaced/disposed views. The initial compaction/bootstrap tests failed for the intended causes
before their fixes. Validation uses Windows x64, Node 24.21.0, and pnpm 11.24.0:

| Check                                                                                          | Result                                        |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Eight focused extension suites: provider/dispatch, compaction, shared ownership, handler, HTML | 408 passed; 7 existing skips                  |
| Four focused chat and lifecycle webview suites                                                 | 310 passed                                    |
| `pnpm --dir src check-types` and `pnpm --dir webview-ui check-types`                           | Passed                                        |
| ESLint and Prettier for touched files; `git diff --check`                                      | Passed                                        |
| `pnpm --filter @alpha-code/vscode-e2e test:smoke:1380`                                         | 13 suites, 47 passed; exact 1.138.0, no skips |
| `pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250`                                 | 4 suites, 19 passed; exact 1.125.0, no skips  |

Structural verdict: Good. The fixes reuse existing operation lanes, task lookup, and disposables with explicit view
ownership. They correct the causes without adding a second state store, recovery loop, or timer-based retry.
The user's original gray-panel incident still needs confirmation against the updated extension; these regressions
establish the specific failure paths described above.

## Second investigation: the entire panel disappears during long runs

The user clarified that the toolbar also disappears, while the task continues and a developer refresh shows the
completed work. Ten further investigations covered automatic compaction, production hydration order, actual rendered
rows, hidden/revealed views, lifecycle transport, rich content, local diagnostics, installed logs, asset loading, and
integration simplicity. This symptom is consistent with a renderer failure or resource pressure, but no actual blank
panel, renderer crash, or out-of-memory event was reproduced. Compaction is a correlated transition, not an established
crash cause. The automatic and overflow compaction paths already pair their start/completion messages in `finally`.

Three resource defects were reproduced and corrected at their existing owning layers:

1. **Live transcript mounting was unbounded.** `App` mounts `ChatView` after hydration with the selected task already
   present. The old transcript hook retained its original start index as new rows arrived, so the 80-row initial window
   grew for the rest of the task. Existing tests mounted the chat before hydration and mocked real rows. The hook now
   uses the existing scroll controller: following output renders the newest 80 rows; browsing, explicit history loading,
   and checkpoint navigation retain their anchors. Returning to the bottom restores the bound. Full history remains
   accessible and original row keys are preserved.
2. **Lifecycle transport grew quadratically.** Every lifecycle event sent the accumulated canonical snapshot with its
   response items and JSON replay fingerprints, then sent it again in state. Compaction of provider context does not
   clear that journal. The extension now publishes its existing `LiveTaskMetadata` projection with optional `turnId`
   and `hasPendingToolCalls` fields. Canonical journals, replay, tool transactions, and public lifecycle readers remain
   intact. Legacy wire readers remain supported; compact host metadata supersedes delayed legacy snapshots, including
   degraded projection. Lifecycle publication does not await unrelated managed-agent startup/tree projection.
   A slow tree projection captures fresh metadata and its sequence at delivery. If a full refresh's independently
   built tree is superseded by a faster lifecycle update, the same view publishes one fresh local tree projection.
   All three full-refresh variants retain their original transcript, queue, and todo fences; navigation suppresses
   follow-up publication to a replacement task.
3. **Final code fences had no highlighting budget.** Shiki could synchronously expand a large fence into hundreds of
   thousands of syntax nodes. Fences over 100,000 characters or 1,000 lines now remain complete plain text, including
   after streaming ends. Copy retains the full original source; smaller fences still receive highlighting.

These changes reuse the transcript hook, scroll controller, task registry, state envelope, and code block fallback.
They introduce no recovery loop, reload timer, alternate task engine, or transcript truncation.

### Deterministic measurements

The real browser regression runs the built extension and real chat rows in an isolated **VS Code 1.138.0** profile,
with the `transcript-lifecycle-ui` scripted model and no live model requests. It restores a selected 1,200-row task,
appends 320 rows in each of three turn/compaction cycles, appends another 320 while hidden, reveals the view, and checks
history browsing during another 40-row append. Controlled provider and summarizer promises establish stage boundaries.

Before the fix, following output grew from **80 to 1,369 mounted rows**, and renderer DOM counters grew from **7,282 to
50,584 nodes** after the third compaction. Heap samples grew from **64.00 to 143.10 MiB** at those two stages. The old
implementation fails the new bounded-row assertion. The saved baseline is
`artifacts/transcript-lifecycle-ui/before-b356d9c8-d541-4b03-abb2-7ad0798cfd7d.json`. DOM counters may include detached
nodes before collection; heap samples do not establish retained memory or a general performance guarantee.

The fixed build passed the same workload. All 14 visible following samples mounted exactly 80 rows with zero bottom
gap. At the same final `transcript-compacted-three` stage, both runs had 2,491 total rows:

| Metric               | Before       | After       |
| -------------------- | ------------ | ----------- |
| Mounted rows         | 1,369        | 80          |
| Renderer DOM counter | 50,584 nodes | 7,525 nodes |
| Heap point sample    | 143.10 MiB   | 65.93 MiB   |

Loading older history expanded the fixed window from 180 to 220 rows during 40 appends while preserving its first
index. Both runs reported zero renderer fatal events. The passing host receipt, stages, acknowledgements, and metrics
are preserved in `artifacts/transcript-lifecycle-ui/after-final-f24ab891-453b-484b-b005-87017eef1acf.json`. An earlier
fixed-build pass is also retained as `after-d65ec9fd-1b24-4486-84a6-f713c01d4414.json`. The table compares the baseline
with the final rebuilt source on the same deterministic workload, not a retained-memory guarantee or reproduction of
the blank panel.

Run the same workload with:

```sh
pnpm --filter @alpha-code/vscode-e2e test:transcript-lifecycle-ui:1380
```

The offline wire benchmark uses Node **24.21.0**, schema-valid 8,000-character text items, the same growing journal,
and one compact task metadata publication per event. Counts exclude old settings/metadata for a conservative baseline.
This measures serialized envelope sizes, not actual browser memory or end-to-end task latency:

| Events | Final canonical snapshot | Previous cumulative lifecycle wire | Compact cumulative lifecycle wire |
| ------ | ------------------------ | ---------------------------------- | --------------------------------- |
| 100    | 1,635,684 bytes          | 166,056,070 bytes                  | 52,792 bytes                      |
| 500    | 8,180,484 bytes          | 4,102,409,270 bytes                | 264,392 bytes                     |
| 1,000  | 16,361,492 bytes         | 16,385,750,790 bytes               | 528,893 bytes                     |

```sh
pnpm exec tsx scripts/benchmarks/webview-lifecycle-transport.ts
```

### Evidence on the next failure

The previous error-boundary telemetry client is a no-op and global handlers only printed to the renderer console.
React errors, unhandled rejections, runtime errors, and resource failures now send a strict, bounded local diagnostic
to the existing Alpha output log under `[webviewError]`, ahead of the global command queue. Reports include only fixed
categories, bounded numeric locations, visibility, hashed task identity, message counts, and validated activity phase.
They exclude exception text, stacks, resource URLs, prompts, and raw task IDs. Both sides deduplicate and cap reports
at ten per document/attached view, and App disposes its global listeners. The error boundary reports synchronously
before optional source-map loading. A killed renderer or failed initial entry bundle cannot report through JavaScript;
absence of this entry does not rule those failures out.

### Reference behavior and remaining uncertainty

Codex source was rechecked at commit `f3a90545aed3188ee1e5c119ec89a742de399cdc`, retrieved 2026-10-22 America/New_York
(2026-10-23 UTC). Its
[compaction tests](https://github.com/openai/codex/blob/f3a90545aed3188ee1e5c119ec89a742de399cdc/codex-rs/tui/src/chatwidget/tests/compaction_tests.rs)
continue to separate compaction status from turn timing and terminal cleanup. Alpha preserves that behavior through its
existing TypeScript lifecycle projection. A bounded DOM window is an intentional VS Code renderer adaptation.

Primary browser contracts were checked on the same retrieval date:
[Chrome memory guidance](https://developer.chrome.com/docs/devtools/memory-problems) distinguishes JavaScript heap from
DOM memory and describes progressive resource pressure; [React lazy](https://react.dev/reference/react/lazy) sends rejected
lazy imports to the nearest error boundary. VS Code's public webview API in the supported host versions exposes no
renderer-process crash event. No proposed API or automatic reload was added.

The measured growth paths explain why long sessions are riskier and a refresh can restore a smaller, healthy UI while
backend work survives. Establishing which failure caused the reported incident still requires a failing live-session
receipt or local diagnostic. Do not describe the controlled growth reproduction as a reproduced renderer crash.

### Second-pass validation

Focused regressions fail before the corresponding fixes: production-order transcript growth, oversized final code
highlighting, compact host pending tools/turn controls, managed-agent startup blocking, and delayed tree publication
ordering. Tests use controlled promises or fake clocks rather than arbitrary sleeps. Validation uses Windows x64,
Node 24.21.0 and pnpm 11.24.0; browser and extension-host fixtures make no live model requests.

Host scenarios assert visible completion through compact metadata and inspect terminal events, tool transactions, and
response items through the existing canonical snapshot reader. This updates their former dependency on full journals
inside UI state without relaxing lifecycle assertions. Scenario evidence retains its existing snapshot shape by reading
the host directly; a regression fixture supplies compact UI state and a separate canonical snapshot.

| Check                                                                                                                | Result                       |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| ChatView, scroll integration, CodeBlock, and both scroll/transcript hooks                                            | 279 passed                   |
| Compact transport, provider, task navigation after the final full-refresh ordering correction                        | 188 passed; 6 existing skips |
| Compaction safety/cost, cancellation after EOF, turn engine, lifecycle projection, shared compaction, view ownership | 256 passed                   |
| Legacy/compact ownership, extension state merge, and follow-up lifecycle projection                                  | 82 passed                    |
| Diagnostic schema, renderer reporting/error boundary/App, and host admission                                         | 65 passed                    |
| Extension, webview, and shared types typechecks                                                                      | Passed                       |

The earlier 673-test shared-types suite also passed. These command groups overlap and their counts must not be added
to claim a unique total.

- `pnpm --filter @alpha-code/vscode-e2e test:transcript-lifecycle-ui:1380`: built extension and real Chromium UI passed;
  1/1 exact-host test, no skips.
- Compiled CDP transport and rendered-probe runner unit tests: 17 passed, no skips.
- Scenario evidence-capture unit tests: 29 passed. Four scripted exact-1.138.0 scenarios (core loop, error/cancellation
  boundaries, completed-thread quiet window/follow-up, command artifacts): 11 passed, no skips.
- The artifact fixture's stale synthetic Plan-wrapper expectation was aligned with the existing provider-authored text
  contract; all terminal/tool assertions remain. The existing Plan handoff contract suite passed 16 tests.
- Final `pnpm --filter @alpha-code/vscode-e2e test:smoke:1380`: **47 passed across 13 suites**, exact 1.138.0, no skips.
  This includes full-200k-window compaction, overflow recovery, VS Code LM ordering/cancellation, and background commands.
- Final `pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250`: **blocked before extension startup; zero tests
  executed**. The official 1.125.0 host waited 30 seconds for Windows' `vscode-updating` mutex, then exited with
  `Code is currently being updated`. Read-only inspection confirmed active VS Code installer processes. The cached
  host and product were verified as exact 1.125.0; no passing minimum-host result is claimed for the final changes.
- E2E typecheck, touched-file ESLint/Prettier, and scoped whitespace checks passed. Existing unrelated changes and
  line endings were preserved; no dependency or release-version change was made.

Final exact-host receipts and the minimum-host startup limitation are preserved in
`artifacts/transcript-lifecycle-ui/exact-host-gates-final.json`. Additional scripted scenario receipts are in
`artifacts/transcript-lifecycle-ui/final-focused-hosts-summary.json`.

The minimum host's
[official startup guard](https://github.com/microsoft/vscode/blob/93cfdd489c3b228840d0f86ec77c3636277c93ea/src/vs/code/electron-main/main.ts#L480)
and exact downloaded source were inspected on 2026-10-22 America/New_York. This guard has no CLI/environment bypass;
the existing test launch's `--disable-updates` flag does not bypass an already active installer. The remaining gate can
run with the normal command once the updater releases the mutex.
