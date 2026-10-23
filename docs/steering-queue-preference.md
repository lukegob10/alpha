# Queue and automatic steering

Ordinary Send/Enter queues messages submitted during an active task by default. Enable **Settings → UI → Auto-steer
messages** and click **Save** to interrupt an eligible active response with ordinary submission. Typing updates only the
composer draft.

Queued messages retain **Steer**, edit, and delete controls. **Send and steer** (`alpha.sendAndSteer`, Ctrl+Alt+S on Windows)
explicitly steers the visible primary chat with automatic steering disabled. Approval, question-answer, completed-task
follow-up, and managed-child boundaries retain their input contracts.

## State and admission

`autoSteer` uses the shared global-settings schema, `ContextProxy`, import/export, and SettingsView's buffered Save/Cancel
flow. A missing saved value defaults to false. The explicit steering command does not consult this preference.

Save/import/reset publishes the preference to other open views on the same host without replacing their task/transcript.
State transport reads the current value so delayed snapshot assembly cannot restore a superseded choice.

`queueMessage` durably admits FIFO input without interrupting the current response. Direct and queued steering use the
existing durable claim/interruption path. Rejected input retains its composer draft; an accepted message whose handoff
fails remains queued. The [turn admission contract](turn-command-admission.md) prevents delayed direct steering or Stop
from affecting a successor turn. No queue/transcript migration or second lifecycle owner is introduced.

## Validation

Cover missing/false/true preferences through Enter, Send, and host shortcuts; explicit steering while disabled; buffered
settings save/cancel/resync; stored reload; cross-view refresh; and delayed snapshots/transports. Controlled provider
promises distinguish queueing from interruption.

```sh
pnpm --dir webview-ui check-types
pnpm --dir src check-types
pnpm --filter @alpha-code/vscode-e2e test:reasoning:1380
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
```

The rendered reasoning fixture uses trusted input with local scripted responses. It does not establish live-model speed
or quality.
