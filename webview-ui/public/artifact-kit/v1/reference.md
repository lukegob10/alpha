# Alpha HTML kit · version 1

Author a complete, semantic HTML document. No generated JavaScript, React, build step,
remote assets, inline event handlers, or custom stylesheet is needed. The viewer
loads the trusted packaged `kit.css` and `kit.js` from `webview-ui/build/artifact-kit/v1/`.
The source directory is `webview-ui/public/artifact-kit/v1/`. Standalone examples opt
in with `<script defer data-alpha-standalone src="../kit.js"></script>`; this is a
gallery harness, not permission for authored executable code in the viewer.

```html
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="alpha-document" content="1" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Decision and subject</title>
	</head>
	<body>
		<main class="alpha-doc" data-alpha-kit="1">
			<header class="doc-header">
				<p class="eyebrow">Implementation spec</p>
				<h1>State the proposed outcome</h1>
				<p class="lead">Explain why it matters.</p>
			</header>
			<section class="summary">
				<h2>Decision needed</h2>
				<p>Recommendation and next action.</p>
			</section>
		</main>
	</body>
</html>
```

The document marker belongs to the viewer contract. The root marker selects the
kit contract independently. Unsupported kit versions retain semantic content and
show an explanation. Do not hide essential information awaiting enhancement.

## Composition

Use one h1; h2 for major sections and h3 for findings or alternatives. A `doc-header`
establishes context, `eyebrow` carries short metadata, `lead` states the conclusion,
and `summary` contains the recommendation. `grid` fits two columns when space
permits and stacks at narrow widths. Keep long prose out of wide grids.

The page fills its available pane up to 104rem, with responsive gutters. Headers,
tables, summaries and findings occupy the full content width; prose retains a
readable measure. Never wrap the entire document in a card or one grid column.
Use `span-all` for a full-width item in a grid. Start with a header, a decision,
and the evidence; use the remaining components only where their structure helps.

### Status, cards and compact summaries

`badge` gives a status label a colored dot, rounded outline and subtle tint.
Combine it with `status-good` (verified health), `status-warning` (attention),
`status-danger` (risk), `status-info` (information), or `status-neutral` (unassessed).
Always include the status as text. A low-severity finding is not automatically
healthy; its blue indicator is deliberately distinct from a green verified state.
The same status classes tint `callout` borders. Status is authored evidence, not
an interactive approval or a calculated score.

```html
<div class="doc-meta">
	<span class="badge status-warning">Needs review</span>
	<span>API contract · 14 September 2026</span>
</div>
<div class="grid">
	<section class="card">
		<h3 class="card-title">Keep the current API</h3>
		<p>Describe the option and its concrete tradeoffs.</p>
		<span class="badge status-good">Compatibility verified</span>
	</section>
	<aside class="callout status-warning">
		<h3>Decision required</h3>
		<p>Name the unresolved constraint and the evidence needed.</p>
	</aside>
</div>
```

`metrics` lays out compact `metric` tiles responsively. Inside a tile use
`metric-label`, `metric-value`, and `metric-detail`. Values must come from the
document's evidence; do not invent scores, percentages or health statuses to fill
tiles. Use ordinary prose when the conclusion is qualitative. `key-values` styles
a semantic `dl` with `dt`/`dd` pairs. `ol.steps` presents a short ordered delivery
sequence. `nav.toc` contains ordinary fragment links to real section IDs.
`section-heading` aligns a heading with a brief status or caption. Keep headings
and important conclusions visible without opening disclosures or tabs.

Use `article.finding[data-severity="high|medium|low"]` with an explicit textual
severity, trigger, consequence, evidence, source, and proposed correction. The
severity border and dot supplement that text. `aside.callout` highlights a caveat or
decision. `ul.checklist` is **read-only**; write statuses such as “Required” or
“Verified” as text, with evidence. Do not imply a saved review state.

