# Provider support and saved-profile recovery

Alpha supports four chat connections: GCP Vertex AI (`vertex`), VS Code LM API (`vscode-lm`), Stellar (`stellar`),
and OpenAI Compatible (`openai`). Indexing separately supports Vertex and Gemini Developer API (`gemini`).
A model vendor exposed through a connection does not create another Alpha provider.

## Execution and compatibility

Dedicated connections outside this set, including OpenAI Native/Codex, OpenRouter, Anthropic, Bedrock, and Gemini chat,
are retired. Their saved identifiers and historical transcripts remain readable. Execution rejects unsupported or unknown
identifiers explicitly; it cannot clear the selection into a default provider. Select a supported replacement deliberately.

Vertex retains its partner routes and gateway/Helix behavior. Stellar retains its gateway/Helix behavior. OpenAI Compatible
retains endpoint, header, model, Azure, and streaming configuration. VS Code LM retains host discovery and provider-state
replay. Shared Anthropic transcript types and SDKs still used by supported connections remain required.

Task creation and resume validate the selected provider before changing the active lifecycle. Reconfiguration builds the
new handler before committing configuration, preserving the current handler when a replacement is rejected. The internal
process-local `fake-ai` seam remains available for tests, is absent from public choices, and cannot restore executable
callbacks from a saved profile after restart.

## Retaining invalid profiles

[ProviderSettingsManager](../src/core/config/ProviderSettingsManager.ts) keeps schema-invalid values in the additive
`retainedApiConfigs` map alongside executable `apiConfigs`. Entries retain a stable identity and original JSON value.
Recognized migrations run before validation. Invalid entries survive unrelated saves, rename, import/export, and reopen
until explicit validated repair or deletion. An all-invalid store retains its selected identity rather than inventing
another provider. Invalid whole-store JSON/metadata produces a safe error without overwriting the stored bytes.

Only safe profile-list metadata crosses to the webview: `availability: "invalid" | "unsupported"` and bounded known
top-level invalid field names. Raw retained data, credentials, and arbitrary nested keys are excluded.

- Duplicate stored IDs remain unchanged; ID-based routing and updates reject ambiguity instead of choosing the first match.
  Valid name-based selection remains available.
- Repair preserves the retained identity. Imported profile references remap to that identity, and ambiguous mappings fail
  before persistence. Embedded legacy IDs or names cannot override authoritative store identity.
- Explicit replacement validates the whole profile before removing retained data.
- Deletion rechecks the clicked identity inside the storage lock, includes retained entries in the last-profile guard,
  and selects an available remaining profile before an unavailable one.
- Fresh unsaved views share the portable `default` identity; persisted identities remain authoritative.
- Configured automatic imports remain authoritative on activation. Repair the configured source file when it would
  reintroduce invalid setup. Warnings expose a bounded count and basename, never the retained payload or JSON fragments.

Previously deleted data cannot be reconstructed from an empty store. Retention preserves evidence; it does not invent
credentials or authorize execution of invalid configuration.

## Index and evaluation boundaries

Index identities distinguish providers, models, dimensions, and gateways. Invalid embedding settings retire active services
before reporting the error, so old vectors cannot silently become vectors for a different connection.

Live API campaigns use OpenAI Compatible, `OPENAI_API_KEY`, and optional `OPENAI_BASE_URL`; endpoint E2E runs additionally
select `ALPHA_E2E_MODEL_ID`, and evaluator CI selects `EVALS_MODEL_ID`. Inject credentials at execution rather than saving
them in campaign files. Scripted and deterministic VS Code LM fixtures require no live credentials.

Use the [testing workflow](testing-harness.md) and [core confidence runbook](core-confidence.md) for current gates.
Focused coverage includes provider registry/factory rejection, profile retention and identity, import projection,
reconfiguration rollback, and indexing-provider compatibility.
