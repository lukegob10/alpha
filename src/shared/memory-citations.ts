const OPEN_TAG = "<alpha-mem-citation>"
const CLOSE_TAG = "</alpha-mem-citation>"
export const MAX_MEMORY_CITATION_LENGTH = 16_384
const MAX_BLOCKS = 32

export interface MemoryCitationText {
	text: string
	blocks: string[]
}

/** Keep reserved metadata out of rendered/copied answers, without interpreting it as HTML. */
export function splitMemoryCitations(text: string, partial = false): MemoryCitationText {
	const visible: string[] = []
	const blocks: string[] = []
	let copiedUntil = 0
	let blockStart: number | undefined
	let bodyStart = 0
	let fence: { character: string; length: number } | undefined

	for (let start = 0; start < text.length; ) {
		const newline = text.indexOf("\n", start)
		const end = newline === -1 ? text.length : newline + 1
		const line = text.slice(start, end).trim()
		if (blockStart !== undefined) {
			if (line === CLOSE_TAG) {
				visible.push(text.slice(copiedUntil, blockStart))
				if (start - bodyStart <= MAX_MEMORY_CITATION_LENGTH && blocks.length < MAX_BLOCKS) {
					blocks.push(text.slice(bodyStart, start))
				}
				copiedUntil = end
				blockStart = undefined
			}
		} else {
			const marker = line.match(/^(`{3,}|~{3,})/)
			if (marker) {
				if (!fence) fence = { character: marker[1][0], length: marker[1].length }
				else if (
					marker[1][0] === fence.character &&
					marker[1].length >= fence.length &&
					line.slice(marker[1].length).trim() === ""
				)
					fence = undefined
			} else if (!fence && line === OPEN_TAG) {
				blockStart = start
				bodyStart = end
			} else if (
				!fence &&
				partial &&
				end === text.length &&
				line.startsWith("<alpha-") &&
				OPEN_TAG.startsWith(line)
			) {
				visible.push(text.slice(copiedUntil, start))
				copiedUntil = end
			}
		}
		start = end
	}

	// An unfinished reserved block is display metadata only. It never counts as a citation.
	if (blockStart !== undefined) {
		visible.push(text.slice(copiedUntil, blockStart))
		copiedUntil = text.length
	}
	if (!visible.length && copiedUntil === 0) return { text, blocks }
	visible.push(text.slice(copiedUntil))
	return { text: visible.join("").trimEnd(), blocks }
}

export function stripMemoryCitations(text: string, partial = false): string {
	return splitMemoryCitations(text, partial).text
}
