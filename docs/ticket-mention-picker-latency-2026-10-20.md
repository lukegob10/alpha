# Alpha ticket mention picker latency

Investigated October 20, 2026, on Windows with Node 24.21.0 and pnpm 11.24.0.

## Scope and reproduction

The reported delay occurs when attaching an Alpha ticket through the chat `@` picker. Opening the ticket area and reading
an already selected ticket are fast. This change targets picker request dispatch rather than ticket storage or tools.

`ChatTextArea` can start both a ticket lookup and a debounced file lookup while resolving a short mention. Previously,
`AlphaProvider.setWebviewMessageListener` appended both `searchTickets` and `searchFiles` to `webviewMessageQueue`, alongside
global commands. A running file search or other slow command therefore prevented ticket lookup from starting. Superseded
ticket queries also accumulated in that queue, even after the picker stopped listening for their responses.

`useTicketSearch` sends empty queries and ticket references with a zero-delay timer and debounces titles by 50 ms. Its
15-second response deadline can expire while a lookup is still waiting for the command queue. Existing correlation and
project checks correctly reject obsolete replies, but do not remove queued work.

## Measurements

The dispatch experiment used five independent provider dispatchers, each with an earlier file request held for 10,000 ms
and an instantaneous ticket handler. The harness extracted the actual listener method from the original and modified
`AlphaProvider.ts`; the modified method used the real request schema and `enqueueTicketSearch` helper. Both versions used
the same retained harness and workload. This measures request admission, not complete picker rendering or user-observed
latency.

| Version                  | Five admission times, ms                              | Median, ms |
| ------------------------ | ----------------------------------------------------- | ---------- |
| Original                 | 10009.966, 10009.986, 10010.007, 10010.186, 10010.529 | 10010.007  |
| Isolated ticket dispatch | 0.085, 0.100, 0.109, 0.500, 1.149                     | 0.109      |

A separate real one-ticket storage fixture made ten `forWorkspace` + `search` requests: 34.6 ms cold and 11.2–15.0 ms warm
(nine warm queries, median 13.5 ms). Warm requests performed two `realpath` and 56 `lstat` calls, with no Markdown reads.
The existing 1,000-ticket fixture measured 936.4 ms cold and 7.1–9.9 ms for subsequent queries, with exactly 1,000 Markdown
reads across five queries. These local fixtures support queueing as the dominant reproduced cause; they do not establish
a universal end-to-end latency guarantee.

## Change and invariants

- Dispatch read-only ticket searches independently of the global command queue. Keep mutations and other existing command
  ordering unchanged.
- Capture the task and project when receiving the request, including a draft's project, so a queued lookup cannot follow
  a later focus or workspace change.
- Allow one active reader and only the latest pending query per conversation. Abort superseded readers and settle dropped
  requests without executing them. Limit a provider to eight concurrent conversation search lanes; return a correlated
  lookup error immediately if the limit is reached.
- Carry cancellation through workspace resolution and ticket search. Check it again before posting a result, including
  when a reader completes after cancellation.
- Cancel active readers and discard pending queries when the webview is cleared or its provider is disposed. Shared ticket
  indexing retains its existing ownership and cancellation rules.

Ticket schemas, saved data, project identities, security/path checks, migration barriers, ranking, file search behavior,
and the picker UI contract are preserved. The ticket editor and selected-ticket attachment path use their existing store.

## Reference behavior

