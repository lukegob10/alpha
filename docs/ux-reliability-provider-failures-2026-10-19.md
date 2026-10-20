# Provider failure and setup audit

Audited on October 19, 2026. This slice covers non-VS Code provider setup and failure metadata; it does not inspect a
specific affected user's credentials, installed extension, or private chat. No live model requests were made.

## Confirmed findings

### P1: A failed gateway setup poisoned the handler until recreation

Stellar's `transportSetupPromise` and Vertex Gemini's `gatewayTransportSetupPromise` retained rejected promises. If a PEM
file was temporarily unavailable, repairing the file and retrying the same task still reused the first rejected promise.
No subsequent certificate check, authentication, or model request occurred. This is a lingering setup failure with the
appearance of a permanently broken chat; it is not evidence of an extension-host process crash.

The owning adapters now evict only the identical failed setup promise. Concurrent callers still share one setup, and a
successful setup remains cached. The first failed request still fails explicitly. The fix adds no automatic retry loop,
does not change the handler's captured settings or policy, and never bypasses certificate validation.

`api/providers/__tests__/gateway-setup-retry.spec.ts` reproduced eight failures before the fix and passes afterward:
both providers, streaming/non-streaming/single-prompt requests, and concurrent failure followed by shared setup retry.
The tests verify no token retrieval or model request occurs after the failed setup and that success remains cached.

### P2: Stellar discarded the shared retry and cancellation classification

`asStellarError` copied only status, code, and error details. Its extra wrapper lost `retryAfterMs`, `retryable`,
`retryCategory`, and `Error.name` after the shared OpenAI adapter had preserved them. The task retry boundary consumes
those fields: explicit non-retryable failures terminate, and server delay advice controls bounded retry timing. Losing
them could cause premature retries, inappropriate retry/manual-retry behavior for permanent errors, or cancellation
misclassification.

Stellar now uses the existing shared `handleProviderError`, retaining its existing user-facing provider prefix while
preserving the shared metadata contract. Nine new regressions failed before the fix and pass afterward: rate limits,
permanent quota failures, and opaque `AbortError` cancellation across all three request surfaces. Authentication refresh
remains bounded to the existing one retry before any emitted chunk.

## Codex CLI comparison

Read current official source and tests at
[`091008729d5572712ac08964a9602eb71cf31428`](https://github.com/openai/codex/commit/091008729d5572712ac08964a9602eb71cf31428),
retrieved October 19, 2026:

- [Responses retry decisions](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/src/responses_retry.rs)
  classify terminal failures, preserve server retry deadlines, bound configured retries, and publish reconnect progress.
  A separately gated feature allows extended connection retries under constrained conditions; Alpha's existing bounded
  retry policy remains unchanged.
- [Retry deadline regression](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/src/responses_retry_tests.rs)
  ensures notification delays do not restart the server's retry deadline.
- [Authentication recovery policy test](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/tests/suite/auth_recovery_policy.rs)
  terminates denied refresh while preserving stored credentials.
- [Catalog/auth tests](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/tests/suite/models_cache_auth.rs)
  invalidate catalogs for changed authentication/provider identity and keep optional discovery best effort under failure
  or stalled authentication.

The applicable behavior is to keep transient setup failure out of permanent caches and preserve authoritative failure
classification through every adapter. These fixes use Alpha's existing TypeScript adapters and retry boundary. They do
not copy Codex's runtime or introduce a new recovery engine.

## Validation and limits

All commands used one Vitest worker and no credentials or external model requests:

- Gateway setup, Stellar, shared error handler, and token-manager tests: 82 passed across four files.
- Vertex provider outcomes, Vertex adapter, and shared retry policy: 77 passed across three files.
- ESLint passed for the four touched TypeScript files. Prettier passed after formatting the touched Stellar adapter.

Extension typecheck and exact VS Code 1.138.0 gates are coordinated by the parent investigation. This audit does not
establish fleet frequency or prove that infrequent updates caused a particular user's failure. These adapter defects
are runtime/setup ownership bugs: a fresh installation alone is not a reliable remedy for either trigger.
