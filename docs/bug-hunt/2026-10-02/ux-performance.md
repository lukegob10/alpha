# UX and performance lane — READY / EDITS FROZEN

Mode: **full-surface review**. Started October 1, 2026 America/New_York. This ledger records bounded proven
repairs and coverage, not a claim of complete UX parity or optimization. All preexisting changes are preserved.
Node 24.14.1 and pnpm 11.24.0 verified. Exact reference host: VS Code 1.125.0; host gates belong to coordinator.

## Ownership and evidence

Three collaboration subagents: chat interactions (`components/chat`); lifecycle/host routing (`core/webview`,
excluding HTML); settings/features (`webview-ui` excluding chat/context, TicketPanel, HTML, scheduled tasks).
Parent owns `webview-ui/src/context`. Actual HTML path is `src/core/webview/html-document`; actual scheduler path
is `src/services/scheduled-tasks`. Root AGENTS is the only AGENTS found by repository inventory.

Applied clean-code-review skill and change-safety, JavaScript, testing, comprehensive, end-state, frontend, HTML,
performance, and severity references. Existing baseline inventory is coordinator-owned; generated artifacts,
packaging/manifests, live providers and shared gates remain outside this lane.

Current official Codex reference: `cb6da58876afed3ede0ab11084f67dd5394ecb48`. Read pinned `git show` source/tests:
`codex-rs/tui/src/chatwidget/turn_lifecycle.rs` (turn state is separate and resets per thread) and
`codex-rs/tui/src/chatwidget/tests/startup_submission_tests.rs` (startup input submits once, editing/disconnect
preserve drafts and cancel pending automatic submission). Prior Alpha completion/loop investigations were checked
against current projection code. Alpha retains explicit host-owned task identity, sequence domains, queue receipts,
approval/execution protections and native feature panels. No source/prompt/runtime port.

Subagents also inspected pinned `chatwidget/user_messages.rs`, `tests/composer_submission.rs`,
`tests/questions_tests.rs` (thread-owned draft/accepted-input recovery); `tui/src/app.rs`,
`app/tests/buffered_replay.rs`, `app/tests/agents_navigation_tests.rs` (ordered thread-scoped projection); and
`core/src/config/edit_tests.rs` (nested configuration preservation). Bespoke schedules/HTML primarily follow Alpha's
current persisted schema and presentation contracts, with no assertion of corresponding Codex feature parity.

## Findings and closure

### UX-1 — High / must-fix — rejected snapshots clear current chat identity — fixed now

Owner: `webview-ui/src/context/ExtensionStateContext.tsx`, `mergeExtensionState`.
The task-domain guard restores current identity for stale/equal task sequence and queue-only patches, but subsequent
explicit-null normalization cleared those restored fields unconditionally. A delayed new-draft snapshot can therefore
clear `currentTaskId`, `currentTaskItem`, and `activeTaskId` while retaining the current task view/transcript.
Null clearing now requires the same accepted task snapshot as all other task-domain writes. Fresh accepted clearing
and the existing undefined-dropping new-draft compatibility path remain intact; no wire change.

Fail-before: `pnpm --dir webview-ui test src/context/__tests__/ExtensionStateContext.spec.tsx` — **3 failed / 45 passed**.
New deterministic cases cover stale sequence 4, duplicate sequence 5, and queue-only sequence 6 against selected task
sequence 5; all failed because currentTaskId became undefined. Regression checks all three identity fields and view.
After: context + refresh + follow-up projection tests **59 passed in 3 files**, repeated after formatting with
`--maxWorkers=2`. Focused ESLint passed; touched files formatted only. Webview typecheck passed; extension typecheck
has other-lane fixture errors detailed below. READY means locally verified UX changes, ready for serialized integration.

### UX-2 — High / must-fix — schedule saves drop command denials — fixed now

