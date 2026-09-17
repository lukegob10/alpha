/** Preserve complete identifiers and camelCase/snake_case components, without language stemming. */
export function codeTerms(text: string): string[] {
	const terms: string[] = []
	for (const word of text.match(/[\p{L}\p{N}_]+/gu) ?? []) {
		terms.push(word.toLowerCase())
		const parts = word
			.replace(/([a-z\d])([A-Z])/g, "$1 $2")
			.replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
			.split(/[_\s]+/)
		if (parts.length > 1) terms.push(...parts.filter(Boolean).map((part) => part.toLowerCase()))
	}
	return terms
}

/** Sparse BM25 term-frequency weights. Qdrant supplies current corpus IDF at query time. */
export function lexicalVector(text: string, query = false): { indices: number[]; values: number[] } {
	const terms = codeTerms(text)
	const counts = new Map<number, number>()
	for (const term of terms) {
		let hash = 2166136261
		for (let index = 0; index < term.length; index++) hash = Math.imul(hash ^ term.charCodeAt(index), 16777619)
		const key = hash >>> 0
		counts.set(key, (counts.get(key) ?? 0) + 1)
	}
	const indices = [...counts.keys()].sort((a, b) => a - b)
	// Fixed average length avoids re-embedding the corpus whenever files change.
	const normalization = 1.2 * (0.25 + (0.75 * terms.length) / 256)
	return {
		indices,
		values: indices.map((index) => (query ? 1 : (counts.get(index)! * 2.2) / (counts.get(index)! + normalization))),
	}
}

export function lexicalText(payload: {
	filePath?: unknown
	context?: unknown
	identifier?: unknown
	codeChunk?: unknown
}): string {
	return [payload.filePath, payload.context, payload.identifier, payload.codeChunk]
		.filter((value) => typeof value === "string")
		.join("\n")
}
