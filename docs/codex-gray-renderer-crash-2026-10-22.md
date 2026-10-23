# Codex gray webview: native renderer crash

Investigated 2026-10-22 America/New_York. This follows the user's screenshot of the entire Codex panel turning gray
in the chat titled “Fix extension gray lifecycle state.” The user confirmed that reloading the VS Code window
restored the panel. The local evidence establishes a native browser renderer crash. Reconstructing its native stack
strongly identifies a Blink selection/layout lifecycle assertion as the failure mechanism.

The 2026-10-23 follow-up reproduced that same native assertion in a small standalone page: noncollapsed text selection,
a scroll-driven CSS animation, and a native click that switches the scroll containers' visibility. Removing any one
of those conditions avoided the crash in the control matrix. Codex ships those scroll-driven fade animations;
Alpha's current built chat styles do not. Alpha's own interaction test passed, so the earlier Alpha gray-panel
incident still needs its own matching crash evidence.

This changes the evidence available to the earlier [Alpha investigation](webview-lifecycle-recovery.md): the matching
visual symptom now has an actual native crash receipt from Codex. It does not establish that Alpha's earlier incidents
have the same native signature.

## Evidence and timeline

The source dump remains at `%APPDATA%/Code/Crashpad/reports/000fe494-b0e0-4a7c-90e8-b04150dd1a78.dmp`.
The repository stores only the [bounded metadata and reconstructed frame matches](../artifacts/codex-gray-renderer-crash-2026-10-22/summary.json),
without raw process memory, prompts, or captured document contents.

| Field           | Observed value                                                     |
| --------------- | ------------------------------------------------------------------ |
| Crash time      | 2026-10-22 23:33:03 EDT / 2026-10-23 03:33:03 UTC                  |
| VS Code         | 1.143.0, commit `2d0b7506a36c1d6db9a466440131a8e01eab2289`         |
| Electron        | 43.7.7                                                             |
| Codex extension | `openai.chatgpt` 26.1007.21434, Windows x64                        |
| Process         | `renderer`, PID 31056, faulting thread 31060                       |
| Exception       | `0x80000003`, instruction at `Code.exe + 0x2a81ec9`                |
| Dump size       | 1,551,824 bytes                                                    |
| Dump SHA-256    | `e0e1e9b748e6ecac2012757ff476a83d752c72c8b55e9e59730f55678f68334a` |

The exception instruction in the matching installed executable is `int3`, followed by `ud2`: an intentional native
failure instruction. Crashpad annotations independently identify the renderer process and the host versions. Captured
resource references identify Codex webview assets. These establish a renderer crash rather than merely an unresponsive
composer. They do not establish out-of-memory termination or a GPU-process crash.

The live log root is `%APPDATA%/Code/logs/20261022T192429`. Relevant files are `window1/exthost/openai.chatgpt/Codex.log`,
`window1/exthost/exthost.log`, `window1/renderer.log`, and `main.log`. Their timestamps use Eastern time:

| Eastern time      | Evidence                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------- |
| 23:31:55–23:32:01 | Codex logs four `ResizeObserver loop completed with undelivered notifications` errors.    |
| 23:32:58          | Codex still logs reasoning progress for the existing chat.                                |
| 23:33:03          | Crashpad records the native renderer crash.                                               |
| 23:33:38          | The same chat's persisted backend rollout records another completed tool result.          |
| 23:33:50          | The backend persists another commentary message about provider validation.                |
| 23:34:56          | The extension host receives a termination message from the renderer during window reload. |
| 23:35:02          | The old extension host exits with code 0.                                                 |

The renderer failed while backend work continued. A completion from an earlier turn in the named chat occurred at
22:39:31; that completion is not the crash timestamp. The evidence does not tie this crash to task completion or
compaction. ResizeObserver errors also occur after reload, so their presence alone is not a fatal-crash diagnosis.
Read-only Windows Event Log queries found no matching Code application-error/hang records or Display 4101 events
after 19:20 that evening; the Crashpad dump is the positive crash evidence.

## Native failure mechanism and confidence

Microsoft's exact native symbols were not available from the public Electron or Microsoft symbol endpoints. Its
installed executable and dump agree on PDB identifier `E88CEDE7B05C53174C4C44205044422E1`. The public Electron 43.7.7
release uses identifier `91772538B6FEF7104C4C44205044422E1`, so looking up Microsoft's addresses directly in those
symbols would give incorrect function names.

Instead, the investigation unwound the faulting thread using the matching installed executable's Windows x64
`.pdata` and unwind records. It compared address-independent instruction sequences around each return site with the
public Electron 43.7.7 executable, then resolved the matched addresses using that release's own Breakpad symbols.
Seventeen of eighteen inspected frames matched through 56 unique instruction sequences. The receipt records each
match's native address, public-release address, and byte count. These names are a strongly supported reconstruction,
not an exact-symbol debugger backtrace; frame 8 remains unnamed.