Owner: `ScheduledTasksView.tsx`. Save rebuilt autoApproval from its visible approvalMode only, losing persisted
`deniedCommands` and broadening command authority on an unrelated rename. Retain existing denials when rebuilding
the form payload; existing approvalMode migration remains authoritative. Deterministic Save payload regression fails
before and passes after. No scheduler execution/policy schema change.

### UX-3 — High / must-fix — history navigation restores another chat's draft — fixed now

Owner: chat `usePromptHistory.ts`. Navigation's saved tempInput reset depended on prompt content only. Task A and B
with identical histories could share navigation index and restore A's private draft into B on ArrowDown. Add optional
displayed task identity through ChatView and ChatTextArea; reset navigation on task/workspace changes while preserving
streaming-only updates. Hook and component regressions cover the identity boundary.

### UX-4 — High / should-fix — blocked view reverses broadcast sequence ownership — fixed now

Owner: `AlphaProvider.ts`, message/todo publication methods. Awaiting each view before reserving the next view's
sequence allowed a newer broadcast to reach view 2 before the older broadcast, which then received a higher sequence
and could overwrite it. Dispatch all eligible views before awaiting settlement, as the existing queue path does.
Preserve selection/disposal filters, revision matching, HTML auto-open and error propagation. Two controlled barrier
tests failed before (ascending sequence yielded newer then older), then **16 host ownership tests passed**.
No mutation scheduler concurrency or authoritative lifecycle changes.

### UX-5 — Medium / should-fix — schedule edits change hidden constraints/precision — fixed now

Owner: `ScheduledTasksView.tsx`. Retain timezone and recurring endAt; preserve unchanged start seconds/milliseconds,
custom interval milliseconds and command timeout. Renaming previously changed 90s intervals to 120s and 90,500ms
timeouts to 120,000ms. Three initial regressions failed / 19 passed, then a separate timeout regression failed before
its fix. Four added tests verify denial retention, precise schedule retention, exact command timeout, and interval
changes retaining deadline/timezone. Final schedule/mode/reasoning group **28 passed**.

### UX-6 — Medium / should-fix — historical answered suggestions submit into a newer question — fixed now

Owner: `FollowUpSuggest.tsx`. Disable/guard answered suggestion submit controls; keep the historical copy action.
Combined UX-3/UX-6 fail-before **2 failed / 22 passed**, then **288 passed across six chat files**; after test typing
repair **24 regression-file tests passed** again. Existing queue/startup changes are preserved.

### UX-7 — Medium / should-fix — failed HTML refresh discards rendered image data — fixed now

Owner: `html-document/viewer.ts`. Error fallback used the parser document HTML, whose image placeholders had not
been hydrated. Retain the last rendered snapshot HTML instead. One real-file failed-refresh regression failed before
with 18 passing tests; covers two consecutive invalid refreshes retaining embedded PNG data after the fix.
Viewer/images initially **25 passed**; final viewer/images/TicketPanel/scheduler-approval group **56 passed**.

## Coverage

| Surface                                                                 | Status       | Evidence / remaining scope                                              |
| ----------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------- |
| Task-domain projection, navigation sequencing, transcript cache         | edited       | UX-1; 59 focused tests; cache/revision and incremental handler read     |
| Turn lifecycle parsing/projection, degraded fallback                    | reviewed     | existing implementation/tests read; no change claimed                   |
| Chat send/queue/steer routing, history keyboard, answered suggestions   | edited       | UX-3/6; 288 tests; full renderer/host accessibility partial             |
| Host session routing, incremental publications, lifecycle navigation    | edited       | UX-4; session/lifecycle/queue/routing focused tests; activation sampled |
| Settings cachedState initialization/resync/reset/save, history, tickets | reviewed     | 85 UI tests; TicketPanel lower-level tests; no settings binding changes |
| HTML refresh/images/navigation/resource disposal                        | edited       | UX-7; actual filesystem and controlled watcher tests                    |
| Scheduled task presentation/approval                                    | edited       | UX-2/5; 28 interaction tests and scheduler approval lower-level tests   |
| Actual VS Code host/visual/theme/narrow-sidebar interactions            | not verified | coordinator gate/visual cases pending                                   |
| Shared types/manifests/builds/certification/live providers              | out of scope | coordinator-owned                                                       |

