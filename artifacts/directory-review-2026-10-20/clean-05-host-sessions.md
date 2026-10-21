# Clean-code review 05: extension host and task sessions

Mode: **full-surface review**, delegated host/session slice, read-only. A good result means one runtime owner for each stable task identity; consistent host limits and terminal events across sidebar, editor, API and IPC; and disposal that joins accepted work before releasing its resources. This pass identifies gaps rather than changing product behavior.

**Quality assessment: 80/100, moderate confidence.** Host-wide ownership, per-view selection, stale navigation generations, cancellation joins and focused regression coverage are substantially developed. The important residual weaknesses are inconsistent admission/disposal across API and webview paths and an API lifecycle projection that bypasses the provider's durable completion boundary. This score is confined to this slice, not a repository-wide quality or Codex-convergence percentage.

## Findings

### CC05-01 — High / must-fix: task admission can complete after its provider has been disposed

- **Location:** `src/core/webview/AlphaProvider.ts:1291` (disposal joins only webview operation queues); `src/core/webview/AlphaProvider.ts:7353` (the sole early disposed check); `src/core/webview/AlphaProvider.ts:7360` (an asynchronous configuration wait after that check).
- **Trigger and reachability:** An API `startNewTask({ newTab: true })` is creating a task when its editor panel closes. `API.startNewTask` calls `provider.createTask` directly (`src/extension/api.ts:244`); it is not in any of the webview queues drained by `disposeOwnedResources`. Hold the configuration queue after the disposed check, close the panel, then release configuration. Disposal can finish with no registered task, dispose history/MCP/skills resources and detach the session view; the accepted creation then constructs, registers and starts a new Task through lines 7487, 7526 and 7541. The constructor has no disposed-provider guard (`src/core/task/Task.ts:1884`, `2026`, `2136`).
- **Impact:** A runtime may outlive the resource owner that just reported successful cleanup. The late task can consume provider resources and register into a detached view, while its resource cleanup is absent from the completed disposal's owned-task snapshot. During extension shutdown this also races global service shutdown.
- **Evidence:** `clean-05-host-session-probes.cjs` executes the current `createTask`, `createTaskUnderCreationLock`, `dispose` and `disposeOwnedResources` method bodies with controlled host adapters. It holds configuration, waits for actual provider-disposal logic to finish, and observes a subsequently registered, started task. This is a deterministic owner-boundary probe; its Task and host adapters are fakes, so it does not establish the complete native-host failure sequence.
- **Existing tests / gap:** Host-ownership tests cover borrowed-view disposal, retained ownership on cleanup failure, and final-history-write joins. They do not start a direct API task admission before disposal and release its configuration lookup afterward. API creation tests mock `provider.createTask`, hiding this lifecycle interaction.
- **Minimal remedy:** Make provider disposal join the accepted task-creation queue before taking its owned-task snapshot, with admission closed first. Recheck disposal after awaited preparation and immediately before runtime ownership commits. Add a controlled-promise regression that closes an API-created editor during configuration preparation, verifies no task starts after disposal resolves, and checks final resource ownership.

### CC05-02 — High / must-fix: public API/IPC reports managed-child completion before its durable result is committed

- **Location:** `src/extension/api.ts:361`.
- **Trigger and reachability:** Any managed child created under an API-observed provider emits raw `TaskCompleted`. `API.registerListeners` subscribes directly to each Task when the provider emits `TaskCreated` (`src/extension/api.ts:352-369`), then forwards completion immediately. This explicitly bypasses `AlphaProvider`'s child barrier: its own Task listener only stores the payload at `src/core/webview/AlphaProvider.ts:913-918`; `publishDurableManagedTaskCompletion` publishes the provider event after result and parent-mailbox commitment (`src/core/webview/AlphaProvider.ts:5616-5636`). API events are also broadcast to IPC by the `API.emit` override (`src/extension/api.ts:191`).
- **Impact:** API/IPC consumers can receive success while the authoritative managed-agent result is still uncommitted, or receive a success that a subsequent persistence failure prevents the provider from accepting. The external integration surface has a different terminal-state contract from the webview/provider.
- **Evidence:** The read-only probe executes the current API listener-registration method with EventEmitters and shows it publishes raw child completion without subscribing to the provider completion event. Existing `AlphaProvider.spec.ts:539-565` explicitly tests that the same raw child event must not yet produce a provider completion. The mismatch is visible directly in the two live implementations.
- **Existing tests / gap:** Provider-level durability has a focused test. API tests cover task creation, sending, cancellation and queued-message durability, but no API test bridges raw managed-child completion to its delayed durable provider event.
- **Minimal remedy:** Forward accepted terminal lifecycle events from the provider's canonical lifecycle surface. Preserve the API's `isSubtask` field from captured task identity without treating the raw Task event as authoritative. Add an API/IPC regression with a held and then failing durable child result/mailbox commit; assert zero early completions and exactly one event after successful commitment.

