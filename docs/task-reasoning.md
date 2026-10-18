# Task reasoning preferences (NOR-44 / NOR-45)

Reasoning belongs to a task, independently of its saved provider profile, execution mode, approvals, and tool policy.
`TaskReasoningPreference` distinguishes Default, a named effort (including the provider's `none` level), Off, On, and a
constrained Stellar custom token. The extension resolves the preference against the selected adapter's model metadata;
the webview consumes the requested/effective projection rather than writing profile settings.

## Ownership and persistence

- `packages/types/src/task-reasoning.ts` owns the validated preference and capability/state schemas.
- `src/core/agent/TaskReasoning.ts` derives effective request settings from an unchanged profile configuration.
- `Task.apiConfiguration` remains the profile configuration. Captured requests use the derived configuration and handler.
- Task history stores the requested preference and resolved state. An old task without either field uses its profile's
  existing default. Restoring an old task never reads another task's composer preference.
- `newTaskReasoningPreference` remembers the last accepted composer choice. New tasks capture it once; Default resets it.
  Explicit creation options take precedence, then a child's parent snapshot, then the new-task composer preference.
- Scheduled tasks own a separate preference. A queued run snapshots it; later schedule edits affect future runs only.
  Admission resolves the snapshot against the selected profile and records the effective state. Legacy schedules use
  Default, independently of the open composer.

## Request and concurrency boundary

Reasoning updates and provider-profile writes use the provider configuration queue. Task updates persist on the existing
transcript/history queue before replacing the accepted runtime state. Rejected persistence retains the accepted choice.
Messages carry a task ID and request ID so an asynchronous acknowledgement cannot target whichever task happens to be
visible later. A message without a task ID updates the new-task composer preference.

Each newly admitted request captures its handler and effective configuration. Preflight, transport retries, and rate-limit
retries retain that boundary. Changing a preference does not cancel a request, restart a task, or introduce another model
request. The projection includes the current captured value when a different accepted value is waiting for the next step.
Retired handlers remain alive while captured requests use them and are disposed after release or task disposal.
Dynamic VS Code LM models are prepared before deriving the admitted request settings. Resolution updates the captured
handler's reasoning options without changing its selected model. Manual compaction uses the same boundary. Scheduled
runs prepare and persist their initial resolved state before starting the task.

## Provider boundaries

The September 20, 2026 ticket contracts are the implementation scope:

- Copilot uses the verified catalog overlay for the exact live VS Code LM model. Missing overlay capabilities mean
  unavailable. Request options use the VS Code 1.125.0 contract; no host reasoning schema is assumed.
- Vertex Gemini uses cataloged thinking levels. Unknown Gemini identifiers do not inherit another model's named levels.
- Vertex Claude budget models retain the existing thinking-budget path. Models without verified reasoning flags do not
  acquire named effort options merely from belonging to the Claude family.
- Vertex OpenAI-compatible routes retain their catalog capability list and gateway model-routing behavior.
- Stellar omits reasoning by default. A task can explicitly supply a token matching `^[a-z0-9_-]{1,32}$`; this is a
  runtime-only OpenAI `reasoning_effort` value and is never added to the saved provider profile.
- OpenAI-compatible custom models receive their effective effort through the nested custom model metadata used by the
  adapter. Advanced output limits and thinking budgets remain profile settings.

An unsupported requested choice is retained for restoration when returning to a compatible model. The effective value
and fallback reason describe the valid request settings. Default, Off, and provider-level None are separate choices.
No performance or cost improvement is claimed.

## Composer and schedules

`ReasoningSelector` is shared presentation for the composer and model-backed schedules. It renders only the extension's
capabilities and effective value, including required reasoning, binary controls, token budgets, unavailable models, and
Stellar's constrained custom input. Default, Off, and provider None remain distinct. Pending changes expose the current
request's value and mark the accepted preference for the next step.

The composer correlates acknowledgements with both task identity and provider configuration. It keeps the accepted
value on a failed save and does not save profiles. Schedule editing uses a local preference buffer and queries its own
selected profile; command schedules omit reasoning. Run details show the persisted admission snapshot. Profile reasoning
controls remain advanced/default settings in SettingsView's existing cached edit buffer.

The footer wraps at narrow widths, uses VS Code theme tokens, and presents named effort levels through a compact,
keyboard-accessible slider inside the existing popover. Binary and budget-only capabilities use compact buttons, while
the slider keeps provider-specific effort levels reachable without listing every choice. The effort popup shows only the
slider and its selected value. It contains the provider's explicit `none` level when supported plus its named reasoning
levels; that `none` level is labeled None.
User-visible labels use the English locale resources.

Primary references retrieved September 20, 2026: [VS Code API](https://code.visualstudio.com/api/references/vscode-api),
[VS Code language models](https://code.visualstudio.com/docs/agent-customization/language-models),
[Vertex OpenAI compatibility](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library),
[Google thinking controls](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking), and
[Vertex Claude](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude). These explain adapter
boundaries; the repository's exact model catalog and VS Code 1.125.0 fixtures determine the supported menu and payload.

## Validation

Run focused reasoning, provider payload, task/profile, schedule, and webview tests; shared package and affected consumer
type checks and lint; and
`pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`. The exact-host LM fixture verifies persistence and that an unverified
LM model receives no effort override while retaining its exact identity. Provider unit fixtures cover supported
named-level payloads.

`pnpm --filter @alpha-code/vscode-e2e test:reasoning:1250` builds the real extension and webview, runs an owned disposable
VS Code 1.125.0 host, and uses trusted keyboard input to select High in the composer. A local HTTP fixture independently
checks that the next request sends High while the saved profile, profile count, mode, and approvals stay unchanged.
It also checks task reload, unsupported-model fallback, Escape/focus restoration, and the editor panel. Rendered
screenshots cover dark, light, and narrow high-contrast layouts. The receipt in `artifacts/reasoning-ui/` links to the
retained screenshots and exact-host evidence for visual inspection.
