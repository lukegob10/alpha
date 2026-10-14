# Ticket search in the chat composer

The Alpha Tickets mention picker now reuses unchanged search records instead of parsing the entire Markdown collection
for every query. Markdown remains authoritative for reads, attachments, tools, and editor mutations. This optimization
belongs to Alpha's native ticket feature; it changes neither agent execution nor ticket status propagation.

## Behavior and ownership

- `TicketStore.search()` owns the suggestion index. `TicketChat` routes the existing validated search request to it.
- Search still covers reference, title, description, and context. Full references retain exact matching, including spoken
  spacing and omitted hyphens. Title equality, reference/title prefixes, and title word matches rank before content-only
  matches. Status, update date, and UUID break ties; empty queries retain the existing status ordering.
- Every inspection checks storage ancestors, pending moves, status directories, and file metadata. A record is reusable
  only when device, inode, size, mode, modification time, and change time agree. Moves, deletions, corruption, replacements,
  and external edits therefore invalidate the affected suggestion. Invalid records remain omitted as in `list()`.
- Reads run in batches of at most 16. Concurrent queries share the refresh for their project. Reader cancellation detaches
  that reader; shared inspection can settle for the remaining readers. Editor transactions invalidate in-flight refreshes
  before and after mutation, and an older refresh cannot republish records into a newer generation.
- The process retains at most four project indexes, each capped at 10,000 records and 16 MiB of estimated search text and
  metadata. Collections beyond either bound remain searchable, but uncached records require rereading. No watcher or
  persistent index is added, and the response remains capped at 50 suggestions.
- The composer sends empty-picker and complete-reference queries immediately. Title typing debounces for 100 ms instead
  of 200 ms. Existing request correlation, workspace checks, cleanup, failure states, and keyboard insertion are retained.

Filesystem metadata contracts were checked against [Node.js 24.21.0 documentation](https://nodejs.org/docs/latest-v24.x/api/fs.html#class-fsstats)
on 2026-10-13, including `lstat`, `bigint: true`, `mtimeNs`, and `ctimeNs`. Webview response cleanup was checked against the
[React useEffect documentation](https://react.dev/reference/react/useEffect#fetching-data-with-effects) on the same date.
The implementation uses no new VS Code API, contribution, dependency, or persisted format.

## Reproducible measurement

The opt-in Vitest workload writes 1,000 deterministic backlog tickets, each with about 7 KiB of Markdown, to a temporary
profile. It then searches `""`, `"backend"`, `"backend cleanup"`, `"PRO-500"`, and `"missing ticket"` in that order. The first
query has a cold process index; subsequent queries use a warm index. Fixture generation is excluded from the timer. Both
measurements use the same Windows machine, Node 24.21.0, pnpm 11.24.0, filesystem-warm fixture, and five-query sequence.
These are local scripted measurements, with one sample per query and no model or network calls.

PowerShell:

```powershell
$env:ALPHA_TICKET_SEARCH_BENCHMARK = '1'
pnpm --dir src test services/tickets/__tests__/TicketStore.search.spec.ts --no-silent
```

For POSIX shells, prefix that pnpm command with `ALPHA_TICKET_SEARCH_BENCHMARK=1`.

| Query           | Before: `list()` (ms) | After: `search()` (ms) |
| --------------- | --------------------: | ---------------------: |
| Open picker     |                2287.7 |                  786.1 |
| backend         |                2211.9 |                   83.6 |
| backend cleanup |                2208.5 |                   52.2 |
| PRO-500         |                2203.7 |                   50.3 |
| missing ticket  |                2157.3 |                   54.1 |

Markdown reads across the five queries fell from 5,000 to 1,000. Steady-state lookup still performs directory and file
metadata inspection, so latency remains dependent on collection size and filesystem performance. This benchmark measures
host lookup time; it excludes the composer debounce, webview transport, and rendering, and is not a general live latency
claim. Correctness tests enforce zero Markdown rereads for unchanged queries and one reread for an edited record instead
of a machine-dependent timing threshold.

## Validation

Validated on 2026-10-13 with focused search regressions, the ticket service/tool tests, composer and mention tests,
extension/webview typechecks, touched-file ESLint/Prettier checks, and the exact-host smoke gate:

```sh
pnpm --dir src test services/tickets core/tools/__tests__/TicketTools.spec.ts
pnpm --dir webview-ui test src/components/chat/hooks/__tests__/useTicketSearch.spec.ts src/components/chat/__tests__/ChatTextArea.spec.tsx src/utils/__tests__/context-mentions.spec.ts
pnpm --dir src check-types
pnpm --dir webview-ui check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```

The smoke gate built the extension and webview and passed using isolated VS Code 1.125.0 extension-test profiles with
scripted providers and the VS Code LM fixture. No live-model performance measurement was used.
