# Provider protocol follow-up

Date: October 11, 2026 (America/New_York). Base: integrated commit
`3a67501a2c92b9747d0598274ef3826121456151`. The accepted settings handoff
`32363ad2fbab62b60f6d8ea21ceffae56959b5b5` remains intact in its original worktree and history.
The host contract remains VS Code **1.125.0**.

## Reproduction and owning boundary

The integrated unit run reported two failures in `src/api/providers/__tests__/openai-protocol.spec.ts`:

- `retains completePrompt retry metadata with one provider prefix` resolved an empty string instead of rejecting.
- `keeps text-only completions on the supported Chat Completions endpoint` returned an empty string instead of `Done.`.

A fresh managed worktree from the exact integrated commit reproduced both without edits: **130 tests passed and two
failed** across the protocol and request-parameter files. The original protocol assertions remain unchanged.
Four new shared-resolver assertions also failed before the resolver fix, identifying the request-kind boundary.

The settings handoff had moved the auxiliary `completePrompt` helper from Chat Completions to Responses whenever its model
used Responses for agent turns. That changed an established public helper contract without an API requirement. The helper
is used by `single-completion-handler.ts` for plain text requests, including message enhancement; it does not run an agent
turn or send task history/tools. The owning boundary is `OpenAiHandler.completePrompt` and its shared parameter projection.

Retry normalization itself was intact: the test rejected the Chat Completions mock, but the new branch called a different
mock. The pinned OpenAI SDK **5.12.2** adds `output_text` to Responses objects through `addOutputText` in
`src/resources/responses/responses.ts` and `src/lib/ResponsesParser.ts`. The protocol mock lacked both `object: "response"`
and that SDK-derived helper. Its empty result explains the test symptom; it does not establish production Responses text
loss. Restoring the verified helper route addresses the actual compatibility regression without changing that mock.

## Current primary evidence and decision

