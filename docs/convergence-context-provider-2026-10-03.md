# Context and provider convergence — 2026-10-03

Scope: provider protocols, compaction acceptance, and saved reasoning continuity. Starting HEAD:
`2660a8f8d68d38ec42d473de6a0eee6d2537e58b`. Other workstreams' shared-checkout changes were preserved.

## Sources and verified contracts

Codex source was inspected at `b741e480e203f037ca726bc2a76d99a8e8668e66`, retrieved 2026-10-03:

- [Model capabilities](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/models-manager/models.json):
  GPT-6.1 Sol declares freeform patch support. Transport is selected separately through provider `wire_api`
  in [client.rs](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/client.rs).
- [Local compaction](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/compact.rs)
  `drain_to_completed`, and [remote v2 collection](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/compact_remote_v2.rs)
  `collect_compaction_output`: completion ends collection; EOF before completion is an error.
- [Typed response items](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/protocol/src/models.rs),
  [history](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/context_manager/history.rs),
  and [compaction integration tests](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/tests/suite/compact.rs):
  reasoning is retained in order and encrypted state is requested for subsequent turns.

Official documentation fetched 2026-10-03:

- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol): Responses is required for tool calling;
  Chat Completions supports text requests. Public API reasoning efforts are low/medium/high/xhigh/max, default medium.
