# Clean-code review 06: webview UI

Review date: 2026-10-20. Mode: full-surface review of the assigned webview slice. Read-only audit; no source or test changes. Existing dirty files, including `webview-ui/src/components/chat/__tests__/ChatView.spec.tsx`, were preserved.

Good means that React projects host-owned lifecycle and policy, asynchronous work stays with its originating chat, settings edits remain buffered until Save, and rendering keeps safe, accessible interaction boundaries. The findings below are confirmed against the current code and deterministic local reproductions. This is an assessment, not a claim to have closed these gaps.

## Findings

### 1. High / should-fix: retained turn snapshots recreate a task after the host removes it

- Primary location: `webview-ui/src/context/agentLifecycleState.ts:419`; related `:308`, `:337`, `:423` and `webview-ui/src/context/ExtensionStateContext.tsx:268`, `:420`.
- Trigger: a webview has received a lifecycle snapshot for a task; a newer authoritative task-state publication removes that runtime from `liveTasksById`/`liveTaskIds` and supplies an empty snapshot map or no replacement for that task. `mergeAgentLifecycleSnapshots` retains the old snapshot, including when incoming is `{}`. Projection then finds no host metadata, synthesizes `Running` even from a completed turn, and adds the task ID back to the live set.
- Impact: removed/evicted task metadata survives as a phantom running task in the webview. This violates host ownership of task existence and leaves retained lifecycle payloads growing across task removal. It does not recreate an actual host runtime.
- Active path evidence: `AlphaProvider.getAgentLifecycleSnapshots()` (`src/core/webview/AlphaProvider.ts:3943`) publishes cached projector/session snapshots; `TaskSessionRegistry.unregister()` (`src/core/webview/TaskSessionRegistry.ts:492`) removes the session while lifecycle snapshots have a separate lifetime. Even when the host clears its own snapshot, the UI merge does not remove it.
- Deterministic reproduction: import `mergeAgentLifecycleSnapshots` and `applyLifecycleSnapshotsToExtensionState` with Node 24's TypeScript support, merge `{closed-task: completedSnapshot}` with `{}` using `allowTurnReplacement=true`, then project into `{liveTasksById:{}, liveTaskIds:[]}`. Actual output was `retainedSnapshots:["closed-task"]`, `liveTaskIds:["closed-task"]`, and metadata `{status:"running", lifecycle:"running", isTurnActive:false}`.
- Nearest tests: `webview-ui/src/context/__tests__/ExtensionStateContext.spec.tsx:1537` tests explicit metadata removal at `:1569`, but its fixture has no lifecycle snapshot. The lifecycle tests cover stale snapshots and preserved completion review, not authoritative task removal with retained snapshots.
- Smallest fix/check: preserve authoritative host membership during projection. A newer complete task-state publication must prune obsolete snapshot entries or prevent snapshots from creating metadata for explicitly removed tasks. Keep incremental lifecycle delivery working before initial host metadata. Add a regression that applies snapshot, terminal task metadata, then a newer empty live-task map/snapshot map; assert the task stays absent, including after another event/state patch.

### 2. High / should-fix: an asynchronous pasted image can attach to a different chat

- Primary location: `webview-ui/src/components/chat/hooks/useTaskComposer.ts:75`; active caller `webview-ui/src/components/chat/ChatTextArea.tsx:1002` and `:1006`.
- Trigger: start pasting an image in chat A, navigate to chat B while its `FileReader` is pending, then let the read finish. The hook exposes stable setters that use `selectedTaskRef.current` at invocation time. The paste completion calls the setter after the selection changed, so it writes B's draft.
- Impact: A loses the intended attachment and B gains an image from an unrelated task. Sending B can consequently send context the user attached for A. This is a chat-ownership/data-integrity defect, not a cosmetic state issue.
- Deterministic reproduction: `renderHook(useTaskComposer)` with task A, retain `setSelectedImages` as the pending completion, rerender with task B, invoke that retained setter, then inspect both drafts. Actual output: `{"imagesInA":[],"imagesInB":["image-from-a"]}`. No timers or network are required.
- Nearest tests: `webview-ui/src/components/chat/hooks/__tests__/useTaskComposer.spec.tsx` verifies normal navigation and a late receipt that explicitly calls `updateTaskDraft("a", ...)`. It does not exercise a retained setter/async image completion. The existing explicit-owner receipt API demonstrates the appropriate pattern.
- Smallest fix/check: capture the originating chat identity before asynchronous image work, and update that draft explicitly after completion, or provide owner-bound setters to asynchronous callers. Add a deferred `FileReader` test that switches A to B before resolution and asserts B is unchanged and A receives its image. Check new-chat drafts as well as existing task IDs.