Current Codex main was checked read-only at
[27065a91ccbf5ba8532844be3777fcf83b77820d](https://github.com/openai/codex/commit/27065a91ccbf5ba8532844be3777fcf83b77820d),
committed **2026-10-11T17:43:08Z**, and confirmed against the remote main ref on October 11, 2026. Relevant sources:

- `codex-rs/core/src/client.rs`: `build_responses_request` and `stream_responses_api` implement agent turns with Responses.
- `codex-rs/core/tests/suite/client.rs`: `includes_default_verbosity_in_request`,
  `configured_verbosity_not_sent_for_models_without_support`, and `configured_verbosity_is_sent` verify capability gating.

Those task contracts do not establish a requirement to migrate Alpha's separate text-only helper. Upstream tests were
read, not run. Official primary API references inspected on the same date:

- [GPT-6.1 Sol model contract](https://developers.openai.com/api/docs/models/gpt-6.1-sol) supports Chat Completions without
  tool calling and directs tool use to Responses.
- [Migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses) describes text generation through
  either API and the Responses SDK text helper.
- [Chat Completions request schema](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
  declares the optional top-level `verbosity` field (`low`, `medium`, `high`). The pinned SDK types declare this field too.

The decision is to retain Alpha's auxiliary Chat Completions contract and the existing task Responses contract. This is
an intentional Alpha adapter distinction from the inspected Codex task request flow; it introduces no separate runtime.

## Effective behavior

`resolveModelParameterApplicability` accepts optional `requestKind: "task" | "single-completion"`, defaulting to `task`.
Only the existing native OpenAI/Stellar route selection needs that distinction. Existing exact model/endpoint eligibility,
Azure/R1 exclusions, Vertex routing, and model metadata precedence remain unchanged.

- Agent turns continue using their existing Responses route, including turns with absent or empty tools. Their response
  phases, retry/cancellation behavior, transforms, and replay are unchanged.
- `completePrompt` uses Chat Completions with one plain user message. It sends no task tools, Responses input, or history
  controls, and returns the existing choices text.
- Included positive safe-integer caps use the existing Chat Completions field selection, including limits below 16.
  Disabled/unset inclusion and `-1` omit caps; invalid explicit caps fail before transport. The minimum 16 remains
  exclusive to actual Responses requests.
- Native saved temperature remains suppressed for both request kinds. Legacy compatible profiles retain sampling,
  including saved `0.8`, unless an explicit capability opt-out or declared parameter list excludes it.
- Native text-only verbosity uses the documented top-level field and requires the same exact native route eligibility
  and explicit supported-model metadata as task verbosity. Task Responses continues using `text.verbosity`.
  Compatible gateways, false/unknown support, and unset preferences omit verbosity. Saved preferences are not mutated.
- The existing provider error wrapper preserves retry/abort metadata and one provider prefix. Auxiliary abort errors
  retain their historical wrapping behavior; task abort identity remains exact. No retry-header parser changes are included.

The response-only single-prompt fixtures introduced by the settings handoff are replaced with endpoint/payload/cap tests
for the verified auxiliary contract. Original public protocol assertions and task Responses outcome guards are retained.
The prior settings design note is corrected and links here; its original validation totals remain historical.

## Independent review and validation

The same three authorized collaboration agents were reused in this isolated follow-up:

- `contract_review` independently verified current source/API contracts and reviewed the final implementation read-only.
- `provider_requests` implemented the provider request change and its request-parameter regressions.
- `parameter_ui` independently inspected the failures and added public protocol regressions; it changed no UI source.

The lead owns shared applicability, integration validation, documentation, final review, and the commit.
All edits are confined to `provider-protocol-followup-20261011`; no primary-checkout or original-handoff edits are made.

Validation used Node **24.21.0**, pnpm **11.24.0**, a frozen dependency install, and the normal
`@alpha-code/types` build/entrypoint verification. No declaration or source-alias workaround was used.

| Check                                            | Result                  |
| ------------------------------------------------ | ----------------------- |
| Full shared types package suite                  | 46 files, 523 passed    |
| Provider requests and public protocol            | 5 files, 300 passed     |
| Transforms, turn, replay, and exact capabilities | 8 files, 204 passed     |
| Affected settings consumers                      | 3 files, 63 passed      |
| Types, extension, webview typechecks             | All three passed        |
| Touched TypeScript ESLint                        | Zero warnings           |
| Touched-file Prettier and `git diff --check`     | Passed                  |
| Independent contract review                      | No correctness blockers |

The final deterministic checks cover **1,090 tests across 62 files**. Reproduction commands from the worktree root:

```sh
pnpm --filter @alpha-code/types test --maxWorkers=2
pnpm --dir src test api/providers/__tests__/openai-request-parameters.spec.ts api/providers/__tests__/openai.spec.ts api/providers/__tests__/stellar.spec.ts api/providers/__tests__/vertex-openai.spec.ts --maxWorkers=2
pnpm --dir src test api/providers/__tests__/openai-protocol.spec.ts --maxWorkers=2 --minWorkers=1
pnpm --dir src test api/transform/__tests__/model-params.spec.ts shared/__tests__/api.spec.ts shared/__tests__/context-output-reservation.spec.ts core/agent/__tests__/AgentTurnEngine.spec.ts core/agent/__tests__/AgentTurnEngine.fault-contract.spec.ts core/task-persistence/__tests__/openaiReasoningReplay.spec.ts core/task-persistence/__tests__/validatePersistedApiMessages.spec.ts --maxWorkers=2
pnpm --dir src test api/providers/utils/__tests__/openai-model-capabilities.spec.ts --maxWorkers=2
pnpm --dir webview-ui test src/components/settings/providers/__tests__/OpenAICompatible.spec.tsx src/components/settings/__tests__/ApiOptions.parameters.spec.tsx src/components/ui/hooks/__tests__/useSelectedModel.spec.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @alpha-code/types check-types
pnpm --dir src check-types
pnpm --dir webview-ui check-types
```

Changed paths (seven files):

```text
docs/provider-protocol-followup-2026-10-11.md
docs/settings-provider-parameter-fixes-2026-10-11.md
packages/types/src/model-parameters.ts
packages/types/src/model-parameters.spec.ts
src/api/providers/openai.ts
src/api/providers/__tests__/openai-protocol.spec.ts
src/api/providers/__tests__/openai-request-parameters.spec.ts
```

The implementation uses normal repository commit hooks; no hook bypass is part of this handoff. Their completion and
the clean final commit are reported in the handoff. No source changes affect tool policy, modes, task lifecycle, persisted
formats, model catalogs, retirement contracts, dependencies, or packaging. Discovered retry-after-ms parsing and auxiliary
abort-instance behavior are deliberately left for separate work; existing wrapped metadata remains covered.

The full integrated unit suite, exact-host smoke gate, live Copilot evaluation, and packaging are reserved for the parent
integration chat as instructed. This follow-up makes no claim that those gates ran or passed and uses no live provider calls.
