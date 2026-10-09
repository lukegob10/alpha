# Code index search settings research

Research date: October 8, 2026. Codex CLI source was inspected first at
[`75e0b4088eff1760443856cc5f187fc9327e37b5`](https://github.com/openai/codex/commit/75e0b4088eff1760443856cc5f187fc9327e37b5),
then current primary retrieval documentation and code retrieval research. Alpha findings apply to release 3.1.8 / main
[`2233a0ef8902e2f4ead8f0529c1d49fce5374637`](https://github.com/lukegob10/alpha/commit/2233a0ef8902e2f4ead8f0529c1d49fce5374637).
The inspected production files match that main revision. This investigation changes no runtime settings or providers.

Keep **0.4 for search score and 50 for maximum results as the measurement baseline**. Neither value is established as
optimal by this research. The immediate improvements should make the settings describe their actual behavior, reconcile
the advertised result range with the runtime cap, and measure candidate retrieval separately from returned context.

## Codex CLI comparison

The reviewed local repository discovery paths favor fast text and file search. The
[current instructions](https://github.com/openai/codex/blob/75e0b4088eff1760443856cc5f187fc9327e37b5/codex-rs/models-manager/prompt.md#L264)
direct text searches toward `rg` and file discovery toward `rg --files`. The
[file-search crate](https://github.com/openai/codex/blob/75e0b4088eff1760443856cc5f187fc9327e37b5/codex-rs/file-search/README.md)
combines an ignore-aware filesystem walker with fuzzy filename matching. Its scores come from the matcher, rather than
embedding cosine similarity. The
[app-server test](https://github.com/openai/codex/blob/75e0b4088eff1760443856cc5f187fc9327e37b5/codex-rs/app-server/tests/suite/fuzzy_file_search.rs#L220)
checks scores such as 84, 72 and 71, ordering, and highlight indices. These tests were read, not executed here.

The [file-search CLI](https://github.com/openai/codex/blob/75e0b4088eff1760443856cc5f187fc9327e37b5/codex-rs/file-search/src/cli.rs#L16)
defaults to 64 filename matches; the
[library options](https://github.com/openai/codex/blob/75e0b4088eff1760443856cc5f187fc9327e37b5/codex-rs/file-search/src/lib.rs#L126)
default to 20. These are different caller contracts and count paths, so neither provides a directly transferable default
for Alpha's code chunks. No counterpart to Alpha's semantic threshold was found in the reviewed local discovery paths.
This finding does not describe every remote service or connector available to Codex.

Alpha's persistent semantic index is an intentional extension capability beyond those paths. Preserve efficient lexical
discovery and bounded context alongside it. Codex alignment does not require replacing Alpha's index or importing a fuzzy
filename score into its settings.

## What Alpha's settings actually control

| Setting                | Current default and UI range | Actual behavior                                                                                                                         |
| ---------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Search Score Threshold | 0.4; 0–1 in steps of 0.05    | Gates semantic candidates before fusion. It does not gate keyword candidates or the final hybrid score.                                 |
| Maximum Search Results | 50; 10–200 in steps of 10    | Counts code chunks, not files. Search clamps the value to 100, then context packing can return fewer. It also controls candidate depth. |

The defaults and accepted configuration range are in
[the shared schema](https://github.com/lukegob10/alpha/blob/2233a0ef8902e2f4ead8f0529c1d49fce5374637/packages/types/src/codebase-index.ts#L21).
The [popover](https://github.com/lukegob10/alpha/blob/2233a0ef8902e2f4ead8f0529c1d49fce5374637/webview-ui/src/components/chat/CodeIndexPopover.tsx)
uses those values, but the
[search service](https://github.com/lukegob10/alpha/blob/2233a0ef8902e2f4ead8f0529c1d49fce5374637/src/services/code-index/search-service.ts#L35)
uses a separate hard cap of 100. Settings of 150 or 200 currently have the same effective cap as 100.

For semantic retrieval, the
[LanceDB adapter](https://github.com/lukegob10/alpha/blob/2233a0ef8902e2f4ead8f0529c1d49fce5374637/src/services/code-index/vector-store/lancedb-client.ts)
uses cosine distance and converts it to a score with `clamp(1 - distance, 0, 1)`. The
[Qdrant adapter](https://github.com/lukegob10/alpha/blob/2233a0ef8902e2f4ead8f0529c1d49fce5374637/src/services/code-index/vector-store/qdrant-client.ts)
uses a cosine collection and sends the threshold to its semantic query. Keyword retrieval has no corresponding semantic
threshold. A higher threshold removes low-scoring semantic candidates; it does not guarantee fewer total matches or better
overall relevance after keyword retrieval and fusion.

The [fusion and packing layer](https://github.com/lukegob10/alpha/blob/2233a0ef8902e2f4ead8f0529c1d49fce5374637/src/services/code-index/shared/retrieval.ts)
uses reciprocal rank fusion (RRF). Its returned score depends on ranks, not raw cosine or keyword scores. With two
channels, the first result in only one channel scores 0.5; a result ranked first in both scores 1. Neither value is a
confidence probability. The
[tool projection](https://github.com/lukegob10/alpha/blob/2233a0ef8902e2f4ead8f0529c1d49fce5374637/src/core/tools/CodebaseSearchTool.ts#L77)
currently emits the hybrid value as `Score` while dropping the retained semantic score, lexical score and score type.

The current candidate limit **per channel** is:

```text
effective result cap = clamp(configured maximum, 1, 100)
candidate limit = min(200, max(40, effective result cap × 4))
```

| Configured maximum | Effective result cap | Semantic candidates | Keyword candidates |
| ------------------ | -------------------- | ------------------- | ------------------ |
| 10                 | 10                   | 40                  | 40                 |
| 20                 | 20                   | 80                  | 80                 |
| 30                 | 30                   | 120                 | 120                |
| 40                 | 40                   | 160                 | 160                |
| 50                 | 50                   | 200                 | 200                |
| 100                | 100                  | 200                 | 200                |
| 200                | 100                  | 200                 | 200                |

These are upper bounds, not guaranteed counts. Lowering the maximum from 50 to 20 also reduces each candidate pool from
200 to 80. That can remove evidence before fusion, even if both settings ultimately return the same amount of context.
Any latency benefit and relevance cost require measurement.

The packer has a fixed budget of **6,000 estimated token units**, removes overlapping or repeated chunks, and keeps
complete chunks. Each result costs the token estimate for its path, context and code plus 40 units. The
[tokenizer](https://github.com/lukegob10/alpha/blob/2233a0ef8902e2f4ead8f0529c1d49fce5374637/src/utils/tiktoken.ts)
uses `ceil(o200k_base tokens × 1.5)`, so this is conservative internal accounting rather than the selected provider's
exact billing token count. Production searches also reject stale, inaccessible or out-of-scope source evidence.

These settings apply when searching an existing index. They do not change document embedding batch size, indexing
concurrency or initial indexing throughput. Changing just these two settings reloads search configuration without
requiring a service restart in
[the configuration manager](https://github.com/lukegob10/alpha/blob/2233a0ef8902e2f4ead8f0529c1d49fce5374637/src/services/code-index/config-manager.ts)
and [index manager](https://github.com/lukegob10/alpha/blob/2233a0ef8902e2f4ead8f0529c1d49fce5374637/src/services/code-index/manager.ts).
Each search invokes one logical query embedding operation; provider retries can still add network requests.

## Primary research and its implications

[OpenAI's retrieval guide](https://developers.openai.com/api/docs/guides/retrieval#ranking) describes threshold tuning as a
relevance tradeoff: stricter filtering can exclude useful chunks. It also provides controls for balancing semantic and
keyword retrieval. This is hosted retrieval guidance, not evidence that Codex CLI uses Alpha's index or that either
product's numeric score thresholds are interchangeable.

[Qdrant's hybrid tuning guide](https://qdrant.tech/documentation/search-tuning/how-to-tune-hybrid-search/) recommends
comparing dense, sparse and fused retrieval on labeled queries. Fusion only reorders retrieved candidates, and RRF uses
rank rather than score magnitude. Its experiments do not show hybrid retrieval winning everywhere. Therefore, keep
Alpha's current fusion as the baseline and validate changes on held-out queries; do not copy Qdrant's fusion constant or
benchmark gains into Alpha claims.

[Qdrant's candidate-depth guide](https://qdrant.tech/documentation/search-tuning/candidate-depth/) distinguishes candidates
available to a ranking stage from final output. It recommends measuring recall and latency rather than assuming that a
larger pool improves the returned ranking. This supports separating candidate breadth from Alpha's returned-result knob.

[LanceDB's hybrid documentation](https://docs.lancedb.com/search/hybrid-search) combines semantic and keyword retrieval
with RRF and explicit result limits. Alpha already owns fusion above its adapters; adopting a second, store-specific
fusion implementation would need a concrete justification and equivalent behavior across stores.

[Google's embedding documentation](https://ai.google.dev/gemini-api/docs/embeddings#supported-task-types) specifies
`CODE_RETRIEVAL_QUERY` for code-search queries and `RETRIEVAL_DOCUMENT` for indexed code with Gemini Embedding 001.
Alpha already applies this distinction in
[its shared Google adapter](https://github.com/lukegob10/alpha/blob/2233a0ef8902e2f4ead8f0529c1d49fce5374637/src/services/code-index/shared/google-embedding.ts).
Gemini Embedding 2 uses a separate instructed-input path. Calibrate thresholds for the exact model and dimensions; do not
assume one universal cosine cutoff or apply 001's request format to every model.

The [CoIR paper](https://aclanthology.org/2025.acl-long.1072/) evaluates retrieval across multiple code tasks and domains,
highlighting limitations of benchmarks dominated by natural language. Alpha's tuning set should include actual code
questions and exact symbols, rather than relying solely on generic document-search benchmarks.

## Verification performed

An offline scripted probe imported the actual Alpha search service, fusion, context packer and tokenizer. Embeddings and
vector stores were controlled fixtures; no provider requests, credentials, live sign-in or repository source validation
were involved. The probe measures setting semantics, not relevance or performance.

| Probe                                                                                   | Observed result                                                                                       |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 250 distinct short chunks, configured maximum 100 / 150 / 200                           | All returned 100 chunks at an estimated cost of 5,700 units.                                          |
| 250 distinct medium chunks, configured maximum 20 / 50 / 100 / 200                      | All returned 11 chunks at an estimated cost of 5,621 units. Each code body alone estimated 450 units. |
| Semantic threshold 0.95 with semantic candidates below the cutoff and one keyword match | The keyword match remained, with hybrid score 0.5.                                                    |
| First semantic candidate with raw score 0.41 versus 0.91                                | Both hybrid scores were 0.5 when absent from the keyword channel.                                     |
| One candidate ranked first in both channels                                             | Hybrid score was 1.0.                                                                                 |
| Query embedding operations in each scripted search                                      | One logical operation, independent of the configured maximum.                                         |

The focused existing regression suites also passed: **4 files, 94 tests**.

```sh
pnpm --dir src test --maxWorkers=2 services/code-index/__tests__/search-service.spec.ts services/code-index/vector-store/__tests__/lancedb-client.spec.ts services/code-index/vector-store/__tests__/qdrant-client.spec.ts services/code-index/__tests__/config-manager.spec.ts
```

Local evidence is saved under `F:/alpha-e2e/artifacts/code-index-settings-research-20261008/`: `settings-probe.mjs`,
`settings-probe.json`, and the pinned `codex-upstream` checkout. Reproduce the probe from this workspace with:

```sh
pnpm exec tsx F:/alpha-e2e/artifacts/code-index-settings-research-20261008/settings-probe.mjs
```

The exact-host gate and live model evaluations were not run for this documentation-only investigation. The offline probe
does not establish a quality gain, a speed gain, provider rate-limit behavior, or equivalence between vector stores.

## Recommended follow-up work

1. **Correct the settings contract.** Rename the score setting to "Semantic similarity threshold" and explain that
   keyword matches can still be returned. Reconcile the 200-value UI/schema range with the 100-value runtime cap. Prefer
   one shared effective-cap contract; preserve saved settings through deliberate normalization rather than making older
   imports fail. Add focused UI, configuration and search regressions.
2. **Separate candidate breadth from returned context.** Keep bounded internal candidate retrieval independently of the
   user's output limit, with context packing still enforcing the budget and source checks. Determine the candidate cap
   through measurements before changing production behavior.
3. **Expose accurate diagnostics.** Preserve score type and component scores in typed diagnostic projections. Record
   candidate counts, rejected/stale chunks, packed chunks and estimated context cost. Avoid presenting the hybrid score
   as confidence or promising that the maximum is a guaranteed result count.
4. **Calibrate before changing defaults.** Start with roughly 40–60 labeled repository queries covering exact identifiers,
   conceptual behavior, configuration and error strings, cross-file evidence, scoped searches and questions with no
   relevant evidence. Split tuning and held-out queries, and label relevant source ranges rather than generated answers.

For calibration, freeze the repository revision, chunker, embedding model, dimensions and document/query vectors. Replay
retrieval offline to avoid making repeated provider calls for every settings combination. Compare semantic-only,
keyword-only and current hybrid retrieval. Sweep semantic thresholds `0 / 0.2 / 0.3 / 0.4 / 0.5 / 0.6` and output caps
`10 / 20 / 50 / 100`, first holding each candidate pool at 200 and the estimated context budget at 6,000 to isolate output
effects. Separately evaluate the current coupled candidate formula and alternative bounded candidate depths.

Measure candidate evidence recall, evidence recall after packing, nDCG@10 or reciprocal rank, irrelevant results on
no-evidence queries, distinct files, returned estimated tokens, and p50/p95 search latency on the same warmed index.
Record model-specific score distributions and provider retry/rate-limit effects separately. Use held-out results and
uncertainty estimates to select the smallest candidate/context budget that preserves the required evidence quality.
Until those measurements exist, a lower result maximum or higher threshold is an experiment, not a demonstrated
optimization.
