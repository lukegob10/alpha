# NOR-65 HTML design kit validation

Worktree baseline: `bc66591b605f9ffa77ae40b210c074b525210e4d` (Alpha 2.1.36).
Implementation commits: `ab2fc77`, `b9255c7`, `66f2d75`.
Date: 2026-09-14. Status: implementation available for integration; release gates remain open.

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

## Outstanding integrated release evidence

- Inspect all three examples in the actual HTML viewer on VS Code 1.122.1;
  attach representative host screenshots and keyboard/theme/resize/zoom observations.
- Compare the same review in Alpha's Markdown/diff flow and HTML viewer. Record
  observed steps to identify the conclusion, inspect evidence, and open the exact
  source. No claim of fewer steps or improved usability has yet been measured.
- Re-run and verify the integrated VSIX with NOR-66 viewer, extension localization
  placement, and NOR-67 bundled skill; ensure packaged files match final source.

The installed general-purpose `code` command reports 1.137.0. NOR-66 owns running
the repository's exact 1.122.1 harness and supplying viewer evidence. NOR-67 owns
the installed-asset verification across the combined workstream. NOR-65 remains
In Progress until required integration and host evidence are resolved.
