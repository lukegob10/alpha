# Document component expansion

Implemented September 14, 2026 in `1e325e1` on the existing version-1 HTML kit and
viewer. This is the first prioritized component group, plus timeline styling;
advanced statistical charts, scenario calculators, saved approvals and comments
are not included.

## Components and authoring

| Reader need              | Implementation                                                                        | Example            |
| ------------------------ | ------------------------------------------------------------------------------------- | ------------------ |
| Navigate a long document | Outline from stable h2/h3 IDs; keyboard section focus; toolbar scroll offset          | All three examples |
| Trace a claim            | Evidence cards, description lists, numbered citations and return links                | Report             |
| Inspect key results      | Responsive metric cards with units, periods, baseline, difference and source          | Report             |
| Understand relationships | Trusted SVG from an acyclic three-column relationship table; permanent table fallback | Spec               |
| Inspect visual evidence  | Workspace PNG/JPEG, required alt text, captions, bounded host reads                   | Spec               |
| Follow a process         | Semantic ordered timeline with authored steps and statuses                            | Spec               |

The reference includes complete markup, constraints and recovery behavior. The skill
still reads only its four existing on-demand resources; no tool-policy or file-read
authority was added. Recipes explain architecture decisions, incident reviews and
experiment reports without requiring every component in every document.

## Boundaries

Images never widen the webview's local resource roots. The sanitizer removes authored
`src`/`srcset` and returns opaque slots. The host resolves workspace-relative paths,
rechecks canonical identity around bounded reads, checks PNG/JPEG headers and
dimensions, and supplies data images. Missing or invalid images preserve the document
with recovery text. Image watchers are scoped and disposed when removed or closed.
Limits are eight images, 1 MiB per file, 4 MiB combined display bytes, 8,388,608 combined
pixels and 4,096 pixels per dimension. Pixel decoding belongs to the renderer.

Diagrams allow at most 24 named nodes and 48 edges, without cycles. Arrows show
direction; exact relationship labels remain in the table. Edges skipping a layer
route around intermediate nodes. Invalid graphs retain their table and localized
explanation. Generated SVG is trusted kit output; authored SVG stays forbidden.

New controls and notices are provided in all 18 locales. Existing stored document
identities and messages are unchanged. No edits to CLI, vscode-shim, dependency
manifests, lockfile or release versions were made.

## Build-cache correction

The inherited Turborepo build inputs omitted `webview-ui/public/**`. Reproduction:
a CSS/example-only change produced a cache hit and packaged older asset bytes.
The webview build now explicitly includes public assets and its TypeScript configs.
A dry-run input manifest confirms all 16 document assets participate in the build.

`node scripts/verify-vsix-contents.mjs bin/alpha-2.1.36.vsix --check-source`
adds an opt-in comparison of every kit/viewer asset against the current source bytes.
It rejected the stale archive during reproduction; filename presence alone had
passed. The usual archive-content check remains available without the flag.

## Validation

- 91 extension viewer tests, including real filesystem/junction boundaries,
  image recovery, watcher disposal, cancellation, byte/pixel limits, sanitizer
  injection cases, bundled examples and the actual parser worker.
- 34 widget/viewer-runtime tests; 291 shared-type package tests.
- Extension, webview and shared-type checks passed; full 12-task lint passed.
- Localization scanner ran and reported existing unrelated missing translations;
  the two new kit keys are present in all 18 locale files.
- Full `test:smoke:1221` passed on actual VS Code 1.122.1: extension
  `f7c6a16f-1d76-4990-9a49-1e0f46e3ab5e`, modes
  `3b24f739-be3a-41aa-ae2d-51c4cb01e8bd`, LM fixture
  `a1dc1456-3f78-441d-b9e7-5aeaa95a6d9d`.

Actual host inspection uses the repository launcher, an isolated profile/workspace
and Electron debugging connection to the real `vscode-file` workbench and
`vscode-webview` renderer. The harness checks `vscode.version === '1.122.1'`.
An 800×360 workspace PNG decoded successfully. Replacing it with invalid bytes
showed recovery text; restoring it refreshed the same document automatically.
Keyboard Enter on the outline focused the intended heading. The 696 px report
pane showed two metric cards, citations and evidence without page overflow.

Evidence is stored outside the checkout at
`C:/Users/Luke Goblirsch/.codex/visualizations/2026/09/14/01a0a03f-31c7-7cf3-b460-cac88c748377/components`.
The first visual pass caught headings obscured by the toolbar on section jumps;
the final CSS adds a scroll margin. In the final renderer, the keyboard-focused
heading starts at y=80 px below the 50 px toolbar. At a real 380 px editor split,
metric cards stack with no document overflow. Default High Contrast at 120% zoom
remains readable in 838/314 px panes; the diagram's keyboard-focusable region
scrolls horizontally with Arrow Right. Citation and return links focus `source-1`
and `citation-1` respectively. No performance or reading-speed improvement is claimed.

Developer Reload Window ended the automated test-host process (exit 1), so that
attempt was not treated as a restoration pass. The same example was then opened
through the ordinary editor and Alpha preview command in a normal isolated
development host. Actual Developer Reload Window succeeded there: the restored
document had nine outline links, six diagram nodes, the decoded 800×360 image and
no viewer error. `components-reload.png` records the normal-host result.

## Final package

`pnpm vsix` (including bundle) and the source-byte verifier pass: 1,856 entries,
all 16 kit/viewer assets equal to current source. SHA256:
`f23edd6f2087328aca687a3d55389b5bfe838c1505513e16bf074789d27a238c`.
The final installed VSIX passed the actual 1.122.1 viewer suite in the isolated
profile, run `491ad36b-4570-4e6c-8c63-08c43790a4d4`. Its receipt records verified
host ownership, complete capture and exit 0. The test exercises multiple documents,
unsaved/external changes and repeated open/close through the installed extension.
The richer component visual inspection above is separately identified as a
development-host check, not represented as installed-package visual inspection.

After the final bundle, all three exact-host smoke suites were rerun successfully:
extension `4de9156e-da27-4230-b156-52fc47ecbf45`, modes
`495c0df0-0505-455e-8e2a-5db545807dfc`, and LM fixture
`91cdcacb-e270-4e36-bac4-5c65d70ed4ac` (actual 1.122.1, exit 0).
