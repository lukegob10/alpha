# Assistant message phases and boundaries

Date: 2026-10-11. Reference host: VS Code 1.125.0. Implementation baseline:
`14fc29614911d0d3b88670135a8a5c11abb75103`.

Alpha must preserve the identity, optional phase, and boundaries of each original assistant message from provider
normalization through canonical response items, persisted history, reload, compaction, and provider replay. Adjacent
commentary, partial answers, and final answers are distinct messages even when their text or phases match. Message phase
does not grant authority, resolve a tool transaction, or decide that an agent turn is complete.

## Verified upstream contract

The read-only Codex CLI source checkout was verified at
`27065a91ccbf5ba8532844be3777fcf83b77820d`, retrieved 2026-10-11T17:43:08Z. This review uses the current functions and
tests at that commit; the earlier divergence audit is design history, not proof of current behavior.

| Source anchor                                                                                                                                                                                                    | Verified behavior                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [protocol models](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/protocol/src/models.rs), `MessagePhase`                                                                 | The finite wire values are `commentary`, `partial_answer`, and `final_answer`. Missing phase means unknown and preserves compatibility behavior for legacy models. |
| Same file, `ResponseItem::Message` and `ResponseInputItem::Message`                                                                                                                                              | Phase is optional and omitted when absent. Output messages also carry an optional original response-item ID.                                                       |
| Same file, `From<ResponseInputItem> for ResponseItem` and `response_input_message_conversion_preserves_phase`                                                                                                    | Conversion and JSON serialization preserve every known phase and the phase-less case.                                                                              |
| [client persistence tests](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/tests/suite/client.rs), `response_item_ids_persist_across_resume_and_preserve_server_ids` | The next request after a resume retains original message IDs, including the assistant's server-assigned ID.                                                        |
| Same file, `resume_sends_prior_items`                                                                                                                                                                            | A prior assistant item loaded from a rollout with `commentary` retains that phase in the resumed Responses request.                                                |
| Same file, `history_dedupes_streamed_and_final_messages_across_turns`                                                                                                                                            | Stream deltas and a final receipt represent one output message; repeating the same text in another turn is a separate history entry.                               |

