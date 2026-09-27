# Task performance observability

Set `ALPHA_TASK_OBSERVABILITY=1` in the VS Code extension host environment to enable diagnostic timing samples. The
default is off. The flag is read when each task is created, so tasks keep their setting for their lifetime. Evaluation
launches inherit the variable through the VS Code E2E runner's `extensionTestsEnv`.

Task samples are appended to that task's existing `agent_turn_events.jsonl` file as `task_performance` events. They
contain only a bounded phase name, outcome, duration, and the event log's normal task/run identity. They do not include
prompt text, images, model settings, or provider payloads. The file remains in the task's storage directory and is
available to the existing diagnostic evidence collector.

The opt-in trace currently measures:

| Phase                     | Measurement                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `task_setup`              | Provider task admission through initial state publication and start dispatch                                             |
| `checkpoint_ready`        | Background checkpoint initialization until it returns a service or disables checkpoints                                  |
| `first_provider_request`  | Task admission through the first provider request invocation                                                             |
| `completed_task_followup` | Completed-task follow-up admission through its first provider request invocation                                         |
| `queue_admission`         | Composer submission through extension-side queue acceptance, including image resolution when needed                      |
| `queued_message_wait`     | Queue acceptance through the runtime dequeuing the message for an eligible turn boundary                                 |
| `condensation`            | Manual or automatic context condensation through summary persistence and cleanup; failures and cancellation are recorded |

Extension activation and the first rendered webview frame are reported to the Alpha output channel with `[performance]`
records while the flag is enabled. `webview_ui_ready` is measured in the webview process from its module start until
the app has hydrated its initial state and passed two animation frames. This confirms an initial rendered frame; it does
not wait for asynchronous provider catalog refreshes or prove that every model option has painted.

These are diagnostic measurements, not pass/fail thresholds. Provider/network time can dominate first-request and
condensation timings. Queue admission uses the webview's wall-clock submission timestamp and ignores missing, future,
or older-than-two-minute values; queued wait is measured on the extension host. No timing sample is written when the
flag is off.

For a local E2E run in PowerShell:

```powershell
$env:ALPHA_TASK_OBSERVABILITY = "1"
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
Remove-Item Env:ALPHA_TASK_OBSERVABILITY
```

For normal use, leave the variable unset. The smoke run uses the scripted provider for task flows and the fixture-backed
VS Code Language Model contract where configured; timings should be compared only for the same host, provider, fixture,
and cache conditions.

The rendered composer responsiveness check is separate from the opt-in task trace. Run
`pnpm --filter @alpha-code/vscode-e2e test:reasoning:1221` to switch between GPT 6 Luna and GPT 5.6 Luna in the actual
composer, verify the reasoning control is ready, and confirm the next request uses `gpt-5.6-luna` with high reasoning.
The switch-to-ready time must be at most 5 seconds and is written to `artifacts/reasoning-ui/ui-probe-<run-id>.json`.
This exact-host UI test uses a local scripted endpoint, so it checks selection and propagation without measuring either
model's network latency.
