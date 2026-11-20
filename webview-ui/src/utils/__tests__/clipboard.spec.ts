import { act, renderHook } from "@testing-library/react"

import { copyToClipboard, useCopyToClipboard } from "../clipboard"

describe("copyToClipboard", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it("copies with the Clipboard API when available", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		})
		const onSuccess = vi.fn()

		await expect(copyToClipboard("hello", { onSuccess })).resolves.toBe(true)

		expect(writeText).toHaveBeenCalledWith("hello")
		expect(onSuccess).toHaveBeenCalledTimes(1)
	})

	it("falls back to a hidden textarea when the Clipboard API fails", async () => {
		const writeText = vi.fn().mockRejectedValue(new Error("denied"))
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		})
		const execCommand = vi.fn().mockReturnValue(true)
		Object.defineProperty(document, "execCommand", {
			value: execCommand,
			configurable: true,
		})
		const onSuccess = vi.fn()

		await expect(copyToClipboard("fallback", { onSuccess })).resolves.toBe(true)

		expect(execCommand).toHaveBeenCalledWith("copy")
		expect(onSuccess).toHaveBeenCalledTimes(1)
		expect(document.querySelector("textarea[readonly]")).toBeNull()
	})

	it("reports failure when both clipboard strategies fail", async () => {
		Object.defineProperty(navigator, "clipboard", {
			value: undefined,
			configurable: true,
		})
		Object.defineProperty(document, "execCommand", {
			value: vi.fn().mockReturnValue(false),
			configurable: true,
		})
		const onError = vi.fn()

		await expect(copyToClipboard("nope", { onError })).resolves.toBe(false)

		expect(onError).toHaveBeenCalledTimes(1)
	})
})

describe("useCopyToClipboard", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("shows the full feedback duration after the latest successful write", async () => {
		const firstWrite = Promise.withResolvers<void>()
		const secondWrite = Promise.withResolvers<void>()
		const writeText = vi.fn().mockReturnValueOnce(firstWrite.promise).mockReturnValueOnce(secondWrite.promise)
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
		const { result } = renderHook(() => useCopyToClipboard(1000))
		const firstCopy = result.current.copyWithFeedback("first")
		const secondCopy = result.current.copyWithFeedback("second")

		await act(async () => {
			firstWrite.resolve()
			await firstCopy
		})
		act(() => {
			vi.advanceTimersByTime(500)
		})
		await act(async () => {
			secondWrite.resolve()
			await secondCopy
		})

		act(() => {
			vi.advanceTimersByTime(999)
		})
		expect(result.current.showCopyFeedback).toBe(true)
		act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(result.current.showCopyFeedback).toBe(false)
	})

	it("does not schedule feedback when a pending write succeeds after unmount", async () => {
		const write = Promise.withResolvers<void>()
		const writeText = vi.fn().mockReturnValue(write.promise)
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
		const { result, unmount } = renderHook(() => useCopyToClipboard())
		const copy = result.current.copyWithFeedback("text")

		unmount()
		write.resolve()

		await expect(copy).resolves.toBe(true)
		expect(vi.getTimerCount()).toBe(0)
	})
})