The reconstructed path, from the initiating operation toward the failure, is:

```text
WebFrameWidgetImpl::FrameSinkIdAt / GetFrameSinkIdAtPoint
  -> pointer hit testing
  -> LocalFrameView::UpdateLifecyclePhases
  -> compositing-inputs phase
  -> LayoutSelection::Commit
  -> FrameSelection::IsHidden / SelectionHasFocus
  -> Document::UpdateStyleAndLayout
  -> LocalFrameView::UpdateStyleAndLayout
  -> Document::UpdateStyleAndLayoutTreeForThisDocument
  -> fatal lifecycle check
```

The assertion has particularly strong corroboration. The Microsoft executable contains the unique instruction
sequence `83 f8 0c 77 0e b9 20 15 00 00 0f a3 c1 0f 82`, branching to the captured failure instruction. The public
release has the same unique sequence and a corresponding `int3; ud2` target. Its own symbol line records map both
the branch and failure to `document.cc:2688`, `CHECK(Lifecycle().StateAllowsTreeMutations())`.
The captured `RAX` value is 8, consistent with the rejected `kInCompositingInputsUpdate` state.

The corresponding source explains the native reentry:

- The [compositing phase](https://github.com/chromium/chromium/blob/150.0.7871.250/third_party/blink/renderer/core/frame/local_frame_view.cc)
  enters `kInCompositingInputsUpdate` before committing pending selection.
- [Selection focus inspection](https://github.com/chromium/chromium/blob/150.0.7871.250/third_party/blink/renderer/core/editing/frame_selection.cc)
  requests a synchronous style/layout update.
- The [document guard](https://github.com/chromium/chromium/blob/150.0.7871.250/third_party/blink/renderer/core/dom/document.cc#L2688)
  terminates execution when that update reaches a phase that forbids layout-tree mutation. The
  [lifecycle contract](https://github.com/chromium/chromium/blob/150.0.7871.250/third_party/blink/renderer/core/dom/document_lifecycle.h)
  expressly forbids it during compositing-inputs updates.

The proximate failure is therefore strongly consistent with a native Blink selection/layout reentry bug. The dump
does not identify which chat DOM change or user interaction made the document require another style update. It does
not prove that the user selected text, moved the pointer, resized the panel, or triggered a particular React callback.
Accessibility was enabled in the captured renderer, but the identified path does not establish it as the cause.

## Consequences for Alpha and validation

Both extensions use VS Code browser webviews, so this native failure class can explain a blank panel with surviving
backend work in either extension. Alpha's prior bounded-rendering and lifecycle fixes still address their own measured
defects. Their passing tests do not establish that this native crash is fixed.

The incident host is **1.143.0**, while Alpha's required reference gate is **1.138.0**. These identify run conditions
and the matching native symbols; their difference does not explain the crash. The relevant condition is selection
painting requesting another style update during compositing. Exercise that interaction in an isolated profile while
keeping the supported-host contracts intact. On Alpha's next occurrence, compare its Crashpad process type,
exception, and reconstructed native path before claiming a shared root cause. React error boundaries cannot recover
a renderer process that has already terminated.

The initial investigation checked the dump hash and exception fields, matched the installed executable's PDB
record to the dump, inspected unwind records and native instructions, verified unique cross-build byte matches, and
read the versioned Chromium sources. That initial stage changed no runtime code and ran no extension tests. The
follow-up below adds a deterministic reproduction and real-extension interaction coverage. An exact Microsoft-symbol
backtrace remains unavailable; the standalone reproduction has exact matching public symbols.

Primary sources were retrieved on 2026-10-22 America/New_York (2026-10-23 UTC):
[Electron 43.7.7 dependencies](https://github.com/electron/electron/blob/v43.7.7/DEPS) pin Chromium 150.0.7871.250;
[Electron release assets](https://github.com/electron/electron/releases/tag/v43.7.7) provide the public binary and its
matching symbols. Microsoft's [native-crash instructions](https://github.com/microsoft/vscode/wiki/Native-Crash-Issues)
explain the distinct product-build symbols. The exact installed
[VS Code build configuration](https://github.com/microsoft/vscode/blob/2d0b7506a36c1d6db9a466440131a8e01eab2289/build/lib/electron.ts)
uses Microsoft's Electron artifact feed. Crashpad metadata was parsed against its
[published minidump extension structures](https://github.com/chromium/crashpad/blob/main/minidump/minidump_extensions.h).

## Follow-up: Alpha exposure and a native browser test

Alpha can enter the relevant browser path. The code audit identified these existing interactions:

| Owner                                                                                         | Relevant behavior                                                                                                                |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [Progressive transcript](../webview-ui/src/components/chat/hooks/useProgressiveTranscript.ts) | Following output removes older mounted rows, including any selected DOM nodes inside them.                                       |
| [Code blocks](../webview-ui/src/components/common/CodeBlock.tsx)                              | Highlighting replaces code markup; scroll/resize handlers measure geometry and reposition copy controls.                         |
| [Chat view](../webview-ui/src/components/chat/ChatView.tsx)                                   | Visibility and composer-control changes can schedule composer focus.                                                             |
| [Clipboard fallback](../webview-ui/src/utils/clipboard.ts)                                    | The legacy copy path focuses/selects a temporary textarea, removes it, then restores focus and the saved document range.         |
| [Scroll controller](../webview-ui/src/hooks/useChatScrollController.ts)                       | Resize notifications schedule scrolling in an animation frame. The observer itself does not synchronously write scroll position. |

These are ordinary supported DOM operations. The audit did not establish an Alpha API misuse that causes the native
guard to fail. It also found no extension-side barrier that makes Alpha immune to this renderer failure class.
Removing text selection or adding speculative delayed focus/reload behavior would change user interactions without
establishing a fix.

The source narrows the captured native conditions further: `LayoutSelection::Commit` requires pending selection work,
and `CalcSelectionRangeAndSetSelectionState` short-circuits before calling `IsHidden` for a collapsed range. Given the
reconstructed stack, a noncollapsed text range was therefore involved. Its origin can be a user gesture or a
programmatic range change; the evidence does not identify which one.

### Minimal reproduction and controlled diagnosis

An [independent Codex report](https://github.com/openai/codex/issues/44322), read on 2026-10-23, describes the same
guard and compositing state on Linux. Although its initial synthetic 100-cycle test did not reproduce it, a later
comment by Alkapuce supplied a [standalone HTML reproduction](https://github.com/user-attachments/files/33386869/repro-standalone.html)
using scroll-driven animations, text selection, and changing scroll-container display. The following local results
independently verify that lead; they do not depend on a maintainer diagnosis.

The repository contains an equivalent small [HTML fixture](../artifacts/codex-gray-renderer-crash-2026-10-22/selection-layout-repro.html)
and an [Electron matrix driver](../artifacts/codex-gray-renderer-crash-2026-10-22/standalone-layout-matrix.cjs).
The fixture selects text outside two scroll containers, applies an opacity animation with
`animation-timeline: scroll(self y)`, and swaps the containers between `display: none` and `display: block`.
It has no network requests or extension backend. The driver starts a fresh sandboxed browser window for each case,
uses native mouse input, and records renderer termination independently of JavaScript exceptions.

The [recorded matrix](../artifacts/codex-gray-renderer-crash-2026-10-22/standalone-layout-matrix.json) ran against the
public Electron build corresponding to the incident's embedded Chromium:

| Case                                                         | Result after one click    |
| ------------------------------------------------------------ | ------------------------- |
| Selection + scroll animation + display toggle + native mouse | **Native renderer crash** |
| Remove the animation                                         | Survived                  |
| Remove the selection                                         | Survived                  |
| Keep the containers displayed                                | Survived                  |
| Use the ordinary animation timeline                          | Survived                  |
| Use script `.click()` instead of native mouse input          | Survived                  |

The full combination crashed on its first native click in two independent runs. Both dumps have exception
`0x80000003`, `RAX = 8`, and `electron.exe + 0x2831a55`. Their PDB identifier exactly matches the public symbols,
which resolve that instruction to `Document::UpdateStyleAndLayoutTreeForThisDocument`, `document.cc:2688`,
`CHECK(Lifecycle().StateAllowsTreeMutations())`. This is the same public-build failure instruction matched from the
original Microsoft Codex dump. The [sanitized fault receipt](../artifacts/codex-gray-renderer-crash-2026-10-22/standalone-layout-fault.json)
contains hashes and native metadata; raw process dumps remain outside the repository.

This establishes a specific browser failure mechanism: selection processing and scroll-animation invalidation can
request a style-tree update during the compositing phase, where Blink forbids it and terminates the renderer.
The native-input control is consistent with the original dump's hit-testing entry path. The fixture does not
identify the exact DOM event in the original Codex chat, and a script-only change did not reproduce it in this run.

To repeat the matrix, pass the driver to a standalone Electron executable, rather than Node:

```sh
electron artifacts/codex-gray-renderer-crash-2026-10-22/standalone-layout-matrix.cjs --collect-dumps
```

The recorded run used the public Electron 43.7.7 Windows x64 executable. No Electron dependency was added to Alpha.
If the launch shell sets `ELECTRON_RUN_AS_NODE`, remove that variable in the test process before launching.
The driver creates a disposable profile, keeps dump uploads disabled, writes the matrix next to the fixture, and
quits its windows. Opening the HTML fixture and clicking **Swap scroll containers** provides the manual equivalent;
the query cases are `?case=no-animation`, `no-selection`, `no-toggle`, and `normal-timeline`.

### Does Alpha contain this trigger?

The installed Codex styles contain horizontal and vertical scroll-fade classes that use `animation-timeline:
scroll(self x)` and `scroll(self y)`. Alpha's current authored chat code has no scroll-timeline declaration or
JavaScript timeline API use. Its three built CSS files contain none either. The sole corresponding string across
358 built JavaScript files belongs to a LESS syntax-highlighting grammar, not an applied animation.
The [feature audit](../artifacts/codex-gray-renderer-crash-2026-10-22/scroll-animation-audit.json) records the scope
and installed extension version.

Therefore the specific demonstrated scroll-animation trigger is present in Codex's assets and absent from Alpha's
current built chat styles. Alpha still shares Blink's selection/layout machinery, and arbitrary HTML preview content
can have different styling. This audit neither proves Alpha immune to every native layout failure nor establishes
that its earlier gray panel had the same cause. No production animation/focus workaround was added without evidence
that Alpha uses the problematic feature.

### Alpha interaction regression

The existing real-extension transcript fixture now includes a
[selection/layout exercise](../apps/vscode-e2e/src/ui/renderedSelectionLayout.ts). Run it with:

```sh
pnpm --filter @alpha-code/vscode-e2e test:transcript-lifecycle-ui:1380
```

The fixture uses the built Alpha extension and real Chromium rendering in an isolated profile, with a scripted model
and no live model requests. It restores a 1,200-row transcript, retains the existing three real compactions and
hide/reveal checks, then runs 24 additional interaction cycles. Each cycle creates a real text range before and after
actual React row changes. It alternates appended rows with partial/final code fences, narrows/widens the transcript
to force wrapping, changes composer focus, and routes trusted mouse movement and mouse-up events through VS Code's
workbench into the webview. Range creation follows geometry reads so the test does not force layout between dirtying
the selection and sending native input.

The test requires the same document, visible toolbar/composer, actual DOM mutations, selected-node detachment,
repeated focus changes, and trusted input. Native tracing separately requires style/layout, compositing-inputs, and
hit-test activity in **Alpha's own renderer process**, identified by a performance mark. Workbench-only activity
cannot satisfy that check. Trace records are counted with explicit limits; the receipt stores counters and bounded
samples rather than raw trace events or page contents. The host waits for trace collection before terminating.

The completed interaction run passed all 48 checkpoints. Its final counters were:

| Observation                                      | Count               |
| ------------------------------------------------ | ------------------- |
| Trusted mouse moves / releases                   | 144 / 24            |
| Selection changes / focus changes                | 183 / 40            |
| DOM mutation batches / selected-node detachments | 55 / 15             |
| Native layout / compositing / hit-test records   | 812 / 1,233 / 1,412 |
| Native renderer crashes                          | 0                   |

These counts demonstrate that the relevant native path is reachable from Alpha. They are one bounded workload,
not a performance benchmark or proof that the original bug cannot recur. A range may legitimately collapse when
highlighting or transcript eviction removes its text node; that alone is not a renderer failure.

A separate positive control issued CDP `Page.crash` against the discovered Alpha iframe in another disposable test
profile. The existing probe rejected it and recorded `Inspector.targetCrashed`. That verifies actual native-crash
detection, without claiming the injected crash reproduces the original selection/layout assertion. The control hook
ran outside the repository and made no production extension change.

The compact [follow-up receipt](../artifacts/codex-gray-renderer-crash-2026-10-22/alpha-selection-layout-test.json)
records the passing interaction run, positive control, conditions, and validation. The 21 focused Node tests for trace
admission, CDP transport, and owned renderer launches passed; E2E typecheck and scoped ESLint also passed. The required
`pnpm --filter @alpha-code/vscode-e2e test:smoke:1380` gate passed all 47 tests across 13 suites, with no pending tests.

The standalone fixture reproduces the unsafe browser reentry. The Alpha workload exercises surrounding selection,
focus, transcript replacement, and native hit-testing interactions without that scroll-animation feature, and passed.
Its detector also rejects an actual injected renderer crash. The remaining incident-level unknown is whether Alpha's
earlier gray panel has this native signature or a different failure. No production fix for that unverified cause is
claimed.
