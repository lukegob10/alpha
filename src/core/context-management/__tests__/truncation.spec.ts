import { cleanupAfterTruncation, getEffectiveApiHistory } from "../../condense"
import type { ApiMessage } from "../../task-persistence/apiMessages"

describe("saved sliding-window markers", () => {
	const initial: ApiMessage = { role: "user", content: "Initial task", ts: 1 }
	const earlier: ApiMessage = { role: "assistant", content: "Initial response", ts: 2 }
	const marker: ApiMessage = {
		role: "user",
		content: "[Sliding window truncation: 1 messages hidden to reduce context]",
		ts: 3,
		isTruncationMarker: true,
		truncationId: "window-1",
	}
	const hidden = { ...earlier, truncationParent: "window-1" }
	const later: ApiMessage = { role: "user", content: "Follow up", ts: 4 }

	it("hides archived records while the marker exists and restores them on rewind", () => {
		const stored = [initial, hidden, marker, later]
		expect(getEffectiveApiHistory(stored)).toEqual([initial, marker, later])
		expect(cleanupAfterTruncation(stored)).toEqual(stored)

		const rewound = stored.slice(0, 2)
		expect(getEffectiveApiHistory(rewound)).toEqual(rewound)
		expect(cleanupAfterTruncation(rewound)).toEqual([initial, earlier])
	})

	it("restores a hidden window in stages when one marker hides an earlier marker", () => {
		const newerMarker: ApiMessage = {
			role: "user",
			content: "[Sliding window truncation: 2 messages hidden to reduce context]",
			ts: 5,
			isTruncationMarker: true,
			truncationId: "window-2",
		}
		const newest: ApiMessage = { role: "assistant", content: "Latest response", ts: 6 }
		const stored: ApiMessage[] = [
			initial,
			hidden,
			{ ...marker, truncationParent: "window-2" },
			{ ...later, truncationParent: "window-2" },
			newerMarker,
			newest,
		]
		expect(getEffectiveApiHistory(stored)).toEqual([initial, newerMarker, newest])

		const rewoundOnce = cleanupAfterTruncation(stored.slice(0, 4))
		expect(rewoundOnce).toEqual([initial, hidden, marker, later])
		expect(getEffectiveApiHistory(rewoundOnce)).toEqual([initial, marker, later])
		expect(cleanupAfterTruncation(rewoundOnce.slice(0, 2))).toEqual([initial, earlier])
	})

	it("restores only the records owned by a deleted marker when a summary is still present", () => {
		const summary: ApiMessage = {
			role: "user",
			content: "Summary of the initial exchange",
			ts: 3,
			isSummary: true,
			condenseId: "summary-1",
		}
		const summarized = { ...earlier, condenseParent: "summary-1" }
		const hiddenAfterSummary = { ...later, truncationParent: "window-1" }
		const laterMarker = { ...marker, ts: 5 }
		const stored = [initial, summarized, summary, hiddenAfterSummary, laterMarker]
		expect(getEffectiveApiHistory(stored)).toEqual([summary, laterMarker])
		expect(cleanupAfterTruncation(stored)).toEqual(stored)

		const rewound = cleanupAfterTruncation(stored.slice(0, 4))
		expect(rewound).toEqual([initial, summarized, summary, later])
		expect(getEffectiveApiHistory(rewound)).toEqual([summary, later])
		expect(cleanupAfterTruncation(rewound.slice(0, 2))).toEqual([initial, earlier])
	})

	it("clears orphaned references when both owning records are gone", () => {
		const archived = { ...earlier, condenseParent: "summary-1", truncationParent: "window-1" }
		expect(cleanupAfterTruncation([initial, archived, later])).toEqual([initial, earlier, later])
	})
})
