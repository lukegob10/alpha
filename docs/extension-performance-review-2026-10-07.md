# Extension performance review — 2026-10-07

## Scope and reference conditions

This review covers the chat composer viewport, Google code-index request scheduling and retries, indexing configuration, and the shared agent tool scheduler. It used the existing enhanced unit, extension-host, rendered UI, and live workflow suites. Existing hotkey, task-history, reasoning, IPC, and other working-tree changes were preserved.

Repository base: `cd6d8ef4fa3f94b872af75f34016a7156658d689`, with an already modified working tree. Environment: Windows, Node 24.21.0, pnpm 11.24.0, Google GenAI SDK 1.47.0, exact VS Code 1.125.0. No production dependency or lockfile change was required.

Codex CLI source was inspected at upstream commit `82e70121f86bc1f6fea7f2bb7bbc169d259b3c6b`, retrieved on 2026-10-07. Primary contracts consulted:

- [Codex tool runtime](https://github.com/openai/codex/blob/82e70121f86bc1f6fea7f2bb7bbc169d259b3c6b/codex-rs/core/src/tools/parallel.rs) and [parallelism tests](https://github.com/openai/codex/blob/82e70121f86bc1f6fea7f2bb7bbc169d259b3c6b/codex-rs/core/tests/suite/tool_parallelism.rs).
- [Gemini embedding API](https://ai.google.dev/api/embeddings), [retrieval input guidance](https://ai.google.dev/gemini-api/docs/embeddings), and [project rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), checked on 2026-10-07.
- [Vertex embedding contract](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-text-embeddings) and [Google SDK 1.47.0 serializer](https://github.com/googleapis/js-genai/blob/v1.47.0/src/models.ts), checked on 2026-10-07.
- [VS Code webviews](https://code.visualstudio.com/api/extension-guides/webview) and [Chromium input protocol](https://chromedevtools.github.io/devtools-protocol/tot/Input/), supplemented by the actual 1.125.0 renderer.

## Changes and reproduced failures

### Composer clipping and scroll work

The composer applied rounded clipping to the textarea, its highlight overlay, and their inner wrapper. The scrolling text surface needs a rectangular viewport; the surrounding composer provides the visible rounding. All three inner surfaces now use square corners.

Scrolling also rebuilt the highlight DOM, although the underlying text had not changed. The scroll handler now only copies the textarea's horizontal and vertical scroll positions to the overlay. Highlight rebuilding still follows text changes; redundant rebuilding in the input handler was removed.

Three focused regressions failed before the change: square inner viewports for both composer presentations and preserving highlight nodes during scrolling. They pass after the fix. The rendered fixture inserts 45 mention-bearing lines, checks four scroll positions, captures screenshots, and sends native mouse-wheel input through the observed webview frame coordinates. In the reference host, the wheel moved the textarea from 650 to 470 pixels and the highlight layer remained aligned within one pixel. Screenshots were visually inspected.

The initial rendered baseline attempt was blocked by the VS Code updater and supplies no before-image evidence. The new checks verify the resulting layout on 1.125.0; they do not establish which newer Chromium release changed the earlier visual behavior.

### Indexing request and retry ownership

The owning layers are the provider adapters for HTTP pacing and retry budgets, and the scanner for source replacement, storage retries, cache hashes, and progress. Four findings drove the change:

| Finding                               | Observed failure                                                                  | Result                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Storage retries recomputed embeddings | One transient upsert failure caused two embedding calls for the same batch        | Validated points survive storage retries; one embedding call                  |
| Retry budgets were nested             | A terminal adapter failure could restart its complete retry budget in the scanner | A typed terminal request error prevents adapter retries from being multiplied |
| Partial writes inflated progress      | A two-chunk batch reported three indexed chunks after retry                       | Progress advances after the full write/cache sequence succeeds                |
| A 429 paused only its own request     | Other waiting requests continued to start                                         | The adapter applies and extends a shared cooldown for all waiting consumers   |

Scanner regressions reproduced the retry and progress failures before their fixes. Fake-clock tests cover spacing from time zero, extended cooldowns, cancellation ahead of unrelated waiters, and delays beyond the native timer limit. Shared retry parsing preserves gateway header getter behavior, handles Google `RetryInfo` and HTTP dates, and rejects non-finite delay conversions. Three additional retry-parser regressions failed before their corrections.

The scanner passes cancellation to the Google SDK and pacing delays. Adapters reject late responses after cancellation and drain accepted work before surfacing failures. An already started storage replacement still settles through the existing write sequence. Scanner and watcher batch pacing is skipped for adapters that already own actual request pacing, avoiding a second delay layer.

### Gemini Developer API restored

The existing Google SDK supports synchronous `batchEmbedContents`, with an ordered vector per embedded request. The new adapter uses that endpoint through `models.embedContent`; real-SDK HTTP tests check the wire payload and response ordering for both supported models. Explicit Content boundaries prevent separate Embedding 2 chunks from becoming one aggregated vector. The existing retrieval input helper provides model-specific document and query roles.

The adapter admits at most two active requests, up to 60 inputs per payload, and a local 20,000 estimated-token payload budget. Per-item estimates use the existing character-based convention; these are local bounds, not provider-billed token counts. Longer inputs reduce batch size. Tests cover payload splitting, oversized input rejection, simultaneous scan/query requests, 429/503 exhaustion, non-retryable authentication failure, incomplete responses, and cancellation during cooldown.

Gemini is explicitly selectable in the indexing popover and uses its own SecretStorage key. The key is omitted from saved global settings and index fingerprints; the webview receives only a presence flag. Draft input survives secret-status refreshes. Gemini configuration does not depend on the active chat provider or unrelated Vertex credentials. Vertex remains the default. Existing unsupported provider settings remain readable and disabled.

Provider or model changes rebuild incompatible indexes through the existing fingerprint mechanism. Key rotation restarts the adapter without changing the index identity.

An enabled delay reserves time for every input in a Gemini payload. This conservative budget prevents a 60-input batch from multiplying the configured input rate, but can limit batching's throughput benefit. Google limits apply to projects and vary by tier/model; simultaneous workspaces and other clients can still cause 429s. The adapter cooldown is shared within an instance, and does not coordinate project-wide RPM/TPM/daily limits across processes. Live Gemini indexing was not evaluated because a dedicated indexing key was not configured for this review.

## Recorded indexing workload

Command:

```sh
pnpm --dir src test services/code-index/processors/__tests__/vertex-indexing.benchmark.spec.ts
```

The fixture has 85 synthetic files, 20 short chunks per file, 20 ms of parsing per file, and 2 ms per vector-store upsert. HTTP responses are scripted: 100 ms, or 400 ms when a request includes a designated slow chunk. All runs use a cold cache, disabled optional request spacing, no 429s, identical chunks and vector-store conditions, and a fake clock. Assertions enforce vector coverage, bounded concurrency, first indexed progress, and total simulated time.

| Provider/model                   | Requests | Peak active | First indexed, ms | Parsing done, ms | Total, ms |
| -------------------------------- | -------: | ----------: | ----------------: | ---------------: | --------: |
| Vertex / embedding-001, before   |    1,700 |           8 |             2,522 |           17,242 |    25,022 |
| Vertex / embedding-001, after    |    1,700 |           8 |             2,522 |           17,242 |    25,022 |
| Vertex / embedding-2, before     |    1,700 |          16 |             1,222 |            8,642 |    12,622 |
| Vertex / embedding-2, after      |    1,700 |          16 |             1,222 |            8,642 |    12,622 |
| Gemini / embedding-001, restored |       29 |           2 |               422 |            1,242 |     6,022 |
| Gemini / embedding-2, restored   |       29 |           2 |               422 |            1,242 |     6,022 |

This is a deterministic request-amplification comparison. The restored Gemini path uses 98.3% fewer HTTP requests on this short-input fixture. The simulated times are not live provider latency or retrieval-quality measurements, and longer real chunks will hit the payload token bound earlier. Vertex's successful-path baseline remains unchanged; its improvements affect retry amplification, cooldowns, cancellation, and duplicate batch delays.

## Codex CLI alignment review

Upstream retains the step context that advertised a tool call, allows parallel-capable calls through a shared read lock, serializes other calls through a write lock, and cancels calls waiting for admission. Its tests cover parallel reads, shell calls, ordered result groups, and starting tool execution before the model stream completes. Ready results are recorded before ordered response collection. These behaviors were verified in the linked upstream source and tests.

Alpha's `AgentTurnEngine`, captured `StepContext`/`TaskToolSurface`, and `ToolScheduler` already provide selective bounded parallelism, captured policy, ordered results, cancellation, and a deferred result commit behind the persisted assistant boundary. The inspected turn, scheduler, command-batching, deferred-result, task-batching, and task tests passed 474 cases. No alternate runtime or broad execution-kernel rewrite was introduced.

Intentional divergence: Alpha permits pre-stream-completion execution only for audited `exec_command` reads with an isolated process and the existing admission checks. Other tools wait for the accepted transcript boundary. Extending early dispatch must preserve Alpha's approvals, mutation protection, terminal ownership, and atomic tool history; upstream shell parallelism alone does not establish that arbitrary Alpha terminal calls can safely overlap.

## Exact-host and live evidence

The deterministic release gate `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` passed 13 suites / 42 actual extension-host tests, including extension and webview builds. The additional `test:composer-ui:1250` rendered check passed on the exact host with a scripted provider and no model calls.

Live work used the dedicated signed-in profile at `F:/alpha-e2e/profiles/1.125.0/user-data`, extension-owned discovery, and actual model `gpt-6-luna` / reasoning effort `max`. Saved-profile discovery verified model access without sending requests before any live workload ran.

| Run                                              | Result                                                                                                                      | Interpretation                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `tonight-live-workflow-20261007-01`              | Readiness completion passed; fixture rejected existing workspace data                                                       | Existing data preserved; no workflow speed claim                                    |
| `tonight-live-workflow-20261007-02`              | Readiness passed; workflow aborted on uncaught `TypeError: e is not iterable` in bundled Copilot 0.53.0 Git branch tracking | Normal Git-enabled live workflow remains blocked by the host dependency             |
| `tonight-live-workflow-20261007-03-git-disabled` | Review/edit/test/commit/follow-up passed; 20 budgeted requests within a 60-request cap                                      | Supplemental diagnostic with `git.enabled=false`; original setting restored exactly |

The successful diagnostic checked complete tool transactions, actual call receipts, completed turns, passing primary/follow-up tests, and committed clean fixture history. The 20 budgeted requests comprised 15 task requests and five background reasoning-summary requests. The existing `ReasoningSummary` owns one active request and one coalesced pending row, with cancellation and a separate handler. Summary requests consume provider capacity, but this run does not isolate their effect on task latency. Its readiness request used 226 input / 34 output tokens and took 2,332 ms, with first text at 2,311 ms. Readiness is separate from solving. The Git-disabled result supports the branch-tracking fault diagnosis, but does not certify normal Git UI integration or establish a general extension speed gain from one live sample. Harness defaults still keep Git enabled for live workflows.

## Validation and evidence locations

Focused checks passed:

- Indexing, embedding model, and webview message-handler tests: 409 passed across 28 files; includes real Google SDK with stubbed HTTP, storage retries, cancellation, vector validation, fingerprints, and secret isolation.
- Chat composer and indexing popover: 90 tests.
- Shared types: 386 tests across 40 files.
- Agent/turn/scheduler/task contracts: 474 tests across seven files.
- E2E-runner unit tests: 555 passed, two skipped.
- Extension, webview, and E2E type checks; ESLint on touched TypeScript files; frozen-lockfile install; focused formatting.
- Exact-host smoke and rendered composer checks described above.

Review logs and downloaded source evidence are retained outside the checkout at `F:/alpha-e2e/artifacts/tonight-review-20261007/`. Rendered composer receipts and screenshots are retained there. Live run receipts are in `F:/alpha-e2e/artifacts/<run-id>/`, including the diagnostic condition and settings-restoration receipt. This review did not produce a release VSIX.

## Ranked next measurements

1. **Representative live indexing and retrieval quality.** Use a dedicated Gemini indexing key and fixed small/large repositories. Compare Vertex and Gemini with the same model, chunks, dimensions, vector store, cache state, and recorded project quotas. Collect at least five samples of chunks/sec, total wall time, 429s, attempts/input, billed usage, peak memory, and retrieval relevance. Decide from these whether larger payloads or adaptive request concurrency improve the dominant path.
2. **Project quota coordination.** Measure overlapping workspaces and query latency during indexing. If shared-project pressure dominates, extend the existing pacing abstraction with explicit RPM/TPM accounting and bounded fairness; avoid independent retry loops in scanner and watcher.
3. **Reasoning presentation overhead.** The diagnostic used five summary requests out of 20 budgeted requests. Compare task latency, provider request pressure, summary freshness, and token use with the same controlled workflow and summary settings. Change presentation scheduling only if that isolates a benefit while preserving cancellation and visible reasoning.
4. **Large-file-list queue pressure.** The scanner bounds active parsing but still creates queued promises for the supported file list. Measure memory and event-loop delay at large list sizes before replacing that admission path with a bounded producer.
5. **Approved read-tool stream overlap.** Measure the current pre-completion command-read path against serial execution using controlled providers and the same tool trace. Consider native read tools only after adding transcript-boundary, cancellation, and ordered-finalization tests for those paths.
6. **Normal live Git workflow.** Re-run the bounded scenario after the exact-host Copilot Git-tracking failure is resolved. Keep the Git-disabled receipt explicitly labeled as diagnostic.