Use native `details`/`summary` for optional explanation. Give details stable IDs
if the viewer should retain disclosure state on source refresh. Use `pre > code`
for code. Diff spans may use `diff-add`/`diff-remove`, but always retain explicit
`+`/`-` prefixes. Scroll long code and wide tables inside `table-scroll`; do not
force the whole document to scroll horizontally. Paragraphs and filenames wrap.

Source references use `<a data-source="src/module.ts" data-line="42">src/module.ts:42</a>`.
Paths are relative to the document's workspace root: no absolute paths, `..`,
backslashes, or schemes. The viewer owns validation and source opening. Ordinary
HTTPS citations use `href`. Source links in the fictional review are illustrative
and intentionally do not claim those fixture files exist in the reader's repo.

## Navigation, evidence, and metrics

Use `<nav data-alpha-toc aria-label="Document contents"><p class="eyebrow">On this page</p></nav>`
after the opening recommendation or introduction. Give major h2/h3 headings stable,
unique IDs. The kit lists up to 200 headings, excluding headings inside navigation,
details, or tabs. Outline labels are capped at 160 characters; full headings remain
in the document. Links move keyboard focus to the section in the viewer. Use ordinary
`href="#section-id"` links for section references, glossary terms, and return links.
Do not hide required decisions inside tabs or disclosures.

Evidence cards use `aside.evidence-card` with an h3, a source link, and a description
list for provenance, method, and limits. A card must identify what a source supports;
it must not imply that a claim was verified merely because it has a citation.
Use ordinary numbered links for footnotes, with distinct citation/source IDs:

```html
<p>
	State the supported claim.<sup><a id="cite-1" href="#source-1" aria-label="Source 1">[1]</a></sup>
</p>
<aside class="evidence-card">
	<h3>Evidence basis</h3>
	<dl>
		<dt>Method</dt>
		<dd>Describe what was actually checked.</dd>
		<dt>Limit</dt>
		<dd>Explain missing coverage.</dd>
	</dl>
</aside>
<section class="footnotes" aria-label="Sources">
	<h2 id="sources">Sources</h2>
	<ol>
		<li id="source-1">
			Describe the actual source and link to it.
			<a href="#cite-1" aria-label="Return to citation 1">Return to citation</a>
		</li>
	</ol>
</section>
```

Use `div.metric-grid > article.metric-card` for two to four key results, each with
an h3 label, `p.metric-value`, unit, period, evidence link, and relevant baseline.
Use a description list for the baseline, calculated difference, target, or limits.
The kit styles authored values; it does **not** calculate or verify them. Distinguish
percent from percentage points, measured from estimated values, and missing from
zero. Avoid unexplained red/green scores and decorative metrics. `examples/report.html`
contains complete cards derived from its canonical table, citations and provenance.

For a decision, compose `section.summary`, a small alternatives table, and an
evidence card stating assumptions and unresolved questions. For a process, use
`ol.timeline` with an h3 and explanation in each li. Dates and statuses are authored
facts or explicitly labeled proposals, not live task state. These patterns have
no inputs, persistent approval state, or background actions.

## Workspace images

```html
<figure>
	<img data-image="images/screen.png" alt="Describe the relevant visual evidence." />
	<figcaption>Explain the observation, provenance, and any numbered callouts.</figcaption>
</figure>
```

The path is relative to the document's workspace root, just like source references.
Use real workspace assets, not URLs, absolute paths, traversal, or base64 in the
authored file. Alt text is required. The host resolves the path, reads bounded bytes,
checks static PNG/JPEG headers and dimensions, then embeds a data image. It does not
grant the webview access to the workspace. Authored `src`, `srcset`, SVG, animation,
event handlers and remote images remain unsupported. Missing, invalid, inaccessible
or oversized assets show an explanation alongside the rest of the document.

Limits: 8 images, 1 MiB per image, 4 MiB combined encoded bytes, 8,388,608 combined
pixels, and 4,096 pixels per dimension. Keep images appropriately sized for a document.
Referenced file changes trigger the same bounded refresh pipeline, without writing
either file. The HTML remains one editable content file; referenced images are
workspace dependencies that must accompany it when moving the document. This is
not a standalone export pipeline.

