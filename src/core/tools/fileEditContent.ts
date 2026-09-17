export function normalizeToLF(content: string): string {
	return content.replace(/\r\n/g, "\n")
}

/** Match against LF text while retaining the file's byte-level framing for the save path. */
export function fileEditContent(original: string): { content: string; restore: (contentLF: string) => string } {
	const hasCRLF = original.includes("\r\n")
	if (hasCRLF && /(^|[^\r])\n/.test(original)) {
		throw new Error(
			"Cannot edit a file with mixed line endings (CRLF and LF). Normalize its line endings explicitly first.",
		)
	}
	const bom = original.startsWith("\uFEFF") ? "\uFEFF" : ""
	return {
		content: normalizeToLF(original.slice(bom.length)),
		restore: (contentLF) => bom + (hasCRLF ? contentLF.replace(/\n/g, "\r\n") : contentLF),
	}
}
