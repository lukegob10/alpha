# First-prompt admission and responsiveness

Investigated October 20, 2026 (America/New_York), on Windows with Node 24.21.0 and pnpm 11.24.0.
The report concerns the interval after submitting a first prompt, rather than extension activation or opening a panel.
The investigation coordinated with the **Review code and Codex convergence** chat; unrelated ticket-search, compaction,
and review changes in the shared working tree were preserved.

## Verified causes and changes

The initial composer submission cleared its input immediately but had no pending receipt or transcript preview.
Until task creation and its first persisted UI message finished, the submitted prompt disappeared. The API-request
row appeared later still, after input expansion, environment capture, persistence, and provider pacing. A focused
renderer-component regression reproduced the missing transcript before the fix.

`ChatView` now retains a task/request-correlated submission in its existing composer draft store and renders the
prompt immediately. It displays **Preparing your request…**, prevents a second admission while the first is pending,
and replaces the preview with the host's first transcript message. A rejected submission restores its text and images
once, to the original new-chat draft, without modifying another chat's draft. Failure after empty-task selection
returns the visible composer to that recoverable draft. The preview provides presentation feedback only; task state,
execution authority, persistence, and cancellation remain host-owned.

`ChatCommandResult` gains an additive `newTask` command. Existing request/task identity fields carry the correlation.
Historical submissions without request IDs retain their existing failure-navigation behavior. Saved task and provider
formats are unchanged.

Normal `AlphaProvider.createTask` also called `ProviderSettingsManager.listConfig()` and then `getProfile()`, reading
and validating the same secret-storage document twice under its serialized lock. This both adds a second storage wait
and permits availability validation and settings retrieval to observe different versions. The manager now resolves
availability and settings together in one locked read. Invalid and unsupported profiles still reject before replacing
existing work; an absent or unconfigured profile retains the existing context-only fallback. Explicit captured provider
settings continue to bypass saved-profile lookup.

## Reference behavior