Current [official reasoning guidance](https://developers.openai.com/api/docs/guides/reasoning), retrieved 2026-10-11,
also requires preserving each original assistant phase during manual replay and does not apply assistant phase to user
messages. The current [public Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
lists `commentary` and `final_answer`; the pinned current Codex protocol additionally defines `partial_answer`.
The installed `openai@5.12.2` SDK declares no message phase and requires message ID/status in its output type.
Alpha uses a narrow TypeScript wire extension for the verified three-value contract and optional original ID. It does not broaden phase to an
arbitrary string or rename partial answers to final answers.

## Root cause and native ownership

Before this change, `AgentResponseItem` text carried only text, and the stream accumulator discarded source message
identity while recording an output index privately for ordering. Both canonical assistant history builders merged
adjacent text without distinguishing original output messages. Responses replay emitted plain assistant strings,
discarding any original phase and message ID. Lifecycle text grouping had the same boundary loss: a deterministic
baseline reproduction combined `Checking.` commentary and `Done.` final-answer messages into the first message.

The checkpoint accumulator and history projection were also reproduced directly by loading Alpha's actual TypeScript
modules from `git show 14fc296` and transpiling them in memory with TypeScript. The accumulator dropped ID, phase, and
output index; the history builder collapsed original `Checking.` and `Answer.` messages into `Checking.Answer.`.
Assertions for the new observable invariants failed with `ERR_ASSERTION` on that checkpoint. No checkout files were
replaced for this reproduction.

| Alpha layer                                                              | Responsibility                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/types/`                                                        | Shared finite phase and optional message metadata contracts, with tolerant normalization at untrusted or legacy boundaries.                                                                         |
| `src/api/transform/stream.ts`, `src/api/providers/openai.ts`             | Normalize message metadata from nonstreaming output, item-added events, text deltas, item-done receipts, and completed response snapshots. Reconcile late metadata without creating duplicate text. |
| `src/core/agent/AgentResponse.ts`, `AgentResponseAccumulator.ts`         | Preserve optional original ID, phase, and output position on canonical text items while retaining ordered reasoning, tool calls, outcomes, and compatibility text projections.                      |
| `src/core/task-persistence/canonicalAssistantHistory.ts`                 | Group only compatible fragments belonging to one source message. Retain metadata in saved canonical and legacy content projections.                                                                 |
| `src/core/task/Task.ts`                                                  | Persist canonical response items before effects; preserve enriched text blocks through request-history cleaning and explicit provider fallback.                                                     |
| `src/core/task-persistence/apiMessages.ts`, `ProviderTranscriptStore.ts` | Keep additive metadata in authoritative canonical bytes and digest-bound sidecar receipts. Reload must not require a still-live provider stream.                                                    |
| `src/api/providers/openai-responses.ts`                                  | Replay original assistant messages as ordered Responses message items with their original optional phase and message ID.                                                                            |
| `src/core/agent/lifecycle/responseItems.ts`                              | Project separate canonical messages to lifecycle events without merging distinct boundaries.                                                                                                        |
| `src/core/condense/`, `src/core/context-management/`                     | Preserve retained source items and saved originals during non-destructive compaction, truncation, and rewind. Hidden items do not leak into effective request history.                              |

The provider normalization methods are `handleOpenAiResponsesStream`, `captureOpenAiResponsesMessageMetadata`,
`emitOpenAiResponsesOutputItem`, and `finishOpenAiResponsesResult`. Replay remains owned by
`buildOpenAiResponsesInput` and `toAssistantMessageInput`; canonical history does not become a separate provider engine.

All changes extend the existing TypeScript extension and shared harness. The user authorized implementation using this
isolated worktree and three subagents with disjoint canonical, provider, and regression/design-note ownership. The lead
integrates lifecycle projection, request cleaning, fallback, and compaction review. No additional task engine, Rust
runtime, copied prompt, or Codex sandbox implementation is introduced.

## Preservation and compatibility rules

- A provider message's original ID and output position identify a boundary. Different IDs or output positions remain
  separate even if their text and phase are identical. A phase by itself does not prove that adjacent text belongs to
  one message.
- Fragments may merge only when their source boundary and phase are compatible. Legacy phase-less text without source
  metadata keeps its existing fragment-merging behavior.
- Metadata may arrive before or after text. Late receipts update matching canonical fragments rather than appending a
  duplicate message. Deduplication is scoped to one provider response; later turns can repeat text or IDs.
- `commentary`, `partial_answer`, and `final_answer` remain distinct. Missing, null, or unsupported provider phases
  use the unknown-phase fallback. Old saved content stays readable; replay ignores unsupported phase values while
  retaining valid independent identity metadata.
- Original assistant message IDs remain replayable in both stored and stateless Responses requests. Existing stateless
  opaque-reasoning replay continues to omit reasoning IDs when `store=false`; that separate rule is unchanged.
- A saved Alpha envelope's legacy `id` can identify a provider response rather than an original message. That response
  identifier must not replace the message identity carried by individual canonical text blocks. A single-source native
  envelope can use the additive `messageId` field; raw Responses message items use their declared `type: "message"` and
  original `id`. No ID-prefix guessing is used.
- Reasoning signatures and opaque bytes, tool-call IDs and terminal results, and output ordering remain intact. Message
  metadata does not replace the canonical outcome or pending-tool continuation rules.
- Cancellation, provider failure, retries, and compaction retain received canonical evidence. No `final_answer`
  declaration can turn a failed or incomplete response into success.
- No phase is synthesized for user/tool-result messages or for a legacy history that never reported one.

## Explicit provider fallback

Responses supports phase-aware message replay. Enriched assistant text uses an explicit message item with output text;
legacy content keeps its existing easy-message shape. Source-only output positions preserve separate messages without
putting Alpha's output index on the wire.

Other provider contracts have no equivalent phase field. Alpha keeps the richer evidence in saved canonical history
and removes unsupported metadata only at the provider boundary. Anthropic keeps distinct ordered text blocks alongside
signed/redacted reasoning. VS Code LM keeps ordered text parts and its opaque state marker.

Chat Completions can preserve enriched text boundaries as separate assistant envelopes while keeping tool calls and
provider reasoning details on the final assistant envelope, as required by the existing tool-result adjacency contract.
Its wire format cannot express the complete Responses ordering of interleaved opaque reasoning and tool items; this
capability limit remains explicit. Legacy Chat history continues to use its established projection. These fallbacks do
not relabel commentary as an answer and do not affect execution policy, approval authority, or turn completion.

Compaction intentionally summarizes older effective history. Retained messages keep their exact metadata; hidden
originals stay in saved history for rewind. A newly generated summary is host-authored context, not a reconstructed
original assistant message, so no original phase is invented for it.

## Validation

The focused regressions cover:

- nonstreaming output, early metadata, late item receipts, late completed-response metadata, and completed-only output;
- all three phases, two adjacent same-phase messages with identical text but different IDs, multi-part message text,
  phase-less messages with distinct output positions, duplicate receipts, and repeated responses;
- opaque reasoning and complete tool-call/result ordering around messages;
- actual authoritative transcript writes/reads, a fresh receipt store reading the digest-bound sidecar, and provider
  request replay after reload;
- signed Anthropic thinking persisted through the real Task boundary with enriched text, followed by a wire projection
  that strips unsupported metadata while preserving block order and the original reasoning signature;
- phase absent/null/unknown inputs, older persisted content and string histories, and unsupported-provider fallback;
- non-destructive compaction/truncation and rewind preservation, failed/cancelled outcomes, and phase-independent turn
  completion.

Validation ran from the isolated `align-response-phases-20261011/Alpha-Code` worktree with Node 24.21.0 and pnpm 11.24.0.
Dependencies were installed with the frozen lockfile; the types package was built before extension consumers ran.

```sh
pnpm --filter @alpha-code/types test src/__tests__/assistant-message.test.ts src/__tests__/agent-lifecycle.test.ts --maxWorkers=2
pnpm --dir src test core/agent/__tests__/AssistantMessageMetadata.spec.ts core/agent/__tests__/AgentResponseFoundation.spec.ts core/agent/__tests__/AgentTurnEngine.spec.ts core/task-persistence/__tests__/canonicalAssistantHistory.spec.ts api/transform/__tests__/stream.spec.ts --maxWorkers=2
pnpm --dir src test api/providers/__tests__/openai-message-phases.spec.ts api/providers/__tests__/openai-responses.spec.ts api/providers/__tests__/openai.spec.ts api/providers/__tests__/openai-protocol.spec.ts --maxWorkers=2
pnpm --dir src test core/task-persistence/__tests__/assistantMessagePhaseReplay.spec.ts --maxWorkers=2
pnpm --dir src test core/agent/lifecycle/__tests__/responseItems.spec.ts core/task/__tests__/Task.lifecycle-publication.spec.ts api/transform/__tests__/openai-format.spec.ts api/transform/__tests__/anthropic-filter.spec.ts api/transform/__tests__/vscode-lm-format.spec.ts core/task-persistence/__tests__/canonicalAssistantHistory.spec.ts core/task-persistence/__tests__/openaiReasoningReplay.spec.ts api/providers/__tests__/provider-history-roundtrip.audit.spec.ts core/task-persistence/__tests__/stageFourTranscript.integration.spec.ts core/task/__tests__/Task.persistence.spec.ts core/task/__tests__/Task.compaction-safety.spec.ts core/agent/__tests__/SubagentContextCapture.spec.ts core/agent/__tests__/SubagentInvocationContext.spec.ts core/task/__tests__/Task.subagent-context.spec.ts --maxWorkers=2
pnpm --dir src test core/task-persistence/__tests__/openaiReasoningReplay.spec.ts --maxWorkers=2
pnpm --filter @alpha-code/types check-types
pnpm --dir src check-types
pnpm --dir webview-ui check-types
```

| Coverage                                                                               | Result                                                                                            |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Shared metadata and lifecycle schemas                                                  | 13 tests passed in two files                                                                      |
| Canonical response, history, turn, and stream                                          | 95 tests passed in five files                                                                     |
| Provider normalization and replay                                                      | 183 tests passed in four files                                                                    |
| Actual disk/reload and sidecar integration                                             | 22 tests passed in one file                                                                       |
| Affected lifecycle, fallback, persistence, compaction, and inherited-context consumers | 13 files passed; the remaining file passed all 10 tests after the expected-contract updates below |
| Ordinary types, extension, and webview typechecks                                      | Passed using their existing scripts and generated shared-package declarations                     |
| Scoped ESLint for all touched TypeScript files                                         | Passed with `--max-warnings=0`, including the final reasoning-replay assertion update             |
| Final diff review                                                                      | Passed; no dependency, lockfile, version, generated-output, or unrelated tool-policy changes      |

The affected-consumer batch initially passed 441 of 449 tests. Its eight failures were exact assertions in
`openaiReasoningReplay.spec.ts` expecting original phase-less message IDs and output indexes to be discarded. Those
assertions now require the known original metadata in saved content and Responses wire replay, without weakening
reasoning, ordering, failure/cancellation, deduplication, or store-specific reasoning-ID checks. The complete file then
passed all 10 tests. The other 13 files cover 439 tests and needed no assertion changes. The canonical history file is
also in this consumer batch, so counts from different batches must not be summed as unique tests.

The first ordinary extension typecheck exposed four older inherited-context fixtures with widened string literals for
newly typed fields. Narrowing those fixture literals restored the intended contract; the normal extension typecheck and
their focused tests passed afterward. No temporary source-alias check substitutes for the ordinary typecheck.

Test runners were scheduled serially with at most two workers. Independent review by the third subagent found no
remaining actionable issue. Existing line endings in two previously mixed/CRLF test files were retained to avoid
unrelated formatting churn. The repository pre-commit hook invokes the full repository lint gate; that gate is deferred
with the other parent-owned integrated checks, while scoped lint and diff review ran here.

The exact VS Code 1.125.0 gate, integrated repository gates, and exclusive live Copilot profile checks are deferred to the
parent integration chat and must run serially there.
