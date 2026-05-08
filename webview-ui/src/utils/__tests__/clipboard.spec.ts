import { copyToClipboard } from "../clipboard"

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
