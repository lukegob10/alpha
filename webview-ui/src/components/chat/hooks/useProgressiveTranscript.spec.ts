import { act, renderHook } from "@testing-library/react"

import {
	CHAT_TRANSCRIPT_RENDER_BATCH_SIZE,
	INITIAL_CHAT_TRANSCRIPT_RENDER_COUNT,
	useProgressiveTranscript,
} from "./useProgressiveTranscript"

describe("useProgressiveTranscript", () => {
	it("bounds a mounted task's live transcript as new rows arrive", () => {
		const items = Array.from({ length: 2_000 }, (_, index) => index)
		const { result, rerender } = renderHook(
			({ count }) => useProgressiveTranscript(items.slice(0, count), "task-1"),
			{
				initialProps: { count: 1 },
			},
		)

		for (let count = 100; count <= items.length; count += 100) {
			rerender({ count })
		}

		expect(result.current.items).toHaveLength(INITIAL_CHAT_TRANSCRIPT_RENDER_COUNT)
		expect(result.current.items).toEqual(items.slice(-INITIAL_CHAT_TRANSCRIPT_RENDER_COUNT))
		expect(result.current.startIndex).toBe(items.length - INITIAL_CHAT_TRANSCRIPT_RENDER_COUNT)
		expect(result.current.hasOlder).toBe(true)
	})

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

	it("keeps the first browsing row in place until following the latest output again", () => {
		const items = Array.from({ length: 1_000 }, (_, index) => ({ index }))
		const { result, rerender } = renderHook(
			({ count, followLatest }) => useProgressiveTranscript(items.slice(0, count), "task-1", false, followLatest),
			{ initialProps: { count: 400, followLatest: true } },
		)
		const firstRow = result.current.items[0]

		rerender({ count: 400, followLatest: false })
		rerender({ count: 700, followLatest: false })
		expect(result.current.startIndex).toBe(320)
		expect(result.current.items[0]).toBe(firstRow)

		rerender({ count: 700, followLatest: true })
		expect(result.current.startIndex).toBe(620)
		expect(result.current.items).toHaveLength(INITIAL_CHAT_TRANSCRIPT_RENDER_COUNT)
		rerender({ count: 1_000, followLatest: true })
		expect(result.current.startIndex).toBe(920)
		expect(result.current.items).toHaveLength(INITIAL_CHAT_TRANSCRIPT_RENDER_COUNT)
	})

	it("captures the displayed row when browsing and new output arrive together", () => {
		const items = Array.from({ length: 700 }, (_, index) => index)
		const { result, rerender } = renderHook(
			({ count, followLatest }) => useProgressiveTranscript(items.slice(0, count), "task-1", false, followLatest),
			{ initialProps: { count: 400, followLatest: true } },
		)
		rerender({ count: 700, followLatest: false })
		expect(result.current.startIndex).toBe(320)
		expect(result.current.items[0]).toBe(320)
	})

	it("preserves loaded history and checkpoint reveals while browsing", () => {
		const items = Array.from({ length: 1_000 }, (_, index) => index)
		const { result, rerender } = renderHook(
			({ count, followLatest }) => useProgressiveTranscript(items.slice(0, count), "task-1", false, followLatest),
			{ initialProps: { count: 400, followLatest: true } },
		)

		// Loading history and leaving follow mode happen in the same UI event.
		act(() => {
			result.current.loadOlder()
			rerender({ count: 400, followLatest: false })
		})
		expect(result.current.startIndex).toBe(220)
		rerender({ count: 700, followLatest: false })
		expect(result.current.startIndex).toBe(220)

		act(() => result.current.revealIndex(20))
		rerender({ count: 800, followLatest: false })
		expect(result.current.startIndex).toBe(20)
		act(() => result.current.revealIndex(0))
		rerender({ count: 900, followLatest: false })
		expect(result.current.items).toEqual(items.slice(0, 900))

		rerender({ count: 1_000, followLatest: true })
		expect(result.current.startIndex).toBe(920)
		expect(result.current.items).toHaveLength(INITIAL_CHAT_TRANSCRIPT_RENDER_COUNT)
	})

	it("resets task windows and clamps a shortened transcript before it grows again", () => {
		const items = Array.from({ length: 1_000 }, (_, index) => index)
		const { result, rerender } = renderHook(
			({ count, taskKey, followLatest }) =>
				useProgressiveTranscript(items.slice(0, count), taskKey, false, followLatest),
			{ initialProps: { count: 500, taskKey: "task-1", followLatest: false } },
		)
		act(() => result.current.loadOlder())
		expect(result.current.startIndex).toBe(320)

		rerender({ count: 100, taskKey: "task-1", followLatest: false })
		expect(result.current.startIndex).toBe(20)
		rerender({ count: 140, taskKey: "task-1", followLatest: false })
		expect(result.current.startIndex).toBe(20)

		rerender({ count: 500, taskKey: "task-2", followLatest: false })
		expect(result.current.startIndex).toBe(420)
		rerender({ count: 600, taskKey: "task-2", followLatest: false })
		expect(result.current.startIndex).toBe(420)
		rerender({ count: 300, taskKey: "task-1", followLatest: true })
		expect(result.current.startIndex).toBe(220)
	})

	it("retains optional idle loading and cancels it on unmount", () => {
		vi.useFakeTimers()
		try {
			const items = Array.from({ length: 400 }, (_, index) => index)
			const { result, unmount } = renderHook(() => useProgressiveTranscript(items, "task-1", true))
			expect(result.current.startIndex).toBe(320)
			act(() => vi.runOnlyPendingTimers())
			expect(result.current.startIndex).toBe(220)
			act(() => vi.runOnlyPendingTimers())
			expect(result.current.startIndex).toBe(120)
			unmount()
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})
})
