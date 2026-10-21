# Clean-code review 07: extension-specific tools

Review date: 2026-10-20. Workspace HEAD: `f67f53ee1f53929669cdda523d6cbd509ea0bfd1`.
Mode: full-surface review within the assigned extension-tools slice; read-only source audit.

**Quality: 84/100, medium-high confidence (approximately 85%).** This is a judgment of the inspected slice, not a measured repository-wide percentage. Skills, Tickets, browser integration and the HTML viewer have clear owners, explicit shared contracts, focused tests and substantial defensive work. Three reproduced defects prevent calling this slice clean. No source or test files were edited.

## Findings

### 1. High / must-fix: scheduled command cancellation leaves descendants running

- Location: `src/services/scheduled-tasks/ScheduledTaskService.ts:689` (through line 695); disposal trigger at `:204`.
- Trigger: a scheduled direct command launches a child process, then its timeout expires or `ScheduledTaskService.dispose()` aborts the controller.
- Violated invariant: cancellation and timeout must reach subprocesses; terminal paths must release the resources they own. The direct command path passes an AbortSignal to `execFile` with `shell: true`, but has no descendant/process-group termination or awaited shutdown ownership. The shell can stop while its actual command continues making filesystem or external changes.
- Verified evidence: a controlled Windows test on Node **24.21.0** executed the same `execFile(command, { shell: true, signal, windowsHide: true })` boundary. The child announced READY; the parent immediately aborted; the callback returned `AbortError`; the child subsequently wrote a marker file. Observed output: `{"platform":"win32","node":"v24.21.0","shellChildReady":true,"callbackError":"AbortError","childWroteAfterAbort":true}`. The temporary child exited and its temporary directory was removed.
- Caller/test evidence: service disposal aborts every `commandControllers` member; `executeCommandRun` also supplies Node's timeout. `src/services/scheduled-tasks/__tests__/ScheduledTaskService.terminal-durability.spec.ts:385` mocks the command runner and tests a late abort write, so it verifies persistence but cannot detect a surviving operating-system descendant.
- Smallest remedy: reuse or extract the existing cross-platform process-tree lifecycle used by `src/integrations/terminal/ExecaTerminalProcess.ts:333` and `src/core/agent/CompletionHooks.ts:284`; retain process ownership until tree termination settles, then finalize the run. Add a real-process contract test using an explicit child-ready handshake and a descendant-exit observation.
- Primary source: [Node 24.21.0 child process documentation](https://nodejs.org/download/release/v24.21.0/docs/api/child_process.html#subprocesskillsignal), retrieved 2026-10-20, also documents the shell/descendant limitation on Linux. Windows behavior above was directly reproduced, not inferred from the Linux note.

### 2. High / must-fix: changing skill modes silently overwrites a concurrent user edit

- Location: `src/services/skills/SkillsManager.ts:851` and `:860`.
- Trigger: the user saves an instruction edit to a discovered SKILL.md while Settings changes the skill's mode associations.
- Violated invariant: workspace mutations must preserve external/concurrent edits and reject stale content. `updateSkillModes` reads the entire file, changes frontmatter, then writes its original body back without a version check, mutation gate, or file transaction.
- Verified evidence: executed the actual transpiled `SkillsManager.updateSkillModes` method against a temporary real file; the filesystem read boundary captured the original contents and injected a separately saved user edit before returning them. The method completed and erased that edit. Observed output: `{"exercised":"SkillsManager.updateSkillModes","externalEditInjected":true,"externalEditPreserved":false,"staleInstructionsWrittenBack":true}`. Discovery and bundled-root checks were stubbed only to isolate the read/modify/write boundary; both file reads and writes used real temporary files.
- Caller/test evidence: `webview-ui/src/components/settings/SkillsSettings.tsx:163` emits `updateSkillModes`; `src/core/webview/webviewMessageHandler.ts:3468` dispatches it to `skillsMessageHandler.ts:163`, which calls the manager. Existing `SkillsManager.spec.ts` coverage mocks `writeFile` and checks serialized frontmatter, not a concurrent editor save. `createSkill` also uses check-then-write at `:691`/`:720`; that adjacent path should use exclusive creation rather than share the overwrite risk.
- Smallest remedy: perform the edit through the established version-aware workspace mutation boundary (including open-document versions), and reject/retry after a content mismatch rather than writing stale body text. Add a controlled-barrier test that saves an external edit between read and commit; use exclusive creation for new files.

### 3. Medium / should-fix: recurring schedules ignore their persisted timezone

- Location: `src/services/scheduled-tasks/schedule.ts:5` (local-time monthly arithmetic) and `:21` (fixed 24-hour/7-day arithmetic).
- Trigger: a monthly schedule runs on a host whose timezone differs from the stored schedule timezone, or a daily/weekly schedule crosses daylight saving time.
- Violated invariant: a persisted schedule carrying a timezone should produce deterministic calendar occurrences in that timezone. Monthly arithmetic uses the extension host's local `Date` setters and never reads `schedule.timezone`; daily/weekly arithmetic treats calendar units as elapsed milliseconds.
- Verified evidence: imported and ran the actual `getNextRunAt` TypeScript module under Node 24.21.0. For a persisted **UTC** monthly schedule starting `2026-01-31T01:30:00.000Z` and queried after February 1, a UTC host returned `2026-02-28T01:30:00.000Z`; switching only the host timezone to `America/New_York` returned `2026-03-01T01:30:00.000Z`. A daily New York 09:00 schedule starting March 7 returned March 8 at 10:00 local time.
- Caller/test evidence: `packages/types/src/scheduled-task.ts:35` persists timezone for every schedule type. `ScheduledTasksView.tsx:864` presents a local start time with a timezone label; the service invokes this helper on creation, edits, resumption and occurrence advancement. `schedule.spec.ts` has a single monthly clamp case and no host-timezone-invariance or DST cases; its current daily tests use fixed-day arithmetic.
- Smallest remedy: define calendar recurrence in the stored timezone for daily/weekly/monthly schedules and reserve fixed-duration arithmetic for hourly/custom intervals. Anchor monthly calculations to the original start date so a February clamp does not permanently move subsequent dates. Add host-timezone-invariance, spring/fall DST and repeated month-end regressions.

## Coverage and architecture assessment

Reviewed:

- Skills: discovery roots, override/path identity, traversal bounds, invocation metadata, explicit/captured selection, skill-tool approval, mutation handlers, watchers and disposal; nearest policy/catalog/tool tests.
- Scheduled tasks: schemas, durable claims, multi-window leases, queue admission, captured profile/mode/approval/reasoning, shared `AlphaProvider.createTask` admission, direct commands, terminal retries/recovery, notifications and recurrence arithmetic.
- Tickets: workspace identity, symlink checks, revision/transaction/recovery paths, cancellation, search cache bounds, tool metadata/approval and progress fingerprints, panel lifecycle, mention lookup and durable task linkage.
- Browser: canonical registry registration/capabilities, live host tool discovery, host-owned confirmation, URL validation, result conversion/error markers and cancellation cleanup. Confirmed the pinned VS Code 1.125.0 typings expressly retain confirmations when `toolInvocationToken` is undefined (`@types/vscode/index.d.ts:21085`).
- HTML viewer: canonical path/scope checks, CSP and sanitization, bounded off-thread parsing, bounded local raster hydration, trusted webview message identity, revision invalidation and disposal; nearest path/sanitizer tests.

The intended extension additions generally reuse the shared harness. Scheduled model work and Ticket work enter through `AlphaProvider.createTask`; tools register through `ToolRegistry`; viewer/panel code projects or displays data. The direct scheduled-command subprocess implementation is the principal repeated lifecycle implementation observed in this slice, and it has the concrete gap in finding 1.

No additional material defect was verified in the sampled Tickets, browser or HTML-viewer boundaries. This does not establish their absence across all possible paths.

## Validation actually run

Runtime: Node `v24.21.0`, pnpm `11.24.0`, Windows. Both Vitest batches used `--maxWorkers=1`.

1. `pnpm --dir src test services/scheduled-tasks/__tests__/schedule.spec.ts services/skills/__tests__/SkillsManager.policy.spec.ts core/tools/__tests__/skillTool.spec.ts services/browser/__tests__/VSCodeBrowserTools.spec.ts core/webview/html-document/__tests__/paths.spec.ts --maxWorkers=1`
    - **5 files, 215 tests passed**, 6.43 seconds.
2. `pnpm --dir src test services/scheduled-tasks/__tests__/ScheduledTaskService.approval.spec.ts services/scheduled-tasks/__tests__/ScheduledTaskService.terminal-durability.spec.ts services/tickets/__tests__/TicketStore.cancellation.spec.ts services/tickets/__tests__/TicketStore.recovery-validation.spec.ts services/tickets/__tests__/TicketTaskLink.spec.ts core/webview/html-document/__tests__/sanitize.spec.ts --maxWorkers=1`
    - **6 files, 79 tests passed**, 18.65 seconds.
3. Three independent deterministic reproductions described above; all confirmed the unwanted behavior. Existing tests passing does not cover those regressions.

Total focused baseline: **11 files, 294 tests passed**. No source edits were made, so no after-change check is claimed. No extension-host, live browser, full typecheck or benchmark gate was run by this reviewer.

## Closure ledger and blind spots

- Fixed now: none; audit-only assignment. The only repository file this reviewer created is this report.
- Flagged for follow-up: the three findings above; prioritize process-tree cancellation and skill-edit data preservation, then calendar recurrence.
- Not verified: live VS Code 1.138.0/1.125.0 behavior, real browser confirmations/errors, full Ticket search race coverage, HTML renderer accessibility/visual presentation and long-running resource/throughput measurements. Other reviewers own frontend/core/release-wide coverage.
- Out of scope: Codex sandbox parity, replacing the first-class Alpha additions, production changes and repo-wide cleanup. This report does not assign a Codex convergence percentage; the convergence reviewers own the source-first comparison.

Recommended next pass: operational hardening on the scheduled command process lifecycle and correctness cleanup on skill authoring mutations; rerun the focused tests plus appropriate real-process and exact-host gates after implementation.
