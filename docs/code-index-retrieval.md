# Code index retrieval

## Objective and evidence

Improve code discovery and the context returned to extension agents, independently of the chat model. This change targets source coverage, retrieval recall, useful context per token, and deterministic indexing. End-to-end Luna task success has not been measured.

The historical parser/scanner/watcher/vector-store/Bedrock baseline (before provider reduction) passed 162 tests, despite dropping a valid 41-character function and losing the parent identity when splitting long functions. New regression tests reproduced those gaps before the parser changed.

Primary sources consulted on 2026-09-12:

- [Anthropic contextual retrieval, 2024-09-19](https://www.anthropic.com/engineering/contextual-retrieval): chunk-specific context and complementary lexical retrieval. Cross-domain retrieval metrics motivate this architecture; they are not Alpha task-success predictions.
- [Voyage contextualized chunk embeddings](https://docs.voyageai.com/docs/contextualized-chunk-embeddings): preserve document context when representing chunks. Alpha uses deterministic syntax-derived context; it does not implement Voyage's joint contextual embedding API.
- [CoREB v1, 2026-05-06](https://arxiv.org/html/2605.04615v1): general rerankers can regress strong code embeddings, while code-finetuned reranking merits evaluation. Competitive-programming and offline-search results have limited transfer to agent tasks.
- [Qdrant sparse indexing and IDF](https://qdrant.tech/documentation/manage-data/indexing/#idf-modifier): indexed sparse retrieval with corpus IDF; the IDF modifier requires Qdrant 1.10 or later. Alpha's installed REST client is 1.14.0.
- [LanceDB full-text search](https://docs.lancedb.com/search/full-text-search) and [reindexing](https://docs.lancedb.com/indexing/reindexing): native lexical indexing and updating changed data. Implementation and native regression tests use the installed 0.27.2 binding.
- [Vertex text embedding requests](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-text-embeddings): Gemini 001 accepts one text per prediction request. The original Google adapter baseline and serialization regression test used Google GenAI SDK 1.29.1; the Embedding 2 endpoint fix below records the subsequent SDK update.

## Implemented contract

### Source representation

The parser partitions exact source without overlapping chunks or discarding small declarations, imports, comments, or parse-error regions. Tree-sitter definition scopes supply enclosing names and signatures. A missing grammar falls back to bounded source chunks. Markdown retains ATX heading ancestry and distinguishes matching code fences.

Chunks have a 768-token-unit body budget and a 4,096-character cap. Scope context has a separate 256-token-unit/1,000-character cap. Units use the existing o200k tokenizer with its 1.5 safety factor; they are not provider-billed token counts. Long lines preserve UTF-16 surrogate pairs. Exact source offsets distinguish multiple fragments on one line. The chunker yields regularly and observes scan cancellation.

Context describes the scopes active at the fragment's start. Later declarations already visible in the chunk are not repeated as sibling metadata. Indexed text combines the relative file path, scope context, and source. The stored source remains exact and separately available.

### Indexing and embedding roles

Initial scanning and filesystem updates share contextual input construction, point IDs, and payload metadata. VS Code byte-array snapshots are decoded as UTF-8 in both paths. A batch must contain exactly one finite, consistently sized vector per input before it can replace existing chunks. Cache hashes are committed after successful writes.

Cancellation skips a batch before its replacement transaction starts and waits for already accepted work to settle. Once replacement has begun, the existing write sequence finishes before teardown. Existing provider calls may still need to finish before cancellation settles; this change does not add transport abort support to every provider.

Search explicitly requests query embeddings. GCP Vertex AI is the only supported embedding provider. Direct Vertex uses the documented 001 task types or Gemini 2 instructed inputs. Vertex gateways preserve their earlier raw-content prediction payload for both documents and queries, including opaque routed model aliases.

Vertex submits one input per request, with at most 16 active requests for a configured `gemini-embedding-2` model and eight for other models, shared across batches and queries on an embedder instance. Each caller queues at most that many tasks; free slots refill immediately and output retains input order. Failed calls stop scheduling new texts and drain accepted requests before rejecting. The configured embedding delay applies to each Vertex request start, including retries; concurrency does not override an enabled rate limit.

Vertex prefers indexing groups matching its request concurrency while preserving whole-file groups, including files larger than that target. Embedding can start while later files are still parsing. This scheduling policy changes neither the embedding input nor vector dimensions and requires no index rebuild.

### File discovery (2026-09-17)

Initial and incremental indexing request files only from the existing `listFiles` helper. Ripgrep remains responsible for traversal, Git ignore handling, symlink behavior, and the file limit. Indexing previously waited for an additional serial JavaScript traversal to collect directory entries, then discarded those entries. That additional walk could also descend into Git-ignored folders. Other listing callers still receive directories by default.

The scanner filters unsupported extensions and excluded paths before `.alphaignore` validation, while retaining symlink-aware policy checks for every remaining candidate. Discovery now forwards cancellation to ripgrep, waits for its process to close through the existing listing contract, and disposes the temporary ignore controller after filtering, including on initialization failure. Cancellation does not trigger deleted-file pruning.

```sh
pnpm --dir src exec vitest run services/glob/__tests__/list-files-discovery.benchmark.spec.ts --no-silent
```

The controlled discovery fixture contains 200 source files in 200 directories plus 1,000 Git-ignored generated directories. Ripgrep completes after 20 simulated milliseconds; each additional directory read costs 2 ms. Before the production change, discovery issued 1,203 extra directory reads and took 2,426 ms. With file-only discovery, it issues zero additional directory reads and takes 20 ms, returning exactly the same sorted source file set. This isolates redundant traversal costs; it is not an end-to-end indexing or user-workspace speed claim. Real-ripgrep coverage also compares the old and file-only paths with nested ignore rules and negation.

After discovery, parsing deliberately pauses when the bounded embedding queue is full. A slowly growing discovered-block count during active embedding can therefore still reflect embedding throughput; this change removes work before parsing without unbounding the queue.

Validation passed: `pnpm --dir src exec vitest run services/glob services/code-index core/ignore/__tests__/AlphaIgnoreController.spec.ts core/ignore/__tests__/AlphaIgnoreController.security.spec.ts --maxWorkers=4` (661 tests across 43 files, including real ripgrep), `pnpm --dir src check-types`, ESLint and Prettier checks on touched files, and `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` (actual VS Code 1.122.1).

The [embedding improvement plan](code-index-improvement-plan.md) records the remaining opportunities and their acceptance criteria.

### Vertex scheduling check

```sh
pnpm --dir src exec vitest run services/code-index/processors/__tests__/vertex-indexing.benchmark.spec.ts --no-silent
```

The benchmark uses the real scanner and Vertex adapter with mocked parsing, SDK responses, and vector writes. Its cold-index fixture has 85 files and 1,700 blocks: parsing takes 20 ms per file, every seventeenth request takes 400 ms and the rest take 100 ms, and writes take 2 ms. Fake timers measure scheduling independently of machine speed. Both model paths assert their shared request cap and that embedding and writes overlap parsing. Gemini 001 retains thresholds of three seconds to first stored results and 26 seconds total; Gemini 2 uses 1.8 and 14 seconds respectively.

The Gemini 2 concurrency change was measured on 2026-09-17 with Node 20.19.2 and pnpm 10.8.1 using the same fixture before and after the production edit:

| Gemini 2 metric           | Before (8 requests) | After (16 requests) |
| ------------------------- | ------------------: | ------------------: |
| Requests / indexed blocks |       1,700 / 1,700 |       1,700 / 1,700 |
| First stored results      |            2,522 ms |            1,222 ms |
| Total simulated time      |           25,022 ms |           12,622 ms |

The deterministic workload shows 49.6% less simulated elapsed time. Rate-limit delay and retries are disabled in this benchmark; there are no live network calls. Separate adapter tests cover shared bounds across batches and queries, out-of-order completion, failure draining, and request spacing across authentication and 429 retries. These checks do not establish live GCP throughput: quotas, gateway latency, configured spacing, parsing, and storage can dominate a real run. Higher concurrency may encounter more throttling on constrained projects or gateways; the existing per-request delay and retry backoff still apply.

[Google's Gemini 2 request examples](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-multimodal-embeddings) and [quotas](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/quotas), retrieved 2026-09-17, confirm the `embedContent` request shape and model quota accounting. Multiple parts in one content represent one embedding input; this change overlaps independent requests rather than concatenating source chunks. The installed Google GenAI SDK remains 1.47.0. The selected concurrency is an Alpha scheduling bound, not a claim about any user's available quota.

Validation for the concurrency change passed: `pnpm --dir src exec vitest run services/code-index --maxWorkers=4` (558 tests), `pnpm --dir src check-types`, ESLint and Prettier checks on touched files, and `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` (actual VS Code 1.122.1).

### Hybrid retrieval

Both Qdrant and local LanceDB retrieve semantic and indexed lexical candidates:

1. Fetch 40–200 candidates per channel, based on the configured result limit. The two read paths run concurrently.
2. Preserve complete identifiers plus camelCase/snake_case components in lexical indexing. Qdrant uses hashed sparse terms with BM25-style term-frequency weights and live corpus IDF; its fixed average-length normalization is an approximation. LanceDB uses its native full-text scorer with pre-tokenized code terms.
3. Combine ranks using equal-weight reciprocal rank fusion with offset 60. Cosine and lexical scores are not directly added. Channel scores remain available for diagnostics.
4. Select complete, non-overlapping evidence within 6,000 conservative token units, including a per-result formatting allowance. The configured result count is an upper bound.
5. Before returning a selected chunk, validate workspace/path scope, ignore access, current file hash, and exact source offsets/content. Deleted, changed, ignored, or out-of-scope evidence is omitted. At most eight source files are cached, only for the current request.

The source validator uses the manager's .gitignore configuration and live .alphaignore controller. It checks resolved paths as well as lexical paths. The tool selects the task's workspace rather than the foreground editor's workspace and returns enclosing scope context to the model.

A failed channel can fall back to available evidence from the other channel. If no channel supplies evidence and a channel failed, the search reports the failure. A transient search failure does not move the indexing lifecycle into Error.

LanceDB 0.27.2's native test exposed missed updated rows in filtered FTS before optimization. Dirty text indexes are refreshed before lexical search and when indexing is marked complete, with an in-flight refresh shared between callers. This can add latency to the first search after edits.

### Search presentation

Chat uses a short, localized code-search activity label with the complete query and optional directory in expandable details. The result disclosure has normal document spacing, a bounded list, and keyboard-operable file buttons. Matches show file names, line ranges, directories, available scope context, and short source previews. Raw ranking scores are omitted from the display because hybrid ranks are not confidence estimates.

Result expansion uses the chat's existing row controller, preserving expansion through virtualization and releasing automatic scroll-follow while the user inspects evidence. File buttons retain the original start-line navigation. Theme colors, hover states, borders, and focus outlines use VS Code tokens.

### Compatibility and rebuilds

Existing collection/table names and saved task/settings formats remain unchanged. Index metadata now fingerprints representation version 2, embedding model/provider, dimensions, and relevant endpoint/model-routing identity. Credentials are excluded from the fingerprint.

A legacy or incompatible index is rebuilt through the existing initialization/cache-reset path. Changing embedding models triggers this even when dimensions match. The first upgrade can therefore re-embed the repository. Key rotation alone does not require re-embedding.

Future changes to chunk representation, document embedding inputs, or lexical term encoding must update the relevant representation fingerprint so stored vectors and query behavior cannot silently diverge.

Gateway input restoration adds a gateway-specific `raw-content-v1` fingerprint. This rebuilds affected gateway indexes through the existing initialization path without invalidating direct Vertex or other providers' indexes.

The existing minimum-score setting applies to the semantic candidate channel. Returned hybrid scores express rank agreement, not cosine similarity or a probability of correctness. Lexical-only matches can be returned even when the semantic channel has no result above its threshold.

No new production dependencies or user settings were added. The protected CLI and VS Code shim were not changed.

### Gemini 001 gateway regression review (2026-09-12)

Compared `6a04173` (2.1.34) with its parent and the earlier `c60a47f` Vertex batch/retry implementation. Gateway URL construction, project/location/model routing, Helix authentication, certificate setup, and the installed Google GenAI SDK 1.29.1 were unchanged. The release added retrieval task fields and split each batch into concurrent singleton predictions. The split bypassed the user-configured delay between actual HTTP requests.

Restore the earlier gateway JSON (`instances: [{ content: text }]`) while retaining singleton predictions required by [Google's Gemini 001 contract](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-text-embeddings), checked on 2026-09-12. Apply the existing rate limiter at the Vertex request boundary. Tests using the real SDK and stubbed HTTP cover canonical/legacy settings, routed URLs and headers, validation/document/query payloads, and 401 token refresh. A fake-clock regression reproduced four simultaneous calls despite a one-second setting; with the fix their starts are 0, 1, 2, and 3 seconds. These are deterministic contract checks; no live customer gateway failure has been reproduced.

Validation passed on Node 20.19.2 / pnpm 10.8.1: `pnpm --dir src test services/code-index shared/__tests__/embeddingModels.spec.ts` (560 tests), `pnpm --dir src check-types`, `pnpm --dir src lint`, and `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` (actual host 1.122.1).

### Gemini Embedding 2 Vertex endpoint fix (2026-09-17)

Alpha offered `gemini-embedding-2` with Google GenAI SDK 1.29.1, whose Vertex embedding serializer always called `:predict` with `instances`. Gemini Embedding 2 requires `:embedContent` with `content` and returns `embedding` instead of `predictions`. A real-SDK regression reproduced this mismatch independently of GCP credentials. The SDK is now resolved to 1.47.0: this retains the existing major version, includes Vertex Embedding 2 support introduced in 1.42.0, and includes the `us` multi-region endpoint correction introduced in 1.47.0. The manifest and lockfile change deliberately includes that SDK's transitive dependencies.

Primary sources checked on 2026-09-17:

- [Google's Gemini Embedding 2 API examples](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-multimodal-embeddings): `:embedContent`, instructed document/query inputs, and response handling.
- [Google GenAI 1.47.0 source](https://github.com/googleapis/js-genai/blob/v1.47.0/src/models.ts) and [release history](https://github.com/googleapis/js-genai/blob/v1.47.0/CHANGELOG.md): model-dependent endpoint selection and multi-region routing.
- [Embedding 2 model availability](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/embedding-2): `global`, `us`, and `eu` locations. Alpha's existing picker exposes `global` and `us`; use one of those for direct Embedding 2 requests. The fix does not silently change the user's selected location.

Real-SDK HTTP tests cover validation, indexing, and queries against `global` and `us`, Gemini 001's existing prediction/task-type contract, and Gemini 2 gateway routing with certificate setup, extra headers, and a refreshed bearer token. Gateway inputs retain their existing raw-content representation; embedding dimensions and index fingerprints do not change. A non-retryable 404 now reports the actual number of requests, including any gateway authentication replay, instead of always reporting the configured maximum of three. Chat reasoning settings remain lowercase in saved configuration and are mapped to the newer SDK's explicit thinking-level enum at the provider transform boundary.

Validation passed on Node 20.19.2 / pnpm 10.8.1: code-index, API transforms, Gemini/Vertex providers, task persistence, and `AgentTurnEngine` tests (1,190 passed, two skipped); `pnpm --dir src check-types`; ESLint on the changed TypeScript files; frozen-lockfile validation; and `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` (ten tests passed in actual host 1.122.1, including extension/webview builds).

These tests use stubbed Google HTTP responses and do not establish access, IAM permissions, or model availability in a particular GCP project or private gateway.

## Recorded workload

Baseline: commit `2f8eb34a5cd4092676dc79a11b06430cb37d5288`. Environment: Windows, Node 20.19.2, pnpm 10.8.1, real bundled TypeScript Tree-sitter grammar. The committed `parser.benchmark.spec.ts` uses five fixed files totaling 20,423 characters: a small function, a long function, a class with many methods, imports/documentation/declarations, and a Markdown guide. Both versions receive identical inputs, one warmup, and five warm parsing samples.

| Metric                                                     |       Baseline |           New |
| ---------------------------------------------------------- | -------------: | ------------: |
| Covered source characters                                  | 17,276 (84.6%) | 20,423 (100%) |
| Total chunks                                               |             90 |            19 |
| Small function chunks                                      |              0 |             1 |
| Long function chunks                                       |             80 |             4 |
| Long function chunks retaining its name in embedding input |         0 / 80 |         4 / 4 |
| Embedding input, conservative token units                  |          5,046 |         6,928 |
| Median warm parsing time                                   |        6.98 ms |      14.19 ms |

Baseline parsing samples: 12.76, 9.73, 5.61, 6.72, 6.98 ms. Final parsing samples: 17.61, 13.90, 13.88, 17.97, 14.19 ms.

This workload shows 78.9% fewer chunks, complete source coverage, and retained enclosing identity. It also shows 37.3% more embedding input and about 7 ms additional median parsing work. Preserving previously omitted source and adding context has a cost. These five synthetic files establish structural behavior; they do not establish production throughput, retrieval NDCG, provider billing, or cheaper-model task success.

Run the current benchmark from the repository root:

```powershell
pnpm --dir src test --maxWorkers=1 services/code-index/processors/__tests__/parser.benchmark.spec.ts --silent=false
```

For a historical comparison, extract both the parser and constants from the recorded commit into temporary sibling modules, change the extracted parser's constants import to the extracted constants module, and set `ALPHA_INDEX_PARSER=../parser.baseline.ts` for the same test. The baseline environment variable changes only the measured parser and disables assertions for the new representation. Remove the temporary modules and environment variable afterward; neither belongs in the working tree.

## Validation and empirical limits

The focused suite covers source coverage and bounds, grammar fallback, cancellation, embedding roles and malformed batches, incremental updates, stable IDs, same-dimension migration, hybrid ranking, bounded output, source freshness, path scope, and task-workspace selection. A native temporary LanceDB test exercises insert, update, lexical/dense search, literal directory filtering, and same-dimension model migration. A test using the installed Google SDK with a stubbed fetch verifies separate serialized requests for both Gemini generations without calling a provider.

Final validation on 2026-09-12:

- `pnpm --dir src test --maxWorkers=2 services/code-index core/tools/__tests__/CodebaseSearchTool.spec.ts`: 538 tests passed across 31 files.
- `pnpm --dir src check-types`: passed.
- `pnpm --dir src lint`: passed.
- The search presentation passes 25 focused webview tests covering disclosures, parent-controlled expansion, persisted result rendering, file navigation, legacy results, and literal source rendering. Webview typechecking and lint pass. The actual chat components were visually checked in a browser preview at normal and 340-pixel sidebar widths, with dark, light, and high-contrast themes; keyboard expansion was also exercised. This was not a manual visual inspection inside the native extension host.
- The required chat translation audit reports 459 pre-existing missing keys. Comparison against the pre-change locale files found no new missing keys; the new search title is translated in all 18 locales.
- After the final search presentation changes, the rebuilt extension passed the exact-host smoke gate again: 10 tests on VS Code 1.122.1. Run IDs: `549264ac-c110-40ad-9d45-e3a7d699d069`, `e3d0e191-2361-465e-9fb9-80d771c319ed`, `62791e4f-264f-49b6-abd9-acac1d35688a`.
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`: passed after rebuilding the final code; 10 tests across three host launches, each reporting actual VS Code 1.122.1 and exit code 0. Run IDs: `e59f2879-26a7-4d60-acf2-40904df7a7a6`, `f2a2a859-00e7-484c-aac4-0d187da12726`, and `cd012a15-9338-4313-a230-9963e931590c`.

A live Qdrant server and live embedding/chat-model evaluations were not available in this session. Docker's CLI was installed, but its Linux engine was not running. Qdrant was checked against installed client types and mocked API contracts; native backend behavior was exercised with LanceDB.

Learned reranking is not enabled by default. Before adding a code-trained reranker, compare hybrid retrieval with and without it on a held-out set of real repository tasks. Hold the generator, token budget, corpus revision, and provider conditions constant; measure evidence recall within the final context budget, task success, latency, retries, and total cost. General-purpose reranking, graph expansion, LLM-written summaries, and a larger context window are not assumed to improve this baseline.
