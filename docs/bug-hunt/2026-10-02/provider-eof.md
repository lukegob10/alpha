# Vertex provider terminal-outcome integration audit

Status: **READY / FROZEN**. Integration scope authorized by the coordinator after the four audit lanes froze. Mode:
contract alignment, limited to active Gemini and Anthropic Vertex adapters and their nearest tests. The Anthropic adapter
is `anthropic-vertex.ts`; this repository has no `anthropic.ts`. Its earlier cache-retry repair is preserved.

## Reference and owning boundary

- Codex CLI commit `cb6da58876afed3ede0ab11084f67dd5394ecb48`, inspected through the existing pinned checkout on
  2026-10-02. `codex-rs/codex-api/src/sse/responses.rs` rejects EOF before `response.completed` and rejects incomplete
  reasons other than the explicit interrupted continuation. `codex-rs/core/tests/suite/stream_no_completed.rs` covers
  recovery from early EOF. [Pinned source](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/codex-api/src/sse/responses.rs),
  [pinned regression](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/tests/suite/stream_no_completed.rs).
- Google's current response contract describes missing `finishReason` as generation still being in progress and
  distinguishes natural `STOP` from `MAX_TOKENS`, safety, and malformed calls.
  [Official response contract](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1/GenerateContentResponse),
  retrieved 2026-10-02.
- Anthropic's streaming contract ends with `message_stop`; `message_delta` carries the stop reason. Its stop-reason
  documentation identifies `max_tokens` and context-window exhaustion as truncation and `pause_turn` as requiring
  continuation. [Official streaming contract](https://platform.claude.com/docs/en/build-with-claude/streaming),
  [official stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons), retrieved 2026-10-02.

`src/api/index.ts` routes Vertex Claude models through `AnthropicVertexHandler` and Gemini models through `VertexHandler`,
which uses `VertexGeminiHandler`. Their `createMessage` streams feed the shared canonical accumulator and `Task` host.
The existing `ApiStreamOutcomeChunk` and `createApiStreamOutcome` are the owning contract; no new runtime or wire format
was introduced. Alpha's execution, approval, sandbox choices, and bespoke features are outside this repair.

## Fixed now

| Finding                                                                                          | Evidence and repair                                                                                                                                                                                                                                                                                                        | Closure                                         |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **High / must-fix:** partial or empty stream EOF lacked an explicit incomplete outcome           | Three Gemini and three Anthropic cases failed before the repair: text, reasoning, and no output all produced no canonical outcome. Gemini now requires a terminal finish reason; Anthropic requires both `message_stop` and a recognized stop reason. Each advertises explicit lifecycle reporting.                        | Fixed, deterministic regression coverage.       |
| **High / must-fix:** output-token limits could be treated as successful ordinary text completion | Streaming and non-streaming token-limit fixtures for both adapters failed before the repair. Limits now produce `incomplete`, retain output and usage, and prohibit replay of partial output. Anthropic context-window exhaustion and unknown reasons, and Gemini safety/malformed/unknown reasons also remain incomplete. | Fixed, including reasoning-only exhaustion.     |
| **High / should-fix:** Anthropic ignored protocol completion while waiting for transport closure | A controlled iterator throws if read beyond `message_stop`. The adapter now emits one outcome at that marker and exits, releasing the iterator. It cannot report completed while a tool block remains open.                                                                                                                | Fixed, cleanup and unfinished-tool regressions. |

Request/attempt correlation, native call IDs and arguments, reasoning signatures, response IDs, grounding, and usage
projections remain intact. Existing gateway-auth refresh and prompt-cache fallback conditions remain intact. Native
successful stop reasons remain completed; Anthropic `pause_turn` reports the existing canonical continuation flag.
This flag normalization does not claim complete support for Anthropic server-tool blocks, which this adapter does not
expose through Alpha's client-tool surface.

The repair deliberately differs from Codex's Rust transport representation: Alpha reports its existing TypeScript
`incomplete` outcome and leaves recovery and resource ownership to the shared host. It does not introduce transport-local
retries. Early EOF without semantic output is marked retryable; partial output and terminal truncation are not. The
coordinator owns verification of the host's recovery decisions.

## Validation

Fail-before command:

```sh
pnpm --dir src test api/providers/__tests__/vertex-provider-outcomes.spec.ts --maxWorkers=2
```

Before the repair, **10 / 10 cases failed** because canonical outcomes were absent. After the repair and adjacent
coverage expansion, the new file contains **30 passing cases**.

Final provider/transport command:

```sh
pnpm --dir src test api/providers/__tests__/vertex-provider-outcomes.spec.ts api/providers/__tests__/vertex.spec.ts api/providers/__tests__/anthropic-vertex.spec.ts api/providers/__tests__/transport-parity.spec.ts --maxWorkers=2
```

Result: **118 passed across four files**. Existing happy-path fixtures now include real finish/stop markers where their
assertions require successful completion; deliberately partial fixtures assert the new incomplete outcome.

Provider-history and kernel consumers:

```sh
pnpm --dir src test api/transform/__tests__/gemini-format.spec.ts api/transform/__tests__/anthropic-filter.spec.ts core/agent/__tests__/AgentResponseFoundation.spec.ts core/agent/__tests__/AgentTurnEngine.spec.ts --maxWorkers=2
```

Result: **75 passed across four files**. The first `pnpm --dir src check-types` run passed. The final rerun was blocked by
a concurrent terminal integration fixture: `integrations/terminal/__tests__/ExecaTerminalProcess.settlement.spec.ts(42,48)`
reported TS2554, expected zero arguments but received one. It reported no provider errors; the coordinator owns the final
shared typecheck after all integration edits freeze. Scoped ESLint, touched-file Prettier, and whitespace diff checks
passed. No dependency, lockfile, manifest, generated-tree, or shared-kernel edits were made in this integration scope.

## Remaining coverage

- **Not verified here:** exact VS Code 1.125.0 host gates, packaging, managed-agent certification, and live provider runs.
  The coordinator owns those serialized gates. Add `vertex-provider-outcomes.spec.ts`, `vertex.spec.ts`, and
  `anthropic-vertex.spec.ts` to the provider-protocol certification track if that track is intended to cover all active
  native provider adapters; its current selection covers OpenAI and VS Code LM only.
- **Compatibility change:** a custom gateway that omits protocol completion markers now receives an incomplete outcome.
  Accepting such responses as successful would recreate the demonstrated defect.
- **Not verified:** full Anthropic server-tool/fallback payload recovery and Gemini post-finish trailer timing. Existing
  Gemini usage draining and request timeout behavior were retained. No live latency or quality improvement is claimed.
- **Out of scope:** sandbox replacement, model catalogs, authentication changes, additional feature redesign, and Rust
  or upstream source copying.