Current Codex CLI source was inspected at commit `d571eaf1f61d0d93a797506335a99a9950ffe37b`, retrieved October 20, 2026
(local date). Its [mention search manager](https://github.com/openai/codex/blob/d571eaf1f61d0d93a797506335a99a9950ffe37b/codex-rs/tui/src/file_search.rs)
updates asynchronous searches as queries change and scopes sessions to their search root. Its
[search tests](https://github.com/openai/codex/blob/d571eaf1f61d0d93a797506335a99a9950ffe37b/codex-rs/file-search/src/lib.rs#L823-L871)
exercise incremental results and query updates; its
[app-server reporting](https://github.com/openai/codex/blob/d571eaf1f61d0d93a797506335a99a9950ffe37b/codex-rs/app-server/src/fuzzy_file_search.rs#L172-L202)
filters obsolete query snapshots.

Alpha tickets have no exact upstream equivalent. Alpha intentionally retains its native TypeScript ticket store and
webview request protocol. This patch follows the applicable independent-search and obsolete-query behavior with bounded
per-conversation dispatch; it does not introduce a second runtime or copy upstream implementation code.

## Regression and benchmark commands

The provider regression was added before the production change: all seven original cases failed on the old dispatcher,
covering blocked admission, stale queued queries, conversation isolation, captured task scope, and disposal. Expanded
coverage also checks cancellation signals, draft scope, and overload errors. Routing and chat-service tests cover late
cancellation and retained project isolation. Existing hook/composer tests exercise response correlation and selection.

```powershell
pnpm --dir src test core/webview/__tests__/AlphaProvider.ticket-search.spec.ts core/webview/__tests__/webviewMessageHandler.searchTickets.spec.ts services/tickets/__tests__/TicketChat.spec.ts core/webview/__tests__/AlphaProvider.prompt-enhancement.spec.ts services/tickets/__tests__/TicketStore.cancellation.spec.ts
pnpm --dir src test core/webview/__tests__/AlphaProvider.spec.ts core/webview/__tests__/AlphaProvider.host-ownership.spec.ts core/webview/__tests__/webviewMessageHandler.searchFiles.spec.ts services/tickets/__tests__/TicketStore.search.spec.ts
pnpm --dir webview-ui test src/components/chat/hooks/__tests__/useTicketSearch.spec.ts src/components/chat/__tests__/ChatTextArea.spec.tsx
pnpm --dir src check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250
```

The focused provider regression uses controlled promises instead of timing thresholds. An opt-in benchmark in the same
file repeats the blocked-file workload on the current implementation. Its five admission samples measured
0.019–0.074 ms in a separate run; the parsed-record workload can also be repeated with its existing benchmark flag:

```powershell
$env:ALPHA_TICKET_PICKER_BENCHMARK = '1'
pnpm --dir src test core/webview/__tests__/AlphaProvider.ticket-search.spec.ts -t 'measures ticket admission behind a ten-second file search' --no-silent
Remove-Item Env:ALPHA_TICKET_PICKER_BENCHMARK
$env:ALPHA_TICKET_SEARCH_BENCHMARK = '1'
pnpm --dir src test services/tickets/__tests__/TicketStore.search.spec.ts -t 'measures a 1,000-ticket typing workload' --no-silent
Remove-Item Env:ALPHA_TICKET_SEARCH_BENCHMARK
```

## Validation results

- Focused dispatch, routing, chat, enhancement, and store-cancellation tests: 41 passed, with the opt-in benchmark skipped.
- Existing provider, ownership, file-search, and ticket-index tests: 199 passed, seven existing skips.
- Existing picker hook and composer tests: 125 passed.
- Extension type checking, focused ESLint, and touched-file Prettier checks passed.
- Exact VS Code 1.125.0 compatibility gate: 19 tests passed across all four scenarios.
- Exact VS Code 1.138.0 reference smoke scenarios: 47 tests passed across all 13 scenarios against the frozen build
  described below, with every selected test executed.

The first normal 1.138.0 gate attempt failed before Mocha while waiting for `api.isReady()`. Renderer logs recorded failed
loads of `index.js` and `index.css`; other build/test processes were active in the same checkout. Concurrent output
replacement is a possible explanation, rather than an established runtime diagnosis. After rebuilding, the exact-host
startup scenario passed against a frozen copy of the extension and its assets. All reference-host scenarios then passed
using the runner's supported `--extension-development-path` override with that same copy, retaining the script's exact
host version, provider, scenario list, and `--require-all-tests` flags.

The frozen extension bundle SHA-256 is `9e79235de7c09c313790c80918ddd1f4937593af206a1844ab614920b9d0a5ad`.

## Remaining verification

The controlled reproduction verifies that ticket admission no longer inherits another command's delay. Final display
timing in the user's running chat still requires loading this build and trying the affected project. Cold ticket index
construction can have its own cost for large projects; this patch preserves its existing behavior.
