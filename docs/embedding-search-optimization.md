# Embedding Search Optimization

This document explains what is missing from Alpha's current codebase search and the proposed path to improve it using the infrastructure currently available: Vertex-hosted embedding models and Vertex-hosted chat completion models.

## Current State

Alpha's codebase search currently works as a dense vector search:

1. Code files are parsed into chunks.
2. Chunks are embedded.
3. Vectors are stored in LanceDB or Qdrant.
4. A search query is embedded.
5. The vector store returns chunks by cosine similarity.
6. Results are returned to the model as file path, score, line range, and code chunk.

This is a good baseline. It is useful for broad semantic discovery, especially when the user does not know the exact file or symbol.

It is not enough by itself for high-quality repository search.

## What Is Missing

### 1. Exact Match Search

Cosine similarity is weak for exact code terms.

Code search often depends on exact strings:

- function names
- class names
- file names
- setting keys
- provider names
- environment variables
- error messages
- test names
- route strings

If the query contains `codebaseIndexEmbedderModelDimension`, semantic similarity should not be the primary matching mechanic. Exact match should dominate.

### 2. Query Planning

The current search embeds one query and searches once.

That misses cases where the user's wording does not look like the code. For example:

- User asks: "Why does the embedding dimension disappear after import?"
- Code may contain: `codebaseIndexEmbedderModelDimension`, `importGlobalSettings`, `codebaseIndexConfig`

The system should derive better search variants before searching.

### 3. Result Ranking Beyond Cosine Score

Current ranking is mostly vector score plus threshold.

For code, relevance should also consider:

- exact identifier matches
- path matches
- symbol names
- file type
- whether the file is a test, config, source file, or docs file
- recently opened or edited files
- directory prefix
- duplicate chunks from the same file

Without this, a semantically similar chunk can outrank the file the agent actually needs.

### 4. Token-Budgeted Results

Search results are returned as code chunks. Those chunks become model context.

Embeddings only reduce token usage if the returned context is smaller and more relevant than the files it avoids reading.

Currently missing:

- max token budget for search output
- snippet deduplication
- per-file result limits
- compact metadata-first output
- "read this exact file/range next" suggestions

### 5. Evaluation

There is no clear retrieval benchmark that says whether search is improving.

We need to know:

- Did search return the file later read?
- Did search return the file later edited?
- Did search avoid unnecessary file reads?
- Did search reduce total task tokens?
- Which embedding model works best on this codebase?

Without this, model choice and search tuning are guesses.

### 6. Chunk Quality

Chunks are not just a storage detail. They define what the embedding model can match.

Current chunking is moderately intelligent:

- Code uses tree-sitter where possible.
- Markdown is split by headers and sections.
- Unsupported or parser-problematic files fall back to line-based chunking.
- Very small chunks are skipped.
- Large chunks are split around a maximum character size.
- Chunks keep file path, line range, type, identifier when available, file hash, and segment hash.

That is better than naive fixed-size text splitting.

The limitation is that chunks are still mostly isolated code blocks. They may lack:

- parent class or module context
- imports and exports
- file-level purpose
- neighboring helper functions
- comments/docstrings connected to the symbol
- test/source relationships
- route/config ownership

This can cause two problems:

- The right code may not match because the chunk lacks surrounding vocabulary.
- The returned chunk may be too small or too local for the model to understand why it matters.

## Proposed Solution

The practical solution is not to build a huge retrieval system immediately. The next step should be a small, focused improvement over the current cosine-only flow.

### 1. Keep Cosine Search, But Add Exact Matching

Continue using embeddings for semantic discovery.

Add an exact-match layer over:

- file paths
- file names
- symbol names
- chunk text
- setting names
- error strings
- test names

Then merge exact-match candidates with embedding candidates.

This gets Alpha closer to hybrid search without requiring a dedicated search platform or reranker.

### 2. Add Simple Query Expansion

Before searching, generate a few search variants from the user's query.

Example:

User query:

`Why does the code index dimension disappear after import?`

Search variants:

- `code index dimension import`
- `codebaseIndexEmbedderModelDimension`
- `codebaseIndexConfig import export`
- `embedding model dimension settings`

Use embeddings for the natural-language variants and exact matching for identifiers.

This should improve recall without adding much complexity.

### 3. Add Heuristic Reranking

No dedicated reranker is available right now. That is fine.

Start with deterministic reranking:

Boost:

- exact symbol match
- exact file/path match
- setting key match
- error string match
- files in requested directory
- files recently opened or modified
- tests when query mentions failures
- config files when query mentions settings, providers, models, or environment

Penalize:

- duplicate chunks from the same file
- generated files
- vendor files
- oversized chunks
- weak vector matches with no lexical overlap

This is cheaper, explainable, and likely enough for a major quality improvement.

