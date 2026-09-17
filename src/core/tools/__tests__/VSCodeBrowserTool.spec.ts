import { beforeEach, describe, expect, it, vi } from "vitest"

import { invokeVSCodeBrowserTool } from "../../../services/browser/VSCodeBrowserTools"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { openBrowserPageTool, readPageTool } from "../VSCodeBrowserTool"

vi.mock("../../../services/browser/VSCodeBrowserTools", () => ({
	invokeVSCodeBrowserTool: vi.fn(),
}))

function harness(signal?: AbortSignal) {
	const task = {
		say: vi.fn(async () => undefined),
		consecutiveMistakeCount: 2,
		recordToolUsage: vi.fn(),
	} as any
	const callbacks = {
		askApproval: vi.fn(),
		handleError: vi.fn(async () => undefined),
		pushToolResult: vi.fn(),
		setResultMetadata: vi.fn(),
		signal,
	} as any

	return { task, callbacks }
}

function presentations(task: ReturnType<typeof harness>["task"]) {
	return task.say.mock.calls.map((call: unknown[]) => ({
		payload: JSON.parse(call[1] as string),
		partial: call[3],
	}))
}

describe("VSCodeBrowserTool", () => {
	beforeEach(() => {
		vi.mocked(invokeVSCodeBrowserTool).mockReset()
		NativeToolCallParser.clearAllStreamingToolCalls()
	})

	it("reaches the VS Code invocation with arguments produced by the native model-call parser", async () => {
		vi.mocked(invokeVSCodeBrowserTool).mockResolvedValue("Opened page page-1")
		const payload = { url: "https://example.com", forceNew: true }
		const block = NativeToolCallParser.parseToolCall({
			id: "model-browser-call",
			name: "open_browser_page",
			arguments: JSON.stringify(payload),
		})
		const { task, callbacks } = harness()

		expect(block?.type).toBe("tool_use")
		if (block?.type !== "tool_use" || !block.nativeArgs) {
			throw new Error("Expected a parsed browser tool call")
		}

		await openBrowserPageTool.execute(block.nativeArgs, task, callbacks)

		expect(invokeVSCodeBrowserTool).toHaveBeenCalledWith("open_browser_page", payload, undefined)
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("Opened page page-1")
	})

	it("publishes running and completed status around a successful VS Code invocation", async () => {
		vi.mocked(invokeVSCodeBrowserTool).mockResolvedValue("Page contents")
		const { task, callbacks } = harness()

		await readPageTool.execute({ pageId: "page-1" }, task, callbacks)

		expect(invokeVSCodeBrowserTool).toHaveBeenCalledWith("read_page", { pageId: "page-1" }, undefined)
		expect(presentations(task)).toEqual([
			{
				payload: expect.objectContaining({
					tool: "browserAction",
					action: "read_page",
					status: "running",
					pageId: "page-1",
				}),
				partial: true,
			},
			{
				payload: expect.objectContaining({ action: "read_page", status: "completed" }),
				partial: false,
			},
		])
		expect(task.consecutiveMistakeCount).toBe(0)
		expect(task.recordToolUsage).not.toHaveBeenCalled()
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "success" })
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("Page contents")
	})

	it("replaces the running row with an error and delegates error formatting", async () => {
		vi.mocked(invokeVSCodeBrowserTool).mockRejectedValue(new Error("Browser unavailable"))
		const { task, callbacks } = harness()

		await readPageTool.execute({ pageId: "page-1" }, task, callbacks)

		expect(presentations(task)[1]).toMatchObject({
			payload: { action: "read_page", status: "error" },
			partial: false,
		})
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
		expect(callbacks.handleError).toHaveBeenCalledWith(
			"using VS Code integrated browser tool read_page",
			expect.objectContaining({ message: "Browser unavailable" }),
		)
	})

	it("returns a cancellation result without reporting a regular tool error", async () => {
		vi.mocked(invokeVSCodeBrowserTool).mockRejectedValue(new Error("Cancelled"))
		const controller = new AbortController()
		controller.abort()
		const { task, callbacks } = harness(controller.signal)

		await readPageTool.execute({ pageId: "page-1" }, task, callbacks)

		expect(presentations(task)[1]).toMatchObject({
			payload: { action: "read_page", status: "cancelled" },
			partial: false,
		})
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("cancelled"))
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})
})
