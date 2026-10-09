# Incremental code index audit: saved edits, recovery, and embedding reuse

Started October 8, 2026; validation continued October 9. Mode: **full-surface review of the indexing subsystem**.

The reported case uses Vertex: a saved change leaves the index yellow at `Processing 0 / 1`. The intended behavior is
to capture saved changes promptly, process the latest version, retain valid chunks until replacement is ready, and
show whether work is reading, waiting for quota/provider, retrying, or committing. Stop, Clear, restart, and reload
must preserve those guarantees. This pass fixes reproducible Alpha defects; it does not establish the latency or
availability of the user's live Vertex account.

## Scope and preservation

The audit covered `src/services/code-index/`, its manager/webview/tool callers, settings/status consumers, persisted
hashes and vector payloads, provider adapters, and nearby tests. The initial inventory contained 60 TypeScript files
including tests; this change adds two production helpers and three test files. The inventory helper's generic
"frontend" classification includes backend TypeScript, so the coverage ledger below uses actual runtime ownership.

The starting revision was `f7f06c549e6ce80ac46dc441244656517d711625`. There were 82 existing modified or untracked
files from earlier work. Their exact bytes, hashes, and patch were captured before editing. Only two already-modified
files were intentionally extended: `manager.ts` and `interfaces/vector-store.ts`. Earlier search settings, retrieval,
steering, IPC, and UI changes are preserved. No dependencies, lockfiles, release versions, or index representation
versions were changed.

Local evidence is stored outside the repository at:

```text
F:\alpha-e2e\artifacts\code-index-incremental-audit-20261008
```

## Sources of truth

Codex source was inspected first. The fetched upstream revision was
`e45069d770c6d0b8984c58a6e7cbaf221ad37599`, committed October 9, 2026 at 03:42:19 UTC.

