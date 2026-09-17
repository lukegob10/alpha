# Code index improvement plan

Reviewed 2026-09-17 against the current working tree. These are proposals, not implemented behavior. The triggering workload uses Gemini Embedding 2 through Vertex/GCP; the vector-store choice and live provider timings are not yet established.

## Direction

Reduce repeated embedding work and make failure recovery predictable. Measure discovery, parsing, provider requests, and storage separately before increasing concurrency again. Preserve the existing provider-neutral indexing pipeline, hybrid retrieval, source freshness checks, ignore policy, and bounded queues.

The completed discovery and Vertex scheduling changes, their deterministic benchmarks, and their limits are recorded in [code-index-retrieval.md](code-index-retrieval.md). They do not establish live GCP throughput.

## Priorities

| Priority | Improvement                                                 | Main benefit                                                       | Scope and risk                                                                                   |
| -------- | ----------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 1        | Phase and queue measurements                                | Identify the actual bottleneck; explain apparent discovery stalls  | Small backend instrumentation; shared progress contracts and localized UI need separate coverage |
| 2        | Separate embedding and storage retries                      | Avoid paying for successful embeddings again after a write failure | Bounded scanner change; preserve replacement and cancellation semantics                          |
| 3        | Reuse embeddings for unchanged chunk inputs                 | Reduce requests after small edits and interrupted work             | Shared scanner/watcher path, bounded persistent cache, strict identity validation                |
| 4        | Recover indexing without discarding valid work              | Avoid full rebuilds after transient failures                       | Higher-risk persistence and replacement contract change                                          |
| 5        | Prioritize queries and propagate cancellation               | Keep searches responsive while indexing; stop obsolete requests    | Shared provider scheduling and lifecycle coverage                                                |
| 6        | Tune representation and storage using retrieval evaluations | Improve useful context, index size, and search latency             | Quality-dependent experiments; explicit rebuilds for representation changes                      |

### 1. Make elapsed time explainable

[state-manager.ts](../src/services/code-index/state-manager.ts) reports indexed/discovered blocks, while [scanner.ts](../src/services/code-index/processors/scanner.ts) pauses parsing when its pending batch bound is reached. A slowly increasing discovery count can therefore mean the embedding queue is full.

Record elapsed and active time for file enumeration, access filtering, reading/hashing, parsing, provider queue wait, provider requests, and storage. Include eligible/skipped files, reused/new chunks, active/pending requests, input volume, retries by status, and successful chunks per second. Keep counters bounded and local by default; never include source text or credentials. Coalesce progress notifications. Show an indeterminate total until discovery is complete and distinguish waiting for provider capacity from parsing.

Acceptance: a deterministic slow-provider fixture identifies provider wait as the bottleneck; a slow-storage fixture identifies storage. Instrumentation must not materially increase event-loop delay or UI update frequency.

### 2. Retry only the failed operation

[DirectoryScanner.processBatch](../src/services/code-index/processors/scanner.ts) wraps embedding, deletion, upsert, and hash updates in one retry loop. A storage error re-enters embedding, even when all vectors were valid. Vertex also has per-request retries. The watcher already separates some storage retries, so the two ingestion paths should converge on the existing shared contracts.

Keep validated vectors through bounded storage retries. Classify permanent provider errors so the scanner does not retry them again. Preserve actual attempt counts, idempotent point IDs, and the rule that hashes are committed only after successful replacement. Count each committed chunk once: a failed later upsert must not inflate progress for earlier successful segments.

Acceptance: inject a transient upsert failure after successful embedding; the provider request count stays unchanged during the storage retry, final points are correct, and progress has no double counting. Inject a permanent provider error and verify it is not amplified by nested retries.

### 3. Cache vectors by exact embedding input

[CacheManager](../src/services/code-index/cache-manager.ts) stores whole-file hashes. Both the scanner and [file-watcher.ts](../src/services/code-index/processors/file-watcher.ts) re-embed all chunks of a changed file. Reuse vectors whenever the exact embedding input is unchanged, even if its source offsets have moved.

Extend the shared indexing path with a workspace-scoped, size-bounded vector cache and in-flight deduplication. Key it by the existing index identity, retrieval purpose, and exact effective embedding input, including path/context and provider representation. Do not key it by `segmentHash`: [chunking.ts](../src/services/code-index/processors/chunking.ts) includes source offsets in that hash. Rebuild source payloads and point IDs from current offsets and file hashes even when a vector is reused.

Validate cached dimensions and finite values. Exclude credentials from identity, keep model/routing/input-version changes isolated, and make corrupt entries cache misses. Serialize persistence and eviction; disposal must settle writes. Cached vectors do not grant access to ignored files or authorize stale search results.

Acceptance: edit one function in a multi-chunk file and assert requests equal distinct cache misses. An insertion that moves unchanged embedding inputs must reuse their vectors while returning current line ranges. Model, dimension, context, path, and representation changes must invalidate the affected entries. A restart should retain valid reuse without preserving incomplete file commits.

