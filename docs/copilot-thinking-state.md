# VS Code LM thinking preservation

VS Code LM thinking is provider state as well as display text. Alpha preserves each supported thinking part's original
`value`, optional `id`, and opaque `metadata` through canonical response items, authoritative conversation history, and
the next VS Code LM request. Empty text, empty IDs, metadata-only parts, array values, and repeated IDs are meaningful
wire representations; their presence does not authorize Alpha to merge or reinterpret them.

## Verified references

Retrieved October 17, 2026:

- Codex CLI commit `7b44ac1661433ae3a6f375fde873fa7123c935fe`,
  [`codex-rs/core/src/session/turn.rs`](https://github.com/openai/codex/blob/7b44ac1661433ae3a6f375fde873fa7123c935fe/codex-rs/core/src/session/turn.rs):
  reasoning summary events retain the active item's ID and summary index; the handler ignores a summary event whose
  item ID differs from the active item. This supports preserving identity and ordered response evidence in Alpha's
  existing TypeScript kernel. Codex source is a behavioral reference; this change does not port its runtime or prompts.
- Exact VS Code `1.125.0`, product commit `93cfdd489c3b228840d0f86ec77c3636277c93ea`, from the retained official test
  archive `.vscode-test/vscode-win32-x64-archive-1.125.0/93cfdd489c`. In
  `resources/app/out/vs/workbench/api/node/extensionHostProcess.js`, the thinking constructor stores `value`, `id`, and
  `metadata`, and both its JSON representation and the chat-message serializer preserve all three fields. The inspected
  constructor and serializer occur near character offsets 843001 and 876327 in this exact artifact.
- Exact `@types/vscode` `1.125.0`, `LanguageModelChatInformation.id`: the identifier is unique per provider, rather than
  globally unique. Alpha therefore records the client's vendor, ID, and version for replay provenance. The source
  declaration is near line 20588 of the pinned package's `index.d.ts`.
- The same host bundles `copilot-chat` `0.53.0`. Its `resources/app/extensions/copilot/dist/extension.js` request adapter
  reads assistant thinking values, IDs, and metadata near offset 13802700. That adapter selects the first thinking part
  and requires a truthy ID before constructing its internal thinking element. Other bundled adapter paths emit an empty
  thinking part carrying `vscode_reasoning_done`, an Anthropic signature with `_completeThinking`, or a Gemini signature
  before a function call. Relevant inspected offsets are 13818500, 13842711, and 14062418. A separate native historical
  tool-turn renderer checks its saved model ID against the current endpoint before including thinking near offset
  13786550; the external LM request adapter lacks that origin information.

These source observations establish a transport contract and show why discarding opaque fields can lose state. They do
not establish that every Copilot model consumes every thinking part, that a particular live request failed because of
lost thinking, or that replay improves model quality, latency, or token usage. The deterministic fixture validates the
transport independently of model behavior.

## Ownership and representation

Previously, the VS Code LM adapter projected thinking into visible text and discarded its ID and metadata. Empty
thinking parts could disappear entirely. The outgoing transform had no corresponding host thinking representation.

`packages/types/src/vscode-lm-thinking.ts` defines the shared `VscodeLmThinking` snapshot and the
`vscode_lm_thinking` history block. A canonical reasoning item may carry `vscodeLmThinking` alongside its display `text`.
The original string or string array stays in the snapshot; the existing array-to-display-text projection remains
separate. Metadata is treated as JSON wire state and copied at capture boundaries so later provider mutation cannot
change an accepted response or its replay.

Alpha also records the selected VS Code LM client's vendor, ID, and version as optional `modelVendor`, `modelId`, and
`modelVersion` provenance, separately from the opaque host thinking ID. Before replay, the provider omits parts whose
known provenance differs from the selected client's corresponding identity field. Missing provenance fields retain
their legacy replay behavior. This is an adapter filter; model selection policy is unchanged. The host constructor
receives only `value`, `id`, and `metadata`, so Alpha's provenance does not become provider metadata. The exact-host
serializer carries thinking without origin validation, and Copilot's external LM request adapter does not apply the
model-match check found in its separate native historical-tool-turn rendering path.

The VS Code LM provider captures each valid part, including parts with no visible text. The existing stream adapter and
canonical accumulator carry that snapshot into the response. Task persistence records the corresponding history block
in its original position among assistant text and tool calls, while retaining the canonical response evidence. This
uses the existing transcript writer and durability boundary. Thinking does not complete or repair a tool transaction by
itself.

Lifecycle display and journal events intentionally remain text projections and may coalesce adjacent display fragments.
They do not replay opaque provider state. Canonical response items and authoritative conversation history retain the
separate original parts used for replay.

The outgoing VS Code LM transform reconstructs a host thinking part at the adapter boundary, using the feature-detected
host constructor. An unavailable constructor safely omits unsupported host state; the required exact-host test fails
if VS Code 1.125.0 does not expose the constructor. Other provider transforms omit this VS Code-specific history block
rather than treating it as user-visible text or another provider's reasoning signature. Legacy history without the
optional state retains its existing interpretation.

The change adds neither a separate agent loop nor a second state store. It does not change model selection, execution
policy, approvals, usage accounting, or the number of production model requests. Existing cancellation and stale-request
guards remain responsible for admitting response parts.

## Validation contract

Focused provider and transform tests cover capture, detached snapshots, metadata-only parts, invalid state, host
constructor availability, and provider isolation. Canonical and persistence tests cover ordered evidence, legacy
history, and reload. Run the owning package's tests and type checks before the exact-host gate:

```sh
pnpm --filter @alpha-code/vscode-e2e check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```

After building the current extension and webview, the focused host rerun is
`pnpm --filter @alpha-code/vscode-e2e test:vscode-lm:1250:run`. The full smoke command performs those builds itself.

The deterministic `vscode-lm-provider` fixture emits array-valued thinking with nested metadata, a second empty-text
thinking part with the same ID and signature/completion metadata, and a real `exec_command` read. The contract test
asserts the exact thinking values and order before the tool call on the next request, inspects both on-disk history and
canonical evidence including model provenance, reloads a fresh task instance, and verifies replay again on an explicit
user follow-up. It expects exactly three task requests: initial response, tool-result continuation, and the user
follow-up. The fixture separately recognizes and answers Alpha's existing tools-disabled title and visible-reasoning
summary requests before assigning task request indexes. These presentation requests do not carry task tool history.
The fixture makes no live Copilot requests.

Validation outcomes belong with the change's recorded command results; this document defines the contract and does not
claim that an unrun check passed.

## Implementation validation

Validated on October 17, 2026, in the isolated `copilot-thinking-state` worktree based on `ee2cea46`:

- 718 focused unit tests passed across provider, transform, canonical history, persistence, Task, and shared types.
- Extension and shared-types typechecks passed; touched-file lint and formatting checks passed.
- Extension/webview builds succeeded. The complete `test:smoke:1250:run` phase passed 44 tests across 13 exact-host
  suites. After tightening provenance to vendor/ID/version, the rebuilt extension passed all eight tests in
  `test:vscode-lm:1250:run` again, and provider tests/typechecks passed again.
- The host fixture distinguishes existing task-title and reasoning-summary requests from task requests. The first host
  attempt exposed that fixture counting error; replay and persistence assertions were retained unchanged.
- The isolated dependency setup initially omitted the bundled ripgrep executable. Running the locked dependency's
  normal rebuild from its cached download restored the existing audited-read test without changing execution policy.

No live Copilot campaign or performance/quality claim is made. The change adds no production model requests or new
dependencies; its snapshots and replay projections use the existing ordered response and transcript paths.
