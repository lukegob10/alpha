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

Use `article.finding[data-severity="high|medium|low"]` with an explicit textual
severity, trigger, consequence, evidence, source, and proposed correction. The
severity border supplements that text. `aside.callout` highlights a caveat or
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

## Tables

Wrap one rectangular table in `section[data-alpha-table]`. Use one thead row,
one tbody, scope attributes, and a caption. Add `data-sort="text"` or `"number"`
to sortable th cells. Numeric cells use `data-sort-value="12.5"`, independent
of the formatted text (such as `12.5 ms`). Empty numeric values sort last in both
directions. Ties preserve authored order. Sorting moves whole rows, including
their evidence links. Limit enhancement to **1,000 rows × 20 columns**; larger
tables remain readable without controls. Colspans and rowspans are not enhanced.

```html
<section data-alpha-table>
	<label for="files">Filter files</label>
	<input id="files" data-alpha-filter type="search" disabled />
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
- `examples/index.html`: executable standalone gallery using the packaged assets.
- `examples/review-baseline.md`: same review content for the existing Markdown/diff comparison.

Before release, verify all three in the actual viewer on VS Code 1.122.1: light,
dark, high contrast, narrow split and text zoom; keyboard through every control;
source links, refresh, missing/invalid data and long content. Compare conclusion,
evidence and source tasks against the baseline; record observations and action
counts, not inferred usability from screenshots. DOM tests alone do not satisfy
this host gate. Verify the installed VSIX includes the same files.
