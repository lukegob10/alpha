export function markdownFormattingSection(): string {
	return `====

MARKDOWN RULES

Use concise Markdown. Link workspace files when that helps the user navigate: [filename](relative/file/path.ext:line). Only create a link when its workspace path is supported by available evidence. Never invent a path or line number. When a target was reported missing or remains unverified, use inline code. Do not investigate a file merely to format a reference.`
}
