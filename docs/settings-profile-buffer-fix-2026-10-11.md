# Profile rename preserves the settings edit buffer

Date: **October 11, 2026 (America/New_York)**. Scope: finding F2 in
[`settings-review-2026-10-10-codex-alignment.md`](settings-review-2026-10-10-codex-alignment.md).
Implementation starts from Alpha checkpoint `14fc29614911d0d3b88670135a8a5c11abb75103`.
The initial rename change was committed as `1435cd18` (`fix(settings): rename saved profiles without applying drafts`).
The follow-up described below builds on that commit and reuses the same three subagents.

The user authorized implementation and concurrent subagents. This work used **three collaboration subagents**:
`contract_review` for the current upstream contract/design note and independent review, `host_rename` for manager/host
implementation and regressions, and `ui_rename` for edit-buffer behavior and UI regressions. All writers used the isolated
managed worktree `C:/Users/Luke Goblirsch/.codex/worktrees/settings-profile-buffer-20261011/Alpha-Code`; the primary checkout
and shared upstream checkout were not edited.

## Problem and owning layers

Editing a profile's provider, endpoint, key, or model and then renaming it previously committed the unsaved provider
configuration. `SettingsView` supplied its `cachedState.apiConfiguration` in the rename message; the host saved that
configuration under the replacement name, deleted the old entry, and activated the replacement. Activation writes
provider settings and rebuilds the current task's API handler. The ordinary Save button therefore did not own when these
edits became effective.

The profile manager owns persisted profile identity and contents. The extension provider owns profile metadata,
configuration sequencing, and task references. The webview owns the local edit buffer and correlates operation results.
Renaming crosses these layers, but it must remain a metadata operation throughout that path.

## Current upstream reference