### 4. Use Vertex Chat As An Optional Reranker

Since there is no dedicated reranker, use a Vertex chat completion model only when needed.

Do not rerank every search with chat. That can become expensive.

Use chat reranking when:

- top cosine scores are close together
- results are broad or noisy
- exact and semantic results disagree
- the task is large enough that bad retrieval would cause many file reads

The chat reranker should receive compact candidate metadata:

- user task
- file path
- symbol name if available
- line range
- short excerpt
- match reason

It should return:

- top candidates
- reason for relevance
- whether to read the file before editing

This gives some reranking benefits using infrastructure already available through Vertex.

### 5. Return Less Code By Default

Search output should be metadata-first.

Default result format should prioritize:

- path
- symbol
- line range
- score
- match reason
- short excerpt

Only include larger code chunks when confidence is high or when the model explicitly needs the code.

Before editing, the agent should still read the exact file or range. Search should guide inspection, not replace exact file reads.

### 6. Improve Chunk Context

Keep the current tree-sitter chunking, but enrich what gets embedded.

Practical improvements:

- Include file path and symbol name in the embedded text.
- Include parent class/function/module name when available.
- Include nearby comments or docstrings.
- Include import/export summary for the file.
- Add a file-level summary chunk for each file.
- Add smaller symbol chunks plus a larger file-summary chunk.
- Store chunk token count so search output can be budgeted.
- Preserve exact line ranges so the model can read the real file before editing.

The goal is not bigger chunks. The goal is better context per chunk.

Example embedded text could conceptually include:

- file path
- language
- symbol name
- parent symbol
- imports/exports summary
- code excerpt

The search result shown to the model can still stay compact.

## Vertex Embedding Model Plan

The company environment has multiple embedding models available through Vertex. The right model should be selected by repository-search performance, not by assumption.

Models to test:

- Gemini embedding models
- MS MARCO BERT / `mass.v5`
- GTE large EN v1.5

Evaluate each model on real Alpha tasks:

- natural-language feature searches
- exact identifier searches
- settings/configuration searches
- bug/error searches
- stack trace searches
- test failure searches
- documentation-to-code searches

Compare:

- Recall@5 for files later read
- Recall@10 for files later edited
- first relevant result position
- total search result tokens
- number of follow-up file reads
- search latency
- embedding cost

Expected model behavior:

- Gemini embeddings may be strong for natural-language-to-code and docs-to-code search.
- GTE large EN v1.5 may be a strong general retrieval baseline.
- MS MARCO BERT / `mass.v5` may perform well on passage-style text matching, but needs validation on code identifiers.

The winning model is the one that helps Alpha find the right files with the fewest downstream tokens.

## Token Usage Impact

Embeddings reduce token usage only when they prevent larger context from being sent.

They help when:

- search finds the right files early
- fewer full files are read
- results are compact
- duplicate chunks are removed
- search output is not kept forever in history

They do not help when:

- too many chunks are returned
- chunks are large
- results are noisy
- the model still reads many full files
- search output stays in the conversation until context compression

The goal is not "compress every context window." The better goal is to avoid filling the context window with irrelevant search and file output in the first place.

## Recommended Near-Term Plan

### Step 1: Measure Current Search

Track:

- query
- embedding model
- returned files
- returned token count
- scores
- whether each returned file was later read or edited

### Step 2: Run An Embedding Model Bake-Off

Test Gemini embeddings, MS MARCO BERT / `mass.v5`, and GTE large EN v1.5 on the same task set.

Pick the model that performs best on real repository tasks.

### Step 3: Add Exact Match Candidates

Add simple exact matching over file paths, symbols, and chunk text.

Merge those results with cosine similarity results.

### Step 4: Add Heuristic Reranking

Boost exact matches, path matches, relevant file types, and recently active files.

Penalize duplicate or low-confidence chunks.

### Step 5: Add Token-Budgeted Search Output

Return fewer, better results.

Use compact excerpts and metadata first.

### Step 6: Improve Chunk Context

Enrich embedded chunks with path, symbol, parent, comments, and file-level summary context.

Keep returned results compact.

### Step 7: Use Vertex Chat Reranking Only For Ambiguous Searches

Use chat completion as a selective fallback, not as a default step.

## Final Recommendation

The current cosine similarity search is a good baseline, but the missing pieces are exact matching, query expansion, heuristic reranking, token-budgeted results, better chunk context, and measurement.

The best next version is:

1. Dense embedding search through Vertex.
2. Exact match search over code metadata and chunk text.
3. Simple query expansion.
4. Heuristic reranking.
5. Compact, token-budgeted results.
6. Better chunk context.
7. Optional Vertex chat reranking only when search confidence is low.

This is a practical improvement path. It gets Alpha much closer to modern code retrieval without requiring a dedicated reranker or a major architecture rebuild.
