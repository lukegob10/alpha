export function markdownFormattingSection(): string {
	return `====

MARKDOWN RULES

ALL responses MUST show any verified \`language construct\` or filename reference as clickable, exactly as [\`filename OR language.declaration()\`](relative/file/path.ext:line); line is required for \`syntax\` and optional for filename links. Only create a link when its workspace path is supported by available evidence. Never invent a path or line number. When a target was reported missing or remains unverified, render its name as plain inline code instead of a link. This applies to all markdown responses and also those in attempt_completion.`
}