The inspected source is [openai/codex commit `27065a91ccbf5ba8532844be3777fcf83b77820d`](https://github.com/openai/codex/commit/27065a91ccbf5ba8532844be3777fcf83b77820d),
committed **2026-10-11T17:43:08Z** and inspected on October 11, 2026. The shared source checkout was read only. Upstream
tests below were inspected, **not executed**. This supersedes the earlier review's upstream snapshot for this fix.

| Verified upstream contract                                                                                                                  | Functions and tests inspected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Native Alpha interpretation                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A persisted write names the exact edits and may reject a stale version. Validation and persistence precede success.                         | [`ConfigManager::write_value`, `batch_write`, and `apply_edits`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/app-server/src/config_manager_service.rs#L195); [`config_value_write_replaces_value`, `config_value_write_rejects_version_conflict`, and `config_batch_write_applies_multiple_edits`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/app-server/tests/suite/v2/config_rpc.rs#L1551)                                    | Rename supplies only identity and the desired name. The existing manager lock serializes the read, collision check, and one profile-store write. Unsaved provider fields are outside the mutation scope.                                         |
| Persisting settings and updating loaded threads are separate operations with explicit scope.                                                | [`ConfigBatchWriteParams::reload_user_config`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/app-server-protocol/src/protocol/v2/config.rs#L1115); [`ConfigRequestProcessor::batch_write` and `reload_user_config_inner`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/app-server/src/request_processors/config_processor.rs#L161)                                                                                                  | Rename updates display and persisted name references without activating the profile, replacing provider settings, rebuilding an API handler, or changing policy. Existing Save and explicit profile selection retain their established behavior. |
| A loaded thread's model/settings change targets its thread ID and affects future turns; settings-only changes do not start a model request. | [`thread_settings_update_inner`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/app-server/src/request_processors/turn_processor.rs#L940); [`thread_settings_update_emits_notification_and_updates_future_turns`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/app-server/tests/suite/v2/thread_settings_update.rs#L230)                                                                                                             | A label change must not implicitly perform a task configuration change. Rename preserves current and background task configurations and in-flight step snapshots.                                                                                |
| Named user profiles are layered configuration files, not the historical `[profiles.<name>]` representation.                                 | [`load_config_layers_state`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/config/src/loader/mod.rs#L145); [`legacy_profile_selection_is_rejected`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/config/config_tests.rs#L9889); [`config_batch_write_rejects_legacy_profile_tables`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/app-server/tests/suite/v2/config_rpc.rs#L2443) | Alpha intentionally retains its native provider/model profiles and stable IDs in VS Code SecretStorage. This fix does not import upstream profile files, Rust, prompts, a sandbox, or a parallel runtime.                                        |

The source verifies scoped mutations and the distinction between persisted defaults and loaded-thread changes. It does
not define an Alpha-style stable-ID provider-profile rename API. The rename contract below is a native Alpha design that
preserves those boundaries and Alpha's existing Save-buffer invariant.

The core writer provides another scoped-mutation check:
[`apply_blocking_to_resolved_file` and `ConfigEditsBuilder`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/config/edit.rs#L749)
apply the requested discrete edits and atomically persist only a changed document.
[`blocking_clear_model_does_not_follow_legacy_active_profile` and `blocking_set_model_does_not_follow_legacy_active_profile`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/config/edit_tests.rs#L722)
assert that unrelated legacy profile fields survive those writes. Alpha likewise preserves saved profile contents during
rename and requires explicit Save for buffered provider fields.

The follow-up reread `ConfigManager::apply_edits`, `ConfigValueWriteParams`, and
`config_value_write_rejects_version_conflict` at this same pinned commit. Upstream validates the configured write target
and optional expected version before committing. Alpha translates the target invariant into its native stable profile
ID and shared queues; it does not add a file-version protocol or change the existing semantics of an explicit provider
configuration Save.

## Rename contract

- The current webview sends `renameApiConfiguration` with `apiConfigurationRename: { requestId, id, newName }`. It does not
  include the provider edit buffer.
- `apiConfigurationRenamed` carries a typed result correlated by `requestId`. Success contains `id`, `oldName`, and
  `newName`. Errors classify invalid input, missing identity, a name collision, and a failed save without returning
  credential-bearing data. A save error may carry the authoritative saved `profile: { id, name }` after a rejected
  primary write or successful compensation, so a failed state refresh cannot make a later Save target the wrong name.
- A legacy `values: { oldName, newName }` request remains supported. Any legacy `apiConfiguration` payload is ignored;
  the host resolves the persisted profile and renames its saved contents. A missing or malformed typed identity cannot
  gain a fallback to a different profile.
- The manager renames one persisted entry while holding its existing lock. The full saved profile and ID survive,
  including retired/unknown provider fields. The current name changes only if the renamed entry was current. Mode and
  child-profile mappings retain their stable IDs. Case-insensitive collisions never overwrite another entry; case-only
  renames remain valid, and a same-name rename is a successful no-op.
- The existing manager lock is shared by managers using the same `ExtensionContext.secrets` object. Sidebar and editor
  views therefore serialize their profile reads and writes against the same namespace; a rename sees a concurrent
  view's completed Save rather than overwriting it from an earlier snapshot. This extends the existing lock through a
  `WeakMap`, without introducing a separate profile store or runtime.
- The provider's existing configuration queue is shared by the same SecretStorage identity through the end of each
  enqueued operation's projection/recovery. This orders the current Save/upsert, activation/selection, rename, and scoped
  task-profile/reasoning entrypoints across sidebar and editor views. It prevents a delayed first rename projection from
  overwriting a later rename's name references. The existing task-creation barrier reads that shared queue; queued
  callbacks do not recursively enqueue or create tasks. This serializes configuration operations, while task execution
  continues through the shared multi-task harness. Historical `saveApiConfiguration` and profile deletion retain their
  distinct paths; all existing manager mutations still use the shared manager lock.
- Matching name-based task references are refreshed for reload continuity; rename does not alter provider
  configuration, execution authority, or immutable in-flight step settings.
- The UI retains ordinary inputs in `cachedState`. A successful name change with the same profile ID preserves draft
  fields and the dirty flag even when a host-state refresh arrives before the correlated result. A different profile ID
  is a real selection change. Pending rename blocks Save and competing profile actions. After a result, further profile
  actions remain blocked until the live current name and same-ID metadata match the confirmed name; ordinary Save is
  available and carries the edit buffer's stable ID plus that confirmed display name while metadata catches up. Failed
  rename preserves the draft and uses the authoritative saved name when supplied for display or retry.

## Existing-profile Save after a queued rename

Independent review after `1435cd18` found a second F2 commit-order failure. An editor could keep a dirty buffer for profile
`A` while a sidebar renamed that same ID to `B`. Save waited behind the shared configuration queue, but then used stale
display name `A` to create another entry. The controlled two-view baseline produced four saved profiles where three
should remain. Serializing operations therefore also requires resolving the edited identity at the write boundary.

- Existing-profile Save sends `upsertApiConfiguration` with `requestId`, `apiConfigurationId`, and the buffered
  `apiConfiguration`. `text` is optional display metadata and cannot select the saved entry. Presence of either modern
  identity/correlation field selects the modern branch. Invalid, missing, or malformed modern fields never fall through
  to name-based creation. A bounded usable request ID can receive an `invalid` result; missing correlation does not
  mutate the profile.
- `ProviderSettingsManager.saveConfig({ id }, draft)` resolves the current persisted map key inside the shared manager
  lock, writes that one entry, and returns canonical `{ id, name }` from the same mutation. An embedded `draft.id` cannot
  override the target. The original draft container is validated before adding that authoritative ID; malformed
  string, array, number, Date, null, undefined, or boolean inputs cannot become an empty saved profile through object
  spread. This container check does not strip or transform legacy fields. Unknown or deleted IDs fail closed, including
  when another ID now owns the old display name. The name-based overload keeps creation, imported IDs, default
  initialization, public API calls, and historical webviews compatible.
- `AlphaProvider` resolves the ID-targeted Save inside the existing shared configuration queue and uses the returned
  canonical name for current-profile activation, mode mappings, and sticky task references. Save/upsert and activation
  wait for all started projection writes before propagating a failure. `ContextProxy.setValues` does the same for its
  inner provider/global/secret batch. This prevents a late owned write from crossing the queue boundary and overwriting
  a subsequent retry or rename. Rejection is detected by status, including when its reason is falsy; these fences do not
  add rollback or a transaction engine.
- The UI captures profile ID and name with the edit buffer. A known ID survives missing metadata and same-ID name
  refreshes; a real selection replaces identity and fields together. Discard only retains a prior unresolved ID for the
  same captured name or confirmed rename aliases. Import or Discard into another unresolved profile cannot borrow the
  old ID or silently degrade to creation: Save waits for that profile's identity. Initial legacy/default buffers and
  explicit profile creation retain their name-based route.

The user explicitly authorized a bounded correlated Save acknowledgement after review also reproduced eager dirty-state
clearing on rejected or unacknowledged Save. `apiConfigurationSaved` returns a strict
`apiConfigurationSaveResult`: success carries `requestId`, `id`, and canonical `name`; error carries `requestId` and
`invalid`, `notFound`, or `saveFailed`. Results contain no provider configuration or credentials.

Modern Save keeps the draft dirty until matching success for its submitted buffer snapshot. The success handler compares
that snapshot inside React's state update queue, so even an edit queued in the same event batch remains dirty. A different
request, profile ID, or replaced buffer cannot clear the current edits. Errors preserve fields and dirty state. Pending
Save blocks another Save and local profile actions while inputs remain editable. Save results do not overlay profile
names, so a delayed success cannot regress a newer same-ID rename projection.

One owned 30-second timeout releases the pending UI operation, preserves the draft, and permits explicit retry. It does
not cancel or roll back a host write, and it does not automatically resubmit. Matching completion, selection, import,
hydration, Discard, and unmount clear the pending request and timer; late or duplicate replies are ignored.

Modern success means the primary profile write and the established queued Save path completed normally. A propagated
activation, projection, or state error may occur after that primary write committed and then return `saveFailed`; it is
not proof that storage stayed unchanged. The draft remains available and retry targets the same saved ID. Existing
best-effort sticky-history error handling remains in place, so success does not newly guarantee every derived history
write. Other settings messages retain their independent completion semantics. Acknowledgement delivery is a separate
stage: a rejecting adapter is logged without changing the chosen result, saving again, or sending a contradictory second
result. Timeout or missing delivery likewise does not prove that persistence failed.

## Compatibility and failure boundaries

No persisted format or public profile ID migration is needed. Alpha's existing SecretStorage namespace remains the owner
of saved provider settings and credentials. Name-based sticky task history must follow a successful rename so a later
reload resolves the renamed profile; ID-based mode and child routing require no rewrite. The retained legacy message
shape is deliberately narrower: supplying provider fields with rename no longer saves them. Save remains the explicit
operation for applying those fields.

Validation distinguishes persisted-write failure from a later projection failure. A failed profile-store write leaves
the old persisted entry, current name, task references, and UI draft intact. If persistence succeeds but a later metadata
or history write fails, compensation renames that same ID back only if its persisted name still matches the attempted
rename. The manager performs this expected-name check inside its existing lock. Recovery attempts each independent
metadata, live sticky-name, history, and state-delivery stage even if an earlier stage rejects; it does not restore full
configuration or history snapshots.

Successful compensation returns `saveFailed` with the restored saved identity, even if a later inverse projection cannot
be delivered. If compensation is rejected, the operation acknowledges the committed saved identity and makes one
bounded reconciliation pass for each original/intermediate name alias, attempting both independently. A newer persisted
rename is authoritative. Recovery resolves that identity by stable ID from one canonical metadata snapshot, rather than
letting a legacy passthrough profile field named `name` override the persisted map key. A rejecting acknowledgement
adapter is logged separately and cannot turn a committed operation into a second persistence result. The configuration
queue remains usable after failure. Rename manager/host result
logging uses bounded stage/error classifications without credential-bearing data; the existing filesystem helper can
still log filesystem errors and paths. Correlation does not guarantee delivery to a disposed webview or add a reliability
protocol; the existing post-message adapter may swallow that disposal error.

`TaskHistoryStore.renameProviderProfile` changes only a matching `apiConfigName`. It validates the durable record and
task identity, preserves raw unknown and nested fields without normalizing unrelated values, and never recreates a
missing history file from cache. Before reading, it uses the existing read-only task-directory resolver to reject
path-shaped IDs, linked task directories, and paths outside the configured storage root. The history file must be a
regular non-symlink file both before the read and at commit. Its existing file-write lease protects an atomic replacement,
with a content comparison immediately before commit to reject an intervening sibling write or deletion. Partial canonical
writes remain visible for name-only compensation; concurrent usage, lifecycle, and profile-selection changes survive. The small synchronous
comparison/replacement uses the existing atomic commit hook and introduces no new state store or transaction engine.

SecretStorage and the derived history/memento stores are separate persistence boundaries. A crash between writes, or
permanent rejection of both compensation and repeated derived-store writes, can leave a display/history name stale even
though the saved profile rename is committed. The correlated result still names the authoritative saved profile; saved
provider configuration, task handlers, and unrelated raw records remain intact. This bounded recovery deliberately does
not claim a distributed transaction or an automatic repair of every permanently unavailable store.

### Scheduled and managed profile references

The scheduler previously selected a profile by ID and then rejected a different name. Its editor also required both ID
and name for availability. Both checks now use the stable profile ID, so a rename keeps the existing schedule available
and the editor shows the current profile option label. Missing, unreadable, and unconfigured profiles still fail closed;
another profile reusing the old display name does not satisfy a missing ID.

Captured schedule setup retains its stored `apiConfig` display snapshot, prompt, workspace, mode, approval policy, and
reasoning choice. Admission loads the same saved ID and records the actual current name in `resolvedApiConfig`. No saved
or queued schedule is silently rewritten. This intentionally changes the former rename-as-unavailable contract; its
regression now covers unconfigured profiles, while new tests prove ordinary and case-only renames work.

Managed routes already resolve their saved `profileId` on restoration. Their captured model/configuration and display
snapshots remain immutable; rename updates reload-facing sticky task names without rewriting approved route snapshots.

## Changed-file manifest

This manifest covers the initial commit and its follow-up source change.

- Shared contract: `packages/types/src/provider-profile-rename.ts`,
  `packages/types/src/__tests__/provider-profile-rename.spec.ts`, `packages/types/src/provider-profile-save.ts`,
  `packages/types/src/__tests__/provider-profile-save.spec.ts`, `packages/types/src/index.ts`, and
  `packages/types/src/vscode-extension-host.ts`.
- Profile persistence and host projection: `src/core/config/ProviderSettingsManager.ts` and
  `src/core/config/__tests__/ProviderSettingsManager.renameProfile.spec.ts`;
  `src/core/config/ContextProxy.ts` and `src/core/config/__tests__/ContextProxy.spec.ts`;
  `src/core/task-persistence/TaskHistoryStore.ts` and `src/core/task-persistence/__tests__/TaskHistoryStore.spec.ts`;
  `src/core/webview/AlphaProvider.ts` and `src/core/webview/__tests__/AlphaProvider.sticky-profile.spec.ts`;
  `src/core/webview/webviewMessageHandler.ts` and `src/core/webview/__tests__/webviewMessageHandler.spec.ts`; and the shared-queue fixture in
  `src/core/webview/__tests__/AlphaProvider.reasoning-preference.spec.ts`.
- Settings edit buffer and rename form: `webview-ui/src/components/settings/SettingsView.tsx`,
  `webview-ui/src/components/settings/ApiConfigManager.tsx`,
  `webview-ui/src/components/settings/__tests__/SettingsView.unsaved-changes.spec.tsx`,
  `webview-ui/src/components/settings/__tests__/ApiConfigManager.spec.tsx`, and
  `webview-ui/src/i18n/locales/en/settings.json`.
- Stable-ID schedule compatibility: `src/services/scheduled-tasks/ScheduledTaskService.ts` and
  `src/services/scheduled-tasks/__tests__/ScheduledTaskService.profiles.spec.ts`;
  `webview-ui/src/components/scheduled-tasks/ScheduledTasksView.tsx` and
  `webview-ui/src/components/scheduled-tasks/__tests__/ScheduledTasksView.spec.tsx`.
- Durable contract and validation record: `docs/settings-profile-buffer-fix-2026-10-11.md`. The October 10 review remains
  unchanged as design history.

## Regression and validation record

### Initial rename commit

The following checks record the implementation committed as `1435cd18`. Follow-up checks are recorded separately below.

The required observable cases are dirty rename followed by explicit Save; refresh/result ordering; matching and stale
request IDs; retry after error; active and inactive profiles; collision; missing ID; same-name no-op; SecretStorage
rejection; preserved stable-ID mappings and saved secret fields; and current/background task configurations untouched by
rename. Controlled promises should establish concurrency order without sleeps.

The host dirty-rename regression failed before the handler change: the legacy request persisted the draft Vertex
provider/model and dropped the saved OpenAI endpoint/key/model. The baseline focused run reported 1 failed and 119 skipped
tests. This directly reproduces F2 at the real manager/message-handler boundary.

Two controlled concurrency regressions also failed before their owning fixes:

- `pnpm --dir src test core/config/__tests__/ProviderSettingsManager.renameProfile.spec.ts --maxWorkers=2 -t 'serializes a sibling view rename'`:
  1 failed, 17 skipped. The sibling manager read the map while another view's Save was still held.
- `pnpm --dir src test core/webview/__tests__/AlphaProvider.sticky-profile.spec.ts --maxWorkers=2 -t 'serializes a sibling rename through'`:
  1 failed, 27 skipped. The persisted profile was `newer`, but the late first projection left the current name `renamed`.

Both pass in the final suite with shared ownership of the existing manager lock and provider configuration queue.

The committed-identity recovery regression also failed before its final refinement:
`pnpm --dir src test core/webview/__tests__/AlphaProvider.sticky-profile.spec.ts --maxWorkers=2 -t 'returns committed metadata identity'`
reported 1 failed and 27 skipped tests. A legacy saved `name` field overrode the actual renamed map key in the result.
The metadata-only recovery now preserves that field while reporting the canonical profile name.

The scheduled admission regression failed for both new-name and case-only renames before changing production code:
`pnpm --dir src test services/scheduled-tasks/__tests__/ScheduledTaskService.profiles.spec.ts --maxWorkers=2 -t 'admits a renamed profile'`.
The editor regression also failed before the fix because the selected stable ID became empty:
`pnpm --dir webview-ui test src/components/scheduled-tasks/__tests__/ScheduledTasksView.spec.tsx --maxWorkers=2 -t 'stable-ID selection when a profile is renamed'`.

| Executed check                                                                                                                                                                                                                                                                                                                                                                                             | Result                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --dir src test services/scheduled-tasks/__tests__/ScheduledTaskService.profiles.spec.ts --maxWorkers=2`                                                                                                                                                                                                                                                                                              | Passed, 30 tests.                                                                                                         |
| `pnpm --dir webview-ui test src/components/scheduled-tasks/__tests__/ScheduledTasksView.spec.tsx src/components/scheduled-tasks/__tests__/ScheduledTasksView.reasoning-selector.spec.tsx --maxWorkers=2`                                                                                                                                                                                                   | Passed, 26 tests across 2 files.                                                                                          |
| `pnpm --dir webview-ui test src/components/settings/__tests__/SettingsView.unsaved-changes.spec.tsx src/components/settings/__tests__/ApiConfigManager.spec.tsx src/components/settings/__tests__/SettingsView.spec.tsx src/components/settings/__tests__/SettingsView.change-detection.spec.tsx --maxWorkers=2`                                                                                           | Passed, 77 tests across 4 files.                                                                                          |
| `pnpm --dir src test core/config/__tests__/ProviderSettingsManager.renameProfile.spec.ts core/config/__tests__/ProviderSettingsManager.spec.ts core/task-persistence/__tests__/TaskHistoryStore.spec.ts core/webview/__tests__/webviewMessageHandler.spec.ts core/webview/__tests__/AlphaProvider.sticky-profile.spec.ts core/webview/__tests__/AlphaProvider.reasoning-preference.spec.ts --maxWorkers=2` | Passed, 298 tests across 6 files.                                                                                         |
| `pnpm --dir src test core/webview/__tests__/AlphaProvider.sticky-profile.spec.ts core/webview/__tests__/webviewMessageHandler.spec.ts --maxWorkers=2`                                                                                                                                                                                                                                                      | Passed, 151 tests across 2 files after the final committed-identity refinement; repeats coverage within the 298-test run. |

Additional executed checks reported by the lead:

- `pnpm --filter @alpha-code/types test src/__tests__/provider-profile-rename.spec.ts --maxWorkers=2`: passed, 14 schema
  tests.
- `pnpm --filter @alpha-code/types build`, `pnpm --filter @alpha-code/types check-types`, and
  `pnpm --filter @alpha-code/types lint`: passed.
- `pnpm --dir webview-ui check-types`: passed.
- `pnpm --dir src check-types`: passed with ordinary workspace settings and without temporary type exclusions.
- `pnpm --dir webview-ui test src/components/settings/__tests__/ApiConfigManager.spec.tsx --maxWorkers=2`: passed,
  17 tests in the owning suite after its matcher typing correction; this repeats coverage within the 77-test run.
- Focused ESLint over the six changed webview files: passed, using the command below.
- Focused ESLint over the eleven changed extension TypeScript files: passed after the shared-lock, shared-queue, and
  history path checks, using the command below.
- The final `AlphaProvider` and sticky-profile regression ESLint rerun passed after the metadata-only recovery refinement.

The distinct focused suites total **445 passing tests across 14 files**, including the 14 shared-schema tests. The final
151-test recovery rerun and 17-test UI matcher rerun repeat coverage and are not added to that total. Ordinary extension
typechecking passed again after the final metadata-only recovery refinement.

```sh
pnpm --dir webview-ui exec eslint src/components/settings/SettingsView.tsx src/components/settings/ApiConfigManager.tsx src/components/settings/__tests__/SettingsView.unsaved-changes.spec.tsx src/components/settings/__tests__/ApiConfigManager.spec.tsx src/components/scheduled-tasks/ScheduledTasksView.tsx src/components/scheduled-tasks/__tests__/ScheduledTasksView.spec.tsx
pnpm --dir src exec eslint core/config/ProviderSettingsManager.ts core/config/__tests__/ProviderSettingsManager.renameProfile.spec.ts core/task-persistence/TaskHistoryStore.ts core/task-persistence/__tests__/TaskHistoryStore.spec.ts core/webview/AlphaProvider.ts core/webview/__tests__/AlphaProvider.sticky-profile.spec.ts core/webview/webviewMessageHandler.ts core/webview/__tests__/webviewMessageHandler.spec.ts services/scheduled-tasks/ScheduledTaskService.ts services/scheduled-tasks/__tests__/ScheduledTaskService.profiles.spec.ts core/webview/__tests__/AlphaProvider.reasoning-preference.spec.ts
pnpm --dir src exec eslint core/webview/AlphaProvider.ts core/webview/__tests__/AlphaProvider.sticky-profile.spec.ts
```

The initial independent review covered manager serialization, preserved stored secrets/legacy fields, strict wire parsing,
metadata-only host projection, compensation ownership, concurrent history preservation, correlated authoritative-name
recovery, and edit-buffer/dirty-state behavior. The review found and resolved missing history identity/raw-field and path
checks, the skipped intermediate-name repair after a failed reconciliation stage, and incomplete lock/queue ownership
across sibling views. Those controlled regressions and affected package checks passed. The subsequent independent review
found the queued Save and completion failures recorded below. No upstream tests or live provider calls were executed for
this source review.

### Follow-up Save identity and acknowledgement

The follow-up first reproduced each failure with controlled boundaries:

- `pnpm --dir src test core/webview/__tests__/AlphaProvider.sticky-profile.spec.ts --maxWorkers=2 -t 'saves a stale sibling draft by stable ID'`:
  1 failed, 28 skipped; the stale queued Save recreated the old name, leaving four profiles instead of three.
- `pnpm --dir webview-ui test src/components/settings/__tests__/SettingsView.unsaved-changes.spec.tsx --maxWorkers=2 -t 'saves a stale editor name by its captured profile ID exactly once'`:
  1 failed, 35 skipped; Save omitted the buffer's stable ID.
- `pnpm --dir webview-ui test src/components/settings/__tests__/SettingsView.unsaved-changes.spec.tsx --maxWorkers=2 -t 'keeps modern edits dirty until the extension acknowledges Save'`:
  1 failed, 40 skipped; Done closed without an unsaved-changes prompt before Save was acknowledged.
- `pnpm --dir src test core/webview/__tests__/AlphaProvider.sticky-profile.spec.ts core/config/__tests__/ContextProxy.spec.ts --maxWorkers=2 -t 'settles all started|waits for all provider-setting writes'`:
  4 failed, 71 skipped across 2 files; Save, activation, and the inner settings batch completed early while an owned write
  was held. After the completion fences, the same command passed all 4 selected tests with 71 skipped.
- `pnpm --dir src test core/config/__tests__/ProviderSettingsManager.renameProfile.spec.ts core/webview/__tests__/AlphaProvider.sticky-profile.spec.ts --maxWorkers=2 -t 'malformed .* draft container'`:
  11 failed, 60 skipped across 2 files. Seven manager container cases and four real modern handler/provider cases showed
  that malformed input was converted into an empty configuration before validation, clearing saved profile fields.

Executed follow-up checks:

| Executed check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Result                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --dir src test core/config/__tests__/ProviderSettingsManager.renameProfile.spec.ts core/config/__tests__/ProviderSettingsManager.spec.ts core/config/__tests__/ContextProxy.spec.ts core/webview/__tests__/AlphaProvider.sticky-profile.spec.ts core/webview/__tests__/webviewMessageHandler.spec.ts core/webview/__tests__/AlphaProvider.reasoning-preference.spec.ts core/webview/__tests__/AlphaProvider.apiHandlerRebuild.spec.ts core/webview/__tests__/AlphaProvider.spec.ts --maxWorkers=2` | Passed, 486 tests; 6 skipped across 8 files after the original-container guard.                                                |
| `pnpm --dir webview-ui test src/components/settings/__tests__/SettingsView.unsaved-changes.spec.tsx src/components/settings/__tests__/ApiConfigManager.spec.tsx src/components/settings/__tests__/SettingsView.spec.tsx src/components/settings/__tests__/SettingsView.change-detection.spec.tsx --maxWorkers=2`                                                                                                                                                                                         | Passed, 103 tests across 4 files.                                                                                              |
| `pnpm --dir webview-ui test src/components/settings/__tests__/SettingsView.unsaved-changes.spec.tsx --maxWorkers=2`                                                                                                                                                                                                                                                                                                                                                                                      | Passed, 61 tests in the owning suite after the inference-only test-table correction; repeats coverage within the 103-test run. |
| `pnpm --filter @alpha-code/types test src/__tests__/provider-profile-save.spec.ts src/__tests__/provider-profile-rename.spec.ts --maxWorkers=2`                                                                                                                                                                                                                                                                                                                                                          | Passed, 34 tests across 2 files: 20 Save and 14 rename.                                                                        |
| `pnpm --dir webview-ui test src/components/welcome/__tests__/WelcomeViewProvider.spec.tsx --maxWorkers=2`                                                                                                                                                                                                                                                                                                                                                                                                | Passed, 6 tests; 2 skipped in 1 file. This checks the retained initial creation route.                                         |

The distinct follow-up suites total **629 passing tests and 8 skipped tests across 15 files**. The 61-test buffer rerun
repeats coverage. These follow-up suites also overlap the initial validation record and are not added to its historical
445-test total. The strengthened same-event edit cases are concurrency coverage; they are not claimed as an additional
failing baseline.

Additional executed follow-up checks:

- `pnpm --dir src check-types`: passed with ordinary workspace settings after the final host changes.
- `pnpm --dir webview-ui check-types`: passed after the final test-table typing correction.
- `pnpm --filter @alpha-code/types build`, `pnpm --filter @alpha-code/types check-types`, and
  `pnpm --filter @alpha-code/types lint`: passed.
- Focused host ESLint, touched-file Prettier, and `git diff --check`: passed for the eight follow-up host files, with the
  three files changed by the original-container guard checked again afterward.
- `pnpm --dir webview-ui exec eslint src/components/settings/SettingsView.tsx src/components/settings/__tests__/SettingsView.unsaved-changes.spec.tsx --max-warnings=0`:
  passed.
- Touched-file Prettier over the four shared-contract and three UI follow-up files: passed.

The final independent review covered target resolution under both queues, malformed modern requests, deleted or replaced
IDs, draft identity override, captured buffer ownership across selection/import/Discard, correlated completion, timer
cleanup, edit-after-submit behavior, and delayed success after a newer rename. The review found and resolved the
unresolved-profile Discard fallback, first-ID adoption provenance, stale acknowledgement name overlay, and early outer
and inner batch rejection. The last malformed-container check also found and resolved validation after the identity
overlay, which could clear saved fields. No unresolved F2 implementation gap remained in that review. Primary-write
partial completion, best-effort sticky history, and result-delivery limits retain the explicit semantics above;
integration gates remain separate.

The exact VS Code 1.125.0 gate, `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`, is deferred to the parent integration
run. Repository-wide checks, bundling, packaging, managed-agent certification, and live Copilot/profile access are also
parent-owned and are not substitutes for this worktree's focused regressions.

The worktree's source commit is separate from those integration gates. `.husky/pre-commit` normally invokes lint-staged
and repository-wide `pnpm lint`; the implementation lead disables that hook for the source commit process only with `HUSKY=0`, following
the explicit gate-ownership instruction. Focused ESLint and touched-file Prettier run manually. No hook source or
configuration is changed, and its full lint remains deferred to integration.
