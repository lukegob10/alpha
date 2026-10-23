# Alpha gray-panel investigation: event ordering and unattended completion

Investigated 2026-10-23. The user starts a prompt, leaves it running, returns to a gray panel, and refreshes to find
completed work. Whether the affected Alpha window was an installed build or an F5 development host is unknown.
The investigation therefore covers background rendering and replacement-webview startup.

The [Codex native failure](codex-gray-renderer-crash-2026-10-22.md) has a reproduced browser assertion. Alpha's reported
incident does not yet have a matching crash dump or a reproduced failing event. A passing stress test cannot establish
that the original Alpha problem is fixed. The changes here are repeatable browser regressions and local diagnostic tools.

## The browser failure is sensitive to event order

The original Codex dump maps to Blink updating style/layout during a phase that prohibits tree mutations. Native hit
testing enters lifecycle processing, pending selection is committed, selection focus checks request another style/layout
update, and the document guard terminates the renderer. This is reentry on the renderer's main thread; the evidence does
not establish a race between JavaScript threads or a task-completion race.

The native sequence and public-symbol mapping are recorded in the preceding report. Relevant primary source includes
the [document guard](https://github.com/chromium/chromium/blob/150.0.7871.250/third_party/blink/renderer/core/dom/document.cc#L2688),
[selection commit during compositing](https://github.com/chromium/chromium/blob/150.0.7871.250/third_party/blink/renderer/core/frame/local_frame_view.cc#L2806),
and [selection focus check](https://github.com/chromium/chromium/blob/150.0.7871.250/third_party/blink/renderer/core/editing/frame_selection.cc#L587).
These sources were retrieved on 2026-10-23.

An independent [Codex issue comment](https://github.com/openai/codex/issues/44322#issuecomment-6146468901) supplied a
[standalone example](https://github.com/user-attachments/files/33386869/repro-standalone.html).
Our smaller page and timing matrix independently reproduced the assertion:

| Controlled case                                                                                               | Observed outcome              |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Noncollapsed selection, scroll-driven CSS animation, native click toggling scrollers' `display` synchronously | Native assertion              |
| Same mutation in the click's microtask                                                                        | Same native assertion         |
| Same mutation in a timer, one animation frame, two animation frames, or a ResizeObserver callback             | Survived                      |
| Same native display toggle without the scroll animation, or with an ordinary time-based animation/transition  | Survived                      |
| No selection, or selection cleared before the toggle                                                          | Survived                      |
| Focus the composer before the toggle, or replace the selected text before the toggle                          | Survived; selection collapsed |
| Change width, content height, visibility, smooth scrolling, or unrelated content                              | Survived in these schedules   |

There are **54 cases: two native crashes and 52 survivors**. Both new dumps have exception `0x80000003`, `RAX=8`,
the exact public Electron PDB identity, and fault offset `0x2831a55`, matching the investigated Blink guard.
The event receipts place both failures after mutation/microtask processing and before the next frame callback.
This explains why event ordering matters; it does not justify adding arbitrary delays to Alpha.

The `background-script` controls in this small matrix disable background throttling and retain a visible document.
They do not test browser freezing. The separate Alpha replay below uses actual hidden/frozen native windows.

Sources and receipts:

- [Timing page](../artifacts/alpha-gray-cause-2026-10-23/ordering.html) and [Electron runner](../artifacts/alpha-gray-cause-2026-10-23/ordering.cjs).
- [All 54 observations](../artifacts/alpha-gray-cause-2026-10-23/ordering-results.json).
- [Native fault metadata](../artifacts/alpha-gray-cause-2026-10-23/ordering-faults.jsonl); raw dumps remain outside the repository.

## Alpha's equivalent rendering paths

The authored chat code, built CSS, and applicable installed VS Code webview styles were inspected for scroll timelines.
Alpha's built chat does not apply the scroll-driven fade animation used in the browser reproduction. The prior report's
asset audit records this search. Runtime animation samples from the replay use `DocumentTimeline`.
Absence of this particular trigger does not rule out every browser lifecycle defect.

The automatic scroll controller schedules its write through an animation frame, reads current task/scroll state when
the callback executes, and cancels owned work on cleanup. Its ResizeObserver schedules that work instead of writing
scroll position synchronously. Selection removal, focus changes, rich-content replacement, resizing and native hit
testing remain relevant adjacent paths and are exercised by the real extension test.

The real extension fixture now completes **six actual scripted model turns** without user input: visible, sidebar hidden,
and application frame callbacks held, each with and without an initial text selection. Each turn appends 120 transcript
rows and streams 120 chunks followed by a final code fence. File barriers hold the provider at known boundaries;
the test polls completion receipts while the task runs. It checks the original document nonce, final response,
visible/enabled composer on return and the 80-row rendering bound.

Holding application `requestAnimationFrame` callbacks is an injected scheduler control, not a frozen Chromium page.
In these cases queued application work grows while callbacks are held and drains on release. Sidebar visibility is
verified at the host iframe and its ancestors: the inner document can still report `visibilityState="visible"` while
VS Code hides the view. Selection may collapse as the selected content is replaced; initial selection is verified,
not presumed to remain throughout the turn.

The fixture also retains 24 rounds/48 checkpoints for real selections, native mouse input, row eviction, code-fence
replacement, focus and width changes. Trace counters must show layout, compositing and hit testing in the Alpha
renderer itself. Renderer exceptions/crash notifications fail the test.

A separate standalone Electron replay loads the actual built Alpha React bundle and CSS with controlled state messages.
It exercises native hide/show and main-page `Page.setWebLifecycleState` freezing. An optional saved transcript was read
locally: 156 messages, 437,032 bytes; its contents are not copied into the artifacts. Twenty-four updates append 24 new
rows, preserving historical rows in the mounted window, and finalize a code fence.

- The [initial twelve replay cases](../artifacts/alpha-gray-cause-2026-10-23/alpha-ui-results.json) survived without native
  crashes or unhandled exceptions and returned with the toolbar/composer visible.
- An [expanded 24-case attempt](../artifacts/alpha-gray-cause-2026-10-23/alpha-ui-return-timeouts.json) recorded no native
  crash or unhandled exception, but nine fixture deadlines: eight waiting for frames after showing a hidden window and
  one during hydration. These are inconclusive observations, not successful return-paint tests or attributed Alpha defects.
- A [six-case follow-up](../artifacts/alpha-gray-cause-2026-10-23/alpha-ui-return-pointer-results.json) passed with and
  without native pointer movement immediately on return. Trusted event counts verify movement delivery. Selection
  collapsed during rendering, so these are not retained-selection controls.

The [standalone runner](../artifacts/alpha-gray-cause-2026-10-23/alpha-ui.cjs) accepts the build directory and an optional
local transcript filename. It blocks external requests and uses a fresh owned profile. This state replay does not run
the task backend; the real extension-host fixture above supplies that coverage.

## Replacement views and development reloads

Production views retain their context while hidden. Ordinary background completion does not assign new webview HTML.
F5 can use Vite, where a module change may recreate the application. Any recreated application needs initial state.

The previously fixed Alpha defect queued `webviewDidLaunch` behind long-running global commands. `App` returns an
empty tree before its first state, so that queue ordering can leave a replacement view blank while the backend runs.
The current implementation admits bootstrap through its immediate operation lane, scoped to the originating view;
the [earlier investigation](webview-lifecycle-recovery.md) documents ownership and unit regressions.

The rendered fixture now starts manual compaction through the actual UI at a completed-task resume boundary, holds
the summarizer, reloads the webview and requires the new document to hydrate **before releasing compaction**.
The current build passes. Opening context details deliberately releases scroll following; the reload then restores
the bounded transcript. This covers the shared startup mechanism without depending on whether Vite caused the reload.

An A/B control changes only the compiled copy's admission rule, removing `webviewDidLaunch` from the immediate lane.
Under the same fixture, the new document remains alive with **zero root children, no toolbar and no transcript**
until the test's bootstrap deadline. There are zero renderer fatal events. The current build hydrates while the same
summarizer remains held. The source bundle is unchanged by the control. This reproduces Alpha's earlier blank-startup
mechanism in a real host; it does not prove that a reload occurred during the user's unattended incident.

The [control runner](../artifacts/alpha-gray-cause-2026-10-23/bootstrap-control.cjs) creates its own extension copy and
profile. Its [receipt](../artifacts/alpha-gray-cause-2026-10-23/bootstrap-control.json) records the expected failed
bootstrap, exact changed-bundle hash, empty-root observation and unchanged source hash. The negative host result is
intentional and must not be reported as a passing extension test.

## Native evidence and the next incident

The preserved default VS Code Crashpad directory contains five dumps. Only the known Codex dump matches the investigated
Blink guard. Three other faults are in `watcher.node`, and one is in `ntdll.dll`; their exception code is an access
violation. A timestamp or a gray-looking panel alone cannot attribute those failures to Alpha's renderer.
The [inventory](../artifacts/alpha-gray-cause-2026-10-23/native-crash-inventory.jsonl) records the distinction.

The [dump inspector](../artifacts/alpha-gray-cause-2026-10-23/inspect-native-dump.cjs) reads bounded Windows minidump
structural metadata. Its matching rule requires the exact binary's PDB identity, fault offset, exception and x64
register state. Other binaries remain unmatched and require new stack analysis. It excludes raw stack memory,
command lines, Crashpad annotations and module directories; it does not infer the extension from the exception.
Its structures were verified against Microsoft's
[exception stream](https://learn.microsoft.com/en-us/windows/win32/api/minidumpapiset/ns-minidumpapiset-minidump_exception_stream),
[module](https://learn.microsoft.com/en-us/windows/win32/api/minidumpapiset/ns-minidumpapiset-minidump_module), and
[x64 context](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-context) definitions on 2026-10-23.

From PowerShell in this repository:

```powershell
pnpm exec node artifacts/alpha-gray-cause-2026-10-23/inspect-native-dump.cjs --directory "$env:APPDATA/Code/Crashpad/reports"
```

On another gray incident, correlate its time with this native receipt and Alpha's bounded `[webviewError]` output.
Capture renderer console/output evidence before refreshing when available. A dead renderer cannot report a JavaScript
error; absence of a webview-error entry does not establish a healthy renderer. Keep native failure, an empty new
document awaiting state, a React error and resource pressure as separate causal hypotheses until evidence connects them.

## Repeatable validation

```sh
pnpm --filter @alpha-code/vscode-e2e test:transcript-lifecycle-ui:1380
pnpm exec node --test artifacts/alpha-gray-cause-2026-10-23/inspect-native-dump.spec.cjs
```

Browser runs use Windows x64 with scripted providers and zero live model requests. Exact host versions, owned profiles
and nonces are retained as experimental conditions; no host-version change is presented as the cause or fix.

The earlier six-turn receipt is [preserved here](../artifacts/alpha-gray-cause-2026-10-23/alpha-unattended-extension.json).
The [final integrated receipt](../artifacts/alpha-gray-cause-2026-10-23/alpha-extension-final.json) has nonce
`76ddaf32-98b8-4b8c-ba98-a497c835e319`. Its [bootstrap observation](../artifacts/alpha-gray-cause-2026-10-23/alpha-reload-bootstrap.json)
confirms a replaced document with two root children, a transcript and toolbar while compaction is held, and zero
renderer fatal events. The old-admission control has zero root children under the same barrier.

| Check                                                                                                                | Result                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Real rendered extension fixture, including six unattended turns, blocked-command reload and 48 selection checkpoints | Passed; 1 test, clean host exit                                                                        |
| Exact VS Code 1.138.0 smoke gate                                                                                     | [47 passed across 13 suites](../artifacts/alpha-gray-cause-2026-10-23/exact-host-smoke.json); no skips |
| Focused selection, CDP and rendered-probe runner unit tests                                                          | 21 passed                                                                                              |
| Native dump inspector regressions                                                                                    | 5 passed                                                                                               |
| Existing provider tests, including queued bootstrap and view ownership                                               | 163 passed; 6 existing skips                                                                           |
| E2E compile/typecheck, touched TypeScript ESLint, scoped formatting and script syntax                                | Passed                                                                                                 |

No production extension or webview implementation was changed by this follow-up. The isolated control records an
intentionally failing host result; it is evidence of the old defect, not a passing gate or the original incident's receipt.