### CC05-03 — Medium / should-fix: API task creation in a fresh editor bypasses the shared live-task maximum

- **Location:** `src/core/webview/AlphaProvider.ts:7458`.
- **Trigger and reachability:** Fill the shared registry to `maxConcurrentTasks`, then call public API `startNewTask({ newTab: true })`. Its options at `src/extension/api.ts:236-244` omit `preserveExisting`. The new provider has no current task to remove. The shared-capacity check only runs when `options.preserveExisting` is true; the default/API branch proceeds directly to construction and registration. `TaskSessionRegistry.register` does not enforce capacity itself (`src/core/webview/TaskSessionRegistry.ts:417`). Each further API-created tab can take the same path. Ordinary webview `newTask` explicitly passes `preserveExisting: true` and is correctly denied (`src/core/webview/webviewMessageHandler.ts:747-754`).
- **Impact:** The configured host-wide live-task cap and its backpressure guarantee depend on which extension surface launches work. New API editor tabs can oversubscribe the provider and extension-host work despite the shared registry knowing it is full.
- **Evidence:** The read-only probe supplies `canCreateTask() === false` and executes the current creation method. The API option shape starts a task; the equivalent `preserveExisting: true` shape rejects with the maximum-live-task error.
- **Existing tests / gap:** Registry and managed-child tests exercise shared prepared-slot reservations. API new-tab tests replace the complete provider creation method. They do not check the full-host case across a real shared registry and fresh editor provider.
- **Minimal remedy:** Enforce the effective host capacity for every new live runtime after any legitimate replacement has released its slot. Keep replacement/recovery and reserved-child admissions explicit so they do not double-charge. Add a shared-host test at maximum capacity for fresh API editor creation, webview creation and actual replacement.

## Coverage and validation

Reviewed current code in `src/extension.ts`, editor panel registration/serialization in `src/activate/registerCommands.ts`, `src/extension/api.ts`, `TaskSessionRegistry`, cancellation-boundary adapters, lifecycle projections, task construction/admission, disposal and queue routing in `AlphaProvider`, selected cross-task ownership paths and webview message routes. Inspected the shared event/IPC schemas, IPC server validation, and adjacent tests. Read the clean-code-review JavaScript, testing, rubric and end-state guidance and applied the repository's ownership/lifecycle rules.

Ran:

```text
pnpm --dir src test core/webview/__tests__/TaskSessionRegistry.spec.ts core/webview/__tests__/AlphaProvider.host-ownership.spec.ts extension/__tests__/api-start-new-task.spec.ts --maxWorkers=1
```

Result: **3 files passed; 71 tests passed** (24.82 seconds reported by Vitest).

```text
node artifacts/directory-review-2026-10-20/clean-05-host-session-probes.cjs
```

Result: **all three deterministic probes confirmed the described boundary gaps; exit 0**. The script reads and transpiles the current methods; it modifies neither production files nor existing tests. It uses controlled fakes and is evidence for the isolated boundary behavior, not a substitute for an extension-host reproduction.

Not run: typecheck, broad unit suites, exact VS Code 1.138.0 smoke, 1.125.0 compatibility, native panel-close reproduction, live provider/IPC evaluation, or performance/memory benchmarks. This is an audit artifact only; no behavior-changing patch needs a release gate in this pass. The native-host race impact and external integrations remain verification gaps.

Positive evidence: `TaskSessionRegistry` shares runtime ownership by storage path while retaining per-view focus; identity-scoped operations protect replacement/cleanup; providers route operations to the owner; failed cleanup retains handles for retry; navigation generations reject stale task opens; cancellation joins are explicit; IPC commands are schema-validated; existing host/registry/API tests pass.

## Closure ledger

- **Fixed now:** None; the delegated review is read-only. Added only this report and its probe artifact.
- **Flagged for follow-up:** CC05-01, CC05-02, CC05-03.
- **Not verified:** Native editor shutdown ordering, actual child commit failure observed through IPC, whole-host resource accounting, and the complete 14k-line provider's remaining integration paths.
- **Out of scope:** Codex CLI behavioral comparison, sandbox architecture, provider transforms, tool policy and subprocess internals, React component quality, packaging and scheduled-task engine internals; other review slices cover those.

Highest-value next pass: operational hardening of task admission/disposal and canonical API lifecycle projection, with real provider/registry plus controlled persistence adapters. Rerun this slice after those three gaps are addressed; no general claim of complete cleanup is supported.
