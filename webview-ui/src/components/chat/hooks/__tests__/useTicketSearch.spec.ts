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
