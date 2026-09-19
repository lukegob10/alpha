# Context compaction policy

Implemented on `codex/nor-56-tool-progress`, reviewed against current source on 2026-09-14.

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

The deliberate change from the old 75% of window-minus-output target to 25% of the compactable working budget leaves
room before the next trigger. For W = 1,000,000, R = 32,768, P = 20%, and F = 10,000, the old target was 725,424 tokens;
the new target is 57,500, below the 200,000-token trigger. These are ceilings, not a request to pad summaries to that size.

System instructions, tool schemas, summary wrapping, active workflows, and any supplied environment details count toward
the result. The default exact recent tail is bounded by one quarter of the remaining history budget and 16,384 tokens.
Optional folded file context is capped during generation and admitted only while the complete measured candidate fits
and remains smaller. The concise handoff prompt includes the remaining summary token budget, including when the user
supplies custom condensing instructions.

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

## Upstream comparison

The public Codex source was inspected at commit `3fa9039bd70d2e4f6b4e614e11b971e261e604e2` on 2026-09-14:

- [Local compaction](https://github.com/openai/codex/blob/3fa9039bd70d2e4f6b4e614e11b971e261e604e2/codex-rs/core/src/compact.rs)
  retains bounded user history and creates a handoff summary.
- [Remote compaction v2](https://github.com/openai/codex/blob/3fa9039bd70d2e4f6b4e614e11b971e261e604e2/codex-rs/core/src/compact_remote_v2.rs)
  uses a separate provider-supported compaction path with a bounded retained suffix.
- [The compact prompt](https://github.com/openai/codex/blob/3fa9039bd70d2e4f6b4e614e11b971e261e604e2/codex-rs/prompts/templates/compact/prompt.md)
  asks for concise continuation context.
- [VS Code 1.122.1 API declarations](https://github.com/microsoft/vscode/blob/1.122.1/src/vscode-dts/vscode.d.ts)
  define `LanguageModelChat.maxInputTokens` as the maximum number of input tokens.

Alpha adopts bounded handoffs, explicit working budgets, retained complete steps, and measured progress in its existing
provider-neutral path. This change does not add native encrypted compaction endpoints. Matching those would require
provider capability, transport, persisted-state, and replay contracts, and should be evaluated separately.

## Verification and limits

The 2026-09-17 regression cases reproduce slow summary generation at 30% and 35% of a 1M window, refreshed environment
content above the summary target but below the working limit across all three entry points, and contradictory automatic
fallback reporting. Additional cases retain the cumulative tokenizer cap, absolute request deadline, profile threshold,
and actual reduction requirement. These are deterministic reproductions; no trace from the reported incident was available.
Validation for that correction passed 546 affected regression tests (one existing skipped test), the final 88-test focused
rerun, extension type checking, lint on changed TypeScript files, formatting, and all 10 VS Code 1.122.1 smoke checks.

Validation on 2026-09-14 passed: 614 extension tests (one existing skipped test), 293 shared-type tests, 63 webview tests,
and six task/webview compaction-routing tests. Repository-wide lint and type checks, formatting with existing line
endings preserved, and the VS Code 1.122.1 smoke gate passed. The final compaction-only rerun passed all 330 tests.

Focused coverage includes threshold scaling across 32K, 200K, and 1M windows; effective output reservations; repeat-click
no-ops; recompacting a saved summary; rejecting growth; file-context budgets; failed-summary truncation; tool-pair and
opaque-state preservation; cancellation; persistence; and final environment overhead. The unchanged event is covered in
shared-schema and webview tests and localized in all 18 webview locales.

The existing deterministic recent-tail benchmark still retains exact evidence with 225 active tokens and no repeated
file read (one scripted model round trip). Its summary-only control has 95 active tokens but needs a repeated read and
two scripted model round trips. This is a continuation regression check, not evidence of live-model quality. The default
condensing instruction text decreased from 5,653 to 1,068 characters with normalized line endings, measured against branch HEAD on the same date;
the dynamically appended budget adds a short sentence. No live-provider cost, latency, or summary-quality improvement
is claimed from these measurements.

Useful validation commands:

```sh
pnpm --dir src test core/context-management core/condense core/task/__tests__/Task.compaction-safety.spec.ts shared/__tests__/context-output-reservation.spec.ts shared/__tests__/api.spec.ts api/providers/__tests__/vscode-lm.spec.ts core/task-persistence core/agent/__tests__/AgentTurnEngine.spec.ts
pnpm --filter @alpha-code/types test
pnpm --dir webview-ui test src/components/chat/context-management/__tests__/CondensationResultRow.spec.tsx src/components/chat/__tests__/TaskHeader.spec.tsx src/components/settings/providers/__tests__/VSCodeLM.spec.tsx src/__tests__/ContextWindowProgress.spec.tsx src/__tests__/ContextWindowProgressLogic.spec.ts
pnpm lint
pnpm check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
node scripts/find-missing-translations.js
```

The repository-wide translation checker currently reports missing keys outside this change; the new unchanged-result
key is present in every locale. Extremely small windows or triggers can still be insufficient for mandatory instructions
and complete transactions. Compaction cannot manufacture capacity in that case. Provider token counts may also differ
from local estimates; forced recovery therefore remains bounded and requires measured progress.
