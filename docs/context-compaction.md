# Context compaction policy

## Optional post-turn compaction

Post-turn compaction runs only at a settled model-turn boundary. Its default threshold is `0` (disabled).
A saved nonzero threshold opts a task into this path. Automatic recovery from a provider context error is separate.
Existing saved values remain unchanged.

## Working budget

The advertised model capacity, selected request window, input allowance, and automatic trigger are different quantities.
The provider adapter resolves the selected model's `contextWindow`; for VS Code LM this is capped by the selected live
model's `maxInputTokens` as well as the configured context size. Compaction uses that resolved window.

The Copilot provider and settings preview share `getVscodeLlmContextWindow`. Before discovery, a supported saved context
selection supplies the preview; live discovery then caps it. The chat header consumes the resolved model in task-scoped
`LiveTaskMetadata`, including incremental message updates, so switching between standard and extended context does not
leave the header on the catalog default. Legacy hosts without this optional metadata use the configured preview.

`getModelReservedOutputTokens` uses the same effective output cap as ordinary requests. A provider declaring
`contextWindowIncludesOutput: false` already supplies an input-only window, so no output reservation is subtracted from
it. VS Code LM declares this capability. Providers without the optional field retain the combined-window interpretation.
The task header uses the same reservation helper.

For resolved window W, effective output reservation R, configured threshold P, and measured system/tool overhead F:

```text
allowed input  = max(0, floor(W - R - 0.10 * W))
trigger        = min(allowed input, floor(W * P / 100))
summary target = floor(F + 0.25 * (trigger - F))
```

F is clamped to the available budget when calculating the target; this does not make oversized mandatory content fit.
A valid profile threshold overrides the global setting. Profile inheritance (`-1`), invalid numbers, and invalid global
settings resolve through the same helper for preview, automatic compaction, manual compaction, and provider-error
recovery. The existing threshold setting continues to mean a percentage of W, preserving its stored interpretation.

The summary target leaves room before the next trigger. For W = 1,000,000, R = 32,768, P = 20%, and F = 10,000,
it is 57,500 tokens, below the 200,000-token trigger. These are ceilings, not a request to pad summaries to that size.

System instructions, tool schemas, summary wrapping, active workflows, and any supplied environment details count toward
the result. The default exact recent tail is bounded by one quarter of the remaining history budget and 16,384 tokens.
Optional folded file context is capped during generation and admitted only while the complete measured candidate fits
and remains smaller. The concise handoff prompt includes the remaining summary token budget, including when the user
supplies custom condensing instructions.

## Smaller-model transitions

After a model change, the host can retain one previous handler when non-model provider settings match. Endpoint,
credentials, or account changes invalidate it. After model preparation, only a larger previous window may generate the
summary through `compactionApiHandler`. The selected handler still owns token counting, replacement acceptance, recent
transactions, and carried user instructions. The summary request is tool-free with independent response-chain metadata.

Captured previous handlers are released after success or failure and are process-local. Reload, unavailable previous
models, and incomplete summary output retain bounded failure/truncation behavior. A larger window alone does not establish
opaque reasoning compatibility. The existing `request-isolation.spec.ts` and recent-tail/reload tests cover this boundary.

## Progress and repeated requests

Historical provider usage can trigger an attempt, but successful summaries and fallback truncations compare active input
before and after with the same operation-scoped token counter. Saved rewind records do not count toward active input.
Equal, larger, negative, missing, or non-finite candidate counts cannot be reported as reductions. Task integration checks
the candidate against the summary/truncation target before persistence. Fresh environment content and final tool schemas
can use the remaining headroom below the configured trigger (or the physical input allowance when automatic compaction
is disabled). They must still leave the complete input smaller than before compaction. The generation target is not a
second context-window limit: for a 1M window at 30%, a 73K candidate plus 20K of fresh environment facts fits below the
300K trigger even though it exceeds the 75K summary target. Final provider input is checked before dispatch.

Token counting shares a five-second cumulative allowance across the operation, charging only time spent waiting on the
tokenizer. Summary generation, environment collection, and persistence do not consume that allowance. An explicit
request deadline still caps every count. Exact counts are cached; exhausted or stalled tokenizers retain the conservative
local fallback. This avoids comparing accurately counted old history with inflated fallback counts solely because a
summary took longer than five seconds to generate.

There is no time-based cooldown. A repeated manual request with no useful older material to summarize returns
`unchanged` when the active context already fits. A generated candidate that cannot improve an already-fitting context
also leaves the original history intact. The UI displays “Context already fits” as information, without a failure or a
summary expander. An oversized saved summary can be summarized again, even if it is the only active message. Provider
rejection requires an actual reduction and cannot be dismissed as an already-fitting request.

Automatic recovery has one bounded truncation fallback if summarization fails. Truncation preserves the first complete
step and a recent complete suffix, using F plus 75% of the remaining working budget. This less aggressive fallback gives
whole steps a chance to fit while staying below the next trigger. With automatic condensation disabled, fallback uses
the allowed physical input budget. If mandatory content or the minimum complete suffix cannot fit, recovery reports
exhaustion instead of splitting tool transactions or retrying unchanged input indefinitely.

A successful automatic fallback reports the truncation result. Its original summarization diagnostic remains available
for investigation, but the UI does not also display a compaction-failed message after recovery succeeded.

Existing non-destructive history tags, rewind readers, lifecycle completion, cancellation, and provider metadata
preservation remain in use. The optional `ContextCondense.outcome` field is backward compatible: saved events without
the field continue rendering as successful compactions. No configuration migration is required.

## Validation

```sh
pnpm --dir src test core/context-management core/condense core/task/__tests__/Task.compaction-safety.spec.ts shared/__tests__/context-output-reservation.spec.ts shared/__tests__/api.spec.ts api/providers/__tests__/vscode-lm.spec.ts core/task-persistence core/agent/__tests__/AgentTurnEngine.spec.ts
pnpm --filter @alpha-code/types test
pnpm --dir webview-ui test src/components/chat/context-management/__tests__/CondensationResultRow.spec.tsx src/components/chat/__tests__/TaskHeader.spec.tsx src/components/settings/providers/__tests__/VSCodeLM.spec.tsx
pnpm lint
pnpm check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
```

Extremely small windows or triggers can still be insufficient for mandatory instructions
and complete transactions. Compaction cannot manufacture capacity in that case. Provider token counts may also differ
from local estimates; forced recovery therefore remains bounded and requires measured progress.
