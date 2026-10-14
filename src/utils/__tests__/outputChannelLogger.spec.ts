import * as vscode from "vscode"

import { createOutputChannelLogger, createDualLogger, createLifecycleSafeOutputChannel } from "../outputChannelLogger"

// Mock VSCode output channel
const mockOutputChannel = {
	appendLine: vitest.fn(),
} as unknown as vscode.OutputChannel

describe("outputChannelLogger", () => {
	it("ignores closed host channel writes across all consumers", () => {
		const raw = {
			appendLine: vitest.fn(() => {
				throw new Error("Channel has been closed")
			}),
			append: vitest.fn(),
			replace: vitest.fn(),
			clear: vitest.fn(),
		} as unknown as vscode.OutputChannel
		const channel = createLifecycleSafeOutputChannel(raw)
		expect(() => channel.appendLine("shutdown")).not.toThrow()
		channel.append("later")
		channel.replace("later")
		channel.clear()
		expect(raw.append).not.toHaveBeenCalled()
		expect(raw.replace).not.toHaveBeenCalled()
		expect(raw.clear).not.toHaveBeenCalled()
	})

	it("preserves unexpected logging failures", () => {
		const raw = {
			appendLine: vitest.fn(() => {
				throw new Error("unexpected")
			}),
		} as unknown as vscode.OutputChannel
		expect(() => createLifecycleSafeOutputChannel(raw).appendLine("message")).toThrow("unexpected")
	})

	it("stops writes after explicit disposal", () => {
		const raw = { appendLine: vitest.fn(), dispose: vitest.fn() } as unknown as vscode.OutputChannel
		const channel = createLifecycleSafeOutputChannel(raw)
		channel.appendLine("before")
		channel.dispose()
		channel.appendLine("after")
		expect(raw.appendLine).toHaveBeenCalledExactlyOnceWith("before")
		expect(raw.dispose).toHaveBeenCalledOnce()
	})
	beforeEach(() => {
		vitest.clearAllMocks()
		// Clear console.log mock if it exists
		if (vitest.isMockFunction(console.log)) {
			;(console.log as any).mockClear()
		}
	})

	describe("createOutputChannelLogger", () => {
		it("should log strings to output channel", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			logger("test message")

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith("test message")
		})

		it("should log null values", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			logger(null)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith("null")
		})

		it("should log undefined values", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			logger(undefined)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith("undefined")
		})

		it("should log Error objects with stack trace", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			const error = new Error("test error")
			logger(error)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Error: test error"))
		})

		it("should log objects as JSON", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			const obj = { key: "value", number: 42 }
			logger(obj)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(JSON.stringify(obj, expect.any(Function), 2))
		})

		it("should handle multiple arguments", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			logger("message", 42, { key: "value" })

			expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(3)
			expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(1, "message")
			expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(2, "42")
			expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(
				3,
				JSON.stringify({ key: "value" }, expect.any(Function), 2),
			)
		})
	})

	describe("createDualLogger", () => {
		it("should log to both output channel and console", () => {
			const consoleSpy = vitest.spyOn(console, "log").mockImplementation(() => {})
			const outputChannelLogger = createOutputChannelLogger(mockOutputChannel)
			const dualLogger = createDualLogger(outputChannelLogger)

			dualLogger("test message", 42)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(2)
			expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(1, "test message")
			expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(2, "42")
			expect(consoleSpy).toHaveBeenCalledWith("test message", 42)

			consoleSpy.mockRestore()
		})
	})
})
