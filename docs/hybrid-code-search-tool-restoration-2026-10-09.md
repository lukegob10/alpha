# Restore the existing hybrid code-search tool

## Reference and intent

Inspected Codex CLI `main` at commit `5ef96ab2785f3ecddf279639eff7b1b42c906fa4` on October 9, 2026
(America/New_York). Its [repository-inspection guidance](https://github.com/openai/codex/blob/5ef96ab2785f3ecddf279639eff7b1b42c906fa4/codex-rs/core/gpt-5.2-codex_prompt.md)
prefers `rg` and `rg --files`. Its [tool-search implementation and tests](https://github.com/openai/codex/blob/5ef96ab2785f3ecddf279639eff7b1b42c906fa4/codex-rs/core/src/tools/handlers/tool_search.rs)
and [tool-search declaration tests](https://github.com/openai/codex/blob/5ef96ab2785f3ecddf279639eff7b1b42c906fa4/codex-rs/core/src/tools/handlers/tool_search_spec.rs)
use local BM25 to discover deferred tools. Tool discovery ranks tool metadata; it does not provide a semantic repository index.

Alpha deliberately retains its existing optional embedding-backed code index. Conceptual requests such as finding the
authentication implementation can benefit from searching meaning and vocabulary together. Exact symbols, filenames, and
error messages continue to use bounded command inspection. No additional model, provider, search service, or ranking
engine is introduced. The configured embedding model and its existing setup and API costs still apply.

## Root cause

The native tool-surface refactor moved `codebase_search` into the legacy schema list and removed its registry descriptor.
The embedding and hybrid retrieval implementation remained intact, and the catalog cache still tracked index availability.
Consequently a configured, initialized index never produced a visible, callable search tool. An availability regression
test failed with `isCallable("codebase_search") === false` before the repair.

## Restored contract

- `codebase_search` is an eager native tool with its existing `query` and nullable `path` wire schema and saved name.
  Existing transcripts remain readable; no persisted format or configuration migration is needed.
- The existing shared mode filter requires indexing to be enabled, configured, and initialized. Code, Plan, and managed
  children retain their existing policy and workspace restrictions. Restricted-provider declarations do not grant
  callability; disabled tools and child allow-lists remain enforced.
- The registry dispatches the existing tool through the shared scheduler as a serial, non-mutating operation with the
  existing approval flow. The caller's cancellation signal reaches the manager, retrieval service, and embedding provider.
  Cancelling one search does not cancel another search in the same workspace. Completed requests release their signal
  subscription, and cancelled tools do not publish late search evidence. Only the retrieval service's own deadline permits
  partial results; a caller's `TimeoutError` remains a cancellation even when keyword candidates are already available.
- Retrieval still combines semantic candidates, indexed lexical matches, and current-source evidence using the existing
  rank fusion and context packing. Existing source validation and ignore rules remain in that implementation.
- The tool declaration explains conceptual discovery and exact-match follow-ups. Partial or incomplete coverage directs
  the model to `exec_command`, `rg`, and direct file reads instead of retired `read_file` and `search_files` tools.
- Ordinary command inspection remains callable when the index is disabled, unconfigured, or uninitialized. Within a
  configured index, the existing retrieval service can return lexical evidence when the embedding provider fails. Tool
  errors and empty or partial results remain explicit and allow the agent to continue with command inspection.

## Verification scope

Regression coverage exercises catalog readiness transitions and immutable captures; OpenAI, Vertex, and VS Code LM
surfaces; Code and Plan; policy restrictions on provider supersets; native registry dispatch in the task workspace;
approval denial; localized coverage guidance; and caller-scoped cancellation through retrieval and late-result handling.
The existing hybrid-search tests cover fusion, freshness validation, and lexical evidence during embedding failure.

Deterministic tests verify availability and retrieval contracts, not the accuracy of a particular embedding model. This
change makes no quality, latency, or token-saving claim. A live comparison on representative repository questions is
separate from the implementation gate and requires recording model, index freshness, workload, and run conditions.

## Schema cost

Measured the declaration against local baseline commit `b0423c06af2341c89948ec2a68f56ffd3e6f037a`, using the same JSON
serialization and `o200k_base` tokenizer, without provider requests. The previous declaration was 1,670 bytes / 336 raw
tokens; the updated declaration is 1,864 bytes / 358 raw tokens, an increase of 194 bytes / 22 tokens for the guidance.
Because the previous declaration was absent from active requests, restoring it adds the full 358-token declaration when
search is available. Default filtered requests omit it when unavailable; restricted-provider supersets retain the
declaration for compatibility while their allowed-function list prevents invocation. These counts exclude request
envelopes and Alpha's safety multiplier and do not represent provider usage or cache savings.

## Completed validation

Ran on Windows with Node.js 24.21.0 and pnpm 11.24.0:

- Focused extension Vitest coverage: 15 files, 376 tests passed. Includes the registry, task surface, catalog cache and
  invalidation, native dispatch, mode filtering, search tool, search service, index manager, scheduler, execution profiles,
  and the existing workflow-prompt size guard.
- `pnpm --dir src check-types`: passed.
- Focused ESLint with `--max-warnings=0` over all touched TypeScript files: passed.
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`: passed all 42 tests across 13 suites on exact VS Code 1.125.0,
  using scripted providers and the VS Code LM fixture. The gate also completed the extension bundle and webview build.
- `git diff --check`: passed. No package manifests, dependency locks, or release versions changed.
