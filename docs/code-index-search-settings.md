# Code index search settings

The baseline is a semantic threshold of **0.4** and a maximum of **50 code chunks**. Search breadth and returned context
have separate bounds.

## Settings and compatibility

| Setting                       | Range                       | Meaning                                                                                                                        |
| ----------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Semantic similarity threshold | 0–1, step 0.05; default 0.4 | Filters semantic candidates before fusion. Keyword matches remain eligible. A similarity score is not a confidence percentage. |
| Maximum code chunks           | 10–100, step 10; default 50 | Caps returned chunks after fusion, deduplication, source validation and context packing. It does not reduce candidate depth.   |

`packages/types/src/codebase-index.ts` owns the shared limits and normalization. Settings imports still accept the older
10–200 range, but values above 100 normalize to 100. The configuration manager and popover also normalize persisted
values, so reading an existing setting does not require rewriting user storage. Normalization truncates fractional
values to whole chunks, clamps the supported range, and uses 50 for an absent or non-finite value. It is idempotent.

Search-only changes do not rebuild the index. The popover keeps edits local until Save, and extension-state refreshes do
not overwrite those edits. Both sliders have accessible names matching their visible labels.

## Retrieval and diagnostics

Each semantic and keyword channel retrieves at most **200 candidates**, the same breadth previously used by the default
50-result setting. Fusion combines their ranks with the existing reciprocal rank fusion implementation. Small output
limits now retain this search breadth rather than reducing each candidate list to `max(40, output limit × 4)`.

Packing retains complete, distinct chunks within **6,000 estimated token units**. Accounting uses the existing
`ceil(o200k_base tokens × 1.5)` estimate plus 40 units per chunk; it is not exact provider billing. Workspace scope, ignore
rules, access checks, source hashes and content validation continue to filter evidence. Searches can return fewer chunks
than the configured maximum.

`searchIndex()` retains its array-returning contract. The additive `searchIndexWithDiagnostics()` method returns the same
results with bounded counts for semantic, keyword and fused candidates, the effective output cap, examined candidates,
returned chunks, estimated context cost, and exclusions due to duplication, budget, source checks or invalid payloads.
`remainingCandidates` counts candidates not examined after the output cap is reached. Exclusion counts describe examined
candidates only; they are not an audit of every indexed chunk or all remaining matches.

Tool messages preserve `scoreType`, `semanticScore`, `lexicalScore` and optional diagnostics through a shared, validated
schema. Model-facing output labels the final score as a hybrid rank score. The expanded results list explains omissions
caused by the budget or output limit. Older messages without these fields remain readable. Malformed messages are safely
ignored by the renderer.

This change tunes retrieval behavior and settings accuracy. It does not change document embedding batches, provider
quotas, indexing concurrency or initial indexing throughput. Each search still invokes one logical query embedding
operation; provider retries can add network requests.

## Offline measurement and validation

The deterministic measurement command is:

```sh
pnpm exec tsx scripts/benchmarks/code-index-search.ts
```

It compares the current search service with a replay of the 3.1.8 candidate formula using the same ranked fixtures,
fusion and context packer. Four fixtures cover a keyword identifier, shared evidence below the old small-limit cutoff,
many short chunks and a medium-chunk context budget, each at output limits 10, 20, 50, 100 and 200. There are no provider
requests. The measured quantities are candidate limits, known evidence retained, output count and estimated context
cost; these fixtures are not a real-repository quality evaluation or a historical latency benchmark.

At a 10-chunk output cap, evidence ranked 61st in both channels was absent with the old 40-candidate formula and ranks
first with the current bound. At output caps of 50 or higher, these fixtures retain the same output count and estimated
context cost as the baseline. Smaller output limits now retrieve more candidates, so database latency may increase;
measure it on the actual index rather than claiming a universal speed gain.

Focused regressions cover legacy setting normalization, settings saves and refreshes, lexical fallback, high semantic
thresholds, empty searches, score semantics, candidate breadth, budget and exclusion accounting, stale source and
out-of-scope junction rejection, tool metadata, and old/malformed saved messages. Run the affected tests and typechecks,
then the required deterministic VS Code 1.125.0 gate:

```sh
pnpm --filter @alpha-code/types test --maxWorkers=2
pnpm --filter @alpha-code/types check-types
pnpm --dir src check-types
pnpm --dir webview-ui check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```

Default calibration still requires labeled repository queries, frozen model/dimensions and query/document embeddings,
and held-out relevance plus latency measurements. Keep 0.4 and 50 until that evidence
supports a change. Live provider measurements require the dedicated signed-in profile; deterministic tests and the
offline measurement do not require sign-in.
