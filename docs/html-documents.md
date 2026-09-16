# HTML documents in Alpha

In the VS Code Explorer, right-click a local `.html` or `.htm` file and choose
**Preview HTML Document** to open it in Alpha's document viewer. This works for
documents saved in `docs/` or elsewhere in the workspace without opening the chat
or source editor first. The menu accepts either filename case and excludes folders.

You can also run **Alpha: Preview HTML Document** with an HTML source file active
(or invoke `alpha.previewHtmlDocument` with a VS Code file URI). An explicit Markdown
action opens the same view from any chat, including a saved task:

```text
[Review](alpha-document://open?uri=file%3A%2F%2F%2FC%3A%2Fwork%2F.alpha%2Fdocuments%2Ftask-1%2Freview.html&task=task-1)
```

Encode the full absolute file URI with `encodeURIComponent`; `task` is optional,
bounded metadata, never an authority grant or a reference to the focused task.
Ordinary `.html` links retain ordinary source-opening behavior. Canonical real
file URI is the document identity, shared across sidebar and editor chat. Opening
it again brings that existing tab into the active editor group. New previews open
as tabs in the group active when opening was requested, without creating a side
group. This also works when an editor chat webview has focus. Restored previews keep
their saved placement. Refresh does not focus a tab. The suggested
durable location is `.alpha/documents/<task-id>/<slug>.html` within the workspace;
the viewer neither creates that directory nor writes, saves, or migrates source.
Moving a document changes its identity: update its saved link or open its new path.

Fresh, non-streaming completion messages in the visible primary task also deliver
document action links automatically to the active editor group, preserving chat focus.
The extension-side message adapter owns this presentation effect. It never scans
history snapshots, opens links in code examples, follows another task's tagged
link, or opens background/subagent output. Per-task deduplication is bounded and
claims a URI before asynchronous work; at most eight links are opened per message.
The viewer rechecks task visibility after resolving the file and does not reveal
an existing panel during automatic delivery. Explicit clicks keep their normal
focus behavior, including after the reader closes an automatically opened tab.

## Format and assets

Use UTF-8 HTML with one `<meta name="alpha-document" content="1">`, a nonempty
title (at most 200 characters), and one direct body child
`<main class="alpha-doc" data-alpha-kit="1">`. The viewer format and kit version
are separate markers, both currently `1`. See the kit's
`webview-ui/public/artifact-kit/v1/reference.md` for semantic markup, tables,
charts, tabs, outlines, citations, metrics, images, relationship diagrams and complete review/spec/report examples. Data is embedded in ordinary
HTML tables. There is no generated TSX, compiler, app server, or export pipeline.

The extension loads trusted `webview-ui/build/artifact-kit/v1/{kit.css,kit.js}` and
`webview-ui/build/html-document/{viewer.css,viewer.js}` on demand. The host parses
and sanitizes the document with an allowlist before transmitting it. Authored
scripts (including JSON script tags), styles, event handlers, audio/video, SVG, forms,
imports, remote resources and command URIs are not supported. Code examples use
escaped text inside `pre > code`. The CSP denies network, frames, forms, objects,
base URLs and untrusted scripts. The document never receives the VS Code API.

Workspace images use `<img data-image="images/screen.png" alt="Descriptive evidence">`.
The sanitizer replaces these with opaque slots; the host alone resolves and reads
static PNG/JPEG bytes, validates dimensions, and supplies data images. Authored
`src` and `srcset` never survive. CSP permits data images only; local resource roots
remain restricted to extension assets. Referenced image files accompany the HTML
when moved. Missing or rejected images have readable recovery text and do not hide
the document. Image file watchers refresh the same panel and are disposed when
references disappear or the panel closes.

The additive kit components preserve the version-1 document contract. Older viewers
retain ordinary headings, metrics, timelines and evidence tables but may omit images
and enhancements. New outlines require stable heading IDs; diagrams use an acyclic
three-column relationship table, limited to 24 nodes and 48 links. Generated SVG
belongs to the trusted kit; authored SVG remains forbidden.

## Evidence and source editing

`<a data-source="src/module.ts" data-line="42">module.ts:42</a>` opens a file at a
one-based line, clamped to the actual file. Paths are relative to the document's
most specific open workspace root. Absolute paths, dot segments, backslashes,
schemes, control characters and escaping symlinks are rejected. Every action is
revalidated, including the document's current workspace membership. Local file
workspaces are supported; remote/virtual/UNC sources are not part of version 1.

Fragment links scroll and move keyboard focus within the document. Explicit HTTPS citation clicks open
the system browser through the host; credentials and other external protocols are
unsupported. No citation is fetched by the viewer. The host replaces both kinds
of evidence links with opaque reference IDs and accepts only strict `ready`,
`source`, and `reference` messages bound to the panel's random token, canonical
identity and current revision. Content cannot supply an arbitrary target URI or
command in a message.

**Open source** uses the normal text editor. Unsaved edits, undo/redo and external
file changes refresh after 150 ms of quiet time, with one read pending per panel.
Newer changes invalidate older work. Matching disclosure IDs and filter input IDs
retain their open/value state and scroll position. Removed IDs reset; new IDs use
authored defaults. Sorting and selected tabs currently reset to authored order.
Widget state is view-only and never written to the source. Panel state persists
its source/task target for reload; saved chat links provide another durable entry.

Malformed/version-mismatched/oversized/deleted sources show a recovery explanation.
When a previous render exists, it is labeled out of date and evidence actions are
disabled until corrected. Fixing the source automatically recovers. A moved file
is not guessed or searched for. Reopen its new source explicitly. A workspace
closed across reload must be reopened before its document link can resolve.

## Workload limits and acceptance budgets

Established before measuring/tuning: maximum source 512 KiB, 12,000 elements,
64 levels of depth, 32 enhanced widgets, 1,000 evidence links. Kit enhancements
add their own table/chart/diagram limits. The host reads at most 512 KiB + 1 byte of
HTML per refresh. Images add at most eight sequential reads of 1 MiB + 1 byte each;
displayed images total at most 4 MiB encoded bytes and 8,388,608 pixels, with each
dimension at most 4,096 pixels. Image headers are inspected without decoding on the
extension host. The viewer disposes watchers, editor subscriptions, timers and widget listeners
on close. At most one refresh is running and one replacement is scheduled per
panel; stale results are discarded. Parsing runs in a worker (64 MiB old-generation
heap, 1.5 s deadline), retained warm after success and terminated on failure,
cancellation or panel closure.
At most eight document panels may be open at once; close one to open another.

Measurement fixtures: small = complete review example; large = 1,000 rows × 5
columns with plain text, within the source and element limits. Initial acceptance
budgets on the development machine: sanitizer p95 < 100 ms small / < 250 ms large;
warm user-visible open < 500 ms small / < 1 s large; cold open < 2 s; refresh after
debounce < 500 ms small / < 1 s large. Repeated-open/close target: one panel per URI,
no remaining listener/watcher/timer registrations after closing. These are budgets,
not claimed measurements or performance gains. Exact-host/installed-package results
and unavailable gates are recorded separately in the release evidence.
