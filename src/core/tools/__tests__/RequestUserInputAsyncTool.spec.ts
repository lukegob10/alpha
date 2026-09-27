import { describe, expect, it, vi } from "vitest"

import { RequestUserInputAsyncTool } from "../RequestUserInputAsyncTool"
import type { ToolCallbacks } from "../BaseTool"

const questions = [
	{ title: "Which environment should I use?", options: ["Staging", "Production"] },
	{ title: "What deadline should I use?" },
]

function createCallbacks() {
	const results: string[] = []
	const callbacks: ToolCallbacks = {
		askApproval: vi.fn(async () => true),
		handleError: vi.fn(async () => {}),
		pushToolResult: vi.fn((result) => results.push(String(result))),
		setResultMetadata: vi.fn(),
	}
	return { callbacks, results }
}

describe("RequestUserInputAsyncTool", () => {
	it("emits one typed nonblocking card and immediately accepts the call", async () => {
		const emittedMessages: unknown[][] = []
		const providerHistory = [{ role: "user", content: "Keep me updated." }]
		const task = {
			taskKind: "primary",
			abort: false,
			apiConversationHistory: providerHistory,
			say: vi.fn(async (...args: unknown[]) => emittedMessages.push(args)),
			askId: "root-task",
		}
		const { callbacks, results } = createCallbacks()

		await new RequestUserInputAsyncTool().execute({ questions }, task as never, callbacks)

		expect(emittedMessages).toEqual([
			[
				"async_user_input",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{
					isNonInteractive: true,
					asyncUserInput: {
						questions: [
							{ title: "Which environment should I use?", options: ["Staging", "Production"] },
							{ title: "What deadline should I use?" },
						],
					},
				},
			],
		])
		expect(task.say).toHaveBeenCalledOnce()
		expect(providerHistory).toEqual([{ role: "user", content: "Keep me updated." }])
		expect(results).toEqual(['{"accepted":true}'])
		expect(callbacks.setResultMetadata).not.toHaveBeenCalled()
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it("denies the action for subagents", async () => {
		const task = { taskKind: "subagent", abort: false, say: vi.fn() }
		const { callbacks, results } = createCallbacks()

		await new RequestUserInputAsyncTool().execute({ questions: [questions[0]!] }, task as never, callbacks)

		expect(task.say).not.toHaveBeenCalled()
		expect(callbacks.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "denied" })
		expect(results).toEqual([
			'{"status":"denied","message":"request_user_input_async is available to the root task only."}',
		])
	})

	it("does not publish invalid questions", async () => {
		const task = { taskKind: "primary", abort: false, say: vi.fn() }
		const { callbacks, results } = createCallbacks()

		await new RequestUserInputAsyncTool().execute({ questions: [{ title: "   " }] }, task as never, callbacks)

		expect(task.say).not.toHaveBeenCalled()
		expect(callbacks.handleError).toHaveBeenCalledExactlyOnceWith(
			"requesting user input",
			expect.objectContaining({ message: "request_user_input_async question 1 must have a title." }),
		)
		expect(results).toHaveLength(0)
	})
})