## Performance

No performance improvement claimed. Added deterministic HTML ready-handshake baseline: 20 requests replay 20 cached
snapshots, **zero additional filesystem opens**, 65-byte HTML per response / **1,300 HTML bytes total** (not complete
wire-envelope size). Fixture is `payload.html` and no live provider; repeated ready messages reuse existing snapshot.
Regression threshold is retained in viewer tests. Broader streaming renders and activation latency remain unmeasured.
Wall-clock unit test duration is not an end-user performance metric.

## Handoffs and host cases

- **Integration typecheck finding:** `pnpm --dir src check-types` ran and failed in concurrent other-lane tests:
  `core/agent/__tests__/AgentResponseFoundation.spec.ts:406,419`, `AgentTurnEngine.spec.ts:86`,
  `core/task/__tests__/Task.spec.ts:4820` omit newly required `ApiStreamOutcomeChunk.terminal` and/or
  `semanticOutputObserved`; `services/command/__tests__/command-precedence.spec.ts:23` casts incomplete Dirents.
  These files remain untouched by UX. Coordinator must reconcile owning-lane fixture contracts.
- First `pnpm --dir webview-ui check-types` found new UX test typing errors (matcher type, partial keyboard events,
  schedule discriminant, optional scheduledTasks). Owners repaired them; rerun **passed**.
- Shared AlphaProvider edits outside UX broadcast patch appeared during this lane (mutation lifetime signals and
  child-start settlement). Preserved all of them. Adjacent FIFO-guidance tests exposed incomplete task mocks missing
  `getTaskLifetimeCancellationSignal`; UX-owned fixture repair adds stable AbortController signals (four fixture lines).
  All three previously timed-out guidance tests passed, then provider suite **139 passed / 6 skipped**. No rm mock
  change or rollback weakening was necessary. This is distinct from broadcast races.
- Coordinator: exercise delayed new-draft state after selecting a running chat in sidebar and editor views; selected
  identity, actions and transcript must remain together. Fresh new-draft navigation must still clear identity.
- Host/E2E/build/package/certification gates deliberately not run here, per control README.

## Remaining highest-value gaps — flagged for follow-up / not verified

- Async-question cards set local answered state before host acknowledgment. Rejected admission restores composer text,
  but the card stays disabled. Code-inspection finding; controlled rejection reproduction still required.
- Scheduler recurring timezone/DST meaning needs an explicit product contract; scheduler disposal versus physical
  child settlement needs controlled lifecycle coverage. Handoff to coordinator/core if outside presentation ownership.
- Malformed cyclic history graphs need behavior coverage. No speculative graph rewrite made.
- Exact-host cases: identical-history chat switching; answered suggestion mouse/keyboard; rejected async answers;
  same-task sidebar/editor blocked delivery; HTML image failure recovery; schedule rename retaining denials/deadlines;
  narrow sidebar, theme/high contrast, focus restoration and keyboard queue interactions.
- Another focused pass should target async-answer acknowledgment recovery and measured streaming renders after these
  integration gates. No claim of exhaustive activation/resource/visual review or complete Codex UX convergence.

## Validation and freeze

All three subagents and parent production edits are frozen. Parent reviewed bounded diffs against preserved baseline,
including schedule discriminants/precision, HTML snapshot revocation, task identity wiring and transcript revision guard.
Focused ESLint, touched-file formatting and `git diff --check` passed. Webview types passed. Extension types ran twice
and remain blocked only by listed other-lane tests; latest Dirent error moved to `command-precedence.spec.ts:33`
(`Dirent<string>` vs `Dirent<Buffer>`). Coordinator owns resolution and final frozen-source 1.125.0 gates.