`examples/spec.html` uses the supplied `fixture-workspace/images/layout-sample.png`.
Copy that fixture's `images` folder to the workspace root when trying the example.
Its ordinary `src` supports the standalone gallery only; the viewer strips that
attribute and resolves `data-image` through the host.

## Relationship diagrams

Use a diagram to explain a **directed acyclic** ownership, dependency, or process
relationship. The trusted kit draws nodes and arrows from a semantic table; authors
never supply SVG, graph scripts, layout expressions, or executable diagram languages.

```html
<figure data-alpha-diagram>
	<figcaption>Request flow. Arrows show direction; the table names each relationship.</figcaption>
	<div class="table-scroll">
		<table>
			<caption>
				Responsibilities
			</caption>
			<thead>
				<tr>
					<th scope="col">From</th>
					<th scope="col">Relationship</th>
					<th scope="col">To</th>
				</tr>
			</thead>
			<tbody>
				<tr>
					<th scope="row">Client</th>
					<td>Sends requests</td>
					<td>API</td>
				</tr>
				<tr>
					<th scope="row">API</th>
					<td>Dispatches work</td>
					<td>Worker</td>
				</tr>
				<tr>
					<th scope="row">API</th>
					<td>Reads cached results</td>
					<td>Cache</td>
				</tr>
			</tbody>
		</table>
	</div>
</figure>
```

Use exactly three columns, one header row, one body, no merged cells, and 1–48
relationships among at most 24 nodes. Every cell needs 1–80 characters of text.
Identical source/target labels identify the same node. The diagram arranges layers
from left to right; arrows encode direction and the always-visible table retains
exact relationship labels. The scroll region supports keyboard use on narrow views.
Cycles, missing labels and over-budget graphs retain the table with an explanation.
For feedback loops, sequence timing, or dense networks, use a plain relationship
table and prose rather than claiming this component supports those graph forms.

## Tables

Use plain semantic tables for short comparisons that should be read together.
Add enhancement only when sorting or filtering helps answer a real reader question.
All tables receive rounded corners, differentiated headers, alternating row
surfaces, and hover/focus highlighting. A `badge` can label a status inside a cell;
retain its full text and sort by the actual meaning when needed. Use
`table-toolbar` to group a filter's visible label and input above the table.

Wrap one rectangular table in `section[data-alpha-table]`. Use one thead row,
one tbody, scope attributes, and a caption. Add `data-sort="text"` or `"number"`
to sortable th cells. Numeric cells use `data-sort-value="12.5"`, independent
of the formatted text (such as `12.5 ms`). Empty numeric values sort last in both
directions. Ties preserve authored order. Sorting moves whole rows, including
their evidence links. Limit enhancement to **1,000 rows × 20 columns**; larger
tables remain readable without controls. Colspans and rowspans are not enhanced.

```html
<section data-alpha-table>
	<div class="table-toolbar">
		<label for="files">Filter files</label>
		<input id="files" data-alpha-filter type="search" disabled />
	</div>
	<div class="table-scroll">
		<table>
			<caption>
				Review scope
			</caption>
			<thead>
				<tr>
					<th scope="col" data-sort="text">File</th>
					<th scope="col" data-sort="number">Findings</th>
				</tr>
			</thead>
			<tbody>
				<tr>
					<td>src/cache.ts</td>
					<td data-sort-value="2">2</td>
				</tr>
			</tbody>
		</table>
	</div>
</section>
```

The trusted runtime enables the filter only after validation and creates keyboard
operable sort buttons. Give each input a stable ID and visible label. The host
may preserve filter values on refresh. Counts and sort direction are announced.

## Charts: the table is the data

