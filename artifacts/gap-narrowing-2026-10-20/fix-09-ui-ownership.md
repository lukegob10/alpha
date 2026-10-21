# Fix 09: webview task and image ownership

Date: 2026-10-20. Mode: correctness cleanup. This closes the two assigned ownership findings in `clean-06-webview.md` and the generic terminal-event finding in `converge-10-host-ux.md`. It does not establish repository-wide or exact-host closure.

## Source and intended contract

Inspected the supplied current Codex checkout at `C:/Users/Luke Goblirsch/AppData/Local/Temp/ac-c7234c1`; `git rev-parse HEAD` returned `c7234c1174b27d9c55199fba0d546dc27d1b0415`.

- [TurnStartParams](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L171) binds input, including images, to a thread identity.
- [TurnStatus and terminal notifications](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L33) distinguish completed, failed and interrupted turns; completion notifications retain the thread ID and complete turn.
- [Agent overview thread notifications](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/tui/src/app/agents_overview_threads.rs#L139) handle host thread closure separately from activity, and ignore a status update for an absent thread. The nearby `agents_overview_actions_tests.rs` regression keeps a hidden thread absent despite late started/status/closed notifications and a refresh.

Alpha keeps its native TypeScript projection, host-owned task membership, per-chat draft store and extension-specific new-chat draft. No Codex runtime, sandbox or UI code was copied.

## Fixed now

### High / should-fix: removed tasks reappeared through retained snapshots

The snapshot merge previously treated an empty incoming map as no update and retained entries omitted from later host task publications. Projection then synthesized metadata for an absent task.

- `webview-ui/src/context/ExtensionStateContext.tsx` now passes accepted host membership to the lifecycle merge. A supplied task map is a membership replacement; a lifecycle-only state envelope remains a delta. Dedicated task-domain freshness guards still decide which publication is accepted.
- `webview-ui/src/context/agentLifecycleState.ts` prunes removed tasks, interprets a supplied snapshot map alongside full membership as a replacement, and filters delayed lifecycle-only patches using previously accepted sequenced membership. Partial updates preserve valid background snapshots and tasks.
- Standalone event, snapshot and degraded handlers cannot admit an absent task after a sequenced membership publication. A newer host publication can admit it again. Bootstrap and unsequenced legacy fallback remain supported.

### High / should-fix: pending image reads updated the selected chat

`useTaskComposer` previously routed the image setter through the current selected-task ref. FileReader completions therefore wrote the chat selected at completion time. The same defect affected pasted and dropped images.

- `webview-ui/src/components/chat/hooks/useTaskComposer.ts` now binds only `setSelectedImages` to the originating render's task identity. Functional updates still use that draft's latest images. Other selected-task setters retain their existing behavior.
- `webview-ui/src/components/chat/ChatTextArea.tsx` uses one owned FileReader path for paste and drop, detaches callbacks and aborts pending readers on disposal, settles cancelled reads, and skips queued completions after disposal. Focus changes and hiding the still-mounted composer preserve the original attachment.

The pre-existing `pendingNewTaskRequest` shape, initializer and draft-retention check were preserved. No edits were made to `ChatView.tsx` or its tests. A focused regression verifies that late new-chat image updates preserve the initial submission receipt and leave the newly created task's images untouched.

### Medium / should-fix: generic terminal fallback discarded the actual outcome

The event-only `turn_terminal` reducer now uses `event.payload.status`, preserving completed, failed and interrupted outcomes. The host-attached snapshot path remains authoritative; turn completion still does not declare the entire task terminal.

## Regression and validation evidence

New files:

- `webview-ui/src/context/__tests__/agentLifecycleState.ownership.spec.ts`
- `webview-ui/src/components/chat/__tests__/ChatTextArea.image-ownership.spec.tsx`
- `webview-ui/src/components/chat/hooks/__tests__/useTaskComposer.image-ownership.spec.tsx`

Before production changes, the corrected first two test files produced **9 intended failures and 5 passes**, reproducing resurrection with empty/omitted maps, completed/failed terminal misclassification, real delayed paste/drop navigation, new-chat contamination, and missing reader disposal. Initial fixture/mock setup errors were corrected before recording that baseline. An additional regression exposed retained removed-task snapshots from a later lifecycle-only state patch; it failed before the membership filter was extended.

Final command:

```text
pnpm --dir webview-ui test src/context/__tests__/ExtensionStateContext.spec.tsx src/components/chat/__tests__/ChatTextArea.spec.tsx src/components/chat/hooks/__tests__/useTaskComposer.spec.tsx src/components/chat/__tests__/ChatTextArea.image-ownership.spec.tsx src/context/__tests__/agentLifecycleState.ownership.spec.ts src/components/chat/hooks/__tests__/useTaskComposer.image-ownership.spec.tsx --maxWorkers=1
```

Result: **6 files passed, 194 tests passed**, Vitest 4.1.11, 28.02 seconds, exit 0. The context suite intentionally logs its existing outside-provider error scenario. Tests use controlled FileReaders and immediate state transitions; no network or arbitrary sleeps are involved.

Formatting was limited to the four owned source files and three new test files. `git diff --check` passed for the owned source changes. Reviewed the diff for unrelated edits, debug output, secrets, generated outputs and dependency churn.

## Limits and remaining gates

Per the delegated assignment, no typecheck, build, broad suite, exact VS Code host test, dependency change or commit was performed. The parent must run `pnpm --dir webview-ui check-types` and the VS Code 1.138.0 smoke gate; no host success or manual visual verification is claimed here. Versions and host APIs were unchanged.

Unsequenced legacy lifecycle bootstrap remains permissive because it has no authoritative membership ordering signal. Once modern sequenced membership exists, a task's lifecycle packets wait for host re-admission rather than creating membership themselves. Current full host publications provide both membership and lifecycle snapshots, so new/background task admission remains owned by the extension.

## Integrated lint follow-up

The parent integrated lint gate identified one new test-only `react-hooks/exhaustive-deps` warning in the image ownership harness. The test now destructures the stable `updateTaskDraft` callback before its initialization effect and lists that callback as the dependency. This avoids depending on the changing composer result object; no rule was disabled and no production behavior changed.

Re-ran the three new specs with `--maxWorkers=1`: **3 files passed, 20 tests passed**, 8.87 seconds, exit 0. Scoped ESLint on the same three files with `--max-warnings=0` also exited 0. Both commands set `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=warn` in their individual PowerShell processes to avoid an incidental install after unrelated script-only manifest changes.
