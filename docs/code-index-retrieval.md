# Code index retrieval

## Objective and evidence

Improve code discovery and the context returned to extension agents, independently of the chat model. This change targets source coverage, retrieval recall, useful context per token, and deterministic indexing. End-to-end Luna task success has not been measured.

The initial parser/scanner/watcher/vector-store/Bedrock baseline passed 162 tests, despite dropping a valid 41-character function and losing the parent identity when splitting long functions. New regression tests reproduced those gaps before the parser changed.

Primary sources consulted on 2026-09-12:

- [Anthropic contextual retrieval, 2024-09-19](https://www.anthropic.com/engineering/contextual-retrieval): chunk-specific context and complementary lexical retrieval. Cross-domain retrieval metrics motivate this architecture; they are not Alpha task-success predictions.
- [Voyage contextualized chunk embeddings](https://docs.voyageai.com/docs/contextualized-chunk-embeddings): preserve document context when representing chunks. Alpha uses deterministic syntax-derived context; it does not implement Voyage's joint contextual embedding API.
- [CoREB v1, 2026-05-06](https://arxiv.org/html/2605.04615v1): general rerankers can regress strong code embeddings, while code-finetuned reranking merits evaluation. Competitive-programming and offline-search results have limited transfer to agent tasks.
- [Qdrant sparse indexing and IDF](https://qdrant.tech/documentation/manage-data/indexing/#idf-modifier): indexed sparse retrieval with corpus IDF; the IDF modifier requires Qdrant 1.10 or later. Alpha's installed REST client is 1.14.0.
- [LanceDB full-text search](https://docs.lancedb.com/search/full-text-search) and [reindexing](https://docs.lancedb.com/indexing/reindexing): native lexical indexing and updating changed data. Implementation and native regression tests use the installed 0.27.2 binding.
- [Cohere on Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-embed-v4.html), [Nova embedding schema](https://docs.aws.amazon.com/nova/latest/userguide/embeddings-schema.html), and [Gemini embeddings](https://ai.google.dev/gemini-api/docs/embeddings): query/document configuration belongs in provider adapters.
- [Vertex text embedding requests](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-text-embeddings): Gemini 001 accepts one text per prediction request. Google provider adapters and a serialization regression test use the installed Google GenAI SDK 1.29.1.

## Implemented contract

### Source representation

The parser partitions exact source without overlapping chunks or discarding small declarations, imports, comments, or parse-error regions. Tree-sitter definition scopes supply enclosing names and signatures. A missing grammar falls back to bounded source chunks. Markdown retains ATX heading ancestry and distinguishes matching code fences.

Chunks have a 768-token-unit body budget and a 4,096-character cap. Scope context has a separate 256-token-unit/1,000-character cap. Units use the existing o200k tokenizer with its 1.5 safety factor; they are not provider-billed token counts. Long lines preserve UTF-16 surrogate pairs. Exact source offsets distinguish multiple fragments on one line. The chunker yields regularly and observes scan cancellation.

Context describes the scopes active at the fragment's start. Later declarations already visible in the chunk are not repeated as sibling metadata. Indexed text combines the relative file path, scope context, and source. The stored source remains exact and separately available.

### Indexing and embedding roles

Initial scanning and filesystem updates share contextual input construction, point IDs, and payload metadata. VS Code byte-array snapshots are decoded as UTF-8 in both paths. A batch must contain exactly one finite, consistently sized vector per input before it can replace existing chunks. Cache hashes are committed after successful writes.

Cancellation skips a batch before its replacement transaction starts and waits for already accepted work to settle. Once replacement has begun, the existing write sequence finishes before teardown. Existing provider calls may still need to finish before cancellation settles; this change does not add transport abort support to every provider.

Search explicitly requests query embeddings. Cohere uses search-query input, Nova uses text-retrieval purpose, and known Nomic code-search prefixes apply only to queries. Native Gemini and Vertex use the documented 001 task types or Gemini 2 instructed inputs. Providers without a distinct query/document contract keep their normal inputs.

Gemini 2 inputs have explicit Content boundaries so separate chunks receive separate embeddings. Vertex submits one input per request, with at most four active requests per embedder, bounded scheduling windows, and output restored to input order. This respects the Gemini 001 prediction limit and settles an accepted window before propagating failure.

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

Future changes to chunk representation, document embedding inputs, or lexical term encoding must increment the representation version so stored vectors and query behavior cannot silently diverge.

The existing minimum-score setting applies to the semantic candidate channel. Returned hybrid scores express rank agreement, not cosine similarity or a probability of correctness. Lexical-only matches can be returned even when the semantic channel has no result above its threshold.

No new production dependencies or user settings were added. The protected CLI and VS Code shim were not changed.

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