Current upstream HEAD was resolved on the investigation date as
[`d571eaf1f61d0d93a797506335a99a9950ffe37b`](https://github.com/openai/codex/tree/d571eaf1f61d0d93a797506335a99a9950ffe37b).
Its [input-submission implementation](https://github.com/openai/codex/blob/d571eaf1f61d0d93a797506335a99a9950ffe37b/codex-rs/tui/src/chatwidget/input_submission.rs#L473)
renders the optimistic prompt before serial app-event submission because turn start can await remote work, and tracks
the pending start by client message identity. The
[composer submission tests](https://github.com/openai/codex/blob/d571eaf1f61d0d93a797506335a99a9950ffe37b/codex-rs/tui/src/chatwidget/tests/composer_submission.rs#L1858)
also preserve pending-start/input state. Alpha follows this visible-input and correlated-admission behavior through
its existing React draft store and typed webview transport. It does not import an upstream runtime or alter its
execution protections.

## Measurements and limits

The deterministic storage workload runs actual `AlphaProvider.createTask` admission with a real settings manager,
one saved OpenAI profile, and a controlled 50 ms delay per secret-storage read. It stops at the task-replacement
boundary, before model work. Fake timers measure the operation, without network or arbitrary race sleeps.

| Same workload                                           | Before | After |
| ------------------------------------------------------- | -----: | ----: |
| Secret reads per admission                              |      2 |     1 |
| Admission time attributable to this controlled workload | 100 ms | 50 ms |

The regression failed before the change with the observed `{ secretReads: 2, admissionMs: 100 }`; the passing threshold
requires `{ secretReads: 1, admissionMs: 50 }`. This is a halving of the **injected storage wait**, not a claim that
whole-task startup or live-provider latency is halved.

The exact VS Code 1.138.0 real-host baseline used three fresh tasks in the same isolated workspace/process, an injected
scripted provider, no configured provider pacing, and the default checkpoint setting. Task creation took
11.3, 5.3, and 4.9 ms; creation-to-first-provider-entry times were 769.0, 861.7, and 470.9 ms respectively.
Task cleanup releases the scoped skills catalog, so each sample discovers a new catalog; filesystem caches are warm.
An earlier fixture metadata string described later catalogs as warm; the runner's metadata has been corrected.

The same scripted workload after the change reached the provider in 657.6, 288.1, and 486.7 ms, with task creation at
13.6, 4.6, and 5.4 ms. These three-sample series establish bounded local behavior; they do not establish a general
end-to-end speedup. In particular, both series bypass the saved-profile path that the storage optimization changes.

This host benchmark excludes the composer transport, renderer paint, provider network, authentication, and saved-profile
lookup because its executable provider is injected explicitly. It does **not** reproduce the reported multi-second
delay or prove the storage issue explains every affected user's experience. The separate rendered admission check holds
saved-profile lookup at a controlled barrier, verifies that the prompt/status is already visible, then rejects admission
and verifies draft restoration without making a model request.

## Verification and reproduction

Focused checks:

```sh
pnpm --dir src test core/config/__tests__/ProviderSettingsManager.spec.ts core/webview/__tests__/AlphaProvider.unavailable-profile-admission.spec.ts core/webview/__tests__/webviewMessageHandler.spec.ts core/webview/__tests__/AlphaProvider.spec.ts
pnpm --dir webview-ui test src/components/chat/__tests__/ChatView.spec.tsx src/components/chat/hooks/__tests__/useTaskComposer.spec.tsx
pnpm --filter @alpha-code/types test
pnpm check-types
pnpm lint
```

Exact-host and renderer checks:

```sh
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
pnpm --filter @alpha-code/vscode-e2e test:composer-ui:1380
pnpm --filter @alpha-code/vscode-e2e compile
# Run in apps/vscode-e2e after building the extension and webview:
node out/runTest.js --vscode-version 1.138.0 --provider scripted --require-all-tests --file first-prompt-latency.test
```

Local ignored logs use `artifacts/first-prompt-*.log`; host runs retain their own nonce/profile/version evidence.
The passing baseline run is `a3091431-5fb3-4bb7-baed-2da24b0bc163`. An earlier diagnostic fixture failed because the
fake provider's executable callbacks had not been registered; that attempt is excluded from timing conclusions.
Final results:

- Focused host/settings/message tests: 397 passed, six pre-existing skipped tests.
- Composer and draft-store tests: 233 passed. Adjacent navigation/reasoning/ownership tests: 120 passed.
- Existing stop/restore/queued-input fixtures updated for the atomic profile lookup: 22 passed.
- Shared types package: 673 tests passed. Root lint and type checks passed; final fixture edits also passed targeted lint.
- Exact 1.138.0 full smoke gate: 13 required files, 47 tests passed, no failed or skipped tests.
- Exact 1.125.0 compatibility runner: four required files, 19 tests passed, no failed or skipped tests. Its held-response
  audited-read test passed on this run (effect observed 190 ms after the fixture reported the tool call, before releasing
  the response tail). The independent review's earlier failure remains historical evidence, rather than a diagnosed
  first-prompt defect or a claim that it was repaired here.
- Rendered composer check: passed, including the new first-prompt admission/rejection stage. The screenshot was inspected
  at `ui-first-prompt-pending.png` in run `ui-6572e911-d18b-4292-9c34-e0d4a7b4f93e`. The prompt and preparation status were
  visible while saved-profile lookup was held. The polling observer saw the preview 18.2 ms after its pre-Enter
  timestamp in this one run; the measurement includes CDP and observation overhead and is not a general UI benchmark.
- Follow-up exact 1.138.0 startup workload passed in run `1d7f6d2d-f1dd-461d-9361-8cde91ccf607`.

The rendered check ran `node out/runComposerUi.js` after the full smoke command rebuilt the extension and webview;
the startup workload likewise reused those current build outputs. The minimum-host compatibility run reuses the same
outputs through `pnpm --dir apps/vscode-e2e test:compatibility:1250:run`.

Long delays limited to signed-in Copilot, remote workspaces, or affected profiles still require an affected-run trace.
Existing opt-in `ALPHA_TASK_OBSERVABILITY=1` evidence records `task_setup` and `first_provider_request` durations;
these begin inside host task creation and do not measure composer transport or renderer paint. No provider-specific
delay, VS Code upgrade regression, or relationship to the separate 1.125.0 held-response-tail test failure is established.
