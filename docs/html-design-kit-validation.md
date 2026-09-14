# NOR-65 HTML design kit validation

Worktree baseline: `bc66591b605f9ffa77ae40b210c074b525210e4d` (Alpha 2.1.36).
Implementation commits: `ab2fc77`, `b9255c7`, `66f2d75`.
Date: 2026-09-14. Status: required implementation, actual-host, and integrated release gates complete.

## Implemented contract

The versioned assets live in `webview-ui/public/artifact-kit/v1/` and Vite copies
them to `src/webview-ui/build/artifact-kit/v1/`. The source contains the concise
reference, complete review/spec/report, gallery and equivalent Markdown review.
The fixture workspace supplies real, explicitly fictional source targets for
the review. No dependency or generated-document compiler was added.

The viewer owns `meta[name=alpha-document]`, identity, authorization, sanitization,
theme propagation, source navigation and refresh. The kit owns scoped markup,
`main.alpha-doc[data-alpha-kit="1"]`, native fallbacks and local widgets.
`AlphaDocumentKit.mount(root, labels)` returns an idempotent disposer. The host
receives raw `htmlArtifactKit` localization strings; NOR-66 relocates these from
the initial webview namespace into `src/i18n/locales` to match its loader.

## Local evidence

| Check                       | Observed result                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Focused Vitest suite        | 26 tests pass in fresh JSDOM realms, preserving actual focus behavior                                               |
| Webview lint                | Pass; full monorepo precommit lint also passed                                                                      |
| Standalone trusted JS lint  | Explicit `eslint public/artifact-kit/v1/kit.js` passes                                                              |
| Webview typecheck           | Pass after workspace type package build                                                                             |
| `pnpm bundle`               | Pass                                                                                                                |
| `pnpm vsix` through 66f2d75 | Pass; Alpha 2.1.36 VSIX, 1,814 entries including source fixtures                                                    |
| Initial VSIX verifier       | Pass; explicit archive listing confirms kit CSS/JS/reference/all examples                                           |
| Translation checker         | Ran; existing gaps in common/chat/package NLS remain; all 18 new kit namespaces have matching keys and placeholders |

The focused suite covers whole-row numeric sorting with stable ties and missing
values last in both directions; filter/source associations; malformed and oversized
tables; missing/zero/negative/invalid chart values; line gaps; merged-cell rejection;
nested chart tables; disposal/remount behavior; tab keyboard focus; version fallback;
and fixture arithmetic. All controls are local and read-only checklists remain text.

