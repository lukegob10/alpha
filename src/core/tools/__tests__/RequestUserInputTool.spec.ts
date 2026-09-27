import { describe, expect, it, vi } from "vitest"

import { RequestUserInputTool } from "../RequestUserInputTool"
import type { ToolCallbacks } from "../BaseTool"

const questions = [
	{
		id: "workspace_scope",
		header: "Scope",
		question: "Which workspace should I inspect?",
		options: [
			{ label: "Current workspace (Recommended)", description: "Use the active project folder." },
			{ label: "All workspaces", description: "Include every open project folder." },
		],
	},
	{
		id: "test_level",
		header: "Testing",
		question: "Which validation should I run?",
		options: [
			{ label: "Focused tests", description: "Run tests covering the changed behavior." },
			{ label: "Full suite", description: "Run all tests in the repository." },
		],
	},
]

const answers = {
	workspace_scope: { answers: ["Current workspace (Recommended)"] },
	test_level: { answers: ["Focused tests"] },
}

function callbacks(overrides: Partial<ToolCallbacks> = {}): ToolCallbacks {
	return {
		askApproval: vi.fn(async () => true),
		handleError: vi.fn(async () => {}),
		pushToolResult: vi.fn(),
		setResultMetadata: vi.fn(),
		...overrides,
	}
}