- [Compaction](https://developers.openai.com/api/docs/guides/compaction): standalone `/responses/compact` returns the
  complete next context window, including retained items and opaque compaction state; replay it as-is.

Read-only exact-host catalog lookup completed after the implementation handoff:

- [Cached Copilot catalog](F:/alpha-e2e/profiles/1.125.0/user-data/User/workspaceStorage/4782705fa547f3c825d839838da3c4f5/GitHub.copilot-chat/debug-logs/108a2fd6-3c89-4cfa-b8f2-51befe38b770/models.json:2062)
  contains GPT-6.1 Sol. The adjacent [session record](F:/alpha-e2e/profiles/1.125.0/user-data/User/workspaceStorage/4782705fa547f3c825d839838da3c4f5/GitHub.copilot-chat/debug-logs/108a2fd6-3c89-4cfa-b8f2-51befe38b770/main.jsonl:1)
  identifies VS Code 1.125.0 and Copilot 0.53.0. Capture time: 2026-10-02 00:37 UTC.
- Catalog SHA-256: `DC987581D05E9058A370FBD6162A207826A8F6BDE46C2FF16A4104149D53F351`.

| Copilot catalog field       | Observed value                                  |
| --------------------------- | ----------------------------------------------- |
| ID, family, version         | `gpt-6.1-sol`                                   |
| Display name                | `GPT-6.1 Sol`                                   |
| Reasoning efforts           | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| Total context limit         | 1,050,000                                       |
| Prompt limit / output limit | 922,000 / 128,000                               |
| Endpoints                   | `/responses`, `ws:/responses`                   |
| Picker / policy             | Disabled / disabled                             |

This cache establishes host-declared metadata, not current model availability. It does not establish a 272,000 default
window, reasoning default, context-size configuration schema, or additional aliases. No inference or fresh authenticated
discovery request was made. The retained sign-in preflight reported zero models and a missing Copilot extension; it is
not evidence of current discovery readiness. No generated/profile/cache files were modified.

## Implemented changes

1. Native OpenAI routing now uses one exact capability table and one native HTTPS-origin check. Responses transport
   and freeform patch support are independent. GPT-6.1 Sol routes to Responses even when a step has no tools.
   Schema, explicit tool choice, and replayed call/result pairs use the same patch capability. Existing exact native
   model routes remain supported; unknown IDs, custom endpoints, Azure, and explicit R1 retain their prior routing.
   HTTP, credentialed, and nonstandard-port URLs no longer receive native OpenAI capability assumptions.
2. Text summary requests discard live instruction fragments that would override Alpha's summary system prompt, set
   `suppressPreviousResponseId`, and retain signal/deadline/tracing/storage controls. Caller metadata is unchanged.
   Compaction now stops at the first terminal outcome, closes the iterator without waiting for stalled cleanup,
   rejects all tool-output variants and responses requiring continuation, and never installs late semantic output.
   Accounting received before the terminal boundary remains available, including usage after a provider error.
3. Persistence validates known reasoning, signed thinking, redacted thinking, Gemini signature, and reasoning-metadata
   shapes before save/reload. Unknown provider metadata stays opaque and unchanged. Rejection uses the existing
   `invalid_messages` error and preserves original saved bytes; no migration or automatic repair is introduced.

Existing transaction-safe compaction tails, cancellation checks, rewind archives, signed-block ordering, and canonical
history projection already have coverage; no competing history or execution path was added.

## Intentional differences and remaining integration

- Alpha keeps its native text summarizer and bounded exact recent tail. Codex local compaction sends its regular base
  instructions with a compact user request; Alpha's existing summary system prompt is intentionally isolated here.
  Continuing task instructions and policy are rebuilt/captured by the owning task harness. Legacy providers without
  lifecycle declarations retain text-at-EOF behavior; explicit failed/incomplete outcomes still reject their summaries.
- Native remote/server-side compaction remains unsupported. The installed OpenAI SDK is 5.12.2; existing `ApiHandler`
  exposes only message generation/token counting, `ApiMessage.type` only admits standalone reasoning, and Task's clean
  history builder plus Responses input/output normalization cannot preserve a native compacted window. Supporting it
  requires an additive typed provider capability, canonical opaque-window persistence/replay, provider/model-switch
  fallback, token accounting, and cancellation/resume tests. It must not relabel compaction as reasoning or replay just
  one encrypted item. Codex's internal Responses `compaction_trigger` v2 protocol is distinct from the public endpoint.
- **Shared-types integration completed:** the initial deterministic identity check reproduced GPT-6.1 Sol receiving
  `recognizedId=null` and silently losing selected maximum reasoning. Root integrated the canonical ID and observed
  display-name alias, Copilot-specific reasoning list, and 922,000 input ceiling in
  `packages/types/src/providers/vscode-llm.ts`. Actual live `maxInputTokens` still constrains that ceiling; an opaque
  live routing ID remains unchanged, and context-configuration flags stay unset without host schema evidence.
  Shared catalog tests passed, and both canonical-ID and opaque-ID VS Code adapter regressions now send `max`
  while preserving the 921,793 supplied host limit. The cache above establishes metadata, not fresh availability.
  No preview/date aliases or public API defaults were inferred. Pinned CLI Sol 6.1 uses default low, admits ultra,
  and declares 272000/872000 windows; its defaults differ from the public API and this observed Copilot catalog.
- Root provider continuity is this stream's scope. Subagent full forks intentionally filter reasoning/tools/non-final
  chatter in the pinned CLI; no additional inherited subagent opacity was introduced.
- No `Task.ts`, `AlphaProvider.ts`, shared schemas, instructions/skills, dependencies, releases, branches, or commits
  were changed by this workstream. Parent owns shared gates, exact VS Code 1.125.0 smoke, certification, and packaging.

## Reproduction and validation

Node 24.21.0 and pnpm 11.24.0 were used. Before fixes: six OpenAI protocol/origin regressions failed, nine summary
isolation/terminal/tool regressions failed, and 21 saved-reasoning/signature regressions failed for the intended causes.
Final review reproduced one additional top-level reasoning-validation bypass when a legacy record also carried a role;
the fix validates the same encrypted state while retaining valid role-bearing records.

Final focused runs all used `pnpm --dir src test --maxWorkers=2` with explicit file filters:

| Area                   | File filters                                                                                                                                                                                                                                                                                           | Result                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| Provider               | `api/providers/__tests__/{openai,openai-protocol,openai-responses,openai-reasoning-details,openai-timeout,openai-usage-tracking,vscode-lm,vscode-lm-contracts}.spec.ts`, `api/providers/utils/__tests__/openai-model-capabilities.spec.ts`                                                             | 9 files, 302 tests passed  |
| Context                | `core/condense/__tests__/{request-isolation,index,recent-tail,recent-tail-benchmark,condense,nested-condense,rewind-after-condense,tokenCountContext,foldedFileContext}.spec.ts`, `core/context-management/__tests__/{context-management,truncation,recovery,compaction-policy,lazy-metadata}.spec.ts` | 14 files, 305 tests passed |
| Persistence/transforms | `core/task-persistence/__tests__/{validatePersistedApiMessages,apiMessages,canonicalAssistantHistory,ProviderTranscriptStore,stageFourTranscript.integration}.spec.ts`, `api/transform/__tests__/{anthropic-filter,gemini-format,openai-format,r1-format}.spec.ts`                                     | 9 files, 149 tests passed  |

The brace notation above describes the explicit tested paths; expand them to individual arguments when rerunning in
PowerShell. Total: 32 files, 756 tests passed. `pnpm exec prettier --check` for all ten touched TypeScript files and
scoped `git diff --check` passed. Independent read-only review found no blocking issue in the compaction change.

Two earlier workstream runs of `pnpm --dir src check-types` are retained as failed-run receipts. The first caught two
typing issues in the new summary fixture; these were fixed. The second reported no errors in this workstream's files
but still failed on concurrent workstream integration:

- `core/agent/__tests__/SubagentContextCapture.spec.ts:338`: scalar `ApiMessage` passed where an array is required.
- `core/task/__tests__/Task.spec.ts:3929` and related cases: tests refer to `getApprovalModeForAsk` before the
  parent-owned Task integration provides it.
- `core/tools/RunSlashCommandTool.ts:59` and `SkillTool.ts:41`: callers pass an argument to a method being changed
  by the instruction/skills stream.
- `services/skills/__tests__/SkillsManager.spec.ts:1347`: assignment to readonly `cwd`.

Those files were not edited here. On 2026-10-03 the parent reported that the latest integrated
`pnpm --dir src check-types` passed after its Task/AlphaProvider, delegation, and skills integration. The earlier typing
blockers are resolved; the failed receipts above remain historical validation evidence. Exact-host and other shared
gates remain parent-owned. No root gates, broad builds, live provider runs, certification, or packaging were run here.
No performance improvement or complete Codex parity is claimed; tests use deterministic offline providers/histories.

## Exact changed files

- `src/api/providers/openai.ts`
- `src/api/providers/openai-responses.ts`
- `src/api/providers/utils/openai-model-capabilities.ts`
- `src/api/providers/utils/__tests__/openai-model-capabilities.spec.ts`
- `src/api/providers/__tests__/openai-protocol.spec.ts`
- `src/core/condense/index.ts`
- `src/core/condense/__tests__/request-isolation.spec.ts`
- `src/core/task-persistence/validatePersistedApiMessages.ts`
- `src/core/task-persistence/__tests__/apiMessages.spec.ts`
- `src/core/task-persistence/__tests__/validatePersistedApiMessages.spec.ts`
- `docs/convergence-context-provider-2026-10-03.md`
