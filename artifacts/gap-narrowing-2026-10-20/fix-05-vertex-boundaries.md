# Fix 05: Vertex error boundaries

Date: 2026-10-20. Mode: contract alignment, bounded to Vertex OpenAI error metadata and gateway transport ownership evidence. This closes the error-wrapper defect in review finding 2; the process-global transport defect in finding 1 remains open.

## Fixed now

`src/api/providers/vertex-openai.ts` now uses the existing `handleProviderError` mapper with the existing Vertex message transformer. The wrapper retains normalized `retryAfterMs`, explicit `retryable` and `retryCategory`, and the error name alongside status/code/details. Error presentation no longer discards server scheduling advice or changes an opaque `AbortError` into an ordinary error. Raw headers are not copied into the wrapped error.

The owning Task retry and cancellation policies remain responsible for their decisions. No retry loop, policy, timeout, capability, or token-refresh semantics were added. The existing one-refresh authentication recovery remains unchanged. The same wrapper serves streaming, non-streaming `createMessage`, `completePrompt`, credential/setup failures, and asynchronous iterator errors.

Thirteen regression cases were added in `src/api/providers/__tests__/vertex-openai.spec.ts`: 429/503 terminal failures retaining retry prohibition, category, delay and error name across three request surfaces; safe Retry-After advice reaching `AgentRetryPolicy`; opaque cancellation classification; and a response iterator failing after visible text without an adapter replay. Existing endpoint, settings, routing, and authentication-refresh tests remain in place.

## Before and after evidence

Runtime: Node 24.21.0, pnpm 11.24.0. Tests are offline SDK fixtures; no credentials or provider services were used.

1. Before the source fix, the first twelve new regression cases failed, while seventeen existing Vertex tests passed. Failures showed missing delay, explicit retry authority/category, and name. Command:

    ```powershell
    pnpm --dir src test api/providers/__tests__/vertex-openai.spec.ts --maxWorkers=1
    ```

2. After the source fix, the same command passed 29/29 tests. The late-iterator regression was then added.
3. The combined check passed **5 files / 126 tests**, including all 30 Vertex cases:

    ```powershell
    pnpm --dir src test api/providers/__tests__/vertex-openai.spec.ts api/providers/__tests__/stellar.spec.ts api/providers/__tests__/gateway-setup-retry.spec.ts api/providers/__tests__/single-completion-cancellation.openai.spec.ts api/providers/utils/__tests__/error-handler.spec.ts --maxWorkers=1
    ```

4. `git diff --check` and a Prettier check passed for the two changed source/test files and transport probe.
5. `pnpm --dir src check-types` ran and failed in the concurrent shared workspace at `services/scheduled-tasks/__tests__/ScheduledTaskService.command-process.integration.spec.ts:153` (`Promise<void> | undefined` passed where `Promise<void>` is required) and `services/scheduled-tasks/runScheduledCommand.ts:3` (missing `../../utils/processTree`). No Vertex errors were reported. These files belong to another active change; they were not edited here. An aggregate typecheck after that work settles remains required.

## High / must-fix: gateway transport pollution is deferred

The unchanged `src/api/providers/utils/vertex-gateway-transport.ts` still writes `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS`, installs a process-global undici dispatcher, and replaces global fetch. Successful setup is cached per handler while the helper tracks only one PEM path. Superseded dispatchers have no owner or close path. This remains an operational and trust-isolation defect, not a completed fix.

All active callers were mapped:

