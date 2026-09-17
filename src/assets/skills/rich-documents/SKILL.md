---
name: rich-documents
description: Create or revise a rich HTML document in Alpha's built-in HTML previewer for a substantial spec, review, or quantitative report, or when explicitly requested. Respect plain text, Markdown, existing output destinations, and ordinary short answers or code fixes.
---

# Rich documents

Create a useful document using Alpha's packaged HTML design kit, version 1. Select this skill through the ordinary skill invocation path; it grants no additional file, tool, network, or approval authority.

Always use Alpha's built-in HTML previewer for these documents. Never use browser tools (`open_browser_page`, `navigate_page`, `run_playwright_code`), an external browser, or a localhost server to open, screenshot, validate, or repair them. The `alpha-document://open` link below is a chat action handled by Alpha, not a browser URL. Read the source and packaged examples with file tools.

Before authoring, read [the component and chart reference](../../../webview-ui/build/artifact-kit/v1/reference.md). Read only the relevant complete example: [review](../../../webview-ui/build/artifact-kit/v1/examples/review.html), [spec](../../../webview-ui/build/artifact-kit/v1/examples/spec.html), or [quantitative report](../../../webview-ui/build/artifact-kit/v1/examples/report.html). Resolve these links against this selected skill's base directory. These resources are installed with Alpha and work offline; do not install packages, fetch a CDN, or copy managed guidance into the workspace.

## Content and layout

Lead with the conclusion, decision, or recommendation. Choose the example whose information structure fits the request; replace its content rather than filling every available component. A review needs meaningful findings with evidence and actionable recommendations. A spec needs the behavior being proposed, boundaries, decisions, and verifiable acceptance criteria. A quantitative report needs a clear question, sourced observations, units, date range, methodology, and limitations.

Distinguish measured facts, estimates, illustrative examples, and missing information. Never invent values, imply that sample data describes the user's project, or add empty panels to fill a template. Cite actual evidence using inspectable tables, source links, and concise notes. Charts are optional: use them when comparisons or trends become easier to understand. Preserve the semantic data table and a text takeaway so the information remains accessible without widget execution. Use only the reference's supported table/chart schemas, finite numeric values, explicit units, and missing-value conventions.

Let long content flow naturally; use headings, anchor navigation, and native details for supporting evidence. Keep the conclusion and key findings visible. Avoid fixed-height prose panels and decorative controls. Every interaction must help the reader inspect the content. Use plain semantic tables for small static schemas or comparisons; add `data-alpha-table` only when sorting or filtering is useful.

Use the full document width for headers, summaries, tables, and major findings. The kit handles readable prose and responsive spacing; do not add narrow wrappers or nest the entire report inside a grid cell. Use `badge` with a textual `status-good`, `status-warning`, `status-danger`, `status-info`, or `status-neutral` label for evidenced status. Red, amber, and green must mean risk, attention, and verified health, not decoration. Use cards for distinct options, `metrics` only for sourced quantitative summaries, and a `table-toolbar` for useful filters. Read the reference's composition examples; select a few components that serve this document rather than filling a dashboard template.

## Write, preview, and revise

Choose additional components by the reader's task. Use a generated outline with stable section IDs for long documents; evidence cards and numbered citations for traceable claims; metric cards for a few contextualized results; and a timeline for a proposed sequence. Metric cards must include units, periods, evidence, and meaningful baselines. Values are authored, not automatically computed or verified. Do not fill a document with decorative cards.

Use a relationship diagram only for a small directed acyclic flow or dependency structure; its three-column table remains the canonical evidence. Use a plain table for cyclic or unsupported graph forms. For visual evidence and analytical plots (including Matplotlib), save actual PNG/JPEG assets inside the workspace. Use `<img src="plots/chart.png" alt="Describe the chart">` with a path relative to the HTML file, or `data-image` with a workspace-root-relative path. Include a provenance caption and respect the documented image byte/pixel limits. Images are workspace dependencies, not remote fetches or content to embed as authored base64. Do not invent screenshots or claim a schematic depicts the running product. The complete spec example demonstrates diagrams, images, and timelines; the report demonstrates metrics, citations, and evidence cards.

Useful compositions: an architecture decision combines a recommendation, alternatives table, relationship diagram and open questions; an incident review combines impact, a dated timeline, linked evidence and corrective actions; an experiment report combines the question, method, metric cards, full data and limitations. Choose only the components needed by the content.

Write HTML through the existing file tools, respecting workspace protections and any requested output location. For a new document without a specified destination, use `.alpha/documents/<task-id>/<descriptive-slug>.html` within the current workspace when the actual task ID is available. If it is unavailable, choose a descriptive workspace filename rather than inventing an ID. The canonical file URI is the document identity. When revising, edit the same file and keep its identity and links stable.

Include `<!doctype html>`, a language, UTF-8 charset, a meaningful `<title>`, `<meta name="alpha-document" content="1">`, and `<main class="alpha-doc" data-alpha-kit="1">`. Use semantic HTML and exactly the shipped version-1 markup. The viewer supplies trusted styles and widgets. Do not add executable scripts, inline event handlers, author CSS, external assets, React/TSX, or build tooling. Embedded chart data lives in semantic tables, not executable or JSON script elements.

For workspace evidence, use `<a data-source="src/example.ts" data-line="12">Descriptive source label</a>` with the actual workspace-root-relative path and positive line number. Do not use traversal, absolute paths, backslashes, or URI schemes in `data-source`. Use ordinary HTTPS references for external evidence. A source link does not grant access outside the open workspace.

The final response should state the takeaway and link to the file using:

`[Open document](alpha-document://open?uri=<percent-encoded-absolute-file-URI>&task=<actual-task-id>)`

Encode the absolute file URI as a query parameter, including spaces and reserved characters; omit `&task=...` if the actual task ID is unavailable. For example, a real file URI `file:///workspace/.alpha/documents/review.html` becomes `file%3A%2F%2F%2Fworkspace%2F.alpha%2Fdocuments%2Freview.html`. Never substitute this example path for the written file. On a new completed response in the visible task, Alpha opens the linked document in the active editor group while keeping chat focus. Keep the Open document link for explicit reopening. Do not invoke extra commands or regenerate the source to open it; revisions refresh the existing preview. Background tasks and restored history retain their links without opening tabs. The user can also use **Alpha: Preview HTML Document** for the source file.

## Validate and repair

Inspect the written document against the reference: version marker and root, coherent heading order, real evidence, labels and units, supported widget markup, and readable table alternatives. Check that the final link points to the file actually written. If direct inspection of Alpha's HTML previewer is unavailable, validate the source and deliver the document link; state that visual verification was unavailable. Do not claim visual verification without viewing it or switch to browser tools when preview inspection is unavailable.

If the viewer reports invalid or unsupported content, repair the same source file using its diagnostic and the shipped reference, then refresh/reopen. Remove unsupported scripts or CSS, correct malformed data cells, restore required metadata, or replace an unnecessary chart with the plain evidence table. Do not reset the task or create a second artifact to bypass validation. An older unsupported document should follow the viewer's compatibility fallback; do not silently rewrite its version marker without checking its markup.
