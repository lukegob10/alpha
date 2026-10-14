import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useTicketSearch } from "../useTicketSearch"
import { vscode } from "../../../../utils/vscode"
vi.mock("../../../../utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => {
	vi.useRealTimers()
	vi.clearAllMocks()
})
describe("ticket search lifecycle", () => {
	it.each(["", "PM-42", "pm42"])("immediately searches an opened picker or complete reference: %s", (query) => {
		vi.useFakeTimers()
		renderHook(() => useTicketSearch(true, query, "/project"))
		act(() => vi.advanceTimersByTime(0))
		expect(vscode.postMessage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ type: "searchTickets", query }),
		)
	})
	it("debounces title typing into one request after 100 ms", () => {
		vi.useFakeTimers()
		const { rerender } = renderHook(({ query }) => useTicketSearch(true, query, "/project"), {
			initialProps: { query: "backend" },
		})
		act(() => vi.advanceTimersByTime(75))
		rerender({ query: "backend cleanup" })
		act(() => vi.advanceTimersByTime(99))
		expect(vscode.postMessage).not.toHaveBeenCalled()
		act(() => vi.advanceTimersByTime(1))
		expect(vscode.postMessage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ type: "searchTickets", query: "backend cleanup" }),
		)
	})
	it("rejects oversized queries without scheduling requests", () => {
		vi.useFakeTimers()
		const { result } = renderHook(() => useTicketSearch(true, "x".repeat(201), "/project"))
		expect(result.current[0]?.label).toBe("activityLookupFailed")
		act(() => vi.advanceTimersByTime(15000))
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
	it("ignores replies from an earlier query or workspace and detaches when closed", () => {
		vi.useFakeTimers()
		const { result, rerender } = renderHook(({ active, query, cwd }) => useTicketSearch(active, query, cwd), {
			initialProps: { active: true, query: "PM-42", cwd: "/project" },
		})
		act(() => vi.advanceTimersByTime(0))
		const earlier = vi.mocked(vscode.postMessage).mock.calls.at(-1)![0]
		rerender({ active: true, query: "PM-42", cwd: "/other" })
		act(() => vi.advanceTimersByTime(0))
		const current = vi.mocked(vscode.postMessage).mock.calls.at(-1)![0]
		const reply = (requestId: string) =>
			act(() =>
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "ticketSearchResults",
							ticketSearch: { type: "ticketSearchResults", requestId, tickets: [] },
						},
					}),
				),
			)
		reply(earlier.requestId!)
		expect(result.current[0]?.label).toBe("activitySearching")
		reply(current.requestId!)
		expect(result.current[0]?.label).toBe("empty")
		rerender({ active: false, query: "PM-42", cwd: "/other" })
		reply(current.requestId!)
		act(() => vi.advanceTimersByTime(15000))
		expect(result.current[0]?.label).toBe("empty")
	})
	it("distinguishes empty, failed, and timed-out searches", () => {
		vi.useFakeTimers()
		const { result, rerender } = renderHook(({ query }) => useTicketSearch(true, query, "/project"), {
			initialProps: { query: "" },
		})
		expect(result.current[0]?.label).toBe("activitySearching")
		act(() => vi.advanceTimersByTime(200))
		const reply = (error?: boolean) => {
			const message = vi.mocked(vscode.postMessage).mock.calls.at(-1)![0]
			act(() =>
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "ticketSearchResults",
							ticketSearch: {
								type: "ticketSearchResults",
								requestId: message.requestId,
								tickets: [],
								error,
							},
						},
					}),
				),
			)
		}
		reply()
		expect(result.current[0]?.label).toBe("empty")
		rerender({ query: "broken" })
		act(() => vi.advanceTimersByTime(200))
		reply(true)
		expect(result.current[0]?.label).toBe("activityLookupFailed")
		rerender({ query: "timeout" })
		act(() => vi.advanceTimersByTime(15000))
		expect(result.current[0]?.label).toBe("activityLookupFailed")
	})
	it("cancels queued searches when closed or unmounted", () => {
		vi.useFakeTimers()
		const { rerender, unmount } = renderHook(({ active }) => useTicketSearch(active, "backend", "/project"), {
			initialProps: { active: true },
		})
		rerender({ active: false })
		act(() => vi.advanceTimersByTime(200))
		expect(vscode.postMessage).not.toHaveBeenCalled()
		rerender({ active: true })
		unmount()
		act(() => vi.advanceTimersByTime(15000))
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
})
