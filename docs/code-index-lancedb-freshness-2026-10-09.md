# LanceDB indexing responsiveness implementation

## Scope and evidence

Keep LanceDB as the local store, Vertex as the selected embedding provider, and the existing source/chunk/model identity.
This iteration improves saved-edit retrieval, bounded batching, and request scheduling. It does not require Qdrant or a
new service. Existing indexes remain readable without a representation migration.

Reference inspected October 9, 2026: Codex CLI `36ae1561b9324c93d5638b45eb19fe2cc070a581`,
[file search](https://github.com/openai/codex/blob/36ae1561b9324c93d5638b45eb19fe2cc070a581/codex-rs/file-search/src/lib.rs)
and [file watcher](https://github.com/openai/codex/blob/36ae1561b9324c93d5638b45eb19fe2cc070a581/codex-rs/file-watcher/src/lib.rs),
with their README/tests.
Codex's inspected local file search uses ignore-aware traversal and fuzzy matching; its debouncer caps collection from
the first event. Alpha keeps semantic retrieval as an additional capability. Its embedding-specific quiet window differs
intentionally, with a fixed upper bound so continuous saves cannot postpone work indefinitely.

Research supporting the design:

- [Cursor's local search](https://cursor.com/blog/fast-regex-search) layers current user/agent changes over a base index.
- [Cursor indexing](https://cursor.com/blog/secure-codebase-indexing) reuses unchanged embedding inputs after rechunking.
- [Triton batching](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/user_guide/batcher.html)
  provides precedent for bounded wait, bounded queues, and priority admission, rather than unlimited concurrency.
- [LanceDB query projection](https://lancedb.com/documentation/js/classes/QueryBase/) recommends selecting needed columns.
- [Controlled chunking research](https://arxiv.org/abs/2605.04763) does not support blindly increasing chunk size or
  assuming whole functions outperform token-bounded syntax-aware chunks.

Vertex `gemini-embedding-2` accepts one embedding input per native request. Grouping files does not turn those requests
into one quota charge. Keep distinct chunks and model task roles; share start spacing and 429 cooldowns across lanes.
Published quotas do not establish this user's account allowance.

## Implementation plan and contracts

1. Search recent saved changes from the watcher's pending/processing/failed paths, capped at 64 files per query.
   Re-read and rechunk current accessible source through the existing parser. Merge candidates into lexical retrieval
   and retain exact source/hash, scope, ignore, size, symlink, token, and duplicate checks. Validate source before
   returning snippets. Retain the active batch snapshot so files awaiting a bounded worker remain visible to search.
   Initial scanning can continue while this local path supplies recent edits; unsaved editor buffers are outside scope.
2. Once a channel supplies candidates, bound remaining retrieval waiting to 1.5 seconds from query start. Allow up to
   eight seconds when no channel has candidates, preserving a useful opportunity for semantic-only questions. Abort
   the query embedding and observe late settlements. Keep partial fresh candidates if later files exceed the deadline.
   Return available validated local matches, with optional diagnostics identifying timeout/error and fresh candidates. An
   incremental embedding error must not globally prevent searching healthy indexed files or current pending changes.
   If a channel fails and no validated evidence remains, return that failure rather than a successful no-match answer.
3. Collect filesystem saves until 500 ms of quiet, capped at 2 seconds from the first pending event. Coalesce repeated
   paths, cancel superseded work, and apply the same window to events arriving during processing. This follows save
   timing, not model-turn completion. Full reconciliation still serializes against watcher writes for integrity.
4. Extend the shared provider request boundary with bounded priority admission: query, incremental, bulk. Bound both
   admission and pacing queues at 256 pending requests. Reserve one search slot in pools above eight (Vertex embedding-2
   bulk uses at most 15 of 16 slots), cap incremental requests at two, preserve total provider concurrency,
   retain Gemini's two-slot bulk capacity with foreground admission at the next free slot, remove cancelled queued
   work promptly, and admit waiting bulk work fairly. Both adapters retain their native wire shapes and retry rules.
   The configured pacing and provider cooldown govern every lane; priority cannot bypass them.
5. Project only needed LanceDB search columns, retaining native FTS refresh and atomic per-file merge replacement.
   Do not remove optimization required by the installed 0.27.2 FTS behavior. Scalar/ANN changes and a persistent
   historical embedding cache require larger-store evidence and are separate follow-ups.
6. Explain the yellow indicator: embeddings are catching up; validated search and current saved-edit matches remain
   available, while semantic coverage of the newest content can lag.

## Validation and measurement

Snapshot all pre-existing dirty files before edits. Add failing regressions for cloud-blocked local search, current
pending source, quiet-window bursts, and foreground admission. Use controlled promises/fake time for races and a fixed
30-second scripted provider workload for before/after retrieval waiting. Record cold bulk and warm incremental request
counts with the existing scripted provider benchmarks, and check native LanceDB insert/update/delete/reopen behavior.
These are offline fixtures, not claims about live provider speed or retrieval accuracy.

Run focused indexing tests, affected shared/webview tests, type checks, lint, and exact VS Code 1.125.0 smoke. Live
Vertex/Copilot testing remains gated on a signed-in dedicated setup; no live requests are part of this implementation.

Evidence directory: `F:/alpha-e2e/artifacts/code-index-lancedb-freshness-20261009`.

## Recorded results

The initial regressions failed for slow-provider local retrieval, fresh pending source, and save-burst coalescing.
Further regressions demonstrated an orphaned pacing timer after cancellation from a progress callback, queue recovery
after a failed observer, and missing saved files awaiting workers in an active batch. Each now passes at its owning
boundary. Stop/Clear/service replacement cancel pending searches; late provider settlements remain observed.

| Workload                                        | Before          | After        | Conditions                                                                                   |
| ----------------------------------------------- | --------------- | ------------ | -------------------------------------------------------------------------------------------- |
| Local match with a 30-second embedding response | 30,000 ms       | 1,500 ms     | Five samples per strategy, controlled clock; retrieval waiting only                          |
| Query admission behind 100 bulk requests        | 700 ms          | 100 ms       | Five samples per strategy, 16-slot pool, 100 ms scripted requests; all 101 requests retained |
| LanceDB materialized result data                | 1,321,227 bytes | 53,981 bytes | Five native runs, 500 rows, 3,072 dimensions, 200 candidates; identical ranked IDs           |

Projection reduced serialized result data by 95.9%. Native query times varied; this does not establish a general
latency or process-memory improvement. Retrieval deadlines bound channel waiting; subsequent source validation still
performs local I/O.

The existing 1,700-chunk cold workloads remain within their original regression thresholds. Vertex embedding-001
retains eight concurrent requests; Vertex embedding-2 uses at most 15 bulk requests; both still send 1,700 native
requests. Gemini retains two concurrent batches and 29 native batch requests. Reserving a Vertex embedding-2 slot is
a responsiveness tradeoff, not a claim that cold indexing is faster. Existing warm reuse also remains intact: for a
ten-chunk file with one changed input, rechunking the whole saved file still embeds only that changed input. This reuse
predates the present iteration and does not change the semantic chunk representation.

Validation commands and logs:

- `pnpm --dir src test services/code-index core/tools/__tests__/CodebaseSearchTool.spec.ts`: 365 tests in 32 files passed,
  including native LanceDB replacement, deletion, reopen, projection, and cosine-score checks (`final-validated-tests.log`).
- Focused `CodeIndexPopover` and `CodebaseSearchResultsDisplay` webview tests: 18 passed (`final-webview.log`).
- Shared `codebase-index` schema tests: 11 passed; historical messages remain accepted (`final-shared-schema.log`).
- `pnpm check-types`: all nine tasks passed (`final-types.log`).
- `pnpm lint`: all eight tasks passed (`final-lint.log`).
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`: all 13 extension-host launches and 42 assertions passed on
  actual VS Code 1.125.0, using scripted and VS Code LM fixture providers (`exact-host-validated.log`,
  `exact-host-results.json`). The command rebuilt the extension and webview from the final production changes.

The baseline snapshot contains 111 pre-existing changed files. All 84 outside this iteration remain byte-identical.
No release version, production dependency, lockfile, or chunk/model identity migration was introduced.

## Practical limits

Fresh retrieval covers the newest 64 tracked saved paths per query, including files waiting in the current batch;
unsaved buffers are outside this contract. Full reconciliation still owns serialized writes, so watcher embeddings
wait for scanning to settle while these saved files remain locally searchable. A yellow indicator means indexing is
catching up, not that search is disabled; newest semantic coverage can lag. Partial results carry coverage diagnostics,
and callers receive an error when failed retrieval leaves no validated evidence.

Pacing and cooldown are shared within a provider instance. They do not guarantee this account's project-wide quota
across other workspaces or applications. Live Vertex latency, rate-limit behavior, and retrieval quality remain
unverified until a signed-in run is authorized and ready. Native FTS refresh remains enabled for correctness. Larger
store ANN/scalar tuning, historical embedding caching, and chunk-quality changes require separate measured workloads.