describe("RequestUserInputTool", () => {
	it("opens one grouped request and returns answers atomically by stable question id", async () => {
		const task = {
			taskKind: "primary",
			abort: false,
			ask: vi.fn(async (_type: string, _payload: string) => ({
				response: "messageResponse" as const,
				text: JSON.stringify({ answers }),
			})),
			say: vi.fn(async () => {}),
		}
		const cb = callbacks()

		await new RequestUserInputTool().execute({ questions }, task as any, cb)

		expect(task.ask).toHaveBeenCalledOnce()
		const request = JSON.parse(task.ask.mock.calls[0]![1])
		expect(request.requestUserInput.questions).toEqual(questions)
		expect(JSON.parse(request.suggest[0].answer)).toEqual({
			answers: {
				workspace_scope: { answers: ["Current workspace (Recommended)"] },
				test_level: { answers: ["Focused tests"] },
			},
		})
		expect(task.say).toHaveBeenCalledExactlyOnceWith(
			"user_feedback",
			"Scope: Current workspace (Recommended)\nTesting: Focused tests",
			undefined,
		)
		expect(cb.pushToolResult).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ answers }))
		expect(cb.setResultMetadata).not.toHaveBeenCalled()
	})

	it("preserves free-form replies for a one-question request", async () => {
		const task = {
			taskKind: "primary",
			abort: false,
			ask: vi.fn(async () => ({ response: "messageResponse" as const, text: "Use the linked workspace" })),
			say: vi.fn(async () => {}),
		}
		const cb = callbacks()

		await new RequestUserInputTool().execute({ questions: [questions[0]!] }, task as any, cb)

		expect(task.ask).toHaveBeenCalledOnce()
		expect(task.say).toHaveBeenCalledExactlyOnceWith("user_feedback", "Use the linked workspace", undefined)
		expect(cb.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({ answers: { workspace_scope: { answers: ["Use the linked workspace"] } } }),
		)
	})

	it("keeps a structured one-question answer unprefixed and preserves attached images", async () => {
		const images = ["data:image/png;base64,example"]
		const task = {
			taskKind: "primary",
			abort: false,
			ask: vi.fn(async () => ({
				response: "messageResponse" as const,
				text: JSON.stringify({ answers: { workspace_scope: { answers: ["Current workspace"] } } }),
				images,
			})),
			say: vi.fn(async () => {}),
		}
		const cb = callbacks()

		await new RequestUserInputTool().execute({ questions: [questions[0]!] }, task as any, cb)

		expect(task.say).toHaveBeenCalledExactlyOnceWith("user_feedback", "Current workspace", images)
		expect(cb.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({ answers: { workspace_scope: { answers: ["Current workspace"] } } }),
		)
	})

	it("does not return answers when the grouped response is cancelled", async () => {
		const task = {
			taskKind: "primary",
			abort: false,
			ask: vi.fn(async () => ({ response: "noButtonClicked" as const })),
			say: vi.fn(async () => {}),
		}
		const cb = callbacks()

		await new RequestUserInputTool().execute({ questions }, task as any, cb)

		expect(task.ask).toHaveBeenCalledOnce()
		expect(task.say).not.toHaveBeenCalled()
		expect(cb.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "cancelled" })
		expect(cb.pushToolResult).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ answers: {} }))
	})

	it("does not commit a response if cancellation arrives while recording the grouped feedback", async () => {
		const controller = new AbortController()
		const task = {
			taskKind: "primary",
			abort: false,
			ask: vi.fn(async () => ({ response: "messageResponse" as const, text: JSON.stringify({ answers }) })),
			say: vi.fn(async () => controller.abort()),
		}
		const cb = callbacks({ signal: controller.signal, setResultMetadata: vi.fn() })

		await new RequestUserInputTool().execute({ questions }, task as any, cb)

		expect(task.ask).toHaveBeenCalledOnce()
		expect(cb.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "cancelled" })
		expect(cb.pushToolResult).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ answers: {} }))
	})

	it("returns a cancelled result without opening a request when the signal is already aborted", async () => {
		const controller = new AbortController()
		controller.abort()
		const task = { taskKind: "primary", abort: false, ask: vi.fn(), say: vi.fn() }
		const cb = callbacks({ signal: controller.signal, setResultMetadata: vi.fn() })

		await new RequestUserInputTool().execute({ questions }, task as any, cb)

		expect(task.ask).not.toHaveBeenCalled()
		expect(cb.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "cancelled" })
		expect(cb.pushToolResult).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ answers: {} }))
	})

	it("ends the active grouped Alpha ask when the scheduler signal aborts", async () => {
		const controller = new AbortController()
		let resolveAsk: ((result: { response: "noButtonClicked" }) => void) | undefined
		const task = {
			taskKind: "primary",
			abort: false,
			ask: vi.fn(
				() =>
					new Promise<{ response: "noButtonClicked" }>((resolve) => {
						resolveAsk = resolve
					}),
			),
			handleWebviewAskResponse: vi.fn(() => resolveAsk?.({ response: "noButtonClicked" })),
			say: vi.fn(async () => {}),
		}
		const cb = callbacks({ signal: controller.signal, setResultMetadata: vi.fn() })
		const running = new RequestUserInputTool().execute({ questions }, task as any, cb)

		expect(task.ask).toHaveBeenCalledOnce()
		controller.abort()
		await running

		expect(task.handleWebviewAskResponse).toHaveBeenCalledExactlyOnceWith("noButtonClicked")
		expect(cb.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "cancelled" })
		expect(cb.pushToolResult).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ answers: {} }))
	})

	it("rejects a partial structured response without returning successful answers", async () => {
		const task = {
			taskKind: "primary",
			abort: false,
			ask: vi.fn(async () => ({
				response: "messageResponse" as const,
				text: JSON.stringify({ answers: { workspace_scope: answers.workspace_scope } }),
			})),
			say: vi.fn(async () => {}),
		}
		const cb = callbacks()

		await new RequestUserInputTool().execute({ questions }, task as any, cb)

		expect(task.ask).toHaveBeenCalledOnce()
		expect(task.say).not.toHaveBeenCalled()
		expect(cb.handleError).toHaveBeenCalledExactlyOnceWith(
			"requesting user input",
			expect.objectContaining({ message: expect.stringContaining("answer every question exactly once") }),
		)
		expect(cb.pushToolResult).not.toHaveBeenCalled()
	})

	it("rejects malformed bounds and duplicate ids before asking", async () => {
		const task = { taskKind: "primary", abort: false, ask: vi.fn(), say: vi.fn() }
		const cb = callbacks()

		await new RequestUserInputTool().execute(
			{ questions: [questions[0]!, { ...questions[1]!, id: questions[0]!.id }] },
			task as any,
			cb,
		)

		expect(task.ask).not.toHaveBeenCalled()
		expect(cb.handleError).toHaveBeenCalledExactlyOnceWith(
			"requesting user input",
			expect.objectContaining({ message: expect.stringContaining("unique snake_case id") }),
		)
		expect(cb.pushToolResult).not.toHaveBeenCalled()
	})

	it("denies subtask calls before opening the root user interface", async () => {
		const task = { taskKind: "subagent", abort: false, ask: vi.fn(), say: vi.fn() }
		const cb = callbacks()

		await new RequestUserInputTool().execute({ questions: [questions[0]!] }, task as any, cb)

		expect(task.ask).not.toHaveBeenCalled()
		expect(cb.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "denied" })
		expect(cb.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({ status: "denied", message: "request_user_input is available to the root task only." }),
		)
	})
})
