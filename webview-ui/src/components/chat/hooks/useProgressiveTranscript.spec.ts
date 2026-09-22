import { act, renderHook } from "@testing-library/react"

import {
	CHAT_TRANSCRIPT_RENDER_BATCH_SIZE,
	INITIAL_CHAT_TRANSCRIPT_RENDER_COUNT,
	useProgressiveTranscript,
} from "./useProgressiveTranscript"

describe("useProgressiveTranscript", () => {
	it("keeps older rows unmounted until loadOlder or revealIndex", () => {
		const items = Array.from({ length: INITIAL_CHAT_TRANSCRIPT_RENDER_COUNT + 25 }, (_, index) => index)
		const { result } = renderHook(() => useProgressiveTranscript(items, "task-1"))

		expect(result.current.startIndex).toBe(25)
		expect(result.current.hasOlder).toBe(true)
		expect(result.current.items).toEqual(items.slice(25))

		act(() => result.current.loadOlder())
		expect(result.current.startIndex).toBe(Math.max(0, 25 - CHAT_TRANSCRIPT_RENDER_BATCH_SIZE))
		expect(result.current.items[0]).toBe(result.current.startIndex)

		act(() => result.current.revealIndex(0))
		expect(result.current.startIndex).toBe(0)
		expect(result.current.hasOlder).toBe(false)
		expect(result.current.items).toEqual(items)
	})
})
