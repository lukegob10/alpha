# Queue and automatic steering preference

Ordinary Send/Enter queues messages submitted during an active task by default. **Settings → UI → Auto-steer messages**
is an opt-in global preference. Enable it and click **Save** to interrupt an eligible active response with ordinary
submission. Typing only updates the composer draft; it does not submit input.

Queued messages retain their existing **Steer**, edit, and delete controls. **Send and steer** (`alpha.sendAndSteer`,
Ctrl+Alt+S on Windows) remains an explicit way to steer the visible primary chat with automatic steering disabled.
The active composer action describes its selected behavior. Existing approval, question-answer, completed-task follow-up,
and managed-child boundaries keep their input contracts.

## Root cause and ownership

The October 8 composer change unconditionally passed `steer = !isManagedSubagent` from both `handleComposerSend` and
the host `acceptInput` shortcut. No setting controlled it. Both callers now consult `autoSteer`; an absent saved value
defaults to false, including existing installations. The explicit steering command does not consult the preference.

The preference uses the shared global-settings schema, `ContextProxy` storage, extension-state projection, and the
Settings view's buffered Save/Cancel flow. It is included in existing settings import/export and search. It changes input
routing rather than introducing a second queue, interrupt mechanism, or task lifecycle owner.

Saving, importing, or resetting settings publishes the preference to the other open chat views on the same host. Peer
updates contain only `autoSteer`, preserving each view's task and transcript. State transport reads the current preference
so an older asynchronously assembled snapshot cannot restore a superseded choice.

`queueMessage` continues to durably admit FIFO input without interrupting the current response. `sendAndSteer` and
`steerQueuedMessage` continue to use the existing durable claim and interruption path. Approval and policy authority
are unaffected. No transcript or queue format migration is needed.

## Validation

Regression coverage exercises missing, false, and true preferences across textarea Enter, Send button, and the host Enter
shortcut; explicit steering with the preference disabled; buffered settings save/cancel/resync; stored preference reload;
queued admission followed by explicit steering; and saved preferences across open views, reset/import refresh, delayed
snapshot assembly, and delayed transports. The exact VS Code **1.125.0** rendered reasoning fixture holds real local HTTP
responses to verify default queueing and explicit steering. It enables automatic steering through the sidebar's Settings
UI and Save, then uses ordinary Enter in an already-open editor to verify the preference reached that composer.

Required checks include the focused settings, composer, types, runtime queue/steering suites and affected typechecks, plus
`pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` and
`pnpm --filter @alpha-code/vscode-e2e test:reasoning:1250`.

Completed October 11, 2026:

- Shared types: all **528 tests** passed. Composer/textarea/queued-message suites: **300 tests** passed. Focused settings,
  persistence, state-projection, and runtime queue/steering suites passed. The final provider/handler/integration run had
  **314 passing tests and 6 existing skips**; adjacent host ownership/history coverage also passed.
- Typechecks passed for `src`, `webview-ui`, `@alpha-code/types`, and `@alpha-code/vscode-e2e`. `pnpm lint`, the extension
  bundle, the webview build, touched-file formatting, and `git diff --check` passed.
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` passed: **13 exact 1.125.0 host launches, 42 passing tests**, no
  failed or pending tests. Each launch verified the host version and captured its evidence.
- The rendered reasoning runner passed all **15 UI stages** using the same built extension and compiled test sources
  (`node ./out/runReasoningUi.js` from `apps/vscode-e2e`, the runner used by `test:reasoning:1250`). Conditions: Windows,
  VS Code **1.125.0**, an owned temporary profile, local HTTP fixture responses, GPT 6 Luna / GPT 5.6 Luna fixture model
  IDs, and trusted keyboard input. Settings and queued-message screenshots were visually inspected in high contrast.

Gate logs are retained under `F:/alpha-e2e/artifacts/steering-queue-20261011-*.log`. The rendered host receipt is
`artifacts/reasoning-ui/ui-probe-0cb535c7-6311-4a83-8a34-8664fda67b19.json`; its owned profile and screenshot evidence
remain in the temporary run directory recorded by that receipt. No live-model quality or speed claim is made.