This helps repeated edits and recovery. It does not eliminate a first index's unique provider requests. Larger chunk boundaries can shift after an edit, so reuse rates must be measured rather than assumed.

### 4. Preserve committed work through failure and restart

The non-cancellation error path in [orchestrator.ts](../src/services/code-index/orchestrator.ts) clears the collection and file-hash cache once indexing has started. This avoids trusting a mismatched cache, but it also discards successful work after an incremental scan fails.

Introduce explicit per-file replacement/checkpoint semantics within the existing vector-store interface. Stage and validate replacement points before committing a file revision; make crash reconciliation idempotent. Distinguish a compatible interrupted scan from a model/representation migration. Preserve previously committed data while reporting incomplete or failed work accurately. Continue rejecting source that no longer matches the current file.

Do not merely remove the cleanup calls: deletion and upsert are currently separate operations, and completion metadata has different implications in the storage adapters. Review Qdrant and LanceDB together before choosing a versioned-file or index-generation design.

Acceptance: deterministic faults before and after every replacement/checkpoint boundary; reload resumes missing work without advertising incomplete files as current. Unchanged committed files require no new embedding requests. Genuine identity changes still rebuild explicitly.

### 5. Schedule for throughput and interactive latency

[vertex.ts](../src/services/code-index/embedders/vertex.ts) shares one bounded request limiter across indexing and queries. Queries can wait behind background work. [IEmbedder](../src/services/code-index/interfaces/embedder.ts) has no cancellation signal, so stopping a scan cannot directly abort provider requests or retry waits. [search-service.ts](../src/services/code-index/search-service.ts) waits for both retrieval channels to settle, even when lexical results are ready first.

Add query priority with fairness inside the shared provider capacity limit. Propagate cancellation through queued work, request spacing, retry delays, and supported transports; keep accepted storage writes settled before teardown. Consider bounded adaptive concurrency only after recording request latency and throttling, retaining user-configured spacing and an explicit ceiling. Add a small bounded query-vector cache if repeated-query measurements justify it; source results still require fresh validation.

Google recommends truncated exponential backoff, smoother traffic, and gradual ramp-up for capacity errors in its [429 guidance](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deploy/error-code-429), retrieved 2026-09-17. This supports cautious scheduling; it does not establish this project's quota or justify changing the selected region.

Acceptance: query queue latency under sustained indexing, no background starvation, bounded requests/memory, simulated 429 recovery, and prompt cancellation without new dispatches. Test scanner, watcher, and search against the same scheduling contract.

### 6. Evaluate quality and storage tradeoffs

The current chunk body budget is 768 conservative token units. Compare that baseline with larger syntax-aware chunks on held-out repository questions before changing defaults. Measure evidence recall within the final context budget and agent task success alongside request count, input volume, latency, and cost. Preserve exact source coverage and enclosing context.

For Gemini Embedding 2, compare the current configured dimension with 1,536 and 768. Google documents a default of 3,072 and supports these lower dimensions in its [embedding guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-multimodal-embeddings), retrieved 2026-09-17. Lower dimensions reduce vector payload/storage size; they do not reduce the number of embedding requests or prove a proportional provider-latency improvement. Quality and normalization behavior need validation, and dimensional changes require an explicit index migration.

If using local LanceDB, [lancedb-client.ts](../src/services/code-index/vector-store/lancedb-client.ts) creates a lexical index but no vector ANN index. The [LanceDB vector-search documentation](https://docs.lancedb.com/search/vector-search), retrieved 2026-09-17, describes no-index search as an exhaustive vector scan. Benchmark an ANN threshold for large corpora against exact-search recall using the installed 0.27.2 API. Also measure the first lexical search after edits: it currently waits for index optimization. Preserve visibility of updated rows when changing maintenance scheduling. These recommendations are specific to LanceDB, not assumptions about the user's selected backend.

Profile parsing/tokenization and extension-host event-loop delay on large files before introducing workers. A bounded worker pool is justified only if CPU work is a measured bottleneck. Existing hybrid retrieval already combines lexical and semantic candidates; adding another retrieval engine or a reranker requires evidence of improved final results.

## Measurement and delivery

Use the same corpus revision and provider fixture for before/after comparisons. Cover cold indexing, unchanged restart, one-function edit, line insertion, repeated query, search during indexing, transient provider/storage failure, cancellation, and restart after partial writes. Record total time, time to first searchable result, requests/tokens, cache hits, retry amplification, p50/p95 query latency, peak memory, and event-loop delay. Live GCP trials should additionally record region, dimensions, configured spacing, sample count, and throttling.

Deliver separate reviewable changes: measurements; storage-retry reuse; shared chunk cache; recoverable file commits; query scheduling/cancellation; then measured quality/storage experiments. Run focused correctness and deterministic performance checks for each, extension typechecking, and the exact VS Code 1.122.1 gate whenever lifecycle, cancellation, persistence, or UI behavior changes.
