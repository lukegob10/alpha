// npx vitest run api/providers/utils/__tests__/timeout-config.spec.ts

import { ApiRequestTimeoutError, getApiRequestTimeout, withApiRequestTimeout } from "../timeout-config"
import * as vscode from "vscode"

describe("request timeout attribution", () => {
	afterEach(() => vitest.useRealTimers())
	it("retains a stable provider timeout code and cancels the underlying request once", async () => {
		vitest.useFakeTimers()
		const cancel = vitest.fn()
		const pending = withApiRequestTimeout(new Promise<void>(() => {}), "provider stream", 100, cancel)
		const rejected = expect(pending).rejects.toMatchObject({
			code: "ProviderTimeout",
			timeoutMs: 100,
			name: "ApiRequestTimeoutError",
		})
		await vitest.advanceTimersByTimeAsync(100)
		await rejected
		expect(cancel).toHaveBeenCalledOnce()
		expect(vitest.getTimerCount()).toBe(0)
		expect(new ApiRequestTimeoutError("provider stream", 100).message).toBe(
			"provider stream timed out after 1 second.",
		)
	})
	it("clears the deadline after early completion", async () => {
		vitest.useFakeTimers()
		const cancel = vitest.fn()
		expect(await withApiRequestTimeout(Promise.resolve("complete"), "provider stream", 100, cancel)).toBe(
			"complete",
		)
		await vitest.advanceTimersByTimeAsync(100)
		expect(cancel).not.toHaveBeenCalled()
		expect(vitest.getTimerCount()).toBe(0)
	})
})

// Mock vscode
vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: vitest.fn().mockReturnValue({
			get: vitest.fn(),
		}),
	},
}))

describe("getApiRequestTimeout", () => {
	let mockGetConfig: any

	beforeEach(() => {
		vitest.clearAllMocks()
		mockGetConfig = vitest.fn()
		;(vscode.workspace.getConfiguration as any).mockReturnValue({
			get: mockGetConfig,
		})
	})

	it("should return default timeout of 600000ms when no configuration is set", () => {
		mockGetConfig.mockReturnValue(600)

		const timeout = getApiRequestTimeout()

		expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith("alpha")
		expect(mockGetConfig).toHaveBeenCalledWith("apiRequestTimeout", 600)
		expect(timeout).toBe(600000) // 600 seconds in milliseconds
	})

	it("should return custom timeout in milliseconds", () => {
		mockGetConfig.mockReturnValue(1200) // 20 minutes

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(1200000) // 1200 seconds in milliseconds
	})

	it("should return undefined for zero timeout (disables timeout)", () => {
		mockGetConfig.mockReturnValue(0)

		const timeout = getApiRequestTimeout()

		// Zero means "no timeout" - return undefined so SDK uses its default
		// (OpenAI SDK interprets 0 as "abort immediately", so we avoid that)
		expect(timeout).toBeUndefined()
	})

	it("should return undefined for negative values (disables timeout)", () => {
		mockGetConfig.mockReturnValue(-100)

		const timeout = getApiRequestTimeout()

		// Negative values also mean "no timeout" - return undefined
		expect(timeout).toBeUndefined()
	})

	it("should handle null by using default", () => {
		mockGetConfig.mockReturnValue(null)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(600000) // Should fall back to default 600 seconds
	})

	it("should handle undefined by using default", () => {
		mockGetConfig.mockReturnValue(undefined)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(600000) // Should fall back to default 600 seconds
	})

	it("should handle NaN by using default", () => {
		mockGetConfig.mockReturnValue(NaN)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(600000) // Should fall back to default 600 seconds
	})

	it("should handle string values by using default", () => {
		mockGetConfig.mockReturnValue("not-a-number") // String instead of number

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(600000) // Should fall back to default since it's not a number
	})

	it("should handle boolean values by using default", () => {
		mockGetConfig.mockReturnValue(true) // Boolean instead of number

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(600000) // Should fall back to default since it's not a number
	})
})
