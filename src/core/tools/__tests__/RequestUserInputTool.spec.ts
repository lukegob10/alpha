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

const userInputResponse = {
	questions: [
		{
			header: "Scope",
			question: "Which workspace should I inspect?",
			answers: ["Current workspace (Recommended)"],
		},
		{ header: "Testing", question: "Which validation should I run?", answers: ["Focused tests"] },
	],
}

function singleQuestionResponse(answer: string) {
	return {
		questions: [{ header: "Scope", question: "Which workspace should I inspect?", answers: [answer] }],
	}
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
			"Which workspace should I inspect?\nCurrent workspace (Recommended)\n\nWhich validation should I run?\nFocused tests",
			undefined,
			undefined,
			undefined,
			undefined,
			{ userInputResponse },
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
		expect(task.say).toHaveBeenCalledExactlyOnceWith(
			"user_feedback",
			"Which workspace should I inspect?\nUse the linked workspace",
			undefined,
			undefined,
			undefined,
			undefined,
			{ userInputResponse: singleQuestionResponse("Use the linked workspace") },
		)
		expect(cb.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({ answers: { workspace_scope: { answers: ["Use the linked workspace"] } } }),
		)
	})

	it.each(["10", "true", "null"])("preserves a free-form JSON scalar reply %s for one question", async (text) => {
		const task = {
			taskKind: "primary",
			abort: false,
			ask: vi.fn(async () => ({ response: "messageResponse" as const, text })),
			say: vi.fn(async () => {}),
		}
		const cb = callbacks()

		await new RequestUserInputTool().execute({ questions: [questions[0]!] }, task as never, cb)

		expect(cb.handleError).not.toHaveBeenCalled()
		expect(task.say).toHaveBeenCalledExactlyOnceWith(
			"user_feedback",
			`Which workspace should I inspect?\n${text}`,
			undefined,
			undefined,
			undefined,
			undefined,
			{ userInputResponse: singleQuestionResponse(text) },
		)
		expect(cb.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({ answers: { workspace_scope: { answers: [text] } } }),
		)
	})

	it.each([
		"[]",
		"{}",
		JSON.stringify({ answers: {} }),
		JSON.stringify({
			answers: { workspace_scope: { answers: ["Current workspace"] }, extra_id: { answers: ["A"] } },
		}),
		JSON.stringify({ answers: { workspace_scope: { answers: ["Current workspace"], extra: true } } }),
		JSON.stringify({ answers: { workspace_scope: { answers: [10] } } }),
	])("rejects a malformed structured reply %s instead of treating it as free-form text", async (text) => {
		const task = {
			taskKind: "primary",
			abort: false,
			ask: vi.fn(async () => ({ response: "messageResponse" as const, text })),
			say: vi.fn(async () => {}),
		}
		const cb = callbacks()

		await new RequestUserInputTool().execute({ questions: [questions[0]!] }, task as never, cb)

		expect(cb.handleError).toHaveBeenCalledExactlyOnceWith("requesting user input", expect.any(Error))
		expect(task.say).not.toHaveBeenCalled()
		expect(cb.pushToolResult).not.toHaveBeenCalled()
	})

	it("records the full prompt with a structured one-question answer and preserves attached images", async () => {
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

		expect(task.say).toHaveBeenCalledExactlyOnceWith(
			"user_feedback",
			"Which workspace should I inspect?\nCurrent workspace",
			images,
			undefined,
			undefined,
			undefined,
			{ userInputResponse: singleQuestionResponse("Current workspace") },
		)
		expect(cb.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({ answers: { workspace_scope: { answers: ["Current workspace"] } } }),
		)
	})

	it("records only full prompts and validated answer lines in the receipt", async () => {
		const task = {
			taskKind: "primary",
			abort: false,
			ask: vi.fn(async () => ({
				response: "messageResponse" as const,
				text: JSON.stringify({
					answers: {
						workspace_scope: { answers: [" Current workspace ", " Keep local changes.\nRun tests. "] },
					},
				}),
			})),
			say: vi.fn(async () => {}),
		}
		const cb = callbacks()

		await new RequestUserInputTool().execute({ questions: [questions[0]!] }, task as never, cb)

		expect(task.say).toHaveBeenCalledExactlyOnceWith(
			"user_feedback",
			"Which workspace should I inspect?\nCurrent workspace\nKeep local changes.\nRun tests.",
			undefined,
			undefined,
			undefined,
			undefined,
			{
				userInputResponse: {
					questions: [
						{
							header: "Scope",
							question: "Which workspace should I inspect?",
							answers: ["Current workspace", "Keep local changes.\nRun tests."],
						},
					],
				},
			},
		)
		expect(cb.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({
				answers: { workspace_scope: { answers: ["Current workspace", "Keep local changes.\nRun tests."] } },
			}),
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

	it.each(["Current workspace (Recommended)", " Current workspace (Recommended) "])(
		"rejects repeated option labels %s before presenting indistinguishable choices",
		async (duplicateLabel) => {
			const task = { taskKind: "primary", abort: false, ask: vi.fn(), say: vi.fn() }
			const cb = callbacks()

			await new RequestUserInputTool().execute(
				{
					questions: [
						{
							...questions[0]!,
							options: [
								questions[0]!.options[0]!,
								{ label: duplicateLabel, description: "Use a different project folder." },
							],
						},
					],
				},
				task as never,
				cb,
			)

			expect(task.ask).not.toHaveBeenCalled()
			expect(cb.handleError).toHaveBeenCalledExactlyOnceWith(
				"requesting user input",
				expect.objectContaining({
					message: "request_user_input question workspace_scope options must have unique labels.",
				}),
			)
			expect(cb.pushToolResult).not.toHaveBeenCalled()
		},
	)

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