### 3. Medium / should-fix: the Markdown URL transform discards Windows/file links before the file handler sees them

- Primary location: `webview-ui/src/components/common/MarkdownBlock.tsx:357`; related file dispatch at `:253`, `:262`, `:273`.
- Trigger: assistant text contains `[Source](F:/roo-fork/Alpha-Code/src/extension.ts:12)` or a `file:///F:/...` link. The custom transform delegates everything except Alpha document links to `react-markdown`'s default transform, which strips both local forms to the empty string. On click, the file handler treats that empty string as local and posts `openFile` with `./`. Even bypassing the transform requires handling drive-rooted paths without prefixing `./`.
- Impact: ordinary absolute source references fail on Windows and file-URI references fail on every platform. A click opens the workspace root instead of the cited file/line. The handler's explicit `file://` branch is effectively unreachable for those links.
- Deterministic evidence: rendered the installed `react-markdown` through `react-dom/server`. Both `F:/roo-fork/Alpha-Code/src/extension.ts:12` and `file:///F:/roo-fork/Alpha-Code/src/extension.ts:12` produced `<p><a href="">Source</a></p>`; `./src/extension.ts:12` retained its target. This uses the actual installed dependency, not inferred URL behavior.
- Nearest tests: `webview-ui/src/components/common/__tests__/MarkdownBlock.spec.tsx` covers relative HTML source paths, Alpha document links, and blocking command schemes, but no absolute Windows/file links. Its existing tests all pass.
- Smallest fix/check: explicitly recognize supported local file targets in the URL transform and route them through a shared local-path parser before applying web-URL sanitization. Preserve the command/javascript scheme rejection. Add click assertions for Windows drive paths, file URIs, absolute POSIX paths, spaces, and line suffixes. Classify fragments/mailto explicitly rather than treating every value without `://` as a workspace file.

## Positive evidence and quality assessment

Estimated quality for this slice: **84/100**, plausible range **80-88**, moderate confidence. This is a qualitative engineering estimate, not a benchmark or whole-repository score. Confidence is high in the three findings because their underlying behavior was reproduced deterministically.

- Settings inputs are bound to `cachedState`; hydration, profile identity, rename/save request correlation, concurrent edits during Save, discard, and imported settings have substantial focused coverage. No direct-live-state binding defect was found in this pass.
- Transcript/lifecycle/queue/todo domains have separate sequencing guards; stale navigation and late message receipts receive deliberate handling.
- The shell context avoids transcript subscriptions for composer/chrome, partial message updates are frame-batched, the transcript cache is bounded to two tasks, and transcript mounting starts with a bounded recent slice.
- Markdown uses `react-markdown` without raw-HTML parsing, terminal ANSI output escapes XML with an escaped fallback, Mermaid uses strict security mode, and Mermaid async render generations reject stale completions.
- Modal and request-input components show deliberate keyboard/focus semantics, native controls, labels, and pending/rejected submission handling. These are source/test observations; no manual accessibility audit was run.

## Validation and coverage

Executed successfully:

```text
pnpm --dir webview-ui test src/context/__tests__/ExtensionStateContext.spec.tsx src/components/common/__tests__/MarkdownBlock.spec.tsx src/components/settings/__tests__/SettingsView.unsaved-changes.spec.tsx --maxWorkers=1
3 files passed; 127 tests passed; 25.32 seconds
```

The context suite intentionally logs its outside-provider error scenario; the run exited 0. Separate read-only Node scripts reproduced all three findings using the installed runtime/libraries. An initial inline Node invocation failed because PowerShell/pnpm stripped quotes; the corrected stdin invocation passed and produced the URL evidence above.

Inspected: `App`, context store/merge/projection, lifecycle fallback, task composer, chat message/render wiring, progressive transcript/scroll control, Settings edit/save/rename flow and tests, Markdown/code/Mermaid/terminal sinks, follow-up/request-input controls, modal and image viewer controls, relevant host publications/removal, and focused tests.

Not verified: material visual behavior in VS Code 1.138.0, the 1.125.0 host fallback, full CSP injection/URI coverage, the complete frontend component tree, all settings providers, CPU/render/memory benchmarks, and full accessibility interaction with assistive technology. Exact-host gates and a typecheck were not run by this read-only review agent; no production changes require validation in this slice.

Closure ledger: fixed now: none (read-only assignment); flagged for follow-up: three findings above; not verified: the listed host/visual/performance surfaces; out of scope: backend policy correctness, provider implementations, and independent Codex CLI convergence scoring.
