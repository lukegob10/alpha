# Task reasoning preferences

Reasoning belongs to a task independently of its saved provider profile, execution mode, approvals, and tool policy.
`TaskReasoningPreference` distinguishes Default, named effort (including a provider's `none`), Off, On, and a constrained
Stellar token. The extension resolves it against adapter/model metadata; the webview consumes requested/effective state.

## Persistence and request ownership

- [Shared schemas](../packages/types/src/task-reasoning.ts) validate preference, capability, and resolved state.
- [TaskReasoning](../src/core/agent/TaskReasoning.ts) derives request settings without rewriting the profile.
- History stores requested and resolved values. Old tasks lacking them use their profile default, never another task's
  composer preference.
- New tasks capture the remembered composer choice once. Explicit creation options take precedence, then an applicable
  parent snapshot, then the new-task composer preference. Default resets the remembered override.
- Scheduled tasks own a separate preference. Queued runs snapshot it; schedule edits affect future runs. Legacy schedules
  use Default independently of the open composer.

Reasoning updates and profile writes share the provider configuration queue. Task changes persist before replacing
accepted state; a failed save preserves the accepted choice. Acknowledgements carry task/request identity so delayed
responses cannot target whichever task becomes visible later.

Each admitted request captures its handler and effective configuration. Preflight, transport, and rate-limit retries keep
that snapshot. Changes apply to the next step without cancelling or restarting the current request or adding a model call.
Retired handlers remain alive until captured users release them. VS Code LM prepares discovered model metadata before
resolution; manual compaction and scheduled admission use the same ownership boundary.

## Provider capabilities

Capabilities come from the selected adapter and the
[shared VS Code LM catalog](../packages/types/src/providers/vscode-llm.ts), not model-family guesses or a copied model list
in documentation. Catalog aliases identify capabilities while pickers/requests retain the exact live model identity.
Account availability remains provider-owned.

Copilot omits unsupported/unverified effort overrides. Vertex routes use their verified named-level or thinking-budget
capabilities. OpenAI-compatible custom models use their nested model metadata. Stellar omits reasoning by default and
accepts an explicit token matching `^[a-z0-9_-]{1,32}$` at request time; it never writes that token into the profile.
Advanced output limits and thinking budgets remain profile settings.

Unsupported requested preferences remain saved for a later compatible model; effective state explains the fallback.
Default, Off, and provider-level None are separate choices.

The [VS Code LM adapter](../src/api/providers/vscode-lm.ts) isolates optional Copilot compatibility. On supported hosts
at or above 1.136.1, an accepted Claude effort also sets `modelOptions._enableThinking: true`. It is omitted for GPT,
unknown models, and absent/unsupported effort, and is never put inside `configuration`. Minimum host 1.125.0 retains
the older request path. Do not infer minimum-host Claude effort support from a reference-host result.

## Composer and schedules

`ReasoningSelector` projects the extension's capabilities, effective value, and pending next-step choice. Named effort uses
a keyboard-accessible slider; binary and budget controls retain distinct presentations. Unsupported/custom-token cases
cannot be treated as another model's named levels.

The composer correlates saves with task and provider identity and keeps the accepted value on failure. Schedule editing
uses a local buffer and the schedule's selected profile; command schedules omit reasoning. Run details display the admitted
snapshot. SettingsView profile controls retain their cached Save/Cancel edit buffer. Theme tokens, focus restoration,
narrow-layout wrapping, and English locale labels apply throughout.

## Validation

```sh
pnpm --dir src test core/agent/__tests__/TaskReasoning.spec.ts api/providers/__tests__/vscode-lm.spec.ts
pnpm --filter @alpha-code/types test
pnpm --dir src check-types
pnpm --dir webview-ui check-types
pnpm --filter @alpha-code/vscode-e2e test:reasoning:1380
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250
```

The rendered reasoning fixture checks trusted composer input, payloads, profile independence, reload, fallback, and editor
projection with local scripted responses. These checks do not establish model quality, cost, or live-provider availability.
