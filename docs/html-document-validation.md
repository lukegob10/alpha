# NOR-66 validation evidence

Recorded September 14, 2026 on Windows, branch `codex/nor-66-html-viewer`,
baseline `bc66591b605f9ffa77ae40b210c074b525210e4d` (Alpha 2.1.36). Main viewer
implementation: `d36a646fc45fa8d00d009a905f31494b7d8990af`. Kit and skill integration
commits remain separate so consumers can cherry-pick the bounded viewer change.

## September 16, 2026: local PNG chart compatibility

Ordinary `<img src="plots/fit.png">` elements were removed because only `data-image`
was recognized. A failing sanitizer test and nested-document viewer test reproduced
the silent loss. Local PNG/JPEG `src` paths now resolve from the HTML file's directory
and enter the existing bounded image hydration/watch pipeline. Workspace-root-relative
`data-image` keeps its original meaning and precedence. Remote/file URLs, embedded
base64, and paths or symlinks escaping the workspace remain unsupported; image budgets are unchanged.

Validation: 118 HTML-document tests passed, including the actual rebuilt parser
worker, encoded filenames, parent paths within the workspace, image creation/refresh,
legacy references, cancellation and scope checks. Extension typecheck, lint and
touched-file formatting passed. The extension bundled using its existing
`node esbuild.mjs` script. Installed workspace binaries ran the checks because the
pnpm launcher failed with `EPERM` while resolving the user-profile directory.
`pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` was blocked by that error;
a direct compiled `html-document.test` runner attempt returned `invalid-options`
before launching a host. No exact-host or visual pass is claimed for this change.
The reported Matplotlib HTML/PNG files were not supplied, so their specific image
encoding, paths and dimensions remain unverified. No extension installation was performed.

## Original deterministic checks

- 77 extension tests: real Windows workspace/junction boundaries, canonical alias
  handling, most-specific multi-root selection, malformed/script/URL injection,
  strict messages, two tasks/documents, unsaved/external edits, coalescing,
  out-of-order work, deletion/correction, restored panels, stale identity after a
  junction swap, HTTPS citations, cancellation and disposal.
- Actual built-worker tests cover seven cases, including successive warm parses,
  adversarial 10,000-deep markup and responsive extension-loop heartbeat during
  the deadline. They are included in the 77 above, not additional tests. Seven
  additional cases in that total validate packaged examples through the sanitizer.
- 34 webview tests: explicit chat routing and ordinary HTML source links, viewer
  refresh state, and all 26 final kit DOM tests.
- Extension, types and webview typechecks pass. Full precommit monorepo lint:
  12 tasks passed. No edits in protected CLI or vscode-shim files.
- Final scheduler and built-in skill inspection suites: 75 tests pass, including
  the exact four packaged reference reads and their asynchronous admission boundary.
- `node scripts/find-missing-translations.js` ran, exit 1: existing unrelated
  frontend/manifest omissions remain (including scheduledTasks and VS Code LM
  version/id descriptions). All new viewer controls/errors and kit namespace
  are present in all 18 backend locales. Widget translations were moved into
  `src/i18n` so the packaged host can supply them to the kit.

## Exact VS Code host

`pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` passed on **actual 1.122.1**:
extension, modes and VS Code LM fixture suites. The dedicated
`html-document.test` also passed on actual 1.122.1: repeated URI open, three
documents including the active-editor/no-argument preview command, unsaved and
external edits, and five open/close cycles. Its measured cold adapter-to-title
latency was 205 ms (initial two-document run) / 227 ms (three-document run),
and 230 ms after the final cache/focus correction (run
`36de4551-bb7b-4d81-afa4-5165a6ab4a97`).
These are title/host measurements, not first-paint or end-to-end authoring times.

The actual extension-development host was inspected through Electron's debugging
connection, using the repository's `launchExtensionHost` and an isolated profile,
workspace and port. The test harness asserts `vscode.version === '1.122.1'`.
Targets were the real `vscode-file` workbench and nested `vscode-webview` document,
not a standalone browser reproduction. Native `@oai/sky` capture failed an app-ID
ownership check for the downloaded host; the supported launcher plus CDP enabled
actual-host inspection. Builds were completed before launching the inspected host.

Observed captures are preserved outside the checkout in
`C:/Users/Luke Goblirsch/.codex/visualizations/2026/09/14/01a0a03f-31c7-7cf3-b460-cac88c748377/html-document-validation`:

- `review-wide.png`: dark review opening and recommendation hierarchy.
- `source-navigation.png`: evidence activation opens the fixture
  `src/export/resolveDestination.ts`, **Ln 7, Col 1**.
- `report-wide.png`, `report-chart.png`: real report with packaged charts,
  permanent data table, no page overflow at a 546 px pane. Keyboard Tab moved from
  the December 2023 point to January 2024, whose accessible label reports 3.1%.
- `spec-high-contrast-zoom.png`: **Default High Contrast**, `window.zoomLevel=1`
  (120%), 852 px content viewport; clear focus/contrast boundaries and no overflow.
- `review-light.png`: **Default Light Modern**, zoom level 0, side-by-side views.
- `review-narrow-light.png`: real editor divider dragged to a **378 px** review
  pane; no whole-page horizontal overflow. Wide table scroll stays local.
- `review-filter-refresh.png`: keyboard filtering to `write`, native disclosure
  open, source revised externally. Update observed in **371 ms**; filter `write`,
  disclosure open, scrollY 2818 and two visible rows preserved. DOM activation was
  used to establish initial disclosure/focus; typing used renderer keyboard events.
