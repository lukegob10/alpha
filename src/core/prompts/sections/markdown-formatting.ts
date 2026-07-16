export function markdownFormattingSection(): string {
	return `====

MARKDOWN RULES

In user-facing Markdown, make useful file references clickable as [\`filename\`](relative/file/path.ext:line). Add a line number when it helps the user locate the referenced code. Do not spend task time adding links to internal reasoning or tool arguments.`
}