- [Codex file watcher](https://github.com/openai/codex/blob/e45069d770c6d0b8984c58a6e7cbaf221ad37599/codex-rs/file-watcher/src/lib.rs)
  coalesces paths and uses a fixed debounce window after the first event. Later events do not indefinitely restart
  that window.
- [Watcher tests](https://github.com/openai/codex/blob/e45069d770c6d0b8984c58a6e7cbaf221ad37599/codex-rs/file-watcher/src/file_watcher_tests.rs)
  cover coalescing and shutdown behavior.
- [File search snapshot](https://github.com/openai/codex/blob/e45069d770c6d0b8984c58a6e7cbaf221ad37599/codex-rs/file-search/src/snapshot.rs)
  guards against presenting results for an old query as a new query's results.

Intentional divergence: Codex's filename search is not Alpha's semantic embedding index. Alpha retains its native
TypeScript scanner, VS Code watcher, parser, provider adapters, and stores. Alignment here concerns bounded event
coalescing and retiring stale work; no Rust runtime or Codex prompts were introduced.

External contracts were checked against primary sources and installed versions:

- [VS Code watcher API](https://code.visualstudio.com/api/references/vscode-api) and
  [watcher internals](https://github.com/microsoft/vscode/wiki/File-Watcher-Internals); reference host **1.125.0**.
- Installed `@google/genai` **1.47.0** supports request `abortSignal`. Its installed API client creates
  `httpOptions.timeout` timers without clearing them on early settlement. Alpha therefore owns and clears its deadline
  timer, while passing the composed cancellation signal to the SDK. See the
  [SDK API client](https://github.com/googleapis/js-genai/blob/main/src/_api_client.ts) for the upstream implementation;
  the installed package, not mutable `main`, was the version evidence used here.
- Installed LanceDB **0.27.2** supports filtered `whenNotMatchedBySourceDelete` during merge. Native tests confirmed
  the filter uses unprefixed `type` and `filePath` fields. See the
  [LanceDB merge contract](https://github.com/lancedb/lancedb/blob/main/docs/openapi.yml) and
  [Lance transaction documentation](https://lancedb.github.io/lance/introduction/read_and_write.html).
- The installed Qdrant client accepts timeout milliseconds and defaults to 300,000 ms. Alpha now uses 30,000 ms.

## Findings and implemented changes

| Severity / disposition | Verified defect                                                                                                                                                                   | Owning change and regression evidence                                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High / must-fix        | The watcher deleted old points before checking hashes or awaiting embeddings. A duplicate unchanged event could empty an index entry; provider failure also removed valid chunks. | `processors/file-watcher.ts` prepares first and commits a per-file replacement. The duplicate-event and failed-provider regressions failed before the fix and pass afterward.                                                           |
| High / must-fix        | A trailing 500 ms debounce restarted on every edit. Snapshots accumulated behind slow work, and Stop did not cancel preparation.                                                  | One coalescing queue, a fixed 150 ms window, bounded workers, and run/file cancellation. Controlled tests cover continuous edits, an unresponsive provider, late settlement, and 100 edits behind a write.                              |
| High / must-fix        | A queued delete could survive a later create if its worker had not started yet. A failed recreation then left no old chunks.                                                      | Workers check for superseding pending events before processing their snapshot. The delete/recreate regression reproduced an empty replacement before the fix.                                                                           |
| High / must-fix        | VS Code returns `Uint8Array`; calling its `toString()` does not decode JSON bytes. Hashes were lost on reload. Older cache writes could also settle after Clear.                  | `cache-manager.ts` decodes UTF-8, validates the existing dictionary format, snapshots writes, serializes saves, and cancels deferred saves on flush/clear. Byte-contract and controlled save/clear tests pass.                          |
| High / must-fix        | A failed cache clear retained old hashes after a new empty vector collection was created, allowing files to be skipped.                                                           | Clear resets memory immediately and rejects persistence failure to its caller. The previous silent-success behavior failed the new regression. Existing startup and webview error handling receives the failure.                        |
| High / must-fix        | The watcher began only after the workspace scan. Saves during a long scan could be missed. Startup failure also discarded valid partial work.                                     | `orchestrator.ts` starts a paused watcher before scanning, drains captured edits afterward, and preserves committed files on failure or Stop. Retry reconciles the workspace rather than wiping the collection.                         |
| High / must-fix        | Completion status could be overwritten by a trailing progress update. Unrelated successful changes could conceal an earlier file failure.                                         | Counts advance after commits; completion is the final event. Pending work prevents premature Indexed status, and failed files remain visible until their own recovery.                                                                  |
| High / must-fix        | Reaching the discovery limit, or a transient stat failure, could make existing files appear deleted. Qdrant deletion used path-segment prefix matching.                           | Scanner retains entries after transient failures and skips deletion reconciliation when discovery is capped. Qdrant deletes by exact normalized `filePath`.                                                                             |
| Medium / should-fix    | Editing one chunk re-embedded every chunk in its file, increasing Vertex request count and consuming quota needed by searches.                                                    | Shared `file-indexing.ts` reuses vectors only for identical path/context/identifier/content inputs. Moved chunks receive fresh positions, IDs, and file hashes. Scanner and watcher use the same preparation path.                      |
| Medium / should-fix    | Provider/auth work could wait indefinitely and looked identical to an idle queue. Ignore-controller ownership also leaked during replacement or failed validation.                | Gemini/Vertex attempts and Vertex auth refresh have owned 30 s deadlines excluding quota waits. Progress distinguishes quota, request, retry, and saving. Factory-owned ignore controllers and failed-validation watchers are disposed. |

## Runtime ownership and contracts

`CodeIndexManager` owns service lifecycle and exposes the existing commands/status to extension callers.
`CodeIndexOrchestrator` coordinates scan/watch ownership and projects status through `CodeIndexStateManager`.
`FileWatcher` owns event coalescing, cancellation, and incremental commits. `DirectoryScanner` owns discovery and
reconciliation. Both use `prepareIndexPoints`; provider adapters retain provider-specific batching and quota behavior.
Storage adapters own the per-file replacement invariant. The React popover continues consuming projected status.

The incremental queue holds at most one pending event per path, takes at most 100 paths per batch, and uses at most
10 preparation workers. Writes are serialized within the watcher. Newer events cancel obsolete reads/parsing/provider
work and are processed in the next drain. Stop aborts preparation and stops accepting events. A write that already
started must settle before `whenIdle()` allows Clear or a new generation to proceed.

Pending paths and failed-file records are capped at the existing 50,000-file discovery limit. Overflow reports an error
requiring workspace reconciliation. Per-file vector reuse reads at most 2,048 points; chunks beyond that optimization
limit are freshly embedded. New files skip the reuse lookup.

LanceDB replaces a file in one merge transaction, including obsolete-chunk deletion. Qdrant upserts all prepared chunks
before pruning obsolete IDs. Qdrant's operation is **not atomic across requests**: a failed prune can temporarily leave
old and new points together. The hash is not advanced after failure, retries are idempotent, and the existing retrieval
source validator rejects stale content. A failed embedding never starts a replacement.

The index schema/version, model identity fingerprint, exact-source payloads, saved configuration, hash-cache dictionary,
and public webview status shape remain unchanged. Added progress and pending-work fields are internal and optional;
provider progress callbacks are optional. Provider changes do not alter tool permissions or execution policy.

Deliberate failure-contract changes: startup errors keep valid partial index data instead of clearing it; cache-clear
failures now propagate instead of reporting success. Model/representation changes retain the existing intentional
rebuild contract. Settings still use the local edit buffer; this pass does not change settings save behavior.

## Measured embedding work

The benchmark replays the verified previous whole-file strategy and the new reuse strategy on the same warm fixture:
ten chunks, one changed chunk, the other chunks shifted in source, `gemini-embedding-001`, 50 ms scripted request
latency, and 1,000 ms configured input/request pacing. There are five samples per strategy per provider: 20 samples
total. Both strategies use the current provider adapter with identical settings; only the embedding-input strategy
changes. The benchmark also verifies fresh payload hashes, moved point IDs, and cleared timers.

| Provider | Whole-file inputs / requests | Reuse inputs / requests | Whole-file embedding stage | Reuse embedding stage | Following query ready, measured from edit start |
| -------- | ---------------------------- | ----------------------- | -------------------------- | --------------------- | ----------------------------------------------- |
| Vertex   | 10 / 10                      | 1 / 1                   | 9,050 ms                   | 50 ms                 | 10,050 ms → 1,050 ms                            |
| Gemini   | 10 / 1                       | 1 / 1                   | 50 ms                      | 50 ms                 | 10,050 ms → 1,050 ms                            |

This fixture uses **90% fewer embedding inputs**. Vertex's adapter sends one input per request; Gemini batches these
inputs but accounts for all of them in its pacing budget. No quota setting or Retry-After protection was weakened.

These times are virtual, deterministic **embedding-stage** measurements. They exclude parsing, storage commits,
real authentication, network latency, and service rate limiting. They are not a measured production speedup. The
existing 1,700-block provider-throughput benchmarks also remain green.

Reproduce the benchmark:

```sh
pnpm --dir src test services/code-index/shared/__tests__/incremental-indexing.benchmark.spec.ts
```

## Validation and evidence

Before implementation, three focused watcher regressions failed for eager deletion and debounce starvation. During
final review, the queued delete/recreate regression failed by making an empty replacement; the failed-cache-clear
regression failed by resolving successfully. All now pass. New races use controlled promises or fake timers.

| Check                                                  | Result                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --dir src test services/code-index`              | **338 tests passed**, including native LanceDB, queue/cancellation, startup/recovery, cache, parser, provider wire, rate-limit/retry, retrieval, and benchmark coverage.                   |
| `pnpm --dir src check-types`                           | Passed after the final production edits.                                                                                                                                                   |
| `pnpm lint`                                            | Passed after the final production edits: eight workspace tasks.                                                                                                                            |
| `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` | Final production bundle passed: 13 launches, 42 assertions, exact actual host 1.125.0, scripted providers, no pending or failed assertions.                                                |
| Focused formatting / diff / preservation               | Touched-file formatting and scoped `git diff --check` passed. All 80 unrelated baseline files are byte-identical; the two intended overlaps were reviewed against their captured baseline. |

The first gate attempt used an artifact-root override without the other required profile paths and stopped at profile
validation before opening VS Code. It was corrected by omitting all three overrides and using the standard disposable
profile. No user sign-in was required for scripted tests. No live Vertex/Gemini requests or signed-in Copilot
evaluations were run.

The unrestricted `git diff --check` also inspected earlier work and reports pre-existing CRLF whitespace in
`src/api/providers/utils/error-handler.ts`. That file is byte-identical to the captured baseline and was not changed;
the scoped check for this iteration passes. No unrelated formatting was applied to hide that result.

Evidence files include `surface-inventory.json`, `pre-existing-file-hashes.json`, `baseline/`, `index-suite.json`,
`incremental-benchmark.log`, `queued-recreate-before-fix.log`, `cache-clear-before-fix.log`, `typecheck.log`, `lint.log`,
and `exact-host-gate.log`. The passing run before final review is separately retained with its compact summary.

## Coverage ledger

| Domain                               | Status                    | Evidence / boundary                                                                                                                                                                                                 |
| ------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Functional correctness and contracts | Reviewed, edited          | Save/change/delete/empty/unchanged, startup, partial failure, pending/error/completion, Stop/Clear/restart, encoding.                                                                                               |
| Architecture and ownership           | Reviewed, edited          | Manager → orchestrator → scanner/watcher → shared preparation → providers/stores; one preparation path, no parallel runtime.                                                                                        |
| Workflow and process                 | Reviewed                  | Root scripts and exact-host runner used. Repository-wide release/deploy workflow redesign is out of scope.                                                                                                          |
| Data and state flow                  | Reviewed, edited          | Hash advancement follows replacement; reusable vectors retain input identity while payloads refresh; UI consumes status projection.                                                                                 |
| Code quality and maintainability     | Reviewed, edited          | Removed duplicated scan branches and eager deletion/batch-text accumulation. Shared helpers isolate cancellation and preparation.                                                                                   |
| Reliability and robustness           | Reviewed, edited          | Bounded queue, supersession, deadlines, serialized cache writes, mutation drain, preserved partial state, actionable failures.                                                                                      |
| Security and privacy                 | Reviewed, edited          | Existing ignore/access boundaries retained; exact normalized replacement/deletion scopes; traversal and literal-path tests; no credentials or file contents added to evidence. Live auth transport is not verified. |
| Performance and resource use         | Reviewed, edited, flagged | Same-fixture embedding-work benchmark; capped queue/workers/reuse reads; cleanup tests. Large native-storage and full end-to-end latency need measurement.                                                          |
| Dependencies and configuration       | Reviewed                  | Installed SDK/native-store behavior checked; versions/settings/lockfile preserved. No repository-wide vulnerability audit.                                                                                          |
| Tests and validation                 | Reviewed, edited          | Before-fix failures, 338-test indexing suite, TypeScript/lint and exact-host gate. Existing older tests outside added regressions still contain some timing sleeps.                                                 |
| Observability and operations         | Reviewed, edited          | Current file/stage remains visible at unchanged 0/1 counts; failed-file state persists. User-specific live traces are not verified.                                                                                 |
| Documentation and onboarding         | Reviewed, edited          | This investigation records source pin, contracts, commands, evidence, benchmark limits, and recovery guidance.                                                                                                      |
| Frontend and UI                      | Reviewed                  | Popover/status and settings consumers inspected; backend progress details localized in English. No layout/keyboard change; manual incremental UI verification remains unperformed.                                  |
| Language-specific passes             | Reviewed                  | TypeScript, async cancellation/resource ownership, native storage interfaces, tests and performance passes. Python, standalone HTML/templates, and infrastructure do not exist in the scoped subsystem.             |

## Closure and next focuses

**Fixed now:** the reproduced event/queue/data-preservation/cache defects, missed saves during scanning, unchanged-chunk
embedding waste, unbounded Google provider attempts, and misleading incremental progress/completion handling.

**Flagged for follow-up:**

1. Run an operational-hardening pass on **legacy damaged-index detection**. This fix prevents new eager deletion, but an
   already-empty file entry with a matching persisted hash is not automatically identified by scanning unchanged files.
   Re-saving changed content reindexes that file; an explicit Clear and Start rebuilds the derived index. A future
   manifest audit should detect missing chunks without adding one database query per unchanged file.
2. Run a performance-optimization pass on **native commit and lexical-index maintenance for large workspaces**. Measure
   incremental save-to-search latency, concurrent search, and cold/warm LanceDB FTS maintenance before changing storage
   concurrency or compaction. This pass measured embedding work, not large-store transaction cost.
3. Run a signed-in operational-hardening pass on **real Vertex/gateway incremental updates**, recording exact model,
   profile, host 1.125.0, quota/retry conditions, and a latency distribution. Respect the user's sign-in requirement
   before any live run. A generic exact-host smoke gate does not substitute for that scenario.

**Not verified:** the exact origin of the user's current live stall, real Vertex/Gemini service latency and quota,
remote-filesystem behavior, live Qdrant network failure, and manual incremental status rendering.

**Out of scope:** unrelated pre-existing Codex steering/UI/retrieval work, whole-repository cleanup, release publishing,
dependency upgrades, and changing embedding provider or quota settings on the user's behalf.

## Responsiveness design follow-up: October 9

The user asked whether a simpler embedding approach would make indexing more useful. This follow-up inspected the
current code and refreshed Codex source to `5fe4fc8f7cd16688b5c661d8cdb76e2a340b046d` (October 9, 12:24:07 UTC).
Codex's [file finder](https://github.com/openai/codex/blob/5fe4fc8f7cd16688b5c661d8cdb76e2a340b046d/codex-rs/file-search/src/lib.rs)
uses local directory traversal and filename matching. That is a useful responsiveness reference; it is not a semantic
embedding implementation to copy.

Three concrete waits remain in Alpha:

- `search-service.ts` awaits both retrieval channels with `Promise.allSettled`, so ready lexical matches wait for the
  semantic request to settle.
- Queries, saved-file updates, and bulk indexing use the same provider request limiter without priority. Bulk work can
  delay interactive work even though concurrency and quota remain bounded correctly.
- LanceDB lexical search awaits `table.optimize()` after writes. Its correctness purpose is covered by native tests,
  but its latency on a large, frequently edited workspace has not been profiled.

Recommended next iteration: make existing local filename/text search usable before embedding completion; extend the
shared provider scheduling boundary with bounded priorities for queries, saved-file updates, and bulk work; keep exact
embedding-input reuse, cancellation, and safe replacement. Semantic enrichment should have an explicit wait budget and
cancel unused requests. This should extend the existing search/tool/store paths rather than add another task engine.

Changing chunk sizes alone does not remove these waits. Evaluate larger stable chunks only against both retrieval
quality and request count. Likewise, changing provider is an experiment, not an established fix: Google's
[model-specific Vertex REST contract](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-text-embeddings#rest)
restricts `gemini-embedding-001:predict` to one input text, while its
[Gemini API documentation](https://ai.google.dev/gemini-api/docs/embeddings) distinguishes separate embeddings from
aggregated multi-input embeddings. The installed SDK and Alpha's wire tests already verify the current endpoint shapes;
larger batches must retain one ordered vector per chunk and quota accounting.

Measure save-to-search latency and search latency during bulk indexing on the same cold/warm workload before claiming a
speedup. Real provider comparisons still require a signed-in live run. This follow-up records a design recommendation;
it does not change runtime behavior or select a provider for the user.
