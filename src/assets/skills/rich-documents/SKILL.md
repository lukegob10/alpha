---
name: rich-documents
description: Create or revise workspace HTML in Alpha's built-in previewer for a requested rich document or a substantial brief, review, spec, report, or runbook. Honor other formats and destinations. Keep ordinary questions and code fixes in chat.
---

# Rich documents

Start with the reader’s task. Put the decision, finding, or next action where the reader can see it on opening the document. Honor the requested format and destination. In Plan mode, give the proposed content or edits in chat when a file write would be required.

## Choose a starting point

When **revising an existing document**, read its source first. Make the requested change in the same file. Preserve unaffected wording, section IDs, citations, and image paths. A prose edit needs no template lookup.

When **creating a document**, use the smallest structure that answers the request. If a worked example would help, read the one that matches what the reader needs to do.

- [Brief](../../../webview-ui/build/artifact-kit/v1/examples/brief.html) — make a decision or take over work. State what changed, the evidence that matters, and the next action. Include an owner and date when known.
- [Review](../../../webview-ui/build/artifact-kit/v1/examples/review.html) — prioritize findings by consequence. Tie each to evidence and a correction the reader can verify. For an incident review, establish the impact and sequence of events.
- [Spec](../../../webview-ui/build/artifact-kit/v1/examples/spec.html) — define proposed behavior, boundaries, tradeoffs, and observable acceptance criteria. For a design decision, explain why the proposed option fits the constraints.
- [Quantitative report](../../../webview-ui/build/artifact-kit/v1/examples/report.html) — answer a question from data. Give the source, method, periods, units, baselines, and limits.
- [Runbook](../../../webview-ui/build/artifact-kit/v1/examples/runbook.html) — carry out a procedure. Identify prerequisites, pair actions with observable checks, and explain when to stop, recover, or hand off.

Resolve packaged links from this skill’s directory using the permitted file tools. Borrow structure only. Omit the gallery stylesheet, scripts, return links, and sample evidence. Read the [component reference](../../../webview-ui/build/artifact-kit/v1/reference.md) when adding or repairing a widget, plotting data, or embedding an image. For a simple document or when kit resources are unavailable, this v1 structure works on its own.

```html
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="alpha-document" content="1" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Weekend handoff</title>
	</head>
	<body>
		<main class="alpha-doc" data-alpha-kit="1">
			<header class="doc-header"><h1>Weekend handoff</h1></header>
			<section>
				<h2>Next shift</h2>
				<p>Bring the open request list so the next shift can confirm an owner for each callback.</p>
			</section>
		</main>
	</body>
</html>
```

## Write for the reader

Attribute claims to what you actually have, including user-supplied notes. Mark estimates, proposals, and unknowns where they affect a decision. For rates, show the counts and denominators and recompute differences from the source. Keep comparisons between partial and complete periods explicit. A small comparison often fits in one sentence or a captioned table.

Use one descriptive h1 and a logical heading order. Keep decisions, actions, and citation targets visible in ordinary sections. Let content flow in a narrow pane. Use native disclosures for optional detail. Add a chart only when it clarifies a comparison or trend. Keep its canonical semantic table, units, missing values, and a plain-language takeaway. Put images in the workspace as PNG/JPEG files with meaningful alt text and a provenance caption. The viewer supplies styles and interactions.

Link to actual workspace evidence with `<a data-source="src/example.ts" data-line="12">Source label</a>`, substituting the workspace-root-relative path and positive line number. Use HTTPS links for external sources. Keep authored HTML free of executable code, inline styles, and external asset dependencies.

## Save and deliver

Write with the existing file tools and permissions. For a new document with no requested location, use `.alpha/documents/<task-id>/<descriptive-slug>.html` when the actual task ID is available. Otherwise use a descriptive workspace filename. The built-in preview opens local `.html` or `.htm` files inside an open workspace. For another requested destination, deliver the file at that location using its ordinary file link.

Always use Alpha's built-in HTML previewer for native document preview. Never use browser tools (`open_browser_page`, `navigate_page`, `run_playwright_code`), an external browser, or a localhost server for this preview. Check the saved source, heading order, evidence, anchors, and any table calculations. If you cannot inspect the preview directly, validate the source and deliver the document link. Say which checks you performed. If Alpha reports an unsupported version or invalid markup, inspect the diagnostic and source before repairing the same file.

After a successful workspace write, state the takeaway and include the following Markdown link outside a code block.

`[Open document](alpha-document://open?uri=<percent-encoded-absolute-file-URI>&task=<actual-task-id>)`

Encode the complete file URI as one query parameter. Omit the task parameter when the ID is unknown. The link opens the saved document in Alpha and reopens the same preview after edits.
