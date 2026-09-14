---
name: rich-documents
description: Create or revise a rich HTML document for a substantial spec, review, or quantitative report that benefits from a separate view, or when explicitly requested. Respect plain text, Markdown, existing output destinations, and ordinary short answers or code fixes.
---

# Rich documents

Create a useful document using Alpha's packaged HTML design kit, version 1. Select this skill through the ordinary skill invocation path; it grants no additional file, tool, network, or approval authority.

Before authoring, read [the component and chart reference](../../../webview-ui/build/artifact-kit/v1/reference.md). Read only the relevant complete example: [review](../../../webview-ui/build/artifact-kit/v1/examples/review.html), [spec](../../../webview-ui/build/artifact-kit/v1/examples/spec.html), or [quantitative report](../../../webview-ui/build/artifact-kit/v1/examples/report.html). Resolve these links against this selected skill's base directory. These resources are installed with Alpha and work offline; do not install packages, fetch a CDN, or copy managed guidance into the workspace.

## Content and layout

Lead with the conclusion, decision, or recommendation. Choose the example whose information structure fits the request; replace its content rather than filling every available component. A review needs meaningful findings with evidence and actionable recommendations. A spec needs the behavior being proposed, boundaries, decisions, and verifiable acceptance criteria. A quantitative report needs a clear question, sourced observations, units, date range, methodology, and limitations.

Distinguish measured facts, estimates, illustrative examples, and missing information. Never invent values, imply that sample data describes the user's project, or add empty panels to fill a template. Cite actual evidence using inspectable tables, source links, and concise notes. Charts are optional: use them when comparisons or trends become easier to understand. Preserve the semantic data table and a text takeaway so the information remains accessible without widget execution. Use only the reference's supported table/chart schemas, finite numeric values, explicit units, and missing-value conventions.

Let long content flow naturally; use headings, anchor navigation, and native details for supporting evidence. Keep the conclusion and key findings visible. Avoid fixed-height prose panels and decorative controls. Every interaction must help the reader inspect the content.

## Write, preview, and revise

Write HTML through the existing file tools, respecting workspace protections and any requested output location. For a new document without a specified destination, use `.alpha/documents/<task-id>/<descriptive-slug>.html` within the current workspace when the actual task ID is available. If it is unavailable, choose a descriptive workspace filename rather than inventing an ID. The canonical file URI is the document identity. When revising, edit the same file and keep its identity and links stable.

Include `<!doctype html>`, a language, UTF-8 charset, a meaningful `<title>`, `<meta name="alpha-document" content="1">`, and `<main class="alpha-doc" data-alpha-kit="1">`. Use semantic HTML and exactly the shipped version-1 markup. The viewer supplies trusted styles and widgets. Do not add executable scripts, inline event handlers, author CSS, external assets, React/TSX, or build tooling. Embedded chart data lives in semantic tables, not executable or JSON script elements.

For workspace evidence, use `<a data-source="src/example.ts" data-line="12">Descriptive source label</a>` with the actual workspace-root-relative path and positive line number. Do not use traversal, absolute paths, backslashes, or URI schemes in `data-source`. Use ordinary HTTPS references for external evidence. A source link does not grant access outside the open workspace.

The final response should state the takeaway and link to the file using:

`[Open document](alpha-document://open?uri=<percent-encoded-absolute-file-URI>&task=<actual-task-id>)`

Encode the absolute file URI as a query parameter, including spaces and reserved characters; omit `&task=...` if the actual task ID is unavailable. For example, a real file URI `file:///workspace/.alpha/documents/review.html` becomes `file%3A%2F%2F%2Fworkspace%2F.alpha%2Fdocuments%2Freview.html`. Never substitute this example path for the written file. Preview opens on the user's click; do not repeatedly invoke commands, open tabs, or steal focus. The user can also use **Alpha: Preview HTML Document** for the source file, edit it normally, and reopen the same preview link.

## Validate and repair

Inspect the written document against the reference: version marker and root, coherent heading order, real evidence, labels and units, supported widget markup, and readable table alternatives. Check that the final link points to the file actually written. Use available preview validation to inspect the result when supported by the environment; do not claim visual verification without viewing it.

If the viewer reports invalid or unsupported content, repair the same source file using its diagnostic and the shipped reference, then refresh/reopen. Remove unsupported scripts or CSS, correct malformed data cells, restore required metadata, or replace an unnecessary chart with the plain evidence table. Do not reset the task or create a second artifact to bypass validation. An older unsupported document should follow the viewer's compatibility fallback; do not silently rewrite its version marker without checking its markup.