| Runtime caller                                                                              | Helper                            | SDK transport seam and lifetime                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stellar.ts:prepareClient`                                                                  | `configurePemCaTransport`         | OpenAI 5.12.2 has constructor `fetch`/`fetchOptions`; client is replaced on token refresh; no handler transport disposal today.                                                                                                                                                                                                 |
| `vertex-openai.ts:prepareClient`                                                            | `configureVertexGatewayTransport` | Same OpenAI seam; shared setup promise, token-driven client replacement.                                                                                                                                                                                                                                                        |
| `gemini.ts:VertexGeminiHandler.ensureGatewayTransportConfigured` (inherited by `vertex.ts`) | `configureVertexGatewayTransport` | GoogleGenAI 1.47.0 `GoogleGenAIOptions`/`HttpOptions` has no public fetch/dispatcher option for `models.generateContent` or `generateContentStream`; private `ApiClient.apiCall` calls global fetch directly. The separately bundled next-generation interactions client has a fetch option, but it is a different API surface. |
| `anthropic-vertex.ts:ensureGatewayTransportConfigured`                                      | `configureVertexGatewayTransport` | Anthropic Vertex 0.7.0 supports constructor `fetch`/`httpAgent`; handler captures global fetch for its logging wrapper and caches clients for routed projects/locations.                                                                                                                                                        |

`ApiHandler.dispose` and Task retirement already provide an adapter disposal boundary after captured requests finish, but none of these gateway adapters currently owns a transport to dispose. A helper-only change cannot supply private CA trust to the current Gemini model SDK without global mutation or unsupported internal modification. Changing the three other adapters alone would leave the fourth path able to replace extension-host globals. No partial global removal, per-request global swapping, SDK private patching, dependency change, or proxy bypass was introduced.

The dedicated no-network probe transpiles the unchanged helper in an isolated Node process, invokes the helper variants used by four gateway profiles with four public bundled root certificates, and inspects global identities and pool closure:

```powershell
node artifacts/gap-narrowing-2026-10-20/fix-05-transport-probe.cjs
```

Observed for every profile: `fetchChanged:true`, `dispatcherChanged:true`, `environmentChanged:true`. The earlier profile was no longer recorded as configured, and the three superseded pools reported `[false,false,false]` for closed state. The debug-proxy branch retained its existing dispatcher. The probe's final cleanup reported `fetchRestored`, `dispatcherRestored`, `environmentRestored`, `createdPoolsClosed`, and `temporaryRemoved` all true. These are reproducible characterization results of the **remaining defect**, not passing product isolation tests.

### Bounded follow-up plan and acceptance criteria

1. Resolve the Gemini model SDK injection seam first: verify a supported version/API can accept a caller-owned fetch/dispatcher for the existing generate-content surfaces, with a deliberate dependency decision if required. If none exists, scope a Gemini gateway HTTP adapter using the existing Alpha request conversion, streaming projection, cancellation and error handling. Do not copy the SDK or create a second agent runtime. Do not patch its private ApiClient or change globals around requests.
2. Replace the helper's returned path with an owned transport containing an injected fetch and idempotent close/dispose. Read and validate the configured PEM without writing process environment. Preserve the configured explicit CA trust behavior deliberately; Node's explicit `ca` replaces default roots. In debug proxy mode retain the existing proxy selection and trust behavior through the established adapter rather than bypassing it.
3. Inject that same provider-owned transport through Stellar and Vertex OpenAI client replacements, Gemini gateway requests, and every Anthropic Vertex routed client. Keep one setup promise per handler, clear rejected setup, close successfully created transport after disposal even if initialization resolves late, and never close the extension's shared debug-proxy dispatcher. Coordinate with existing captured-request retirement so token refresh and profile replacement cannot close an active request's pool.
4. Add deterministic two-provider tests using different PEMs and controlled streams. Assert global fetch, global dispatcher, both CA environment variables and unrelated direct-provider requests remain unchanged. Assert each request uses its own dispatcher; setup failure/cancellation/late initialization, auth client replacement, routed-client reuse, early iterator return, repeated disposal, and normal retirement release only owned resources. Preserve debug proxy tests and verify 1.138.0/1.125.0 integration gates when authorized and available.

## Sources and compatibility

- Inspected local Codex checkout `C:/Users/Luke Goblirsch/AppData/Local/Temp/ac-c7234c1`, verified HEAD **c7234c1174b27d9c55199fba0d546dc27d1b0415**. [`api_bridge.rs:22`](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/codex-api/src/api_bridge.rs#L22) preserves retry advice through mapping; [`api_bridge_tests.rs:77`](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/codex-api/src/api_bridge_tests.rs#L77) keeps hard errors terminal while retaining advice. Alpha reuses its native mapper and policy; no upstream implementation or prompts were copied.
- [Node 24.21.0 fetch dispatcher contract](https://github.com/nodejs/node/blob/v24.21.0/doc/api/globals.md#custom-dispatcher) documents request-local dispatchers and the process-wide effect of `setGlobalDispatcher`. [Node TLS CA contract](https://github.com/nodejs/node/blob/v24.21.0/doc/api/tls.md#tlscreatesecurecontextoptions) documents replacement of default roots by explicit CA trust. [undici 6.28.1](https://github.com/nodejs/undici/tree/v6.28.1) and its installed Agent API were inspected.
- [OpenAI 5.12.2 fetch configuration](https://github.com/openai/openai-node/blob/v5.12.2/README.md#customizing-the-fetch-client), installed OpenAI client types, and installed Anthropic Vertex 0.7.0 `client.d.ts` establish the injectable SDK seams. [GoogleGenAI 1.47.0 public client](https://github.com/googleapis/js-genai/blob/v1.47.0/src/client.ts), [Node client](https://github.com/googleapis/js-genai/blob/v1.47.0/src/node/node_client.ts), [HTTP types](https://github.com/googleapis/js-genai/blob/v1.47.0/src/types.ts), and [private API call](https://github.com/googleapis/js-genai/blob/v1.47.0/src/_api_client.ts#L658) establish the missing Gemini model seam. Sources inspected 2026-10-20.

No public/persisted formats, settings, VS Code APIs, or provider request schemas changed. No source edits were made outside the assigned Vertex wrapper and its test. This pass did not alter `openai.ts`, Task, transport/proxy code, Helix lifetime, Gemini replay, or shared error handling owned by other work.

## Closure ledger

- **Fixed now:** Vertex metadata loss, with failing-before/passing-after coverage.
- **Flagged for follow-up:** High-impact process-global transport ownership defect, with a concrete all-callers plan above.
- **Not verified:** Real private PEM/proxy chains, live credential commands/services, exact VS Code 1.138.0/1.125.0 hosts, full provider suite, packaging, builds and performance. Host runs and broad builds were excluded from this assignment; deterministic lower-level provider/cancellation checks ran instead. No speed/quality gain is claimed.
- **Out of scope:** Sandbox alignment, broad provider/runtime redesign, Helix token-manager retirement and Gemini signed-part replay (separate owners).
