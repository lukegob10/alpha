import { createHash } from "crypto"

export interface ContentVersionCheck {
	status: "current" | "recovered" | "stale_context"
	fingerprint: string
	metadata?: { recovery: "unique_search_anchors"; anchorCount: number }
	error?: string
}

export function fingerprintContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex")
}

export function contentVersionMetadata(content: string): {
	fingerprint: string
	anchors: Array<{ line: number; digest: string }>
} {
	const lines = content.split(/\r?\n/)
	const candidates = lines
		.map((value, index) => ({ value, line: index + 1 }))
		.filter(({ value }) => value.trim().length > 0)
	const selected = candidates.length > 1 ? [candidates[0], candidates.at(-1)!] : candidates
	return {
		fingerprint: fingerprintContent(content),
		anchors: selected.map(({ value, line }) => ({
			line,
			digest: fingerprintContent(value).slice(0, 16),
		})),
	}
}

function extractSearchAnchors(diff: string): string[] {
	const anchors: string[] = []
	const pattern = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n[\s\S]*?\r?\n>>>>>>> REPLACE/g
	for (const match of diff.matchAll(pattern)) {
		anchors.push(match[1].replace(/^:start_line:\d+\r?\n-------\r?\n/, ""))
	}
	return anchors
}

function occurrenceCount(content: string, search: string): number {
	if (!search) return 0
	let count = 0
	let offset = 0
	while ((offset = content.indexOf(search, offset)) !== -1) {
		count++
		offset += Math.max(1, search.length)
	}
	return count
}

export function checkObservedContentVersion(
	currentContent: string,
	diff: string,
	observedFingerprint?: string,
): ContentVersionCheck {
	const fingerprint = fingerprintContent(currentContent)
	if (!observedFingerprint || observedFingerprint === fingerprint) return { status: "current", fingerprint }

	const anchors = extractSearchAnchors(diff)
	if (anchors.length > 0 && anchors.every((anchor) => occurrenceCount(currentContent, anchor) === 1)) {
		return {
			status: "recovered",
			fingerprint,
			metadata: { recovery: "unique_search_anchors", anchorCount: anchors.length },
		}
	}

	return {
		status: "stale_context",
		fingerprint,
		error: "stale_context: the file changed after it was read and the requested edit cannot be uniquely re-anchored; re-read the file before editing",
	}
}