Inventory helper ran successfully, but includes downloaded `.vscode-test` trees, so its inflated totals are not used
as coverage evidence. The filtered coordinator baseline inventory remains the source surface map.

### Reproduction and focused verification commands

Chat fail-before (2 failed / 22 passed):

```powershell
pnpm --dir webview-ui test src/components/chat/__tests__/FollowUpSuggest.spec.tsx src/components/chat/hooks/usePromptHistory.spec.tsx
```

Final chat group (288 passed):

```powershell
pnpm --dir webview-ui test src/components/chat/__tests__/FollowUpSuggest.spec.tsx src/components/chat/hooks/usePromptHistory.spec.tsx src/components/chat/__tests__/ChatTextArea.spec.tsx src/components/chat/__tests__/ChatView.spec.tsx src/components/chat/__tests__/QueuedMessages.spec.tsx src/components/chat/hooks/__tests__/useTaskComposer.spec.tsx --maxWorkers=2
```

Context (59 passed), schedules (28 passed), settings/history/tickets (85 passed), HTML/service group (56 passed):

```powershell
pnpm --dir webview-ui test src/context/__tests__/ExtensionStateContext.spec.tsx src/context/__tests__/ExtensionStateContext.refresh.spec.tsx src/context/__tests__/followup-lifecycle-projection.spec.ts --maxWorkers=2
pnpm --dir webview-ui test src/components/scheduled-tasks/__tests__/ScheduledTasksView.spec.tsx src/components/scheduled-tasks/__tests__/ScheduledTasksView.reasoning-selector.spec.tsx src/components/__tests__/UserFacingModeSelectors.spec.tsx --maxWorkers=2
pnpm --dir webview-ui test src/components/settings/__tests__/SettingsView.spec.tsx src/components/history/__tests__/HistoryPreview.spec.tsx src/components/tickets/__tests__/TicketsView.spec.tsx --maxWorkers=2
pnpm --dir src test core/webview/html-document/__tests__/viewer.spec.ts core/webview/html-document/__tests__/images.spec.ts services/tickets/__tests__/TicketPanel.spec.ts services/scheduled-tasks/__tests__/ScheduledTaskService.approval.spec.ts --maxWorkers=2
```

Schedule fail-before command: `pnpm --dir webview-ui test src/components/scheduled-tasks/__tests__/ScheduledTasksView.spec.tsx`
(3 failed / 19 passed), then same with `--maxWorkers=2` (timeout precision: 1 failed / 22 passed).
HTML fail-before: `pnpm --dir src test core/webview/html-document/__tests__/viewer.spec.ts` (1 failed / 18 passed).
Initial uncapped runs preceded the worker-cap control update; later tests used the specified cap.

Host routing final commands:

```powershell
pnpm --dir src test core/webview/__tests__/AlphaProvider.host-ownership.spec.ts --maxWorkers=2
pnpm --dir src test core/webview/__tests__/AlphaProvider.spec.ts --maxWorkers=2
```

Results: 16 passed; 139 passed / 6 skipped. Initial adjacent command below produced 272 passed / 3 failed / 6 skipped
in 6 files. The three failures were missing-lifetime-signal mocks in AlphaProvider; repaired final suite above passed.
Other five files passed; no claim the initial combined command passed.

```powershell
pnpm --dir src test core/webview/__tests__/AlphaProvider.spec.ts core/webview/__tests__/TaskSessionRegistry.spec.ts core/webview/__tests__/AgentLifecycleProjection.spec.ts core/webview/__tests__/AlphaProvider.lifecycle-admission.spec.ts core/webview/__tests__/queue-steering.integration.spec.ts core/webview/__tests__/webviewMessageHandler.spec.ts
```

Focused lint was run with package `exec eslint <touched paths> --max-warnings=0` for context, chat, schedule,
HTML viewer and host ownership/provider files. All passed. All edits, including this ledger, are now frozen.
