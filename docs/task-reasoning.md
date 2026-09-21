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
  unavailable. Request options remain compatible with VS Code 1.122.1; no host reasoning schema is assumed.
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
All new strings are localized in the 18 supported locales.

Primary references retrieved September 20, 2026: [VS Code API](https://code.visualstudio.com/api/references/vscode-api),
[VS Code language models](https://code.visualstudio.com/docs/agent-customization/language-models),
[Vertex OpenAI compatibility](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library),
[Google thinking controls](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking), and
[Vertex Claude](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude). These explain adapter
boundaries; the repository's exact model catalog and VS Code 1.122.1 fixtures determine the supported menu and payload.

## Validation

Run focused reasoning, provider payload, task/profile, schedule, and webview tests; shared package and affected consumer
type checks and lint; `node scripts/find-missing-translations.js`; and
`pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`. The exact-host LM fixture verifies persistence and that an unverified
LM model receives no effort override while retaining its exact identity. Provider unit fixtures cover supported
named-level payloads.

`pnpm --filter @alpha-code/vscode-e2e test:reasoning:1221` builds the real extension and webview, runs an owned disposable
VS Code 1.122.1 host, and uses trusted keyboard input to select High in the composer. A local HTTP fixture independently
checks that the next request sends High while the saved profile, profile count, mode, and approvals stay unchanged.
It also checks task reload, unsupported-model fallback, Escape/focus restoration, and the editor panel. Rendered
screenshots cover dark, light, and narrow high-contrast layouts. The receipt in `artifacts/reasoning-ui/` links to the
retained screenshots and exact-host evidence for visual inspection.

### September 20, 2026 verification

NOR-44 was validated before NOR-45 implementation started: 732 focused extension tests, 298 shared-type tests, affected
type checks/lint, the exact-host smoke gate, and automated managed-agent certification passed. Certification included
26 deterministic checks and a fresh managed-agent 1.122.1 host run; its completion-idle evidence input replayed the
existing September 14 capture rather than claiming a new live-model run.

After NOR-45, 212 focused webview tests and 59 message-handler tests passed. The runner suite passed 429 tests with two
existing skips; the affected atomic receipt/barrier checks passed all nine tests after the fixture publication fix.
Extension, webview, shared-type, and runner type checks/lint passed, as did all 18 locales' translation completeness checks.

The final 1.122.1 smoke run passed activation (4), modes (2), and LM contracts (6). The rendered scenario passed all four
stages, including the actual HTTP High payload, unchanged profile/policy, reload, fallback, keyboard selection/Escape,
focus restoration, and the same task in an editor panel. Actual-host screenshots were visually inspected in dark, light,
and high contrast, including the narrow sidebar. The final receipt is
`artifacts/reasoning-ui/ui-probe-987578a5-e228-49ff-8e96-cc5fc6f5aafa.json`.

Provider payload coverage uses deterministic fixtures. Live Copilot, Vertex, and Stellar account behavior was not tested.

### Continuation review

The September 20 continuation keeps the delivery scopes separate:

- NOR-44 owns the shared preference schemas, runtime resolver, task/history and schedule persistence, admission/retry
  snapshots, provider payloads, and requested/effective projection. The review adds coverage for composer rollback and
  raw legacy schedule files, preserves unknown Vertex Claude model IDs, and recomputes pending state when live LM
  capabilities change while a request retains its captured reasoning.
- NOR-45 owns the composer and schedule controls, their messages, localization, Settings isolation, and rendered-host
  acceptance. Invalid-update replies retain the addressed task identity. Schedule capabilities are scoped synchronously
  to the edited model, and the shared popover has an accessible name and keyboard/focus regression coverage.

Validation uses Node 24.14.1 and pnpm 11.24.0. The Codex shell initially selected a bundled fallback pnpm; prepend the
installed Corepack shims when reproducing checks in that environment. Sandboxed exact-host evidence capture fails its
home-directory ownership check with `EPERM`; running the owned disposable host with normal filesystem permissions
allows the check and evidence capture to complete without weakening the harness. The managed-agent suite's optional
completion-idle replay requires `ALPHA_COMPLETION_IDLE_EVIDENCE`; the retained September 14 capture is replay evidence,
not a new live-provider run.

The schedule store still uses separate task/run files, as before this change. Its rollback handles rejected writes but
does not claim crash-atomic cross-file commits. No live-provider quality or performance improvement is claimed.