Report observations are the 13 all-items CPI-U annual changes in Chart 2 of the
[archived BLS December 2024 release](https://www.bls.gov/news.release/archives/cpi_01152025.pdf).
The embedded values independently recalculate year-end change −0.5 percentage
points, increase from September's low +0.5 points, and observed range 1.1 points.
The report identifies rounded observations, calculations and interpretation limits.

## Browser inspection

Inspected the three actual example files through the standalone trusted kit in
the Codex browser, including 380px width. Reviewed hierarchy, source evidence,
two-column sections, table and code overflow, chart labels and data alternatives.
Review filtering for `writeArchive` visibly changed four rows to two.

Inspection caught and resolved two visual defects: series CSS initially overrode
the line's no-fill rule, and narrow SVG scaling made chart labels too small.
The line now renders without a filled polygon; charts retain readable width in
a keyboard-focusable local scroll region. The surrounding prose wraps, and long
code scrolls within its own block. Temporary browser viewport override was reset.

These are standalone browser observations, **not** the required VS Code host
inspection. No screenshot-only usability claim is made.

## Actual-host inspection update

NOR-66 supplied Electron CDP captures from its isolated host; its harness asserts
VS Code 1.122.1. NOR-65 independently inspected the review opening view, report
opening/chart views, exact-source navigation, and spec high-contrast/zoom view.
The review conclusion and decision are legible; the split report wraps cleanly,
retains readable chart labels in its own scroll region, and keeps the data table
visible. The spec opening composition remains readable in the captured contrast
theme at increased size. No additional layout defect was visible in these captures.

The source capture shows `src/export/resolveDestination.ts` at line 7, matching
the fixture evidence. This corroborates the reported source action; it does not
measure the interaction sequence or establish superiority over Markdown.
Representative review, report, source and spec captures are attached to
[NOR-65](https://linear.app/norval/issue/NOR-65).

Host inspection found missing stable IDs in the example filter; `cc8d489` adds
the review filter ID/label association and disclosure IDs. `0f5d44d` simplifies
the short spec comparison to a static table, retaining all alternatives together.
Those example follow-ups require inclusion in the final combined package.

NOR-66 subsequently performed the following actual-host checks; NOR-65 inspected
the corresponding light/narrow/refresh captures independently:

- Default Light Modern at zoom 0; review inner width 378 after dragging the real
  editor-group divider, with no page overflow.
- Default High Contrast at `window.zoomLevel=1` (120%); spec inner width 852,
  with no page overflow.
- Real keyboard Tab from the first report point moved to Jan 2024, exposing
  the exact 3.1% inspection label.
- Keyboard-entered review filter `write` and an open disclosure survived an
  external source refresh acknowledged in 371 ms: two visible rows, the filter
  value, disclosure state and `scrollY=2818` were retained.
- Source reference opened the fixture at line 7, column 1; source-to-preview
  command roundtrip passed after a coherent build/restart, with a three-document
  actual-host regression test added by NOR-66.

These are concrete walkthrough observations, not a benchmark or a human usability
study. NOR-66 subsequently verified focused-filter retention during external
refresh with its focus-cache correction `7e74d975`. The narrow
light capture and walkthrough details are also attached/commented on NOR-65.

## Same-content Alpha Markdown comparison

NOR-66 streamed the exact `review-baseline.md` through a fake provider into actual
Alpha chat in the same VS Code 1.122.1 host. This was Alpha's Markdown flow,
not VS Code's built-in Markdown preview. NOR-65 independently inspected
`chat-markdown-top.png` and `chat-markdown-source.png`.

| Reader task                      | Alpha chat Markdown                                                             | HTML viewer                                                                |
| -------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Locate the recommendation        | Chat initially followed completion; one reset-to-top exposed the recommendation | Recommendation visible on initial opening                                  |
| Inspect first finding's evidence | One locator-assisted scroll/focus exposed the same finding and source reference | Same finding, evidence and source reference appear in the findings section |
| Reach the source                 | Actual keyboard Enter opened `resolveDestination.ts` at line 7, column 1        | Source activation opened the same file and line                            |

Both formats provide the conclusion, evidence and working exact-source access.
The HTML document avoided the initial return-to-top observed in the completed
chat. No general claim of fewer actions or faster reading follows: evidence
targeting was assisted by a DOM locator, viewport widths differed (chat was about
300px), and this was neither timed nor randomized. This satisfies a functional
same-content comparison; a human discoverability/usability study was not run.

## Completed integrated release evidence

NOR-67 built the final combined kit, viewer, and skill package from runtime HEAD
`e7c6e8ec14680413ff5eaeaff5e439567a483f01`. The 1,855-entry archive verifier passed;
SHA-256 is `0230e9062d986fc505de803f01b7ecac3bda295be7865bb1e67453d049b296ab`.
NOR-65 independently compared all 13 kit files with the integrated source and
installed extension: every file matched, including stable IDs `cc8d489` and
the static specification correction `0f5d44d`.

The exact VS Code 1.122.1 smoke suite passed, including all five LM fixture tests
in run `390d5e81-ce99-4169-8942-43b131be1c81`. Installed authoring, preference
preservation across package replacement, and unchanged authored-file reopening in
a new host passed with verified process ownership. The full run IDs, archive
provenance, and retained evidence are documented in `rich-documents-validation.md`.
Required NOR-65 integration gates are complete; the comparison's usability limits
above still apply.
