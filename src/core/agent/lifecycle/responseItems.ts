import type { AgentResponseItem } from "../AgentResponse"

// Stay below the journal's 8,000-character value limit. Canonical/provider
// history remains untouched; only adjacent lifecycle display fragments merge.
const MAX_FRAGMENT_TEXT = 4_000

export function* lifecycleResponseItems(
	items: readonly AgentResponseItem[],
	stepId: string,
	publishedIds: ReadonlySet<string> = new Set(),
): Generator<{ itemId: string; responseItem: AgentResponseItem }> {
	const covered = new Set<number>()
	const groupPrefix = `${stepId}:items-`
	for (const id of publishedIds) {
		if (!id.startsWith(groupPrefix)) continue
		const [start, end] = id.slice(groupPrefix.length).split("-").map(Number)
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start < 0 ||
			end < start ||
			end >= items.length
		)
			continue
		for (let index = start; index <= end; index++) covered.add(index)
	}
	for (let index = 0; index < items.length; index++) {
		if (covered.has(index) || publishedIds.has(`${stepId}:item-${index}`)) continue
		const start = index
		let responseItem = items[index]
		if (responseItem.type === "text" || responseItem.type === "reasoning") {
			while (index + 1 < items.length) {
				const next = items[index + 1]
				if (covered.has(index + 1) || publishedIds.has(`${stepId}:item-${index + 1}`)) break
				if (next.type !== responseItem.type || (next.type !== "text" && next.type !== "reasoning")) break
				if (
					next.type === "reasoning" &&
					responseItem.type === "reasoning" &&
					next.signature !== responseItem.signature
				)
					break
				if (responseItem.text.length + next.text.length > MAX_FRAGMENT_TEXT) break
				responseItem = { ...responseItem, text: responseItem.text + next.text }
				index++
			}
		}
		yield {
			itemId: start === index ? `${stepId}:item-${start}` : `${stepId}:items-${start}-${index}`,
			responseItem,
		}
	}
}
