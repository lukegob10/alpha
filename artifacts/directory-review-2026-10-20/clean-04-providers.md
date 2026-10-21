# Clean-code review 04: provider adapters and transforms

Date: 2026-10-20. Mode: full-surface review, scoped to the assigned provider/transform domain. Read-only audit; no product source or test files changed. Existing dirty `src/api/providers/__tests__/vscode-lm.spec.ts` was preserved.

Good means one typed provider boundary that preserves ordering, tool identities, opaque replay state, usage, cancellation and retry authority across every supported adapter. This pass establishes evidence and follow-up work; it does not close the defects.

**Scoped quality assessment: 78–85/100, medium-high confidence (about 0.8).** Shared stream primitives, canonical history projection, explicit terminal outcomes, and the focused tests are substantive strengths. Gateway process-global state and a parallel error-wrapper implementation are the largest cleanliness/correctness weaknesses. This is a reviewer assessment of this domain, not a measured repository score or a Codex-convergence percentage.

## Findings

### 1. High / must-fix: gateway setup overwrites extension-host-wide transport and CA trust

- **Location:** `src/api/providers/utils/vertex-gateway-transport.ts:44`, especially `:50` and `:53`; process environment writes at `:16` and `:19`.
- **Failure scenario:** Start a Stellar/Vertex profile using a private PEM bundle, then use a direct public API or a concurrent gateway profile with a different PEM. `configurePemCaTransport` replaces the global undici dispatcher and global fetch with the last profile's CA configuration. Unrelated requests inherit that trust store. Provider instances cache successful setup, so the first profile does not restore its trust when the second profile has replaced it. A PEM containing only corporate roots can also make unrelated public HTTPS requests fail. The prior dispatcher is never closed.
- **Owning invariant:** Provider transport and trust configuration must be scoped to that provider/request, and every pool must have an owner. Concurrent sessions must not change each other's execution environment.
- **Proof:** Runnable probe reports `fetchReplaced:true`, both dispatcher replacements `true`, `firstDispatcherClosed:false`, and the first profile no longer configured after the second setup. The helper has active callers in Stellar, Vertex OpenAI, Vertex Gemini, and Anthropic Vertex. Their nearest gateway tests mock this helper completely, so they cannot detect the global mutation.
- **Contract evidence:** [Node 24 TLS documentation](https://nodejs.org/docs/latest-v24.x/api/tls.html#tlscreatesecurecontextoptions) specifies that explicit `ca` replaces default trust. [Undici dispatcher documentation](https://github.com/nodejs/undici/blob/main/README.md#undicisetglobaldispatcherdispatcher) establishes its process-wide scope. Retrieved 2026-10-20; local reproduction uses installed undici 6.28.1 and Node 24.21.0.
- **Smallest complete fix/test:** Return a provider-owned dispatcher/fetch adapter and supply it to the provider SDK, retaining the existing proxy adapter where appropriate. Release it when captured requests finish and the handler is disposed. Add a two-provider test with distinct trust configurations and verify unrelated global fetch/dispatcher identity is unchanged and owned pools close. Do not fix this by repeatedly switching one global dispatcher.

### 2. High / must-fix: Vertex OpenAI wrapping discards retry authority and server delay

- **Location:** `src/api/providers/vertex-openai.ts:269`, particularly `:275` and `:279`–`:281`.
- **Failure scenario:** The shared OpenAI handler returns a 429/503 carrying `retryAfterMs:60000` and/or `retryable:false`. `asVertexOpenAiError` keeps only `status`, `code`, and `errorDetails`, dropping the delay, terminal retry prohibition, category, and error name. The owning Task then sees a retryable rate-limit/transport error without the server delay, so it can retry too soon or retry a provider-designated terminal failure. An opaque `AbortError` also loses its cancellation identity.
- **Owning invariant:** Presentation wrappers must preserve the structured metadata consumed by the single retry/cancellation owner.
- **Proof:** The actual wrapper, transpiled directly from its source by the probe, converts `{status:429,retryAfterMs:60000,retryable:false,retryCategory:"rate-limit",name:"ProviderError"}` into status 429/name Error with all three retry fields absent. Active callers are the stream and single-completion catch paths at `vertex-openai.ts:118` and `:138`. `Task.ts:6371` reads the delay and `:16838` enforces `retryable:false`. The shared `utils/error-handler.ts:19` already preserves these fields; Stellar uses it while this sibling adapter duplicates a weaker implementation.
- **Upstream evidence:** At current Codex pin `d571eaf1f61d0d93a797506335a99a9950ffe37b`, [api_bridge.rs](https://github.com/openai/codex/blob/d571eaf1f61d0d93a797506335a99a9950ffe37b/codex-rs/codex-api/src/api_bridge.rs#L22) preserves retry advice through error mapping. [Its paused-time test](https://github.com/openai/codex/blob/d571eaf1f61d0d93a797506335a99a9950ffe37b/codex-rs/codex-api/src/api_bridge_tests.rs#L77) separately checks that advice cannot make hard failures retryable. Inspected from the shared checkout on 2026-10-20.
- **Smallest complete fix/test:** Reuse `handleProviderError` with the existing Vertex message transformer instead of maintaining another metadata copier. Add streaming and non-streaming Vertex cases for 429 with Retry-After, `retryable:false`, explicit category, and an opaque AbortError; assert the owning retry policy receives the original authority and delay.

### 3. Medium / should-fix: retired Helix configurations keep refreshing forever

- **Location:** `src/api/providers/utils/helix-token-manager.ts:32`, `:46`, and `:106`.
- **Failure scenario:** A user changes the Helix command, token-field configuration, or refresh interval, or switches away from the gateway provider. Every distinct normalized configuration remains in the static `instances` map; once used, its timer continues launching the old credential command and rescheduling indefinitely. No release/dispose/eviction path exists. `unref()` permits process exit but does not stop work while the extension host remains alive.
- **Owning invariant:** Timers, child processes, and credential caches need explicit lifetimes, bounded retention, and cleanup on provider retirement.
- **Proof:** With command execution and timers controlled, the probe acquires two configurations without retaining caller references, fires the first configuration's timer, and reports `disposeAvailable:false`, `retainedManagers:2`, `commandCallsAfterOldTimer:3`, and `scheduledTimers:3`. No runtime consumer has a manager-release path. Existing unit tests cover parsing/caching/forced refresh, not retirement.
- **Smallest complete fix/test:** Give shared managers leases or reference-counted ownership, release them from provider disposal after captured requests drain, clear timers/token retention and remove unused map entries, and ensure a late refresh cannot re-arm a disposed manager. An alternative is bounded, on-demand refresh without permanent background timers. Use fake timers and a controlled in-flight command to test profile changes, shared users, disposal during refresh, and final release.

### 4. Medium / should-fix: Gemini signature replay loses its original part boundary

- **Location:** `src/api/transform/gemini-format.ts:170`; source capture at `src/api/providers/gemini.ts:875` and `:1015`; legacy storage at `src/core/task/Task.ts:2862`.
- **Failure scenario:** A text-only Gemini response carries a thought signature on its final text part or on a final empty part. Capture reduces all signatures to a response-level `lastThoughtSignature`; Task saves a standalone block; conversion attaches it to `parts[0]`. Original source-part association and empty signed parts cannot be reconstructed. This is a deterministic replay-contract violation, even when the API does not reject the non-function-calling request.
- **Owning invariant:** Opaque provider state must retain its source part and ordering through persistence/reload and request projection.
- **Proof:** For two text parts and a stored signature from the last source part, the converter probe returns `replaySignedIndexes:[0]`. The provider only exposes one response-wide signature, so a converter-only swap to the last part would still be insufficient for all legacy/signed-part combinations.
- **Contract evidence:** [Google's Generate Content thought-signature contract](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures) requires returning a signature in the exact part that supplied it and describes final empty signed streaming parts. Retrieved 2026-10-20. No live-model quality degradation is claimed or measured here.
- **Smallest complete fix/test:** Capture additive, indexed Gemini part metadata in canonical response/history data and project signatures on those same parts, including empty parts. Retain a conservative reader for old standalone signature blocks. Add provider-to-history-to-reload-to-request tests for multiple text parts, final empty signed parts, first signed parallel function call, and interrupted responses.

## Verification

Executed with Node **24.21.0** and pnpm **11.24.0**:

```powershell
pnpm --dir src test api/providers/__tests__/vertex-openai.spec.ts api/providers/__tests__/openai-provider-outcomes.ws06.spec.ts api/transform/__tests__/tool-history-replay.spec.ts api/transform/__tests__/stream.spec.ts --maxWorkers=1
```

Result: **4 files passed, 201 tests passed**, reported duration 8.00 seconds. These are existing contract tests; passing them does not cover the four gaps above.

```powershell
node artifacts/directory-review-2026-10-20/clean-04-provider-probes.cjs
```

Result:

```json
{"probe":"global transport","fetchReplaced":true,"firstDispatcherReplaced":true,"secondDispatcherReplaced":true,"firstDispatcherClosed":false,"firstProfileStillConfigured":false}
{"probe":"gateway retry metadata","status":429,"name":"Error","hasRetryAfter":false,"hasRetryable":false,"hasRetryCategory":false}
{"probe":"retired token manager","disposeAvailable":false,"retainedManagers":2,"commandCallsAfterOldTimer":3,"scheduledTimers":3}
{"probe":"Gemini signature position","originalSignedPart":"last","replaySignedIndexes":[0],"replay":[{"text":"First source part.","thoughtSignature":"signature-from-last-source-part"},{"text":"Last source part."}]}
```

The probe transpiles unchanged source in an isolated Node process. Transport inspection uses public built-in CA certificates without network requests; Helix execution/timers are stubs; the Gemini example stubs only unrelated history normalization/localization. It does not modify product files or contact credential services.

## Coverage and closure

- **Reviewed:** Provider factory/callers; OpenAI Chat and Responses streaming/non-streaming outcome, tool identity, opaque reasoning, phase and usage paths; Vertex/Stellar wrapper ownership; Anthropic signed/redacted reasoning and cumulative usage; Gemini tool/signature handling; VS Code LM cancellation, opaque thinking/state markers, usage and message projection; shared stream/abort and tool-history contracts. Read nearest provider/history/transform tests, shared canonical accumulator/history code and Task request/retry/persistence callers.
- **Positive evidence:** One provider-neutral stream union and canonical accumulator, strict tool-schema conversion, backward tool-history normalization, indexed Anthropic reasoning replay, and substantial explicit failure/cancellation tests. OpenAI's shared outcome suite protects safe retry metadata; the Vertex wrapper gap demonstrates why sibling adapters should use that implementation.
- **Fixed now:** None; this assignment is read-only.
- **Flagged for follow-up:** Four findings above.
- **Not verified:** Live provider services, real corporate PEM/proxy setups, actual credential commands, exact VS Code 1.138.0/1.125.0 hosts, end-to-end task cancellation, all provider tests, typecheck/build and performance measurements. No source changes were made, so no changed-surface exact-host gate is claimed.
- **Out of scope:** Sandbox convergence, broad scheduler/UI/tool-policy implementation and production fixes. No new sandbox/runtime design is suggested.
- **Recommended next pass:** Operational hardening of provider-owned transport/credential lifetimes, followed by provider contract alignment for Vertex error metadata and Gemini part replay.
