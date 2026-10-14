# Settings provider parameter fixes (F3, F4, F7)

Date: October 11, 2026 (America/New_York). Implementation starts at checkpoint
`14fc29614911d0d3b88670135a8a5c11abb75103`. Alpha's host contract remains **VS Code 1.125.0**.

The integrated protocol follow-up corrected the auxiliary completion route described below; see
[the protocol follow-up](provider-protocol-followup-2026-10-11.md) for the reproduction, current API evidence, and validation.
The validation totals in this note record the original settings handoff, before that follow-up.

## Scope and upstream evidence

This change makes the settings editor and native provider request construction agree about per-response output caps,
temperature, and verbosity. It preserves provider-neutral execution, saved profiles, user-controlled Code/Plan modes,
tool policy, approvals, task identity, and existing tools.

Exactly **three collaboration subagents** were launched in this chat: `contract_review` inspected current upstream contracts
and independently reviewed implementation; `provider_requests` implemented request construction and transport regressions;
`parameter_ui` implemented the editor and interaction regressions. All writers used this chat's isolated managed worktree.
The lead owns the shared resolver, integration review, validation, this note, and the implementation commit.

Current Codex source and tests were inspected read-only at
[27065a91ccbf5ba8532844be3777fcf83b77820d](https://github.com/openai/codex/commit/27065a91ccbf5ba8532844be3777fcf83b77820d),
committed **2026-10-11T17:43:08Z**. Retrieval and inspection date: October 11, 2026. Upstream tests were read, not executed.
The older settings review is design history; it is not the current behavioral authority.

| Verified contract                                                                 | Current source/test                                                                                                                                                        | Native Alpha implementation                                                                                     |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Verbosity requires model support and is a Responses text control                  | `codex-rs/core/src/client.rs`, `build_responses_request`; `codex-rs/codex-api/src/common.rs`, `create_text_param_for_request`                                              | Shared route/capability applicability; supported `text.verbosity` on native Responses requests                  |
| Unsupported verbosity is omitted, while configured values override model defaults | `codex-rs/core/tests/suite/client.rs`: `includes_default_verbosity_in_request`, `configured_verbosity_not_sent_for_models_without_support`, `configured_verbosity_is_sent` | Omit unsupported and unset profile verbosity; retain saved preferences when switching routes                    |
| Unknown catalog metadata must not manufacture capabilities                        | `codex-rs/models-manager/src/model_info.rs`, `model_info_from_slug`                                                                                                        | No new native routes, model-name prefix capability guesses, or unknown verbosity support                        |
| Context and compaction limits retain distinct meanings                            | `codex-rs/protocol/src/openai_models.rs`, `model_context_window_limits_preserve_their_distinct_meanings`                                                                   | Per-response request caps remain distinct from context size, reasoning output, and cumulative task/tree budgets |

Official primary references inspected on the same date include the
[OpenAI model guide](https://developers.openai.com/api/docs/guides/latest-model),
[Responses API request schema](https://developers.openai.com/api/reference/python/resources/responses/methods/create), and
[Anthropic thinking sampling restrictions](https://platform.claude.com/docs/en/build-with-claude/thinking#sampling-parameters).
The primary Responses schema establishes the native minimum output cap of 16; the model guide and pinned Codex request
source establish the used text-control contract. Anthropic's current documentation establishes editable sampling
on older models without thinking and the restrictions during thinking. It supports explicit temperature declarations for
the retained Vertex Claude Sonnet 4.6 and Opus 4.6 catalog entries.

## Owning layers and effective behavior

`packages/types/src/model-parameters.ts` owns pure capability applicability and optional request-cap resolution shared by
the webview and adapters. Existing native OpenAI route metadata moved to `packages/types/src/providers/openai.ts`; the
old internal utility remains a re-export. Its exact existing entries and endpoint checks are preserved. The existing
Vertex partner route parser moved to the shared Vertex module, so an opaque gateway model override affects consuming
request branches while selected-model metadata remains the capability identity. Stellar and Vertex partner models share
their existing compatible metadata fallbacks between adapters and the settings projection.

The provider adapters remain the request effect boundary. `ApiOptions`, `OpenAICompatible`, `Verbosity`, and
`useSelectedModel` project the shared contract into the existing cached settings edit buffer. No new task runtime,
registry, policy path, dependency, persisted format, or migration is introduced.

Exact changed paths (30 files, relative to the repository root):

```text
docs/settings-provider-parameter-fixes-2026-10-11.md
packages/types/src/index.ts
packages/types/src/model-parameters.ts
packages/types/src/model-parameters.spec.ts
packages/types/src/providers/openai.ts
packages/types/src/providers/stellar.ts
packages/types/src/providers/vertex.ts
src/api/providers/anthropic-vertex.ts
src/api/providers/gemini.ts
src/api/providers/openai.ts
src/api/providers/stellar.ts
src/api/providers/vertex-openai.ts
src/api/providers/vertex.ts
src/api/providers/utils/openai-model-capabilities.ts
src/api/providers/__tests__/anthropic-vertex.spec.ts
src/api/providers/__tests__/openai.spec.ts
src/api/providers/__tests__/openai-request-parameters.spec.ts
src/api/providers/__tests__/stellar.spec.ts
src/api/providers/__tests__/vertex-openai.spec.ts
src/api/providers/__tests__/vertex-request-parameters.spec.ts
webview-ui/src/components/settings/ApiOptions.tsx
webview-ui/src/components/settings/Verbosity.tsx
webview-ui/src/components/settings/providers/OpenAICompatible.tsx
webview-ui/src/components/settings/providers/__tests__/OpenAICompatible.spec.tsx
webview-ui/src/components/settings/__tests__/ApiOptions.parameters.spec.tsx
webview-ui/src/components/ui/hooks/useSelectedModel.ts
webview-ui/src/components/ui/hooks/__tests__/useSelectedModel.spec.ts
webview-ui/src/i18n/locales/en/settings.json
webview-ui/src/utils/validate.ts
webview-ui/src/utils/__tests__/validate.spec.ts
```

### F3: output cap inclusion and validation

| Saved setting                                                                  | Effective optional request                                  |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `includeMaxTokens: true`, positive integer limit                               | Emit the per-response cap                                   |
| `includeMaxTokens: false` or unset                                             | Omit the optional cap; the editor is unchecked              |
| Included effective limit `-1`, null, or absent                                 | Omit; the server chooses its default                        |
| Included zero, other negative, fractional, non-finite, or unsafe integer limit | Reject before transport with an actionable validation error |

An explicit override uses nullish precedence, so zero and `-1` cannot accidentally fall through to a model default.
Persisted schema readers remain backward compatible. Disabled or overridden stale values remain readable; they do not
become request limits. The editor preserves invalid text locally, displays an associated validation error, and prevents
Save until that edit is repaired. An invalid first edit marks the existing edit buffer dirty without persisting an invalid
numeric value. Unrelated capability changes and live state refreshes do not erase that draft.

Native Responses additionally enforces the API's minimum cap of 16; compatible servers retain positive-integer validation
without inheriting that native minimum.

Mandatory native Vertex output limits retain their provider defaults and are validated separately from the compatible
adapter's optional inclusion checkbox. Gemini task and single-prompt requests share cap resolution. Anthropic thinking
budgets must remain strictly below the total output cap; impossible minimum-budget combinations fail before transport.
Reasoning output is part of the per-response cap, not an additional tree budget.
Context reservation retains its existing conservative normalization and is not redefined by the optional request toggle.

### F4: temperature follows the consuming route

Native OpenAI Responses and VS Code LM do not consume Alpha's temperature preference, so neither advertises its editor nor
sends stale saved temperature. Compatible Chat Completions, Stellar, and supported Vertex routes preserve sampling.
An explicit unsupported flag is authoritative. When the explicit flag is absent, a declared supported-parameter list
determines support. Missing model metadata does not advertise a control.

Legacy compatible model descriptors predate capability flags. Their existing generic Chat Completions sampling contract
remains an adapter-owned compatibility default, including saved custom temperatures. This is distinct from assigning
native capabilities by model-name prefix. Stellar and Vertex partner adapters retain their existing gateway fallback
descriptors and now project them consistently in the editor. Unknown Vertex Claude/Gemini descriptors do not gain
sampling support from a nearby catalog entry. The Gemini unknown-model fallback explicitly withholds sampling even if
the copied row later advertises it. The verified Vertex Claude 4.6 catalog declarations preserve their existing sampling
controls.

Active reasoning budgets can require a fixed temperature of 1 on compatible/Anthropic paths. The resolver represents that
fixed request value separately from an editable preference. The editor hides the ineffective adjustment, the request
retains its model-required value, and the saved preference remains available after the reasoning setting changes. Gemini
sampling remains editable where its native request consumer supports it. Existing reasoning-family Chat Completions
branch restrictions are preserved as transport behavior; they do not establish new capabilities for unknown names.

Vertex canonical and legacy model-routing overrides participate in the same applicability calculation as request routing.
Malformed routing edits suppress inapplicable controls while the existing request/configuration validation reports them.

### F7: supported verbosity reaches transport

Explicit supported model metadata on the native Responses route emits `text.verbosity` for task requests. Native
`completePrompt` retains Chat Completions and emits the documented top-level `verbosity` field with the same capability
gate. False or undeclared support, compatible/gateway routes without an implemented consumer, and
VS Code LM omit it. Unset verbosity omits the control and is displayed as the provider default. Saved low/medium/high
preferences remain intact across provider/model/route changes.

The original handoff moved native `completePrompt` to Responses. Integrated protocol coverage exposed that this changed
the established text-only API contract without a requirement. The follow-up restores Chat Completions, which the current
model API still supports for text-only requests. The resolver explicitly represents the request kind, keeping task
Responses routing and its minimum cap of 16 intact. Single completions retain positive-integer Chat Completions caps,
plain user messages, the existing error wrapper, and no task tools or history controls. Native saved temperature remains
suppressed on either request kind. Streaming response normalization, persisted history, and replay remain outside this remit.

## Intentional Alpha differences

Codex's inspected Responses request structure does not expose Alpha's compatible-provider inclusion checkbox or sampling
editor. Alpha retains those provider-native controls and valid mandatory Vertex caps. Alpha does not adopt Codex's sandbox
architecture, Rust runtime, prompts, or configuration storage. Gateway credentials, Vertex transport, Stellar Helix
authentication, VS Code LM host options, and all built-in capabilities remain native extension concerns.

Verbosity reaches Alpha's supported native Responses task consumer and native Chat Completions text-only consumer. The
native endpoint and exact model route eligibility remain required for both. This does not assume that every compatible
server accepts the OpenAI Chat Completions verbosity field or manufacture a catalog/default verbosity value where Alpha
has no verified declaration; unset values use the server's default.

## Validation

Focused deterministic request regressions were run before request changes: 52 failures in 109 tests reproduced negative
sentinels, invalid caps, unsupported temperatures, missing non-streaming sampling, dead verbosity, and the mismatched
native single-completion route under the original proposed Responses behavior. Those single-completion expectations were
superseded by the verified existing Chat Completions contract in the protocol follow-up; the original integrated protocol
assertions remain unchanged. A second Vertex-focused baseline reproduced mandatory cap and sampling boundary defects.
No live provider calls were used for these regressions.

Final checks ran in the isolated worktree with Node **24.21.0** and pnpm **11.24.0**. The frozen dependency install and
prerequisite `@alpha-code/types` build completed successfully; the build verifies published entrypoints and supplies the
normal generated package declarations for consumer typechecks. No source-alias workaround was used.

| Check                                       | Result                               |
| ------------------------------------------- | ------------------------------------ |
| Full affected `@alpha-code/types` suite     | 42 files, 451 tests passed           |
| Focused provider request/transport suites   | 8 files, 437 tests passed            |
| Transform, turn, replay, persistence checks | 8 files, 199 tests passed            |
| Focused webview settings suites             | 7 files, 104 tests passed            |
| Types, extension, and webview typechecks    | All three passed                     |
| ESLint on touched TypeScript/TSX files      | Passed with zero warnings            |
| Prettier on all touched files               | Passed                               |
| `git diff --check`                          | Passed                               |
| Independent contract review                 | No remaining implementation blockers |
| Primary checkout preservation               | Clean; no edits made there           |

The final deterministic runs cover **1,191 tests across 65 files**. Reproduction commands from the worktree root:

```sh
pnpm --filter @alpha-code/types test --maxWorkers=2
pnpm --dir src test api/providers/__tests__/openai-request-parameters.spec.ts api/providers/__tests__/vertex-request-parameters.spec.ts api/providers/__tests__/openai.spec.ts api/providers/__tests__/vertex-openai.spec.ts api/providers/__tests__/stellar.spec.ts api/providers/__tests__/anthropic-vertex.spec.ts api/providers/__tests__/vertex.spec.ts api/providers/__tests__/vertex-provider-outcomes.spec.ts --maxWorkers=2
pnpm --dir src test api/transform/__tests__/model-params.spec.ts shared/__tests__/api.spec.ts shared/__tests__/context-output-reservation.spec.ts api/providers/utils/__tests__/openai-model-capabilities.spec.ts core/agent/__tests__/AgentTurnEngine.spec.ts core/agent/__tests__/AgentTurnEngine.fault-contract.spec.ts core/task-persistence/__tests__/openaiReasoningReplay.spec.ts core/task-persistence/__tests__/validatePersistedApiMessages.spec.ts --maxWorkers=2
pnpm --dir webview-ui test src/components/settings/providers/__tests__/OpenAICompatible.spec.tsx src/components/settings/__tests__/ApiOptions.parameters.spec.tsx src/components/settings/__tests__/ApiOptions.reasoning.spec.tsx src/components/ui/hooks/__tests__/useSelectedModel.spec.ts src/utils/__tests__/validate.spec.ts src/components/settings/__tests__/SettingsView.unsaved-changes.spec.tsx src/components/settings/__tests__/SettingsView.change-detection.spec.tsx --maxWorkers=2 --minWorkers=1
pnpm --filter @alpha-code/types check-types
pnpm --dir src check-types
pnpm --dir webview-ui check-types
```

The existing real `SettingsView` suites mock `ApiOptions`. The new nested output-cap draft/live-refresh regression uses
a controlled buffer with the real setter's equality and dirty-state semantics. Manual extension-host verification remains
part of integration; this focused patch does not edit the other settings lead's `SettingsView` source or tests.

The implementation commit uses the repository's normal pre-commit hooks. Their completion is reported with the commit
handoff; no hook bypass is part of this work.

The exact-host smoke gate, full integrated repository gates, packaging/VSIX, managed-agent certification, and the dedicated
live Copilot profile are **deferred to the parent integration chat**, as instructed. This worktree does not claim those gates
passed and does not launch or modify the parent-owned profile.