- `reload-restored.png`: actual Developer Reload Window creates new webview
  identities and restores all three panels, review filter/disclosure and scroll.
  `source-after-reload.png` then confirms the restored source reference opens
  `resolveDestination.ts` at Ln 7, Col 1.
- A focused filter remains focused after an external edit. This exposed stale
  trusted JavaScript caching across reload during same-version development;
  each shell now versions its local asset URLs with its nonce. Fresh loaded
  script URLs and retained focus were verified in the actual renderer. A refresh
  only restores focus if the document itself still has focus.
- `authored-spec.png` and `authored-report.png`: independent NOR-67 authoring
  outputs rendered in the same actual host. CSV proposal/schema remains readable;
  the latency chart plots 210/190 ms and stops before the missing third value,
  keeps the missing table cell, and separates request-count units. Neither pane
  has whole-page horizontal overflow.

## Same-content chat comparison

The packaged `review-baseline.md` was emitted by a deterministic fake provider
through Alpha's actual chat renderer. `chat-markdown-top.png` shows its opening
recommendation after one scroll reset from the chat's automatic completion
position. One programmatic scroll-to-evidence/focus action and keyboard Enter
opened `src/export/resolveDestination.ts` at Ln 7, Col 1, captured in
`chat-markdown-source.png`. The HTML walkthrough likewise shows the recommendation
at its opening and successful activation of the same source reference. Both
formats preserve the highest-priority finding and evidence. HTML additionally
provides filtering and collapsible regression details.

This is a deterministic functional comparison, not a timed or randomized reader
study. The narrow chat and wider editor panes differ in width; DOM positioning
was used to establish evidence focus. No fewer-actions or faster-reading claim
is supported by this procedure.

NOR-65 independently inspected review/source/report/spec captures and found no
visible kit defect. The initial interactive preview attempt during fixture setup
failed; a coherent rebuilt host, explicit target, source-to-preview round trip and
the added three-document/no-argument exact-host regression all passed. Diagnostics
now log preview errors instead of hiding the technical cause behind the localized
recovery message.

## Workload measurements

Budgets and fixtures are defined in `docs/html-documents.md` before tuning. Run
`pnpm exec tsx scripts/measure-html-documents.ts` after building the worker.
12 observations per fixture: first cold, remaining 11 warm; p95 is their nearest
rank. Measurements ran alongside normal development workloads, not an isolated
benchmark machine. No generalized performance improvement is claimed.

| Fixture                          |   Bytes | Cold worker path | Warm p50 | Warm p95 | Outcome            |
| -------------------------------- | ------: | ---------------: | -------: | -------: | ------------------ |
| Complete review                  |   7,050 |           497 ms |   3.7 ms |   9.8 ms | accepted           |
| 1,000 × 5 table                  | 133,655 |           613 ms |  93.5 ms | 129.7 ms | accepted           |
| 10,000 nested divs               | 110,176 |         1,516 ms | 1,510 ms | 1,521 ms | deadline rejection |
| 3,000 malformed table/b/i groups |  39,176 |           987 ms |   994 ms | 1,102 ms | rejected           |

The initial synchronous implementation passed normal fixtures but stalled on deep
markup. A fresh worker per update added ~0.5 s startup overhead. The final parser
retains one warm worker per open panel, kills it on cancellation/deadline, and
disposes it on close. At most eight panels, one running parse and one scheduled
replacement per panel. Worker heap and deadline are bounded. Tests verify listener,
watcher and timer cleanup; no long-duration operating-system memory trend claim.

## Packaging and installed verification

Final combined `pnpm bundle`, `pnpm vsix`, and the verifier pass, including the
worker assertion: **1,855 entries** for `bin/alpha-2.1.36.vsix`. Local final SHA256:
`6b5eb3ca2357542f8755436ce2b5cec12f75f6834ab0c440e7d8b7095af5ddd3`.

NOR-67 reports the installed VSIX workflow (run
`ae3fe457-d2cb-4394-b639-5e07f6aafc8a`) and second-process authored-file reopen
(`c34b4e60` prefix) passed on actual 1.122.1 with unchanged source SHA and no
regeneration. The final
cache/focus correction is commit `7e74d975e88d401a9a872af276d6837d2160b84e`.
After incorporating it, NOR-67 rebuilt and installed the final combined package
(SHA256 `0230e9062d986fc505de803f01b7ecac3bda295be7865bb1e67453d049b296ab`).
Its installed extension bundle, parser worker, viewer script and skill match the
archive bytes. The fresh-host preferences check passed in run
`b2849599-4087-4a8f-81f5-f58608ba8823`: disabled built-in setting and exact user
override survive reinstall; removing the override leaves the built-in disabled;
the fixture restores its original setting. Package hashes differ between
worktrees; evidence names the package used for each check.

The final integrated 1.122.1 smoke suite passed (extension, modes and five VS Code
LM fixture tests; final LM run `390d5e81-ce99-4169-8942-43b131be1c81`). The updated
installed package also reopened the original authored document without changing
its SHA in run `ccdb4ab4-e4c6-47b1-99e3-ed994a9fdd30`, with actual-host ownership
and complete capture verified by NOR-67.

These checks establish bounded functional behavior and supported-host
compatibility. They do not establish long-run memory stability or a measured
usability advantage. Automatic approval review blocked scratch-directory cleanup;
the isolated `.nor66-visual` files remain untracked, with evidence preserved in
the external directory above.