No JSON or executable data script is required. A `figure[data-alpha-chart]` with
`data-chart-type="bar"` or `"line"` contains a descriptive figcaption and canonical
`table[data-alpha-chart-data]`. Its first header is the category/time axis; other
headers are named series, each with the same nonempty `data-unit` (for example `%`
or `ms`). Each body row starts with a category th, followed by numeric td cells
with `data-value`. Use a decimal finite number, magnitude at most 1e12. Use
`data-value=""` and visible “Not available” for missing data; **zero is `"0"`**.
Missing line observations break the line. All-zero data remains valid.

The chart supports **1–120 rows, 1–3 series, one shared unit**. Use separate charts
for different units. Line categories are evenly spaced: use regular periods, not
irregular timestamps. Supply a meaningful title, source and time range, rounding
and uncertainty notes, and a table caption. Every table remains visible and
accessible. Invalid or empty data retains the table and adds an actionable
explanation. Inspect points with keyboard focus or pointer hover; exact labels
include category, series, value, and unit. Do not use charts as the sole evidence.
Large or very small axis ticks use scientific notation; rounded ticks carry `≈`.
Inspection labels and the canonical table retain the exact supplied values.
Keep labels concise; full labels remain in the table. Bar charts use zero baseline.
Charts retain a readable minimum width inside their own keyboard-focusable scroll
region at narrow widths and increased text zoom. The surrounding document wraps.
The viewer also bounds the whole document to 512 KiB, 12,000 elements, depth 64,
32 widgets and 1,000 source references; these aggregate limits apply in addition
to each widget's limits. A table within the per-widget maximum may still exceed
the document element limit, so split large analyses into separate documents.

## Optional tabs

Prefer ordinary sections for sequential reading. For genuine alternatives, use a
`section[data-alpha-tabs][aria-label="Implementation alternatives"]` containing
2–8 direct sections, each with a unique ID and `data-tab-label`. All sections are
readable before initialization. The kit supplies tabs; Arrow Left/Right, Home and
End move focus and selection. Tab enters the selected tab only. Do not author
hidden panels or a second tab control layer.

## Host integration and theme

`window.AlphaDocumentKit.mount(root, labels?)` returns an idempotent disposer.
Call it on sanitized `.alpha-doc[data-alpha-kit]`, after loading the trusted
assets. A second mount returns the existing disposer. Dispose before replacing
the root; the kit restores table order, disclosure-independent panel visibility,
and authored headers. The kit has no host API, network, storage, or message access.
Viewer identity, authority, file refresh, links and persisted state remain host-owned.

Pass raw `htmlArtifactKit` locale resources as labels. Interpolation uses single
braces (`{column}`, `{visible}`, `{total}`), handled by the kit. English defaults
serve standalone examples. Interface keys are filter, sort, rows, unsupported,
invalidTable, invalidChart, invalidTabs, missing, inspect, sortAscending,
sortDescending. Authored prose is not extension interface text.

All styles are scoped under `.alpha-doc`. Tokens `--doc-bg`, `--doc-fg`,
`--doc-muted`, `--doc-border`, `--doc-accent`, `--doc-focus` inherit corresponding
VS Code editor, description, group-border, link, and focus colors. The host must
propagate VS Code theme variables into the isolated content. Fallback colors
support standalone light/dark previews; forced colors and reduced motion are
supported. Do not load this sheet as host-control styling.

## Complete examples and release checks

- `examples/review.html`: prioritized fictional multi-file review.
- `examples/spec.html`: implementation decision, tradeoffs and unresolved policy.
- `examples/report.html`: archived BLS CPI observations, calculations and limits.
- `examples/index.html`: standalone gallery with cards, semantic status badges, a filterable status table, and packaged assets.
- `examples/review-baseline.md`: same review content for the existing Markdown/diff comparison.

Before release, verify all three in the actual viewer on VS Code 1.122.1: light,
dark, high contrast, narrow split and text zoom; keyboard through every control;
source links, refresh, missing/invalid data and long content. Compare conclusion,
evidence and source tasks against the baseline; record observations and action
counts, not inferred usability from screenshots. DOM tests alone do not satisfy
this host gate. Verify the installed VSIX includes the same files.
