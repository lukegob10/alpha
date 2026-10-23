# Code index retrieval

Code search uses Alpha's shared indexing service independently of the selected chat model. Supported embedding
connections are GCP Vertex AI (`vertex`) and Gemini Developer API (`gemini`); storage uses Qdrant or local LanceDB.

## Source and indexing contracts

The parser retains exact source, including small declarations, imports, comments, and parse-error regions. Syntax scopes
supply enclosing names and signatures; unsupported grammars use bounded source chunks. Markdown retains heading ancestry
and matching code fences. Chunk bodies are bounded to 768 conservative token units and 4,096 characters; scope context has
a separate 256-unit/1,000-character cap. These units use the local tokenizer's safety factor, not provider billing.

Initial scans and filesystem updates share embedding inputs, point identities, and metadata. File discovery uses the
existing ripgrep-backed listing and respects Git ignores, `.alphaignore`, path scope, and cancellation. A batch must
produce one finite vector of consistent dimensions per input before replacing stored chunks. Cache hashes commit after
successful writes. Accepted replacement work settles before teardown; cancelled discovery cannot trigger deletion pruning.

Document and query embedding roles remain distinct. Vertex gateway routes preserve their raw-content payload contract.
Gemini indexing owns a SecretStorage key independently of chat settings. Adapters bound concurrent requests and queued work,
pace actual requests, share cooldown after throttling, and honor cancellation. Storage retries reuse validated vectors
instead of restarting a failed provider retry budget.

## Search settings

[Shared settings and limits](../packages/types/src/codebase-index.ts) own defaults, import compatibility, and normalization.

| Setting             | Supported values   | Meaning                                                             |
| ------------------- | ------------------ | ------------------------------------------------------------------- |
| Semantic threshold  | 0–1; default 0.4   | Filters semantic candidates. Keyword evidence remains eligible.     |
| Maximum code chunks | 10–100; default 50 | Caps packed results after fusion, source checks, and deduplication. |

Older imports accepting up to 200 chunks remain readable; values above 100 normalize to 100. Normalization truncates
fractions, clamps the range, and uses 50 for absent/non-finite values without rewriting storage. Search-only settings do
not rebuild the index. Popover edits remain local until Save and survive unrelated extension-state refreshes.

## Retrieval and freshness

The [search service](../src/services/code-index/search-service.ts) retrieves semantic, indexed lexical, and available
fresh-source evidence concurrently. Search can run while an index is catching up. Each ranked channel is bounded to
200 candidates independently of the requested output cap. Identifier terms retain whole names and camel/snake components.

Reciprocal rank fusion combines ranks with offset 60; it does not add cosine and lexical scores. Packing returns complete,
distinct chunks within 6,000 estimated token units, including formatting allowance. The configured result count is an
upper bound, not a guarantee.

Before returning evidence, the service rechecks the task's workspace, resolved path, ignore access, current file hash,
and exact source extent. Stale vectors cannot hide current lexical evidence for the same chunk. Failed channels may fall
back to validated available evidence; a failure with no usable evidence is reported. Search failure does not change the
index lifecycle into Error. Cancellation releases owned listeners and pending requests.

`searchIndex()` keeps its array result. The additive `searchIndexWithDiagnostics()` returns bounded candidate, packing,
freshness, and channel-status metadata. Exclusion counts describe examined candidates; they do not audit the entire index.
Saved messages without diagnostics remain readable, and malformed result metadata is rejected by the renderer.
Hybrid rank scores express rank agreement, not confidence percentages.

Chat results preserve source navigation, enclosing context, and expansion through the existing row controller. Presentation
uses VS Code theme tokens and keyboard-operable controls.

## Index compatibility

Index metadata fingerprints the representation version, embedding provider/model, dimensions, and relevant endpoint or
routing identity. Credentials are excluded. Incompatible or legacy indexes rebuild through the existing initialization
path, including same-dimension model changes. Key rotation alone does not require re-embedding. Gateway-specific raw-input
identity remains distinct from direct Vertex identity.

Changes to chunk representation, embedding inputs, or lexical encoding must update the corresponding fingerprint.
Existing task/settings formats and collection/table naming remain compatible. Unsupported saved providers require explicit
repair under the [provider recovery contract](provider-reduction.md).

## Validation

```sh
pnpm --dir src test services/code-index core/tools/__tests__/CodebaseSearchTool.spec.ts
pnpm --filter @alpha-code/types test
pnpm --dir src check-types
pnpm --dir webview-ui check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
```

Use the native temporary LanceDB tests for backend behavior and stubbed HTTP tests for adapter payloads. Deterministic
fixtures do not prove live IAM access, gateway compatibility, provider quotas, retrieval quality, or production throughput.
